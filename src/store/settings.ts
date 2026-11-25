/**
 * The `memory` entry's prompt-injection and recall knobs: the settings slice
 * every other memory plugin reads back through the `ctx.memory` service.
 *
 * These fields live on the store entry because the store is the one memory
 * service every other plugin already resolves (`ctx.memory`), and because the
 * `memory` settings namespace is the store entry's `Config` under the host's
 * per-entry configuration model: a plugin reads its own entry config and
 * publishes what its siblings need, instead of every plugin reading a shared
 * namespace. The tool cap, the janitor's decay window, and the system-prompt
 * budgets are all here for that reason.
 *
 * @module @chenhw7/dsh-memory/store/settings
 */

import z from '@deepseek-ai/schemastery'
import { liveValue, type LiveConfig } from '../live-config.ts'
import type { MemoryMode } from '../context/policy.ts'

// Factory default is `digest`: the system prompt carries only the frozen
// policy guidance, while a one-time <memory-digest> inventory (category
// counts + anchor topics) rides the first step's tail and per-step recall
// fences answer "what does it actually say". The data never resides in the
// prefix, so a re-freeze or store change never disturbs the cached prefix.
// `index`/`full` remain explicit opt-ins for prefix-resident data;
// `policy-only`/`off` trim further.
export const DEFAULT_MEMORY_MODE: MemoryMode = 'digest'
export const DEFAULT_MEMORY_CHAR_LIMIT = 5000
/** Character budget for the one-time digest inventory (≈250 tokens); `0` = off. */
export const DEFAULT_MEMORY_DIGEST_CHAR_LIMIT = 800
export const DEFAULT_MAX_SEARCH_RESULTS = 50
export const DEFAULT_DECAY_DAYS = 30
/**
 * Default maximum number of memory entries injected into the system-prompt
 * snapshot, regardless of the character budget (P0-6). Prevents a large store
 * from flooding the prompt even when the character budget allows it.
 * `0` = no entry-count limit (character budget only).
 */
export const DEFAULT_MEMORY_MAX_ENTRIES = 20

/**
 * How recalled memory reaches the model, plus the budgets and store knobs that
 * shape it. Every field is optional in `cordis.yml`; the schema defaults
 * supply the rest.
 */
export interface MemoryInjectionSettings {
  /** How recalled memory reaches the system prompt; defaults to `digest`. */
  memoryMode: MemoryMode
  /** User-supplied custom policy text, used only when `memoryMode` is `custom`. */
  memoryPolicyCustomText?: string
  /** Character budget for the frozen memory content snapshot; defaults to `5000`. */
  memoryCharLimit: number
  /**
   * Character budget for the one-time `<memory-digest>` inventory message in
   * `digest` mode (≈250 tokens at the 4-chars/token estimate; CJK topics run
   * higher). `0` disables the digest message while keeping the mode's section
   * guidance. Defaults to `800`.
   */
  memoryDigestCharLimit: number
  /**
   * Maximum number of entries injected into the memory snapshot regardless of
   * the character budget (P0-6). Entries beyond this count are rolled up into
   * a count-only summary line. `0` = no entry-count limit. Defaults to `20`.
   */
  memoryMaxEntries: number
  /** Max entries returned by `memory_search` / `memory_list` when the call omits `limit`; defaults to `50`. `0` = no limit. */
  maxSearchResults: number
  /** Days without recall before a project-scoped entry is decayed by the janitor. `0` = disabled. Defaults to `30`. */
  decayDays: number
}

/**
 * Schema fragment for {@link MemoryInjectionSettings}: the single home of the
 * field defaults, shared by the store entry's `Config` and the runtime
 * resolver so the composition layer and the service cannot drift.
 */
export const INJECTION_FIELDS = {
  memoryMode: z.union(['full', 'policy-only', 'custom', 'off', 'index', 'digest'] as const).default(DEFAULT_MEMORY_MODE).volatile(),
  memoryPolicyCustomText: z.string().volatile(),
  memoryCharLimit: z.number().step(1).min(0).default(DEFAULT_MEMORY_CHAR_LIMIT).volatile(),
  memoryDigestCharLimit: z.number().step(1).min(0).default(DEFAULT_MEMORY_DIGEST_CHAR_LIMIT).volatile(),
  memoryMaxEntries: z.number().step(1).min(0).default(DEFAULT_MEMORY_MAX_ENTRIES).volatile(),
  maxSearchResults: z.number().step(1).min(0).default(DEFAULT_MAX_SEARCH_RESULTS).volatile(),
  decayDays: z.number().step(1).min(0).default(DEFAULT_DECAY_DAYS).volatile(),
}

/** The builtin values, used when no store service is composed. */
export const DEFAULT_INJECTION_SETTINGS: MemoryInjectionSettings = {
  memoryMode: DEFAULT_MEMORY_MODE,
  memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
  memoryDigestCharLimit: DEFAULT_MEMORY_DIGEST_CHAR_LIMIT,
  memoryMaxEntries: DEFAULT_MEMORY_MAX_ENTRIES,
  maxSearchResults: DEFAULT_MAX_SEARCH_RESULTS,
  decayDays: DEFAULT_DECAY_DAYS,
}

/**
 * Materialize every default of the injection slice. The entry `Config` schema
 * already applies them at load; this resolver keeps a partial value (a unit
 * test, a direct `apply` call) on the same footing.
 * @param config - the entry config, possibly partial.
 * @returns the injection settings with every default materialized.
 */
export function resolveInjectionSettings(config: Partial<LiveConfig<MemoryInjectionSettings>> | undefined): MemoryInjectionSettings {
  const customPolicy = liveValue(config?.memoryPolicyCustomText)
  return {
    memoryMode: liveValue(config?.memoryMode) ?? DEFAULT_MEMORY_MODE,
    ...customPolicy === undefined ? {} : { memoryPolicyCustomText: customPolicy },
    memoryCharLimit: liveValue(config?.memoryCharLimit) ?? DEFAULT_MEMORY_CHAR_LIMIT,
    memoryDigestCharLimit: liveValue(config?.memoryDigestCharLimit) ?? DEFAULT_MEMORY_DIGEST_CHAR_LIMIT,
    memoryMaxEntries: liveValue(config?.memoryMaxEntries) ?? DEFAULT_MEMORY_MAX_ENTRIES,
    maxSearchResults: liveValue(config?.maxSearchResults) ?? DEFAULT_MAX_SEARCH_RESULTS,
    decayDays: liveValue(config?.decayDays) ?? DEFAULT_DECAY_DAYS,
  }
}
