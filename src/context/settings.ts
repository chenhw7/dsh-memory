/**
 * The `memory-autorecall` entry's settings: the per-step recall fence and the
 * usage-hit signal.
 *
 * The context plugin owns this slice because it owns the fence: the entry
 * config is its own `Config`, and the host's settings page writes it directly.
 * Everything else the context plugin needs (injection budgets, notes budgets,
 * identity budgets) it reads from the services that own those entries.
 *
 * @module @chenhw7/dsh-memory/context/settings
 */

import z from '@deepseek-ai/schemastery'

/**
 * Append a fenced auto-recall block to each step's messages (BM25 over the
 * store). Defaults to `true` — the digest-mode complement: the digest says
 * WHAT is stored (once per session), the fence recalls WHAT it says (per
 * step, at the step tail). Fence hits stamp `lastRecalledAt` only, never
 * `accessCount`.
 */
export const DEFAULT_AUTO_RECALL_ENABLED = true
/** Max entries in one auto-recall fence. */
export const DEFAULT_AUTO_RECALL_LIMIT = 5
/** Skip recall when the step's user text is shorter than this many characters. */
export const DEFAULT_AUTO_RECALL_MIN_CHARS = 12
/**
 * Usage-hit signal default: off. When on, an answer echoing an injected
 * entry's tokens/anchors (IDF-weighted overlap above the threshold) books one
 * `hitCount` on that entry; the periodic sweep is the only consumer.
 */
export const DEFAULT_HIT_SIGNAL_ENABLED = false
/**
 * Weighted token-overlap between an injected entry and the assistant's answer
 * above which the answer counts as a hit: the IDF-weighted share of the
 * entry's tokens the answer restates. `0.25` is the mid-band of the measured
 * calibration (genuine restatement 0.5–0.7, incidental mention 0.05–0.12,
 * unrelated ~0).
 */
export const DEFAULT_HIT_SIGNAL_THRESHOLD = 0.25

/** The `memory-autorecall` entry settings. */
export interface AutoRecallSettings {
  autoRecallEnabled: boolean
  /** Max entries in one auto-recall fence. */
  autoRecallLimit: number
  /** Skip recall when the step's user text is shorter than this many characters. */
  autoRecallMinChars: number
  /** Enable the usage-hit signal (write-path rework Step 2). */
  hitSignalEnabled: boolean
  /** Weighted token-overlap above which an answer counts as a hit. */
  hitSignalThreshold: number
}

/** Schema fields for the `memory-autorecall` entry (the Auto Recall page's form). */
export const AUTORECALL_FIELDS = {
  autoRecallEnabled: z.boolean().default(DEFAULT_AUTO_RECALL_ENABLED),
  autoRecallLimit: z.number().step(1).min(1).default(DEFAULT_AUTO_RECALL_LIMIT),
  autoRecallMinChars: z.number().step(1).min(1).default(DEFAULT_AUTO_RECALL_MIN_CHARS),
  hitSignalEnabled: z.boolean().default(DEFAULT_HIT_SIGNAL_ENABLED),
  hitSignalThreshold: z.number().min(0).max(1).default(DEFAULT_HIT_SIGNAL_THRESHOLD),
}

/** The builtin values, used when the entry config is absent. */
export const DEFAULT_AUTO_RECALL_SETTINGS: AutoRecallSettings = {
  autoRecallEnabled: DEFAULT_AUTO_RECALL_ENABLED,
  autoRecallLimit: DEFAULT_AUTO_RECALL_LIMIT,
  autoRecallMinChars: DEFAULT_AUTO_RECALL_MIN_CHARS,
  hitSignalEnabled: DEFAULT_HIT_SIGNAL_ENABLED,
  hitSignalThreshold: DEFAULT_HIT_SIGNAL_THRESHOLD,
}

/**
 * Materialize every default of the auto-recall slice.
 * @param config - the entry config, possibly partial.
 * @returns the settings with every default materialized.
 */
export function resolveAutoRecallSettings(config: Partial<AutoRecallSettings> | undefined): AutoRecallSettings {
  return {
    autoRecallEnabled: config?.autoRecallEnabled ?? DEFAULT_AUTO_RECALL_ENABLED,
    autoRecallLimit: config?.autoRecallLimit ?? DEFAULT_AUTO_RECALL_LIMIT,
    autoRecallMinChars: config?.autoRecallMinChars ?? DEFAULT_AUTO_RECALL_MIN_CHARS,
    hitSignalEnabled: config?.hitSignalEnabled ?? DEFAULT_HIT_SIGNAL_ENABLED,
    hitSignalThreshold: config?.hitSignalThreshold ?? DEFAULT_HIT_SIGNAL_THRESHOLD,
  }
}
