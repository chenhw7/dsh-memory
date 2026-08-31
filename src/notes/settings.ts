/**
 * Defaults and the read-side view for the notes keys of the `memory` settings
 * namespace. Both consumers pull from here so defaults cannot drift:
 * `memory-context`'s Config schema (schema `.default()` values → settings UI
 * ownership) and the `memory-notes` plugin (defensive reads of the raw
 * namespace value via `ctx.settings.get`).
 *
 * Since 0.6 the notes surface is prompt-only (no repo files), so there is no
 * directory or AGENTS.md knob anymore — `notesEnabled` gates the injected
 * `project-notes` section and the two budget keys cap its render.
 *
 * @module @chenhw7/dsh-memory/notes/settings
 */

/** Whether the project-notes prompt section is injected. */
export const DEFAULT_NOTES_ENABLED = true
/** Character budget for the injected project-notes section. */
export const DEFAULT_NOTES_CHAR_LIMIT = 4000
/** Max entries rendered into the project-notes section (oldest by updatedAt are truncated). */
export const DEFAULT_NOTES_MAX_ENTRIES_PER_FILE = 100

/** The notes slice of the `memory` settings namespace, fully resolved. */
export interface NotesSettings {
  readonly notesEnabled: boolean
  readonly notesCharLimit: number
  readonly notesMaxEntriesPerFile: number
}

/**
 * Resolve the notes settings from an untyped namespace value (defaults for
 * anything absent or mistyped). Unknown keys — including the pre-0.6
 * `notesDir` / `notesAgentsPointer` — are ignored.
 * @param value - the raw `memory` namespace value (`ctx.settings.get` returns `unknown`).
 * @returns the fully-resolved notes settings.
 */
export function resolveNotesSettings(value: unknown): NotesSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    notesEnabled: typeof v.notesEnabled === 'boolean' ? v.notesEnabled : DEFAULT_NOTES_ENABLED,
    notesCharLimit: typeof v.notesCharLimit === 'number' && v.notesCharLimit >= 0 ? Math.trunc(v.notesCharLimit) : DEFAULT_NOTES_CHAR_LIMIT,
    notesMaxEntriesPerFile: typeof v.notesMaxEntriesPerFile === 'number' && v.notesMaxEntriesPerFile >= 0 ? Math.trunc(v.notesMaxEntriesPerFile) : DEFAULT_NOTES_MAX_ENTRIES_PER_FILE,
  }
}
