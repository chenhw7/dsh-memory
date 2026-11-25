/**
 * `@chenhw7/dsh-memory/review`: the automatic memory sediment layer. A
 * function plugin that registers a `session-projection` accumulator over
 * `user/message` / `assistant/message` events and triggers one LLM extraction
 * call when the accumulator crosses its threshold, plus a fire-and-forget
 * flush on `compaction/end` and `session/disposed` (方案 C).
 *
 * Two mechanisms, one store:
 * 1. **Periodic review** — a pure synchronous projection collects candidate
 *    fragments (keyword/correction signals); on `agent/pre-step`, when the
 *    unprocessed candidates reach the threshold, one `ctx.llm.stream`
 *    extraction runs and the high-water mark advances (the logical "clear").
 * 2. **Flush** — on `compaction/end` the shadowed raw events are read from the
 *    matching `compaction/summary` and extracted; on `session/disposed` the
 *    recent derived messages are extracted. Both are fire-and-forget and never
 *    block their event.
 *
 * All knobs are live configuration: the `memory-review` entry's `Config` is
 * the settings surface, and handlers read the resolved value per event. The
 * editable knobs are `volatile` (commits update the live refs in place), so a new value lands on
 * the next event without a restart.
 *
 * @module @chenhw7/dsh-memory/review
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { liveValue, type LiveConfig } from '../live-config.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '../index.ts'
// Loads the `compaction/*` SessionEventMap declaration merge so the flush
// helpers can narrow `SessionEvent<'compaction/summary' | 'compaction/end'>`.
import type {} from '@deepseek-ai/dsh-compaction/types'
import {
  MEMORY_REVIEW_PROJECTION_KEY,
  accumulatorSchema,
  applyAccumulator,
  emptyAccumulator,
  messageText,
} from './accumulator.ts'
import type { AccumulatorState, AccumulatorView } from './accumulator.ts'
import { runFlushExtraction, runReviewExtraction, runCuration, type ExtractionModelOverride } from './extract.ts'
import { runSweepPass, stampSweepLastRun, sweepCooldownOpen, type SweepStoreFace } from './sweep.ts'
import type { MemoryEntry } from '../types.ts'

/** Cordis function-plugin name. */
export const name = 'memory-review'

/** Services required before the plugin applies. The LLM seam is mandatory;
 *  `sessionProjections` and `memory` are optional (read via `ctx.get`). */
export const inject = ['llm']

/**
 * The face the review plugin publishes on `ctx.memoryReview`: the resolved
 * `memory-review` entry settings, for siblings that must honour them (the
 * tool plugin's confirm-before-write gate).
 */
export interface MemoryReviewSettingsFace {
  /** The resolved settings, re-read per call. */
  settings(): ResolvedConfig
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryReview: MemoryReviewSettingsFace
  }
}

/** Fallback for `decayDays` when no store service is composed. */
const DEFAULT_DECAY_DAYS = 30

/**
 * Cap on the per-session seq→text log the compaction flush reads. The flush
 * needs the raw text of the events a compaction summary shadows, and the host
 * deprecates synchronous session-log reads, so this plugin keeps its own
 * bounded copy of what it already receives on `session/event`.
 */
const EVENT_TEXT_CAP = 500

/** Plugin configuration. */
export interface Config {
  /** Enable the periodic-review extraction. Defaults to `true`. */
  reviewEnabled?: boolean
  /** Number of unprocessed candidates that trigger one extraction. Defaults to `10`. */
  reviewCandidateThreshold?: number
  /** Enable the compaction-end flush. Defaults to `true`. */
  flushOnCompaction?: boolean
  /** Enable the session-disposed flush. Defaults to `true`. */
  flushOnDispose?: boolean
  /** Override provider for extraction calls; empty string falls back to the session route. */
  extractionModelProvider?: string
  /** Override model for extraction calls; empty string falls back to the session route. */
  extractionModelModel?: string
  /** Max extraction calls per session before budget exhaustion; defaults to 20. 0 = unlimited. */
  extractionBudget?: number
  /** Enable the LLM dedup judge on prefilter hits; defaults to `true`. */
  judgeEnabled?: boolean
  /** Consecutive same-signature tool failures required before a success emits a pitfall candidate. Defaults to 2. */
  pitfallStreakThreshold?: number
  /** Enable the low-frequency curator pass that re-summarizes oversized entries. Defaults to `true`. */
  curatorEnabled?: boolean
  /** Run the curator pass every N session creations. Defaults to `20`. */
  curatorEveryNSessions?: number
  /** Max entries selected per curation pass (longest first). Defaults to `5`. */
  curatorMaxEntries?: number
  /** Only entries at least this long (chars) are selected for re-summarization. Defaults to `400`. */
  curatorMinChars?: number
  /**
   * Human-confirm mode (P1-1): extraction/tool proposals land in the
   * pending-review queue instead of the store until adopted in the Memory
   * settings section. Defaults to `false` (the original fully-automatic behavior).
   */
  confirmBeforeWrite?: boolean
  /**
   * Which write path the batch extraction runs (kill-switch, write-path
   * rework Step 1.3). `two-tier` (default) replaces the per-pair dedup judge
   * with one batch-consolidation call; `legacy-judge` restores the original
   * `judgeDuplicate` flow for one release. Defaults to `two-tier`.
   */
  consolidation?: 'two-tier' | 'legacy-judge'
  /**
   * Enable the periodic whole-store consolidation sweep (write-path rework
   * Step 1.4) — the fallback pass that re-judges usage-ranked pairs of stored
   * entries through the same verdict protocol, catching reworded duplicates
   * the per-round lexical pre-screen structurally cannot see. Defaults to
   * `false` (opt-in this release: the per-round layer already owns the write
   * path; the sweep is the additional whole-store net).
   */
  sweepEnabled?: boolean
  /** Run the consolidation sweep every N session creations. Defaults to `20`. */
  sweepEveryNSessions?: number
  /** Max entries selected per sweep pass (usage-ranked). Defaults to `20`. */
  sweepTopN?: number
}

export const Config = z.object({
  reviewEnabled: z.boolean().default(true).volatile(),
  reviewCandidateThreshold: z.number().step(1).min(1).default(10).volatile(),
  flushOnCompaction: z.boolean().default(true).volatile(),
  flushOnDispose: z.boolean().default(true).volatile(),
  extractionModelProvider: z.string().default('').volatile(),
  extractionModelModel: z.string().default('').volatile(),
  extractionBudget: z.number().step(1).min(0).default(20).volatile(),
  judgeEnabled: z.boolean().default(true).volatile(),
  pitfallStreakThreshold: z.number().step(1).min(1).default(2).volatile(),
  curatorEnabled: z.boolean().default(true).volatile(),
  curatorEveryNSessions: z.number().step(1).min(1).default(20).volatile(),
  curatorMaxEntries: z.number().step(1).min(1).default(5).volatile(),
  curatorMinChars: z.number().step(1).min(1).default(400).volatile(),
  confirmBeforeWrite: z.boolean().default(false).volatile(),
  consolidation: z.union(['two-tier', 'legacy-judge'] as const).default('two-tier').volatile(),
  sweepEnabled: z.boolean().default(false).volatile(),
  sweepEveryNSessions: z.number().step(1).min(1).default(20).volatile(),
  sweepTopN: z.number().step(1).min(2).default(20).volatile(),
})

/** Resolved config with every default materialized. */
interface ResolvedConfig {
  readonly reviewEnabled: boolean
  readonly reviewCandidateThreshold: number
  readonly flushOnCompaction: boolean
  readonly flushOnDispose: boolean
  readonly extractionModel: ExtractionModelOverride | undefined
  readonly extractionBudget: number
  readonly judgeEnabled: boolean
  readonly pitfallStreakThreshold: number
  readonly curatorEnabled: boolean
  readonly curatorEveryNSessions: number
  readonly curatorMaxEntries: number
  readonly curatorMinChars: number
  readonly confirmBeforeWrite: boolean
  readonly consolidation: 'two-tier' | 'legacy-judge'
  readonly sweepEnabled: boolean
  readonly sweepEveryNSessions: number
  readonly sweepTopN: number
}

/** Best-effort timeout for the dispose flush, in milliseconds. */
const DISPOSE_FLUSH_TIMEOUT_MS = 5_000

/** Resolve the raw config into the runtime form (re-run per resolved read). */
function resolveConfig(config: Partial<LiveConfig<Config>>): ResolvedConfig {
  const provider = liveValue(config.extractionModelProvider) ?? ''
  const model = liveValue(config.extractionModelModel) ?? ''
  const hasOverride = provider.length > 0 || model.length > 0
  return {
    reviewEnabled: liveValue(config.reviewEnabled) ?? true,
    reviewCandidateThreshold: liveValue(config.reviewCandidateThreshold) ?? 10,
    flushOnCompaction: liveValue(config.flushOnCompaction) ?? true,
    flushOnDispose: liveValue(config.flushOnDispose) ?? true,
    extractionModel: hasOverride ? {
      ...provider.length > 0 ? { provider } : {},
      ...model.length > 0 ? { model } : {},
    } : undefined,
    extractionBudget: liveValue(config.extractionBudget) ?? 20,
    judgeEnabled: liveValue(config.judgeEnabled) ?? true,
    pitfallStreakThreshold: liveValue(config.pitfallStreakThreshold) ?? 2,
    curatorEnabled: liveValue(config.curatorEnabled) ?? true,
    curatorEveryNSessions: liveValue(config.curatorEveryNSessions) ?? 20,
    curatorMaxEntries: liveValue(config.curatorMaxEntries) ?? 5,
    curatorMinChars: liveValue(config.curatorMinChars) ?? 400,
    confirmBeforeWrite: liveValue(config.confirmBeforeWrite) ?? false,
    consolidation: liveValue(config.consolidation) ?? 'two-tier',
    sweepEnabled: liveValue(config.sweepEnabled) ?? false,
    sweepEveryNSessions: liveValue(config.sweepEveryNSessions) ?? 20,
    sweepTopN: liveValue(config.sweepTopN) ?? 20,
  }
}

/** A derived message rendered for flush extraction. */
interface FlushMessage {
  readonly role: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/** Render one derived message as a flush fragment (role-prefixed text). */
function messageFragment(message: FlushMessage): string | undefined {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  if (parts.length === 0) return undefined
  return `${message.role}: ${parts.join('\n')}`
}

/** What this plugin retains per session about events it already received. */
interface SessionEventLog {
  /** Message text by seq, for the seqs a later compaction summary can shadow. */
  readonly texts: Map<number, string>
  /** Shadowed seqs by compaction id, from each `compaction/summary`. */
  readonly summaries: Map<string, readonly number[]>
}

/** Collect text fragments for the shadowed seqs of a compaction summary. */
function collectShadowedFragments(log: SessionEventLog | undefined, seqs: readonly number[]): string[] {
  const fragments: string[] = []
  if (log === undefined) return fragments
  for (const seq of seqs) {
    const text = log.texts.get(seq)
    if (text !== undefined) fragments.push(text)
  }
  return fragments
}

/** Fire-and-forget flush on `compaction/end`: extract the shadowed fragments. */
async function flushOnCompaction(ctx: Context, session: Session, eventLogs: WeakMap<Session, SessionEventLog>, compactionId: SessionEvent<'compaction/end'>['data']['compactionId'], modelOverride: ExtractionModelOverride | undefined, judgeEnabled: boolean, confirmMode: boolean, consolidation: 'two-tier' | 'legacy-judge'): Promise<void> {
  const log = eventLogs.get(session)
  const shadowedSeqs = log?.summaries.get(String(compactionId))
  if (shadowedSeqs === undefined) return
  const fragments = collectShadowedFragments(log, shadowedSeqs)
  await runFlushExtraction(ctx, session, fragments, undefined, modelOverride, judgeEnabled, confirmMode, consolidation)
}

/** Fire-and-forget flush on `session/disposed`: extract recent derived messages. */
async function flushOnDispose(ctx: Context, session: Session, modelOverride: ExtractionModelOverride | undefined, judgeEnabled: boolean, confirmMode: boolean, consolidation: 'two-tier' | 'legacy-judge'): Promise<void> {
  const messages = session.deriveMessages()
  const fragments: string[] = []
  for (const message of messages) {
    const fragment = messageFragment(message)
    if (fragment !== undefined) fragments.push(fragment)
  }
  const signal = AbortSignal.timeout(DISPOSE_FLUSH_TIMEOUT_MS)
  await runFlushExtraction(ctx, session, fragments, signal, modelOverride, judgeEnabled, confirmMode, consolidation)
}

/**
 * Per-session review state held at module scope: a settings change re-runs
 * this entry's `apply` (the host's per-entry configuration model), and the
 * restarted fiber must not lose the in-flight session's accumulator marks,
 * extraction budget, or compaction event log. Sessions are the WeakMap keys,
 * so the state dies with them; the curator cadence counter is the one value
 * that outlives a fiber on purpose — it paces passes across the whole process.
 */
const highWaterMarks = new WeakMap<Session, number>()
const extractionCalls = new WeakMap<Session, number>()
const eventLogs = new WeakMap<Session, SessionEventLog>()
let curatorSessionCount = 0

/**
 * Install the memory-review function plugin.
 * @param ctx - Cordis context carrying the LLM seam.
 * @param config - plugin configuration (defaults applied by schemastery).
 */
export function apply(ctx: Context, config: Partial<LiveConfig<Config>> = {}): void {
  // The entry config IS the settings surface: the host resolves it (schema
  // defaults → composition base → user layer) and re-runs this function when
  // the review card commits a change, so `resolved()` always reads the live
  // value for the life of this fiber.
  const resolved = (): ResolvedConfig => resolveConfig(config)

  // Publish the resolved settings for the tool plugin, which needs
  // `confirmBeforeWrite` to route model writes into the pending-review queue.
  // Cross-plugin reads go through services under the per-entry configuration
  // model; there is no shared namespace to read.
  ctx.provide('memoryReview', { settings: resolved })

  // `decayDays` belongs to the store entry (`ctx.memory`); read it from the
  // service and fall back to the builtin default when no store is composed.
  const readDecayDays = (): number => ctx.get('memory')?.settings().decayDays ?? DEFAULT_DECAY_DAYS

  /** Check and increment the per-session extraction budget. Returns false when exhausted. */
  function checkBudget(session: Session): boolean {
    const budget = resolved().extractionBudget
    if (budget <= 0) return true
    const used = extractionCalls.get(session) ?? 0
    if (used >= budget) return false
    extractionCalls.set(session, used + 1)
    return true
  }

  // Register the projection accumulator (optional: only when sessionProjections
  // is composed; headless assemblies stay unaffected). Host-only unit: the
  // state is read back through the registration handle, so no `wire` view is
  // declared. Registration is awaitable and the handle is the supported read
  // path (the registry-level read is deprecated), so the handle is retained
  // here and every later read goes through it.
  let accumulator: ProjectionHandle<AccumulatorState> | undefined
  ctx.inject(['sessionProjections'], (pctx) => {
    void pctx.sessionProjections.register<typeof MEMORY_REVIEW_PROJECTION_KEY, AccumulatorState>({
      key: MEMORY_REVIEW_PROJECTION_KEY,
      stateSchema: accumulatorSchema,
      init: () => emptyAccumulator,
      apply: (state, event) => applyAccumulator(state, event, resolved().pitfallStreakThreshold),
      stateVersion: 2,
    }).then((handle) => { accumulator = handle })
  })

  // Bounded per-session event log for the compaction flush (module-scoped:
  // the log must survive a settings re-apply). The flush needs the raw text of
  // the events a `compaction/summary` shadows, and the host deprecates
  // synchronous session-log reads, so this plugin keeps its own copy of what it
  // already receives — texts by seq plus each summary's shadowed seqs. A
  // WeakMap: the log dies with its session.
  const eventLogFor = (session: Session): SessionEventLog => {
    let log = eventLogs.get(session)
    if (log === undefined) {
      log = { texts: new Map(), summaries: new Map() }
      eventLogs.set(session, log)
    }
    return log
  }
  ctx.on('session/event', (session: Session, event) => {
    const log = eventLogFor(session)
    if (event.type === 'compaction/summary') {
      log.summaries.set(String(event.data.compactionId), event.data.shadowedSeqs)
      return
    }
    const text = messageText(event)
    if (text === undefined) return
    log.texts.set(event.seq, text)
    while (log.texts.size > EVENT_TEXT_CAP) {
      const oldest = log.texts.keys().next()
      if (oldest.done === true) break
      log.texts.delete(oldest.value)
    }
  }, { global: true })

  // Periodic review: drain the accumulator on agent/pre-step. Always
  // registered — the enabled flag and knobs are read per event, so a settings
  // change takes effect on the very next step without a restart.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const cfg = resolved()
    if (!signal.aborted && cfg.reviewEnabled) {
      try {
        await maybeRunReview(ctx, agent, () => accumulator, cfg.reviewCandidateThreshold, highWaterMarks, cfg.extractionModel, checkBudget, cfg.judgeEnabled, cfg.confirmBeforeWrite, cfg.consolidation)
      } catch (reviewError) {
        // Best-effort: a review failure must never block the step.
        ctx.get('memory')?.reportFailure('review-drain', reviewError)
      }
    }
    return next()
  })

  // Flush on compaction/end (fire-and-forget; never blocks compaction). The
  // same root-scoped feed the event log subscribes to, with the same `global`
  // escape so the pair cannot diverge when this entry is composed under an
  // agent scope.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/end') return
    if (event.data.error !== undefined) return
    const cfg = resolved()
    if (!cfg.flushOnCompaction) return
    if (!checkBudget(session)) return
    void flushOnCompaction(ctx, session, eventLogs, event.data.compactionId, cfg.extractionModel, cfg.judgeEnabled, cfg.confirmBeforeWrite, cfg.consolidation).catch((error: unknown) => {
      // Best-effort: never blocks compaction, but stays observable.
      ctx.get('memory')?.reportFailure('flush-compaction', error)
    })
  }, { global: true })

  // Flush on session/disposed (fire-and-forget; never blocks dispose).
  ctx.on('session/disposed', (session) => {
    const cfg = resolved()
    if (!cfg.flushOnDispose) return
    if (!checkBudget(session)) return
    void flushOnDispose(ctx, session, cfg.extractionModel, cfg.judgeEnabled, cfg.confirmBeforeWrite, cfg.consolidation).catch((error: unknown) => {
      // Best-effort: dispose must not block on memory extraction, but stays observable.
      ctx.get('memory')?.reportFailure('flush-dispose', error)
    })
  })

  // Janitor: decay stale project-scoped entries on session/created (§3.5).
  // `decayDays` belongs to the store entry and comes back through
  // `ctx.memory.settings()`, read per event; `0` disables. Falls back to the
  // builtin default when no store is composed.
  ctx.on('session/created', () => {
    const days = readDecayDays()
    if (days <= 0) return
    const memory = ctx.get('memory')
    if (memory === undefined) return
    void memory.janitor(days).catch((error: unknown) => {
      // Best-effort: a janitor failure never blocks session creation, but stays observable.
      memory.reportFailure('janitor', error)
    })
  }, { global: true })

  // Curator pass: every N session creations, offer the longest oversized
  // entries to the LLM for a concise rewrite (nanobot-style consolidation,
  // bounded by the extraction budget). Fire-and-forget; never blocks
  // session creation. Selection is deterministic: length desc, then age.
  ctx.on('session/created', (session: Session) => {
    curatorSessionCount++
    const cfg = resolved()
    if (!cfg.curatorEnabled) return
    if (curatorSessionCount % cfg.curatorEveryNSessions !== 0) return
    const memory = ctx.get('memory')
    if (memory === undefined) return
    const selected: MemoryEntry[] = memory.list()
      .filter(entry => entry.content.length >= cfg.curatorMinChars)
      .sort((a, b) => b.content.length - a.content.length || a.createdAt - b.createdAt)
      .slice(0, cfg.curatorMaxEntries)
    // One oversized entry is still worth a pass: the curator rewrites each
    // selected entry on its own, so a single long entry is a full batch.
    if (selected.length === 0) return
    if (!checkBudget(session)) return
    void runCuration(ctx, session, selected, cfg.extractionModel, cfg.confirmBeforeWrite).catch((error: unknown) => {
      // Best-effort: curation failures never surface into session creation, but stay observable.
      ctx.get('memory')?.reportFailure('curator', error)
    })
  }, { global: true })

  // Periodic whole-store consolidation sweep (write-path rework Step 1.4):
  // the fallback pass that re-judges usage-ranked pairs of stored entries —
  // the net under the per-round lexical pre-screen, seeing reworded
  // duplicates no word-face signal proposes. Rides the curator's per-N-
  // sessions gate shape (its own counter, so the two layers' cadences stay
  // independent), gated by `sweepEnabled`, a meta-table cooldown
  // (`consolidation:lastRun`, persisted across restarts), and a startup
  // pass. Fire-and-forget; never blocks session creation. The extraction
  // budget deliberately does NOT bound the sweep: it is a store-maintenance
  // pass, not an extraction drain (its cadence is gated by sessions +
  // cooldown, not per-session work).
  let sweepSessionCount = 0
  const maybeRunSweep = (session: Session, startupPass: boolean): void => {
    const cfg = resolved()
    if (!cfg.sweepEnabled) return
    if (!startupPass && sweepSessionCount % cfg.sweepEveryNSessions !== 0) return
    const memory = ctx.get('memory') as unknown as SweepStoreFace | undefined
    if (memory === undefined) return
    const now = Date.now()
    if (!startupPass && !sweepCooldownOpen(memory, now)) return
    void (async () => {
      await stampSweepLastRun(memory, now)
      await runSweepPass(ctx, session, cfg.sweepTopN, cfg.extractionModel)
    })().catch((error: unknown) => {
      // Best-effort: sweep failures never surface into session creation.
      ctx.get('memory')?.reportFailure('sweep', error)
    })
  }
  ctx.on('session/created', (session: Session) => {
    // Startup pass: the first session creation after plugin apply runs the
    // sweep once (when enabled and the cooldown allows), then every N.
    sweepSessionCount++
    maybeRunSweep(session, sweepSessionCount === 1)
  }, { global: true })
}

/** Read the projection snapshot and run one review extraction if the threshold is met.
 *
 * Failure semantics: `runReviewExtraction` throws when an extraction call
 * fails. The high-water mark is advanced ONLY after a successful drain, so a
 * failed batch stays "unprocessed" and is retried on the next threshold
 * crossing — re-storing already-saved entries is idempotent thanks to the
 * dedup prefilter + LLM judge. The `agent/pre-step` listener wraps this call
 * in try/catch, so the failure never blocks the step (§3.6 best-effort).
 */
async function maybeRunReview(
  ctx: Context,
  agent: Agent,
  readAccumulator: () => ProjectionHandle<AccumulatorState> | undefined,
  threshold: number,
  highWaterMarks: WeakMap<Session, number>,
  modelOverride: ExtractionModelOverride | undefined,
  checkBudget: (session: Session) => boolean,
  judgeEnabled: boolean,
  confirmMode: boolean,
  consolidation: 'two-tier' | 'legacy-judge',
): Promise<void> {
  const handle = readAccumulator()
  if (handle === undefined) return
  const session = agent.session
  // Host-state read: the accumulator is a host-only unit (no wire view), so
  // the state comes from the registration handle, not the client-facing view.
  const state = handle.stateOf(session)
  if (state === undefined || state === null) return
  const mark = highWaterMarks.get(session) ?? -1
  const unprocessed = state.candidates.filter(candidate => candidate.seq > mark)
  if (unprocessed.length < threshold) return
  if (!checkBudget(session)) return
  await runReviewExtraction(ctx, agent, unprocessed, modelOverride, judgeEnabled, confirmMode, consolidation)
  const nextMark = unprocessed.reduce((max, candidate) => Math.max(max, candidate.seq), mark)
  highWaterMarks.set(session, nextMark)
}
