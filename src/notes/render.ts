/**
 * Markdown renderers for the project-notes prompt section: store entries
 * (pre-filtered through {@link isRenderedEntry}) become the conventions /
 * pitfalls texts injected into the system prompt. Pure functions — no I/O.
 *
 * Selection is entry-level and budgeted at render time (frozen with the
 * snapshot — a live budget change takes effect at the next freeze, and the
 * section assembly's fence cap is the final defense). Entries the budget or
 * the count cap squeeze out fold into a per-section count line pointing at
 * memory_search — never silently dropped.
 *
 * Section order doubles as the precedence hint (project > global > personal);
 * the injected system-prompt wrapper states it explicitly. Section headings
 * are English regardless of entry language — the notes surface is English.
 *
 * @module @chenhw7/dsh-memory/notes/render
 */

import type { MemoryEntry, MemoryScope } from '../types.ts'

/** The provenance line stamped under every rendered section title. */
export const AUTO_HEADER = 'Managed by dsh-memory (auto-generated from the memory store) — correct outdated entries via the memory tools or the Memory UI.'

/** Format an epoch-ms timestamp as `YYYY-MM-DD`. */
function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/** Render one entry as a dated bullet. */
function bullet(entry: MemoryEntry): string {
  return `- (${isoDate(entry.createdAt)}) ${entry.content}`
}

/**
 * Selection priority for notes rendering: pinned entries first, then the
 * model-assessed importance (absent reads as 0), then the freshest use
 * signal. Importance outranks recency so a key convention that rarely
 * matches queries is not the first to fold — query luck should not decide
 * which standing rules stay visible.
 */
function byNotesPriority(a: MemoryEntry, b: MemoryEntry): number {
  return (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0)
    || (b.importance ?? 0) - (a.importance ?? 0)
    || (b.lastRecalledAt ?? b.updatedAt) - (a.lastRecalledAt ?? a.updatedAt)
}

/** One rendered scope section of a notes document. */
interface NotesSectionSpec {
  readonly title: string
  readonly scope: MemoryScope
}

/** The per-section count line for squeezed entries — visible, never dropped. */
function foldedLine(folded: number, title: string): string {
  return `(another ${folded} ${title.toLowerCase()} — use memory_search)`
}

/** Whether any selected bullet already opened this scope's section. */
function selectedHasScope(bullets: Map<MemoryScope, string[]>, scope: MemoryScope): boolean {
  return (bullets.get(scope) ?? []).length > 0
}

/**
 * Render one notes document (`# <docTitle>` + AUTO_HEADER + the scope
 * sections) from priority-ordered entries under a character budget: entries
 * are added in priority order while they fit; the rest — including anything
 * the count cap dropped — fold into their section's count line.
 * @param docTitle - the document heading (`Conventions` / `Pitfalls`).
 * @param sections - the scope sections in render order (precedence hint).
 * @param entries - one kind's entries (already filtered by the matrix).
 * @param cap - max total entries (`notesMaxEntriesPerFile`); `0` = unlimited.
 * @param charLimit - character budget for the rendered text (`0` → empty).
 * @returns the document text; empty when the kind has no entries.
 */
function renderBudgeted(
  docTitle: string,
  sections: readonly NotesSectionSpec[],
  entries: readonly MemoryEntry[],
  cap: number,
  charLimit: number,
): string {
  if (charLimit <= 0 || entries.length === 0) return ''
  const docHeader = `# ${docTitle}\n\n${AUTO_HEADER}\n\n`
  const ordered = [...entries].sort(byNotesPriority)
  const capped = cap > 0 ? ordered.slice(0, cap) : ordered
  // Opening a section costs its real heading plus the '\n\n' part separator.
  const sectionCost = new Map<MemoryScope, number>()
  for (const spec of sections) sectionCost.set(spec.scope, `## ${spec.title}\n\n`.length + 2)

  const bullets = new Map<MemoryScope, string[]>()
  const selected = new Set<MemoryEntry>()
  let used = docHeader.length
  for (const entry of capped) {
    // Scope without a section in this document (the caller pre-filters via
    // the matrix; anything else here has no render home).
    if (!sectionCost.has(entry.scope)) continue
    let cost = bullet(entry).length + 1
    if (!selectedHasScope(bullets, entry.scope)) cost += sectionCost.get(entry.scope)!
    if (used + cost > charLimit) break
    const list = bullets.get(entry.scope) ?? []
    list.push(bullet(entry))
    bullets.set(entry.scope, list)
    selected.add(entry)
    used += cost
  }

  // Every capped/budgeted-out entry folds into its section's count line.
  const folded = new Map<MemoryScope, number>()
  for (const entry of ordered) {
    if (selected.has(entry)) continue
    if (!sectionCost.has(entry.scope)) continue
    folded.set(entry.scope, (folded.get(entry.scope) ?? 0) + 1)
  }

  const parts: string[] = []
  for (const spec of sections) {
    const lines = [...(bullets.get(spec.scope) ?? [])]
    const count = folded.get(spec.scope) ?? 0
    if (lines.length === 0 && count === 0) continue
    if (count > 0) lines.push(foldedLine(count, spec.title))
    parts.push(`## ${spec.title}\n\n${lines.join('\n')}`)
  }
  if (parts.length === 0) return ''
  return `${docHeader}${parts.join('\n\n')}\n`
}

/**
 * Render the conventions text: `## Project conventions` / `## Global
 * practices` / `## Personal habits` (empty sections omitted). Entries are
 * selected under the conventions budget in priority order; squeezed entries
 * fold into per-section count lines.
 * @param entries - convention-kind entries (already filtered).
 * @param cap - max total entries (`notesMaxEntriesPerFile`); `0` = unlimited.
 * @param charLimit - the conventions half's character budget (`0` → empty).
 * @returns the full section text.
 */
export function renderConventions(entries: readonly MemoryEntry[], cap: number, charLimit: number): string {
  return renderBudgeted('Conventions', [
    { title: 'Project conventions', scope: 'project' },
    { title: 'Global practices', scope: 'global' },
    { title: 'Personal habits', scope: 'user' },
  ], entries, cap, charLimit)
}

/**
 * Render the pitfalls text: `## Project pitfalls` / `## Environment &
 * cross-project pitfalls` (empty sections omitted). Entry content is emitted
 * verbatim — the pitfall extraction prompt guarantees the structured wording.
 * Entries are selected under the pitfalls budget in priority order; squeezed
 * entries fold into per-section count lines.
 * @param entries - pitfall-kind entries (already filtered).
 * @param cap - max total entries (`notesMaxEntriesPerFile`); `0` = unlimited.
 * @param charLimit - the pitfalls half's character budget (`0` → empty).
 * @returns the full section text.
 */
export function renderPitfalls(entries: readonly MemoryEntry[], cap: number, charLimit: number): string {
  return renderBudgeted('Pitfalls', [
    { title: 'Project pitfalls', scope: 'project' },
    { title: 'Environment & cross-project pitfalls', scope: 'global' },
  ], entries, cap, charLimit)
}
