/**
 * The scope×category render matrix for project notes (§4 of
 * docs/PROJECT_NOTES.md): which store entries land in the notes files.
 * Pure functions, zero host imports — shared by the notes renderer and by
 * `memory-context` (which excludes the same set from its own snapshot/index
 * injection so content never appears twice in the prompt).
 *
 * @module @chenhw7/dsh-memory/notes/scope
 */

import type { MemoryCategory, MemoryEntry } from '../types.ts'

/** Categories rendered into CONVENTIONS.md. */
export const NOTES_CONVENTION_CATEGORIES: readonly MemoryCategory[] = ['convention', 'preference']

/** Categories rendered into PITFALLS.md (project- and global-scoped only). */
export const NOTES_PITFALL_CATEGORIES: readonly MemoryCategory[] = ['failure', 'procedure', 'tool-quirk']

/** The minimal entry shape the matrix needs. */
export type RenderableEntry = Pick<MemoryEntry, 'scope' | 'category' | 'projectName'>

/** Which notes file an entry renders into, when any. */
export type NotesKind = 'conventions' | 'pitfalls'

/**
 * Decide whether an entry is rendered into the notes files, and into which
 * one. Rules (docs/PROJECT_NOTES.md §4):
 * - `project`-scoped entries must match the current project name; an unknown
 *   project (no cwd) excludes them.
 * - Conventions come from all three scopes (project > global > personal is
 *   the render order, doubling as the precedence hint).
 * - Pitfalls come from `project` and `global` scopes only.
 * - Entries without a category, or with categories outside the matrix
 *   (`insight`, `correction`, …), are never rendered.
 *
 * @param entry - the entry to classify.
 * @param projectName - the current project name (cwd basename), or undefined.
 * @returns the target notes file kind, or `undefined` when not rendered.
 */
export function isRenderedEntry(entry: RenderableEntry, projectName: string | undefined): NotesKind | undefined {
  const category = entry.category
  if (category === undefined) return undefined
  const inProject = entry.scope === 'project'
  if (inProject && (projectName === undefined || entry.projectName !== projectName)) return undefined
  if ((entry.scope === 'user' || entry.scope === 'global' || inProject) && NOTES_CONVENTION_CATEGORIES.includes(category)) {
    return 'conventions'
  }
  if ((entry.scope === 'global' || inProject) && NOTES_PITFALL_CATEGORIES.includes(category)) {
    return 'pitfalls'
  }
  return undefined
}
