/**
 * System-prompt memory context injection and the `memory` settings namespace.
 *
 * This function plugin contributes one `memory` system-prompt section at order
 * 90 (before tool guidance at 100–199). On `session/created` it reads a frozen
 * snapshot of recalled memory from the optional `ctx.memory` store (global,
 * project, and user scopes) and freezes it per session so a running session
 * reuses the same recalled content across steps, preserving KV-cache prefix
 * stability. The section text is rebuilt at each assembly from the live
 * settings mode and the session's frozen snapshot.
 *
 * The `memory` settings namespace is registered through `ctx.settings` so the
 * frontend settings UI auto-renders a form; `applies: 'live'` means a mode
 * change takes effect on the next assembly without a restart.
 *
 * @module @chenhw7/dsh-memory/context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { redactBlocked } from '../scanner.ts'
import type { MemoryEntry, MemoryScope } from '../types.ts'
import type { MemoryStore } from '../index.ts'
import { annotateConflicts, type ConflictStatus } from './conflict.ts'
import type { ProjectNotesService, ProjectNotesSnapshot } from '../notes/index.ts'
import { isRenderedEntry } from '../notes/scope.ts'
import {
  DEFAULT_NOTES_AGENTS_POINTER,
  DEFAULT_NOTES_CHAR_LIMIT,
  DEFAULT_NOTES_DIR,
  DEFAULT_NOTES_ENABLED,
  DEFAULT_NOTES_MAX_ENTRIES_PER_FILE,
} from '../notes/settings.ts'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: merges the `compaction/*` SessionEventMap declaration so the
// refreeze listener can narrow `compaction/end` and read its error field.
import type {} from '@deepseek-ai/dsh-compaction/types'
// Type-only: registers `agent/pre-step` on the Cordis event map for the
// auto-recall waterfall.
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: resolves the `systemPrompt` service and the `AssembleContext`
// slot the section text provider receives.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: merges the `agent` field into `AssembleContext` so the section
// text provider can recover the session whose frozen snapshot it reads.
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { buildMemorySectionText, buildNotesSectionText, buildAutoRecallBlock, renderMemoryIndex, AUTO_RECALL_CHAR_LIMIT, type MemoryMode, type IndexEntry } from './policy.ts'

export { buildMemorySectionText, buildAutoRecallBlock, renderMemoryIndex, MEMORY_POLICY_TEXT, MEMORY_CONTEXT_NOTE, MEMORY_INDEX_NOTE, AUTO_RECALL_NOTE } from './policy.ts'
export { buildNotesSectionText, PROJECT_NOTES_NOTE } from './policy.ts'
export type { MemoryMode, IndexEntry } from './policy.ts'

/** Cordis plugin name. */
export const name = 'memory-context'

/** The prompt registry is required; settings and memory are optional. */
export const inject = ['systemPrompt']

/** The settings namespace this plugin owns. */
const NS = settingsNamespace('memory')

const DEFAULT_MEMORY_MODE: MemoryMode = 'policy-only'
const DEFAULT_MEMORY_CHAR_LIMIT = 5000
const DEFAULT_MAX_SEARCH_RESULTS = 50
const DEFAULT_DECAY_DAYS = 30
/** Upper bound on any single generated notes file (defense-in-depth on top of the entry cap). */
const MAX_NOTES_FILE_CHARS = 32_000
/**
 * Default maximum number of memory entries injected into the system-prompt
 * snapshot, regardless of the character budget (P0-6). Prevents a large
 * store from flooding the prompt even when the character budget allows it.
 * `0` = no entry-count limit (character budget only).
 */
const DEFAULT_MEMORY_MAX_ENTRIES = 20

/** Per-session frozen memory state: the content/index snapshots plus the project-notes snapshot. */
interface FrozenSnapshot {
  readonly content: string
  readonly index: string
  readonly notes: ProjectNotesSnapshot
}

/** The empty project-notes snapshot (notes disabled, service absent, or no cwd). */
const EMPTY_NOTES: ProjectNotesSnapshot = { conventions: '', pitfalls: '' }

/** The `memory` system-prompt section name. */
const SECTION_NAME = 'memory'
/** Section order: before tool guidance (100–199). */
const SECTION_ORDER = 90
/** The `project-notes` system-prompt section name. */
const NOTES_SECTION_NAME = 'project-notes'
/** Notes section order: right after the memory section. */
const NOTES_SECTION_ORDER = 91
/** Scopes read into the frozen per-session memory snapshot, in render order. */
const SNAPSHOT_SCOPES: readonly MemoryScope[] = ['global', 'project', 'user']

/**
 * The `memory` settings-namespace shape, validated by the same-named
 * schemastery schema and doubling as the plugin's `cordis.yml` config. Every
 * field is optional in yml; the composition entry supplies the `base` layer
 * and the user settings document overlays it.
 */
export interface MemoryConfig {
  /** How recalled memory reaches the system prompt; defaults to `policy-only`. */
  memoryMode: MemoryMode
  /** User-supplied custom policy text, used only when `memoryMode` is `custom`. */
  memoryPolicyCustomText?: string
  /** Character budget for the frozen memory content snapshot; defaults to `5000`. */
  memoryCharLimit: number
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
  /** Enable project-notes export + injection; defaults to `true`. */
  notesEnabled: boolean
  /** Repo-relative directory holding the generated notes files; defaults to `docs/agent-memory`. */
  notesDir: string
  /** Character budget for the injected project-notes section; defaults to `4000`. */
  notesCharLimit: number
  /** Maintain the AGENTS.md pointer block; defaults to `true`. */
  notesAgentsPointer: boolean
  /** Max entries per generated notes file; defaults to `100`. */
  notesMaxEntriesPerFile: number
  /** Append a fenced auto-recall block to each step's messages (BM25 over the store). Defaults to `false`. */
  autoRecallEnabled: boolean
  /** Max entries in one auto-recall fence; defaults to `5`. */
  autoRecallLimit: number
  /** Skip recall when the step's user text is shorter than this many characters. Defaults to `12`. */
  autoRecallMinChars: number
}

/** Runtime schema for the `memory` settings namespace and plugin config. */
export const Config: z<MemoryConfig> = z.object({
  memoryMode: z.union(['full', 'policy-only', 'custom', 'off', 'index'] as const).default(DEFAULT_MEMORY_MODE),
  memoryPolicyCustomText: z.string(),
  memoryCharLimit: z.number().step(1).min(0).default(DEFAULT_MEMORY_CHAR_LIMIT),
  memoryMaxEntries: z.number().step(1).min(0).default(DEFAULT_MEMORY_MAX_ENTRIES),
  maxSearchResults: z.number().step(1).min(0).default(DEFAULT_MAX_SEARCH_RESULTS),
  decayDays: z.number().step(1).min(0).default(DEFAULT_DECAY_DAYS),
  notesEnabled: z.boolean().default(DEFAULT_NOTES_ENABLED),
  notesDir: z.string().default(DEFAULT_NOTES_DIR),
  notesCharLimit: z.number().step(1).min(0).default(DEFAULT_NOTES_CHAR_LIMIT),
  notesAgentsPointer: z.boolean().default(DEFAULT_NOTES_AGENTS_POINTER),
  notesMaxEntriesPerFile: z.number().step(1).min(0).default(DEFAULT_NOTES_MAX_ENTRIES_PER_FILE),
  autoRecallEnabled: z.boolean().default(false),
  autoRecallLimit: z.number().step(1).min(1).default(5),
  autoRecallMinChars: z.number().step(1).min(1).default(12),
})

/**
 * Render one scope's entries as a bulleted list under a `## <scope>` heading.
 *
 * Load-time defenses applied per line:
 * - `redactBlocked`: scanner-violating content surfaces as `[BLOCKED: …]`.
 * - conflict annotation: entries touched by a same-scope newer correction get
 *   a short staleness marker so the model weighs them accordingly.
 * @param scope - the heading label.
 * @param entries - the (healthy, non-excluded) entries to render.
 * @param conflicts - entry-id → status map from {@link annotateConflicts}.
 */
function renderScope(scope: MemoryScope, entries: readonly MemoryEntry[], conflicts?: ReadonlyMap<string, ConflictStatus>): string {
  if (entries.length === 0) return ''
  const lines = entries.map(entry => {
    let line = `- ${redactBlocked(entry.content)}`
    const status = conflicts?.get(entry.id as string)
    if (status === 'conflicting') line += ' (⚠ contradicts a newer correction — verify before trusting)'
    else if (status === 'stale') line += ' (⚠ possibly outdated — a newer correction touches this topic)'
    return line
  })
  return `## ${scope}\n${lines.join('\n')}`
}

/** The note appended when soft-decayed entries were folded out of the view. */
function staleNote(count: number): string {
  const noun = count === 1 ? 'memory' : 'memories'
  return `(${count} stale ${noun} hidden by soft decay — recall them via memory_search/memory_get to refresh)`
}

/**
 * Rough estimate of the token count for a text blob (P0-6). Uses the
 * commonly cited ~4-characters-per-token approximation for English; CJK
 * text is typically 1–2 tokens per character, which this underestimates —
 * the estimate is a coarse magnitude indicator, not a billing figure.
 * @param text - the text to estimate.
 * @returns the estimated token count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Read a frozen memory-content snapshot from the store across the global,
 * project, and user scopes, joined and truncated to the character budget and
 * entry-count cap (P0-6).
 *
 * Folding rules applied before rendering:
 * - Soft-decayed entries (`staleSince` set) are hidden entirely and summarized
 *   in a trailing count line — they remain searchable via tools.
 * - Healthy entries are cross-checked against same-scope correction-category
 *   entries ({@link annotateConflicts}); contradicted topics get inline markers.
 * - When `maxEntries > 0`, at most `maxEntries` entries are rendered; the
 *   rest are folded into a trailing `(N more entries …)` line.
 * @param memory - the live memory store.
 * @param charLimit - character budget; `0` yields no content.
 * @param exclude - optional predicate: entries it accepts are omitted (used to
 *   keep notes-rendered entries out of the memory section — no double injection).
 * @param maxEntries - maximum number of entries to render; `0` = no limit.
 * @returns the rendered snapshot text, possibly truncated.
 */
export function readMemorySnapshot(
  memory: MemoryStore,
  charLimit: number,
  exclude?: (entry: MemoryEntry) => boolean,
  maxEntries: number = 0,
): string {
  if (charLimit <= 0) return ''
  const parts: string[] = []
  let hiddenStale = 0
  let renderedCount = 0
  let overflowCount = 0
  for (const scope of SNAPSHOT_SCOPES) {
    const all = memory.list(scope)
    hiddenStale += all.filter(entry => entry.staleSince !== undefined).length
    const visible = all.filter(entry => entry.staleSince === undefined)
    const filtered = exclude === undefined ? visible : visible.filter(entry => !exclude(entry))
    if (filtered.length === 0) continue
    const capped = maxEntries > 0
      ? filtered.slice(0, Math.max(0, maxEntries - renderedCount))
      : filtered
    overflowCount += filtered.length - capped.length
    if (capped.length === 0) continue
    const conflicts = annotateConflicts(capped)
    const rendered = renderScope(scope, capped, conflicts.size > 0 ? conflicts : undefined)
    if (rendered.length > 0) {
      parts.push(rendered)
      renderedCount += capped.length
    }
  }
  let text = parts.join('\n\n')
  const annotations: string[] = []
  if (hiddenStale > 0) annotations.push(staleNote(hiddenStale))
  if (overflowCount > 0) annotations.push(`(${overflowCount} more entries — use memory_search to recall them)`)
  if (annotations.length > 0) {
    const noteStr = annotations.join(' ')
    text = text.length + noteStr.length + 2 > charLimit && text.length > 0
      ? text
      : text.length === 0 ? noteStr : `${text}\n\n${noteStr}`
  }
  if (text.length > charLimit) {
    const truncated = text.slice(0, charLimit)
    text = `${truncated}\n…(memory truncated at ${charLimit} characters ≈${estimateTokens(truncated)} tokens)`
  } else if (text.length > 0) {
    // Append a ≈token footer so the model (and the user) can budget against
    // a consistent unit alongside the character limit (P0-6).
    text = `${text}\n\n[memory snapshot: ${text.length} characters ≈${estimateTokens(text)} tokens]`
  }
  return text
}

/**
 * Read a frozen memory-index snapshot from the store: one existence line per
 * entry, ordered by relevance, with category roll-up when the budget is
 * exhausted. The index size grows with the number of categories, not entries.
 * @param memory - the live memory store.
 * @param charLimit - character budget; `0` yields no index.
 * @param exclude - optional predicate: entries it accepts are omitted (see
 *   {@link readMemorySnapshot}).
 * @returns the rendered index text, possibly truncated with roll-up lines.
 */
export function readMemoryIndex(memory: MemoryStore, charLimit: number, exclude?: (entry: MemoryEntry) => boolean): string {
  if (charLimit <= 0) return ''
  const all = exclude === undefined ? memory.list() : memory.list().filter(entry => !exclude(entry))
  const hiddenStale = all.filter(entry => entry.staleSince !== undefined).length
  const visible = all.filter(entry => entry.staleSince === undefined)
  const entries: IndexEntry[] = visible.map(entry => ({
    id: entry.id as string,
    scope: entry.scope,
    ...entry.category !== undefined ? { category: entry.category } : {},
    ...entry.projectName !== undefined ? { projectName: entry.projectName } : {},
    // Load-time guard: the index line shows a placeholder, never a payload.
    content: redactBlocked(entry.content),
    // Prefer the explicit summary for the index line (P0-4 progressive disclosure).
    ...entry.summary !== undefined ? { summary: redactBlocked(entry.summary) } : {},
    updatedAt: entry.updatedAt,
  }))
  let text = renderMemoryIndex(entries, charLimit)
  if (hiddenStale > 0 && text.length > 0) {
    text = `${text}\n…${staleNote(hiddenStale)}`
  }
  return text
}

/**
 * Register the `memory` settings namespace and the `memory` system-prompt
 * section. The section text is a function evaluated at each assembly: it reads
 * the live settings mode and the session's frozen memory snapshot, so a
 * settings change takes effect on the next assembly while the recalled
 * content stays frozen for the session.
 * @param ctx - Cordis context carrying the prompt registry.
 * @param config - resolved plugin entry config, used as the settings `base`.
 */
export function apply(ctx: Context, config: MemoryConfig): void {
  // Source thunk for the current resolved settings: the settings scope while
  // one is attached, the composition entry otherwise. Reassigned by
  // `installSettingsSection` on attach and detach.
  let current = (): MemoryConfig => config

  // Per-session frozen memory snapshots (content + index), read once at session/created.
  const sessionMemory = new WeakMap<Session, FrozenSnapshot>()

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    // The section text provider reads settings live at each assembly, so a
    // committed change is picked up without re-judging registration-level facts.
    onChange: () => {},
  })

  /** Infer the current project name from a session's cwd (basename). */
  const projectNameOf = (session: Session): string | undefined => {
    const cwd = session.header?.cwd
    if (cwd === undefined || cwd.length === 0) return undefined
    const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
    return base !== undefined && base.length > 0 ? base : undefined
  }

  /** Freeze (or re-freeze) the per-session snapshot from live settings + store. */
  const freezeFor = (session: Session): void => {
    const settings = current()
    const memory = ctx.get('memory')
    // The project-notes snapshot: rendering is synchronous AND reconciles
    // (fires the async file persistence), so the frozen prompt content always
    // matches what lands on disk — no file-read lag, no ordering race.
    const notes: ProjectNotesSnapshot = settings.notesEnabled
      ? ctx.get('projectNotes')?.snapshotFor(session.header?.cwd) ?? EMPTY_NOTES
      : EMPTY_NOTES
    if (memory === undefined) {
      sessionMemory.set(session, { content: '', index: '', notes })
      return
    }
    const charLimit = settings.memoryCharLimit
    const maxEntries = settings.memoryMaxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES
    // No double injection: entries rendered into the notes files are excluded
    // from the memory section's snapshot/index while notes are enabled.
    const exclude = settings.notesEnabled
      ? (entry: MemoryEntry): boolean => isRenderedEntry(entry, projectNameOf(session)) !== undefined
      : undefined
    sessionMemory.set(session, {
      content: readMemorySnapshot(memory, charLimit, exclude, maxEntries),
      index: readMemoryIndex(memory, charLimit, exclude),
      notes,
    })
  }

  ctx.on('session/created', freezeFor, { global: true })

  // Compaction is the one sanctioned moment to break the KV-cache prefix —
  // the prompt rebuilds anyway — so re-freeze here to surface memories that
  // were learned mid-session (review/flush extraction) without paying the
  // staleness for the rest of the session (Hermes-style boundary invalidation).
  ctx.on('session/event', (session: Session, event) => {
    if (event.type !== 'compaction/end') return
    if (event.data.error !== undefined) return
    try {
      freezeFor(session)
    } catch {
      // Best-effort: keep serving the previous frozen snapshot on failure.
    }
  }, { global: true })

  // P1-11 step-level auto recall (opt-in): on every agent step, run a BM25
  // search keyed on the step's user text and append a fenced
  // `<recalled-memory>` message. The system prompt is untouched — the block
  // rides in the logged user-message channel of this step only, so the
  // KV-cache prefix stays stable. Synchronous store search; never throws into
  // the waterfall (any failure falls through to `next()` unchanged).
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const settings = current()
      if (!settings.autoRecallEnabled) return next()
      const memory = ctx.get('memory')
      if (memory === undefined) return next()
      const query = payload.messages.map(userMessageText).join('\n').trim()
      if (query.length < settings.autoRecallMinChars) return next()
      const result = memory.search({ query, limit: settings.autoRecallLimit })
      // Soft-decayed entries stay hidden until deliberately recalled again.
      const hits = result.entries.filter(entry => entry.staleSince === undefined)
      if (hits.length === 0) return next()
      memory.markRecalled(hits.map(entry => entry.id))
      const block = buildAutoRecallBlock(hits, AUTO_RECALL_CHAR_LIMIT)
      if (block.length === 0) return next()
      const recallMessage = createUserMessage({
        content: [{ type: 'text', text: block }],
        source: { kind: 'plugin', plugin: 'dsh-memory-context' },
      })
      return { kind: 'enter', messages: [...payload.messages, recallMessage] }
    } catch {
      // Recall must never break the step: fall through unchanged.
      return next()
    }
  })

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context: AssembleContext): string => {
      const settings = current()
      const session = context.agent?.session
      const snapshot = session === undefined ? undefined : sessionMemory.get(session)
      const memoryContent = snapshot?.content ?? ''
      const indexContent = snapshot?.index ?? ''
      return buildMemorySectionText(settings.memoryMode, settings.memoryPolicyCustomText, memoryContent, indexContent)
    },
  }), 'memory-context.section()')

  ctx.effect(() => ctx.systemPrompt.section({
    name: NOTES_SECTION_NAME,
    order: NOTES_SECTION_ORDER,
    text: (context: AssembleContext): string => {
      const settings = current()
      if (!settings.notesEnabled) return ''
      const session = context.agent?.session
      const snapshot = session === undefined ? undefined : sessionMemory.get(session)
      return buildNotesSectionText(snapshot?.notes.conventions ?? '', snapshot?.notes.pitfalls ?? '', settings.notesCharLimit)
    },
  }), 'memory-context.notes-section()')
}

/** Extract the concatenated text blocks of one incoming user message. */
function userMessageText(message: unknown): string {
  const content = (message as { content?: readonly { type?: string; text?: unknown }[] } | undefined)?.content
  if (content === undefined || !Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => (block as { text: string }).text)
    .join('\n')
}
