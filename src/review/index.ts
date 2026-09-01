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
 * All knobs are live configuration: the composition entry is the settings
 * `base` layer under the `memory-review` namespace, and handlers re-read the
 * resolved value per event — a frontend settings change applies on the next
 * event, no restart.
 *
 * @module @chenhw7/dsh-memory/review
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: merges the `settings` service (SettingsProvider) into the Context
// so `sctx.settings` types in this module.
import type {} from '@deepseek-ai/dsh-settings'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
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
import type { MemoryEntry } from '../types.ts'

/** Cordis function-plugin name. */
export const name = 'memory-review'

/** Services required before the plugin applies. The LLM seam is mandatory;
 *  `sessionProjections` and `memory` are optional (read via `ctx.get`). */
export const inject = ['llm']

/** The settings namespace owned by this plugin (live, UI-visible). */
const NS = 'memory-review'

/** The `memory` settings namespace — read cross-namespace (owned by memory-context). */
const MEMORY_NS = 'memory'

/** Default for decayDays when the namespace value is absent. */
const DEFAULT_DECAY_DAYS = 30

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
}

export const Config: z<Config> = z.object({
  reviewEnabled: z.boolean().default(true),
  reviewCandidateThreshold: z.number().step(1).min(1).default(10),
  flushOnCompaction: z.boolean().default(true),
  flushOnDispose: z.boolean().default(true),
  extractionModelProvider: z.string().default(''),
  extractionModelModel: z.string().default(''),
  extractionBudget: z.number().step(1).min(0).default(20),
  judgeEnabled: z.boolean().default(true),
  pitfallStreakThreshold: z.number().step(1).min(1).default(2),
  curatorEnabled: z.boolean().default(true),
  curatorEveryNSessions: z.number().step(1).min(1).default(20),
  curatorMaxEntries: z.number().step(1).min(1).default(5),
  curatorMinChars: z.number().step(1).min(1).default(400),
  confirmBeforeWrite: z.boolean().default(false),
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
}

/** Best-effort timeout for the dispose flush, in milliseconds. */
const DISPOSE_FLUSH_TIMEOUT_MS = 5_000

/** Resolve the raw config into the runtime form (re-run per resolved read). */
function resolveConfig(config: Config): ResolvedConfig {
  const hasOverride = (config.extractionModelProvider ?? '').length > 0 || (config.extractionModelModel ?? '').length > 0
  return {
    reviewEnabled: config.reviewEnabled ?? true,
    reviewCandidateThreshold: config.reviewCandidateThreshold ?? 10,
    flushOnCompaction: config.flushOnCompaction ?? true,
    flushOnDispose: config.flushOnDispose ?? true,
    extractionModel: hasOverride ? {
      ...(config.extractionModelProvider ?? '').length > 0 ? { provider: config.extractionModelProvider } : {},
      ...(config.extractionModelModel ?? '').length > 0 ? { model: config.extractionModelModel } : {},
    } : undefined,
    extractionBudget: config.extractionBudget ?? 20,
    judgeEnabled: config.judgeEnabled ?? true,
    pitfallStreakThreshold: config.pitfallStreakThreshold ?? 2,
    curatorEnabled: config.curatorEnabled ?? true,
    curatorEveryNSessions: config.curatorEveryNSessions ?? 20,
    curatorMaxEntries: config.curatorMaxEntries ?? 5,
    curatorMinChars: config.curatorMinChars ?? 400,
    confirmBeforeWrite: config.confirmBeforeWrite ?? false,
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

/** Collect text fragments for the shadowed seqs of a compaction summary. */
function collectShadowedFragments(session: Session, seqs: readonly number[]): string[] {
  const fragments: string[] = []
  const events = session.events
  for (const seq of seqs) {
    const event = events[seq]
    if (event === undefined) continue
    const text = messageText(event)
    if (text !== undefined) fragments.push(text)
  }
  return fragments
}

/** Locate the `compaction/summary` matching one `compaction/end` id. */
function findCompactionSummary(session: Session, compactionId: SessionEvent<'compaction/end'>['data']['compactionId']): SessionEvent<'compaction/summary'> | undefined {
  for (const event of session.events) {
    if (event.type === 'compaction/summary' && event.data.compactionId === compactionId) {
      return event as SessionEvent<'compaction/summary'>
    }
  }
  return undefined
}

/** Fire-and-forget flush on `compaction/end`: extract the shadowed fragments. */
async function flushOnCompaction(ctx: Context, session: Session, compactionId: SessionEvent<'compaction/end'>['data']['compactionId'], modelOverride: ExtractionModelOverride | undefined, judgeEnabled: boolean, confirmMode: boolean): Promise<void> {
  const summary = findCompactionSummary(session, compactionId)
  if (summary === undefined) return
  const fragments = collectShadowedFragments(session, summary.data.shadowedSeqs)
  await runFlushExtraction(ctx, session, fragments, undefined, modelOverride, judgeEnabled, confirmMode)
}

/** Fire-and-forget flush on `session/disposed`: extract recent derived messages. */
async function flushOnDispose(ctx: Context, session: Session, modelOverride: ExtractionModelOverride | undefined, judgeEnabled: boolean, confirmMode: boolean): Promise<void> {
  const messages = session.deriveMessages()
  const fragments: string[] = []
  for (const message of messages) {
    const fragment = messageFragment(message)
    if (fragment !== undefined) fragments.push(fragment)
  }
  const signal = AbortSignal.timeout(DISPOSE_FLUSH_TIMEOUT_MS)
  await runFlushExtraction(ctx, session, fragments, signal, modelOverride, judgeEnabled, confirmMode)
}

/**
 * Install the memory-review function plugin.
 * @param ctx - Cordis context carrying the LLM seam.
 * @param config - plugin configuration (defaults applied by schemastery).
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Live-resolved config: the settings scope while one is attached, the
  // composition entry otherwise (swapped by installSection on attach/detach).
  let resolved = (): ResolvedConfig => resolveConfig(config)
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => { resolved = () => resolveConfig(source()) },
      onChange: () => {},
    })
  })

  // `decayDays` lives in the `memory` namespace (owned by memory-context).
  // Read it cross-namespace via a settings-injected fiber; fall back to the
  // default when no settings service is mounted.
  let readDecayDays = (): number => DEFAULT_DECAY_DAYS
  ctx.inject(['settings'], (sctx) => {
    readDecayDays = (): number => {
      try {
        const ns = sctx.settings.get(MEMORY_NS) as { decayDays?: number } | undefined
        if (typeof ns?.decayDays === 'number') return ns.decayDays
      } catch { /* namespace not registered yet — fall through */ }
      return DEFAULT_DECAY_DAYS
    }
  })

  /** Per-session high-water mark: the seq of the last candidate covered by an extraction. */
  const highWaterMarks = new WeakMap<Session, number>()
  /** Per-session extraction call count (§3.6 cost guardrail). */
  const extractionCalls = new WeakMap<Session, number>()

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
  // state is read back through `stateOf`, so no `wire` view is declared.
  ctx.inject(['sessionProjections'], (pctx) => {
    pctx.sessionProjections.register<typeof MEMORY_REVIEW_PROJECTION_KEY, AccumulatorState>({
      key: MEMORY_REVIEW_PROJECTION_KEY,
      stateSchema: accumulatorSchema,
      init: () => emptyAccumulator,
      apply: (state, event) => applyAccumulator(state, event, resolved().pitfallStreakThreshold),
      stateVersion: 2,
    })
  })

  // Periodic review: drain the accumulator on agent/pre-step. Always
  // registered — the enabled flag and knobs are read per event, so a settings
  // change takes effect on the very next step without a restart.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const cfg = resolved()
    if (!signal.aborted && cfg.reviewEnabled) {
      try {
        await maybeRunReview(ctx, agent, cfg.reviewCandidateThreshold, highWaterMarks, cfg.extractionModel, checkBudget, cfg.judgeEnabled, cfg.confirmBeforeWrite)
      } catch (reviewError) {
        // Best-effort: a review failure must never block the step.
        ctx.get('memory')?.reportFailure('review-drain', reviewError)
      }
    }
    return next()
  })

  // Flush on compaction/end (fire-and-forget; never blocks compaction).
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/end') return
    if (event.data.error !== undefined) return
    const cfg = resolved()
    if (!cfg.flushOnCompaction) return
    if (!checkBudget(session)) return
    void flushOnCompaction(ctx, session, event.data.compactionId, cfg.extractionModel, cfg.judgeEnabled, cfg.confirmBeforeWrite).catch((error: unknown) => {
      // Best-effort: never blocks compaction, but stays observable.
      ctx.get('memory')?.reportFailure('flush-compaction', error)
    })
  })

  // Flush on session/disposed (fire-and-forget; never blocks dispose).
  ctx.on('session/disposed', (session) => {
    const cfg = resolved()
    if (!cfg.flushOnDispose) return
    if (!checkBudget(session)) return
    void flushOnDispose(ctx, session, cfg.extractionModel, cfg.judgeEnabled, cfg.confirmBeforeWrite).catch((error: unknown) => {
      // Best-effort: dispose must not block on memory extraction, but stays observable.
      ctx.get('memory')?.reportFailure('flush-dispose', error)
    })
  })

  // Janitor: decay stale project-scoped entries on session/created (§3.5).
  // `decayDays` lives in the `memory` namespace (owned by memory-context) and is
  // read live per event; `0` disables. Falls back to the default when no
  // settings service is mounted.
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
  let sessionCount = 0
  ctx.on('session/created', (session: Session) => {
    sessionCount++
    const cfg = resolved()
    if (!cfg.curatorEnabled) return
    if (sessionCount % cfg.curatorEveryNSessions !== 0) return
    const memory = ctx.get('memory')
    if (memory === undefined) return
    const selected: MemoryEntry[] = memory.list()
      .filter(entry => entry.content.length >= cfg.curatorMinChars)
      .sort((a, b) => b.content.length - a.content.length || a.createdAt - b.createdAt)
      .slice(0, cfg.curatorMaxEntries)
    if (selected.length < 2) return
    if (!checkBudget(session)) return
    void runCuration(ctx, session, selected, cfg.extractionModel, cfg.confirmBeforeWrite).catch((error: unknown) => {
      // Best-effort: curation failures never surface into session creation, but stay observable.
      ctx.get('memory')?.reportFailure('curator', error)
    })
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
  threshold: number,
  highWaterMarks: WeakMap<Session, number>,
  modelOverride: ExtractionModelOverride | undefined,
  checkBudget: (session: Session) => boolean,
  judgeEnabled: boolean,
  confirmMode: boolean,
): Promise<void> {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) return
  const session = agent.session
  // Host-state read: the accumulator is a host-only unit (no wire view), so
  // the state comes from `stateOf`, not the client-facing `snapshot`.
  const state = projections.stateOf(session, MEMORY_REVIEW_PROJECTION_KEY)
  if (state === undefined) return
  const mark = highWaterMarks.get(session) ?? -1
  const unprocessed = state.candidates.filter(candidate => candidate.seq > mark)
  if (unprocessed.length < threshold) return
  if (!checkBudget(session)) return
  await runReviewExtraction(ctx, agent, unprocessed, modelOverride, judgeEnabled, confirmMode)
  const nextMark = unprocessed.reduce((max, candidate) => Math.max(max, candidate.seq), mark)
  highWaterMarks.set(session, nextMark)
}
