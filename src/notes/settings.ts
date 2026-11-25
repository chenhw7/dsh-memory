/**
 * The `memory-notes` entry settings: its `Config` schema, the defaults, and
 * the resolved view the notes service publishes. Both consumers pull from
 * here so defaults cannot drift: the entry schema (the Project Notes card's
 * form) and the section assembly that `memory-context` drives from
 * `ctx.projectNotes.settings()`.
 *
 * Since 0.6 the notes surface is prompt-only (no repo files), so there is no
 * directory or AGENTS.md knob anymore — `notesEnabled` gates the injected
 * `project-notes` section and the budget keys cap its render.
 *
 * The budgets are per-kind (`notesConventionsCharLimit` /
 * `notesPitfallsCharLimit`) so the pitfall log can no longer be starved by the
 * conventions half. Their schema fields carry NO default on purpose: absence
 * is the signal the deprecated-key fallback below reads, so the builtin
 * defaults live here — the one home. The deprecated combined
 * `notesCharLimit` (released in v0.9.1) still derives both budgets at 60/40
 * when it is the only key set; schemastery's non-strict object merge passes
 * the unknown key through, so stored documents still read.
 *
 * @module @chenhw7/dsh-memory/notes/settings
 */

import z from '@deepseek-ai/schemastery'

/** Whether the project-notes prompt section is injected. */
export const DEFAULT_NOTES_ENABLED = true
/** Character budget for the rendered conventions half of the notes section. */
export const DEFAULT_NOTES_CONVENTIONS_CHAR_LIMIT = 1600
/** Character budget for the rendered pitfalls half of the notes section. */
export const DEFAULT_NOTES_PITFALLS_CHAR_LIMIT = 800
/** Max entries selected into the project-notes section (the rest fold into count lines). */
export const DEFAULT_NOTES_MAX_ENTRIES_PER_FILE = 100
/** The deprecated combined budget's conventions share; pitfalls gets the rest. */
const DEPRECATED_CONVENTIONS_SHARE = 0.6

/** The `memory-notes` settings namespace, fully resolved. */
export interface NotesSettings {
  readonly notesEnabled: boolean
  readonly notesConventionsCharLimit: number
  readonly notesPitfallsCharLimit: number
  readonly notesMaxEntriesPerFile: number
}

/**
 * Resolve one budget: the new key wins when set; otherwise a present
 * deprecated `notesCharLimit` derives both from its 60/40 split; otherwise
 * the builtin default.
 */
function resolveBudget(
  value: Record<string, unknown>,
  key: 'notesConventionsCharLimit' | 'notesPitfallsCharLimit',
  share: number,
  fallback: number,
): number {
  const own = value[key]
  if (typeof own === 'number' && own >= 0) return Math.trunc(own)
  if (typeof value.notesCharLimit === 'number' && value.notesCharLimit >= 0) {
    return Math.trunc(value.notesCharLimit * share)
  }
  return fallback
}

/**
 * Schema fields for the `memory-notes` entry (the Project Notes card's form).
 * The two budget fields deliberately carry no default: absence is the signal
 * {@link resolveNotesSettings}'s deprecated-key fallback reads.
 */
export const NOTES_FIELDS = {
  notesEnabled: z.boolean().default(DEFAULT_NOTES_ENABLED),
  notesConventionsCharLimit: z.number().step(1).min(0),
  notesPitfallsCharLimit: z.number().step(1).min(0),
  notesMaxEntriesPerFile: z.number().step(1).min(0).default(DEFAULT_NOTES_MAX_ENTRIES_PER_FILE),
}

/** The builtin values, used when no notes entry is composed. */
export const DEFAULT_NOTES_SETTINGS: NotesSettings = {
  notesEnabled: DEFAULT_NOTES_ENABLED,
  notesConventionsCharLimit: DEFAULT_NOTES_CONVENTIONS_CHAR_LIMIT,
  notesPitfallsCharLimit: DEFAULT_NOTES_PITFALLS_CHAR_LIMIT,
  notesMaxEntriesPerFile: DEFAULT_NOTES_MAX_ENTRIES_PER_FILE,
}

/** A notes entry value: the resolved shape plus the deprecated combined budget. */
export type NotesConfigValue = Partial<NotesSettings> & {
  /** Deprecated combined budget (v0.9.1); derives both halves at 60/40 when it is the only key set. */
  notesCharLimit?: number
}

/**
 * Resolve the notes settings from an entry value (defaults for anything
 * absent or mistyped). Unknown keys are ignored — except the deprecated
 * pre-0.6 `notesDir` / `notesAgentsPointer` (still ignored) and the
 * deprecated `notesCharLimit`, which derives the two budgets until the
 * document is migrated to the new keys.
 * @param value - the `memory-notes` entry value, possibly partial.
 * @returns the fully-resolved notes settings.
 */
export function resolveNotesSettings(value: NotesConfigValue | undefined): NotesSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    notesEnabled: typeof v.notesEnabled === 'boolean' ? v.notesEnabled : DEFAULT_NOTES_ENABLED,
    notesConventionsCharLimit: resolveBudget(v, 'notesConventionsCharLimit', DEPRECATED_CONVENTIONS_SHARE, DEFAULT_NOTES_CONVENTIONS_CHAR_LIMIT),
    notesPitfallsCharLimit: resolveBudget(v, 'notesPitfallsCharLimit', 1 - DEPRECATED_CONVENTIONS_SHARE, DEFAULT_NOTES_PITFALLS_CHAR_LIMIT),
    notesMaxEntriesPerFile: typeof v.notesMaxEntriesPerFile === 'number' && v.notesMaxEntriesPerFile >= 0 ? Math.trunc(v.notesMaxEntriesPerFile) : DEFAULT_NOTES_MAX_ENTRIES_PER_FILE,
  }
}
