/**
 * Defaults and the read-side view for the notes keys of the `memory` settings
 * namespace. Both consumers pull from here so defaults cannot drift:
 * `memory-context`'s Config schema (schema `.default()` values → settings UI
 * ownership) and the `memory-notes` plugin (defensive reads of the raw
 * namespace value via `ctx.settings.get`).
 *
 * @module @chenhw7/dsh-memory/notes/settings
 */

import path from 'node:path'

/** Whether notes export + injection are enabled. */
export const DEFAULT_NOTES_ENABLED = true
/** Repo-relative directory holding the generated notes files. */
export const DEFAULT_NOTES_DIR = 'docs/agent-memory'
/** Total character budget for the injected notes section. */
export const DEFAULT_NOTES_CHAR_LIMIT = 4000
/** Whether the AGENTS.md pointer block is maintained. */
export const DEFAULT_NOTES_AGENTS_POINTER = true
/** Max entries per generated file (oldest by updatedAt are truncated). */
export const DEFAULT_NOTES_MAX_ENTRIES_PER_FILE = 100

/** The notes slice of the `memory` settings namespace, fully resolved. */
export interface NotesSettings {
  readonly notesEnabled: boolean
  readonly notesDir: string
  readonly notesCharLimit: number
  readonly notesAgentsPointer: boolean
  readonly notesMaxEntriesPerFile: number
}

/**
 * Resolve the notes settings from an untyped namespace value (defaults for
 * anything absent or mistyped).
 * @param value - the raw `memory` namespace value (`ctx.settings.get` returns `unknown`).
 * @returns the fully-resolved notes settings.
 */
export function resolveNotesSettings(value: unknown): NotesSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    notesEnabled: typeof v.notesEnabled === 'boolean' ? v.notesEnabled : DEFAULT_NOTES_ENABLED,
    notesDir: typeof v.notesDir === 'string' && v.notesDir.trim().length > 0 ? v.notesDir.trim() : DEFAULT_NOTES_DIR,
    notesCharLimit: typeof v.notesCharLimit === 'number' && v.notesCharLimit >= 0 ? Math.trunc(v.notesCharLimit) : DEFAULT_NOTES_CHAR_LIMIT,
    notesAgentsPointer: typeof v.notesAgentsPointer === 'boolean' ? v.notesAgentsPointer : DEFAULT_NOTES_AGENTS_POINTER,
    notesMaxEntriesPerFile: typeof v.notesMaxEntriesPerFile === 'number' && v.notesMaxEntriesPerFile >= 0 ? Math.trunc(v.notesMaxEntriesPerFile) : DEFAULT_NOTES_MAX_ENTRIES_PER_FILE,
  }
}

/**
 * Resolve `notesDir` against the project root, requiring containment: absolute
 * values and `../`-style escapes resolve outside the root and are rejected, so
 * a mistyped or hostile settings value cannot direct notes writes out of the
 * project. Lexical check only — symlinks are not resolved.
 * @param cwd - the project root (session working directory).
 * @param notesDir - the settings value (repo-relative by convention).
 * @returns the absolute contained directory, or undefined when rejected.
 */
export function resolveNotesDir(cwd: string, notesDir: string): string | undefined {
  const root = path.resolve(cwd)
  const dir = path.resolve(root, notesDir)
  if (dir !== root && !dir.startsWith(root + path.sep)) return undefined
  return dir
}
