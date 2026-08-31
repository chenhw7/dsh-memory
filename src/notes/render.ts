/**
 * Markdown renderers for the project-notes prompt section: store entries
 * (pre-filtered through {@link isRenderedEntry}) become the conventions /
 * pitfalls texts injected into the system prompt. Pure functions — no I/O.
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

/** Render one `## <title>` section; empty input drops the section. */
function section(title: string, entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return ''
  return `## ${title}\n\n${entries.map(bullet).join('\n')}`
}

/** Sort newest-first by updatedAt and truncate to the per-file cap. */
function capEntries(entries: readonly MemoryEntry[], cap: number): MemoryEntry[] {
  const sorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt)
  return cap > 0 ? sorted.slice(0, cap) : sorted
}

function byScope(entries: readonly MemoryEntry[], scope: MemoryScope): MemoryEntry[] {
  return entries.filter(entry => entry.scope === scope)
}

/**
 * Render the conventions text: `## Project conventions` / `## Global
 * practices` / `## Personal habits` (empty sections omitted).
 * @param entries - convention-kind entries (already filtered).
 * @param cap - max total entries (`notesMaxEntriesPerFile`); `0` = unlimited.
 * @returns the full section text.
 */
export function renderConventions(entries: readonly MemoryEntry[], cap: number): string {
  const capped = capEntries(entries, cap)
  const parts = [
    section('Project conventions', byScope(capped, 'project')),
    section('Global practices', byScope(capped, 'global')),
    section('Personal habits', byScope(capped, 'user')),
  ].filter(text => text.length > 0)
  return `# Conventions\n\n${AUTO_HEADER}\n\n${parts.join('\n\n')}\n`
}

/**
 * Render the pitfalls text: `## Project pitfalls` / `## Environment &
 * cross-project pitfalls` (empty sections omitted). Entry content is emitted
 * verbatim — the pitfall extraction prompt guarantees the structured wording.
 * @param entries - pitfall-kind entries (already filtered).
 * @param cap - max total entries (`notesMaxEntriesPerFile`); `0` = unlimited.
 * @returns the full section text.
 */
export function renderPitfalls(entries: readonly MemoryEntry[], cap: number): string {
  const capped = capEntries(entries, cap)
  const parts = [
    section('Project pitfalls', byScope(capped, 'project')),
    section('Environment & cross-project pitfalls', byScope(capped, 'global')),
  ].filter(text => text.length > 0)
  return `# Pitfalls\n\n${AUTO_HEADER}\n\n${parts.join('\n\n')}\n`
}
