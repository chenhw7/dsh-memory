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
 * @module @chenhw7/dsh-memory/review
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
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
import { runFlushExtraction, runReviewExtraction, type ExtractionModelOverride } from './extract.ts'

/** Cordis function-plugin name. */
export const name = 'memory-review'

/** Services required before the plugin applies. The LLM seam is mandatory;
 *  `sessionProjections` and `memory` are optional (read via `ctx.get`). */
export const inject = ['llm']

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
  /** Days without recall before a project-scoped entry is decayed by the janitor. 0 = disabled. Defaults to 30. */
  decayDays?: number
  /** Consecutive same-signature tool failures required before a success emits a pitfall candidate. Defaults to 2. */
  pitfallStreakThreshold?: number
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
  decayDays: z.number().step(1).min(0).default(30),
  pitfallStreakThreshold: z.number().step(1).min(1).default(2),
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
  readonly decayDays: number
  readonly pitfallStreakThreshold: number
}

/** Best-effort timeout for the dispose flush, in milliseconds. */
const DISPOSE_FLUSH_TIMEOUT_MS = 5_000

/** Resolve and validate the raw config into the runtime form. */
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
    decayDays: config.decayDays ?? 30,
    pitfallStreakThreshold: config.pitfallStreakThreshold ?? 2,
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
async function flushOnCompaction(ctx: Context, session: Session, compactionId: SessionEvent<'compaction/end'>['data']['compactionId'], modelOverride: ExtractionModelOverride | undefined, judgeEnabled: boolean): Promise<void> {
  const summary = findCompactionSummary(session, compactionId)
  if (summary === undefined) return
  const fragments = collectShadowedFragments(session, summary.data.shadowedSeqs)
  await runFlushExtraction(ctx, session, fragments, undefined, modelOverride, judgeEnabled)
}

/** Fire-and-forget flush on `session/disposed`: extract recent derived messages. */
async function flushOnDispose(ctx: Context, session: Session, modelOverride: ExtractionModelOverride | undefined, judgeEnabled: boolean): Promise<void> {
  const messages = session.deriveMessages()
  const fragments: string[] = []
  for (const message of messages) {
    const fragment = messageFragment(message)
    if (fragment !== undefined) fragments.push(fragment)
  }
  const signal = AbortSignal.timeout(DISPOSE_FLUSH_TIMEOUT_MS)
  await runFlushExtraction(ctx, session, fragments, signal, modelOverride, judgeEnabled)
}

/**
 * Install the memory-review function plugin.
 * @param ctx - Cordis context carrying the LLM seam.
 * @param config - plugin configuration (defaults applied by schemastery).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const modelOverride = resolved.extractionModel as ExtractionModelOverride | undefined
  /** Per-session high-water mark: the seq of the last candidate covered by an extraction. */
  const highWaterMarks = new WeakMap<Session, number>()
  /** Per-session extraction call count (§3.6 cost guardrail). */
  const extractionCalls = new WeakMap<Session, number>()

  /** Check and increment the per-session extraction budget. Returns false when exhausted. */
  function checkBudget(session: Session): boolean {
    if (resolved.extractionBudget <= 0) return true
    const used = extractionCalls.get(session) ?? 0
    if (used >= resolved.extractionBudget) return false
    extractionCalls.set(session, used + 1)
    return true
  }

  // Register the projection accumulator (optional: only when sessionProjections
  // is composed; headless assemblies stay unaffected).
  ctx.inject(['sessionProjections'], (pctx) => {
    pctx.sessionProjections.register<typeof MEMORY_REVIEW_PROJECTION_KEY, AccumulatorState>({
      key: MEMORY_REVIEW_PROJECTION_KEY,
      schema: accumulatorSchema,
      init: () => emptyAccumulator,
      apply: (state, event) => applyAccumulator(state, event, resolved.pitfallStreakThreshold),
      view: (state: AccumulatorState): AccumulatorView => state,
      stateVersion: 2,
    })
  })

  // Periodic review: drain the accumulator on agent/pre-step.
  if (resolved.reviewEnabled) {
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) {
        try {
          await maybeRunReview(ctx, agent, resolved.reviewCandidateThreshold, highWaterMarks, modelOverride, checkBudget, resolved.judgeEnabled)
        } catch (_reviewError) {
          // Best-effort: a review failure must never block the step.
        }
      }
      return next()
    })
  }

  // Flush on compaction/end (fire-and-forget; never blocks compaction).
  if (resolved.flushOnCompaction) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'compaction/end') return
      if (event.data.error !== undefined) return
      if (!checkBudget(session)) return
      void flushOnCompaction(ctx, session, event.data.compactionId, modelOverride, resolved.judgeEnabled).catch(() => {
        // Best-effort: a flush failure is logged by the runtime, not thrown here.
      })
    })
  }

  // Flush on session/disposed (fire-and-forget; never blocks dispose).
  if (resolved.flushOnDispose) {
    ctx.on('session/disposed', (session) => {
      if (!checkBudget(session)) return
      void flushOnDispose(ctx, session, modelOverride, resolved.judgeEnabled).catch(() => {
        // Best-effort: dispose must not block on memory extraction.
      })
    })
  }

  // Janitor: decay stale project-scoped entries on session/created (§3.5).
  // Runs once per new session; best-effort, never blocks session creation.
  if (resolved.decayDays > 0) {
    ctx.on('session/created', () => {
      const memory = ctx.get('memory')
      if (memory === undefined) return
      void memory.janitor(resolved.decayDays).catch(() => {
        // Best-effort: a janitor failure never blocks session creation.
      })
    }, { global: true })
  }
}

/** Read the projection snapshot and run one review extraction if the threshold is met. */
async function maybeRunReview(
  ctx: Context,
  agent: Agent,
  threshold: number,
  highWaterMarks: WeakMap<Session, number>,
  modelOverride: ExtractionModelOverride | undefined,
  checkBudget: (session: Session) => boolean,
  judgeEnabled: boolean,
): Promise<void> {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) return
  const session = agent.session
  const snapshot = projections.snapshot(session)
  const state = snapshot.values[MEMORY_REVIEW_PROJECTION_KEY] as AccumulatorState | undefined
  if (state === undefined) return
  const mark = highWaterMarks.get(session) ?? -1
  const unprocessed = state.candidates.filter(candidate => candidate.seq > mark)
  if (unprocessed.length < threshold) return
  if (!checkBudget(session)) return
  await runReviewExtraction(ctx, agent, unprocessed, modelOverride, judgeEnabled)
  const nextMark = unprocessed.reduce((max, candidate) => Math.max(max, candidate.seq), mark)
  highWaterMarks.set(session, nextMark)
}
