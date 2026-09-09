/**
 * System-prompt memory context injection and the `memory` settings namespace.
 *
 * This function plugin contributes four system-prompt sections: `memory` at
 * order 90 and `project-notes` at 91 (before tool guidance at 100–199), and —
 * when the identity layer is enabled — `soul` at 80 and `user-profile` at 81
 * (after the host's deployment persona at order 0). On `session/created` it reads a frozen
 * snapshot of recalled memory from the optional `ctx.memory` store (global,
 * project, and user scopes) and freezes it per session so a running session
 * reuses the same recalled content across steps, preserving KV-cache prefix
 * stability. The section text is rebuilt at each assembly from the live
 * settings mode and the session's frozen snapshot.
 *
 * The memory-family settings namespaces are registered through `ctx.settings`,
 * one per plugin-configuration card (`memory`, `memory-notes`,
 * `memory-autorecall`, `memory-identity`): the harness's plugins tab dispatches
 * a card only when its slot key names a namespace the Host serves, so each
 * card's key IS its namespace here. All are `applies: 'live'` — a change takes
 * effect on the next assembly without a restart. The composition config stays
 * one full shape, and each namespace's base layer projects its slice from it.
 *
 * @module @chenhw7/dsh-memory/context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: merges the `settings` service (SettingsProvider) into the Context
// so `ctx.settings` / `sctx.settings` type in this module.
import type {} from '@deepseek-ai/dsh-settings'
import { redactBlocked } from '../scanner.ts'
import type { MemoryEntry, MemoryId, MemoryScope } from '../types.ts'
import type { MemoryStore } from '../index.ts'
import { buildCorpusStats, tokenizeForSearch, uniqueTokens, idfOf } from '../store/bm25.ts'
import { messageText } from '../review/accumulator.ts'
import { annotateConflicts, type ConflictStatus } from './conflict.ts'
import type { ProjectNotesService, ProjectNotesSnapshot } from '../notes/index.ts'
import { isRenderedEntry } from '../notes/scope.ts'
import {
  DEFAULT_NOTES_CHAR_LIMIT,
  DEFAULT_NOTES_ENABLED,
  DEFAULT_NOTES_MAX_ENTRIES_PER_FILE,
} from '../notes/settings.ts'
import type { IdentitySnapshot } from '../identity/index.ts'
import { EMPTY_IDENTITY } from '../identity/index.ts'
import { validateSeedDir } from '../identity/seeds.ts'
import {
  DEFAULT_IDENTITY_ENABLED,
  DEFAULT_IDENTITY_SEED_DIR,
  DEFAULT_SOUL_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
} from '../identity/settings.ts'
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
import { buildMemorySectionText, buildNotesSectionText, buildAutoRecallBlock, buildSoulSectionText, buildUserProfileSectionText, renderMemoryIndex, AUTO_RECALL_CHAR_LIMIT, type MemoryMode, type IndexEntry } from './policy.ts'

export { buildMemorySectionText, buildAutoRecallBlock, renderMemoryIndex, MEMORY_POLICY_TEXT, MEMORY_CONTEXT_NOTE, MEMORY_INDEX_NOTE, AUTO_RECALL_NOTE } from './policy.ts'
export { buildNotesSectionText, buildSoulSectionText, buildUserProfileSectionText, PROJECT_NOTES_NOTE, SOUL_NOTE, USER_PROFILE_NOTE } from './policy.ts'
export type { MemoryMode, IndexEntry } from './policy.ts'

/** Cordis plugin name. */
export const name = 'memory-context'

/** The prompt registry is required; settings and memory are optional. */
export const inject = ['systemPrompt']

/**
 * The settings namespaces this plugin owns — one per plugin-configuration
 * card: the harness's plugins tab dispatches a card only when its slot key
 * names a namespace the Host serves, so each card's key IS its namespace.
 */
const NS = 'memory'
const NOTES_NS = 'memory-notes'
const AUTORECALL_NS = 'memory-autorecall'
const IDENTITY_NS = 'memory-identity'

// Factory default is `index`: every entry is visible to the model as an
// existence line without it having to guess that a memory might exist. The
// superseded policy-only default and its measured costs are recorded in the
// implemented Agent Note (index-default-promotion); deployments with tight
// context budgets set policy-only or off explicitly.
const DEFAULT_MEMORY_MODE: MemoryMode = 'index'
const DEFAULT_MEMORY_CHAR_LIMIT = 5000
const DEFAULT_MAX_SEARCH_RESULTS = 50
const DEFAULT_DECAY_DAYS = 30
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
  readonly identity: IdentitySnapshot
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
/** The `soul` system-prompt section name. */
const SOUL_SECTION_NAME = 'soul'
/** Soul section order: after the deployment persona (order 0), before memory (90). */
const SOUL_SECTION_ORDER = 80
/** The `user-profile` system-prompt section name. */
const USER_PROFILE_SECTION_NAME = 'user-profile'
/** User-profile section order: right after the soul section. */
const USER_PROFILE_SECTION_ORDER = 81
/** Scopes read into the frozen per-session memory snapshot, in render order. */
const SNAPSHOT_SCOPES: readonly MemoryScope[] = ['global', 'project', 'user']

/**
 * The memory-family settings shape, validated by the same-named schemastery
 * schemas and doubling as the plugin's `cordis.yml` config. The composition
 * config stays ONE full shape; the four settings namespaces project their
 * slices from it as each namespace's `base` layer, and the user settings
 * document overlays each slice in its own section. Every field is optional in
 * yml; the schema defaults supply the rest.
 *
 * The split follows the host's plugin-card contract (one card per served
 * namespace), so the slice boundaries are the card boundaries:
 * `MemoryInjectionConfig` → the curated memory card / `memory` namespace,
 * `MemoryNotesConfig` → the Project Notes card / `memory-notes`,
 * `MemoryAutoRecallConfig` → the Auto Recall card / `memory-autorecall`,
 * `MemoryIdentityConfig` → the Identity card / `memory-identity`.
 */
export interface MemoryInjectionConfig {
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
}

export interface MemoryNotesConfig {
  /** Enable the `project-notes` prompt section; defaults to `true`. */
  notesEnabled: boolean
  /** Character budget for the injected project-notes section; defaults to `4000`. */
  notesCharLimit: number
  /** Max entries rendered into the project-notes section; defaults to `100`. */
  notesMaxEntriesPerFile: number
}

export interface MemoryAutoRecallConfig {
  /** Append a fenced auto-recall block to each step's messages (BM25 over the store). Defaults to `false`. */
  autoRecallEnabled: boolean
  /** Max entries in one auto-recall fence; defaults to `5`. */
  autoRecallLimit: number
  /** Skip recall when the step's user text is shorter than this many characters. Defaults to `12`. */
  autoRecallMinChars: number
  /**
   * Enable the usage-hit signal (write-path rework Step 2): when the
   * assistant's answer echoes an injected entry's tokens/anchors (IDF-weighted
   * overlap above {@link hitSignalThreshold}), the entry gains one `hitCount`.
   * The periodic sweep's selection is the only consumer. Defaults to `false`.
   */
  hitSignalEnabled: boolean
  /**
   * Weighted token-overlap between an injected entry and the assistant's
   * answer above which the answer counts as a hit: the IDF-weighted share of
   * the entry's tokens the answer restates. Defaults to `0.25` — mid-band of
   * the measured calibration (genuine restatement 0.5–0.7, incidental
   * mention 0.05–0.12, unrelated ~0).
   */
  hitSignalThreshold: number
}

export interface MemoryIdentityConfig {
  /**
   * Enable the identity layer: the `soul` and `user-profile` prompt sections
   * plus the `identity_update` agent tool's write surface. Opt-in; defaults
   * to `false`.
   */
  identityEnabled: boolean
  /** Character budget for the injected soul section; defaults to `2000`. */
  soulCharLimit: number
  /** Character budget for the injected user-profile section; defaults to `3000`. */
  userCharLimit: number
  /**
   * Optional directory holding custom identity seed files (`SOUL.md` /
   * `USER.md`); empty uses the builtin Chinese seeds. Validated loudly at
   * load when identity is enabled; a missing file for one kind keeps that
   * kind's builtin seed (partial override).
   */
  identitySeedDir?: string
}

/** The full memory-family settings shape: the composition config and the merged runtime view. */
export type MemoryConfig = MemoryInjectionConfig & MemoryNotesConfig & MemoryAutoRecallConfig & MemoryIdentityConfig

/**
 * Schema fragments shared between the four namespace schemas and the plugin
 * config — one home per default, so the composition layer and the settings
 * namespaces cannot drift.
 */
const INJECTION_FIELDS = {
  memoryMode: z.union(['full', 'policy-only', 'custom', 'off', 'index'] as const).default(DEFAULT_MEMORY_MODE),
  memoryPolicyCustomText: z.string(),
  memoryCharLimit: z.number().step(1).min(0).default(DEFAULT_MEMORY_CHAR_LIMIT),
  memoryMaxEntries: z.number().step(1).min(0).default(DEFAULT_MEMORY_MAX_ENTRIES),
  maxSearchResults: z.number().step(1).min(0).default(DEFAULT_MAX_SEARCH_RESULTS),
  decayDays: z.number().step(1).min(0).default(DEFAULT_DECAY_DAYS),
}

const NOTES_FIELDS = {
  notesEnabled: z.boolean().default(DEFAULT_NOTES_ENABLED),
  notesCharLimit: z.number().step(1).min(0).default(DEFAULT_NOTES_CHAR_LIMIT),
  notesMaxEntriesPerFile: z.number().step(1).min(0).default(DEFAULT_NOTES_MAX_ENTRIES_PER_FILE),
}

const AUTORECALL_FIELDS = {
  autoRecallEnabled: z.boolean().default(false),
  autoRecallLimit: z.number().step(1).min(1).default(5),
  autoRecallMinChars: z.number().step(1).min(1).default(12),
  hitSignalEnabled: z.boolean().default(false),
  hitSignalThreshold: z.number().min(0).max(1).default(0.25),
}

const IDENTITY_FIELDS = {
  identityEnabled: z.boolean().default(DEFAULT_IDENTITY_ENABLED),
  soulCharLimit: z.number().step(1).min(0).default(DEFAULT_SOUL_CHAR_LIMIT),
  userCharLimit: z.number().step(1).min(0).default(DEFAULT_USER_CHAR_LIMIT),
  identitySeedDir: z.string(),
}

/** Runtime schema for the composition config: the union of the four namespace slices. */
export const Config: z<MemoryConfig> = z.object({
  ...INJECTION_FIELDS,
  ...NOTES_FIELDS,
  ...AUTORECALL_FIELDS,
  ...IDENTITY_FIELDS,
})

/** Per-namespace schemas — each plugin-configuration card's settings slice. */
const MemorySectionSchema: z<MemoryInjectionConfig> = z.object(INJECTION_FIELDS)
const NotesSectionSchema: z<MemoryNotesConfig> = z.object(NOTES_FIELDS)
const AutoRecallSectionSchema: z<MemoryAutoRecallConfig> = z.object(AUTORECALL_FIELDS)
const IdentitySectionSchema: z<MemoryIdentityConfig> = z.object(IDENTITY_FIELDS)

/** Base-layer projections: each namespace's composition slice of the plugin config. */
function injectionEntry(config: MemoryConfig): MemoryInjectionConfig {
  return {
    memoryMode: config.memoryMode,
    // Optional composition keys are carried only when set (exactOptionalPropertyTypes).
    ...config.memoryPolicyCustomText === undefined ? {} : { memoryPolicyCustomText: config.memoryPolicyCustomText },
    memoryCharLimit: config.memoryCharLimit,
    memoryMaxEntries: config.memoryMaxEntries,
    maxSearchResults: config.maxSearchResults,
    decayDays: config.decayDays,
  }
}

function notesEntry(config: MemoryConfig): MemoryNotesConfig {
  return {
    notesEnabled: config.notesEnabled,
    notesCharLimit: config.notesCharLimit,
    notesMaxEntriesPerFile: config.notesMaxEntriesPerFile,
  }
}

function autoRecallEntry(config: MemoryConfig): MemoryAutoRecallConfig {
  return {
    autoRecallEnabled: config.autoRecallEnabled,
    autoRecallLimit: config.autoRecallLimit,
    autoRecallMinChars: config.autoRecallMinChars,
    hitSignalEnabled: config.hitSignalEnabled,
    hitSignalThreshold: config.hitSignalThreshold,
  }
}

function identityEntry(config: MemoryConfig): MemoryIdentityConfig {
  return {
    identityEnabled: config.identityEnabled,
    soulCharLimit: config.soulCharLimit,
    userCharLimit: config.userCharLimit,
    ...config.identitySeedDir === undefined ? {} : { identitySeedDir: config.identitySeedDir },
  }
}

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
    // Superseded entries (consolidation conflict verdicts) drop out of the
    // injection snapshot entirely — they stay navigable through the tools.
    const visible = all.filter(entry => entry.staleSince === undefined && entry.status !== 'superseded')
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
  // Superseded entries are excluded from the existence index like stale ones —
  // the index surfaces only injectable memories.
  const visible = all.filter(entry => entry.staleSince === undefined && entry.status !== 'superseded')
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
  // Load-time loud gate for the composition layer: the owner of the `memory`
  // namespace validates its own config before mounting. Cordis swallows
  // throws from `ctx.inject` callbacks (verified against the installed
  // runtime), so the gate cannot live in the identity plugin; settings-overlay
  // changes made live through the UI degrade observably instead (reported
  // failure + builtin-seed fallback, surfaced through health()).
  const seedDir = config.identitySeedDir ?? ''
  if (config.identityEnabled && seedDir.trim().length > 0) {
    validateSeedDir(seedDir)
  }

  // Source thunks for the current resolved settings slices: the settings
  // scopes while one is attached, the composition projections otherwise
  // (reassigned by `installSection` on attach and detach). The merged view
  // keeps every consumer reading the one MemoryConfig shape.
  let memorySource = (): MemoryInjectionConfig => injectionEntry(config)
  let notesSource = (): MemoryNotesConfig => notesEntry(config)
  let recallSource = (): MemoryAutoRecallConfig => autoRecallEntry(config)
  let identitySource = (): MemoryIdentityConfig => identityEntry(config)

  /** The merged runtime view across the four namespaces, re-read per event/call. */
  const current = (): MemoryConfig => ({
    ...memorySource(),
    ...notesSource(),
    ...recallSource(),
    ...identitySource(),
  })

  // Per-session frozen memory snapshots (content + index), read once at session/created.
  const sessionMemory = new WeakMap<Session, FrozenSnapshot>()

  // Usage-hit ledger (write-path rework Step 2): per session, the entries the
  // current round injected — the standing snapshot's entries (recorded at
  // freeze time) plus the latest auto-recall fence's hits. The
  // `assistant/message` listener weighs the answer against these and books the
  // echoes as store hits. A WeakMap: the ledger dies with its session.
  const hitLedger = new WeakMap<Session, LedgerEntry[]>()

  ctx.inject(['settings'], (settingsCtx) => {
    // One namespace per plugin-configuration card; each base layer projects
    // its slice of the composition config. A card whose slot key is not a
    // served namespace is never dispatched by the host's plugins tab, so
    // these registrations are what make the four cards visible.
    settingsCtx.settings.installSection(ctx, NS, MemorySectionSchema, injectionEntry(config), {
      setSource: (source) => {
        memorySource = source
      },
      // The section text provider reads settings live at each assembly, so a
      // committed change is picked up without re-judging registration-level facts.
      onChange: () => {},
    })
    settingsCtx.settings.installSection(ctx, NOTES_NS, NotesSectionSchema, notesEntry(config), {
      setSource: (source) => {
        notesSource = source
      },
      onChange: () => {},
    })
    settingsCtx.settings.installSection(ctx, AUTORECALL_NS, AutoRecallSectionSchema, autoRecallEntry(config), {
      setSource: (source) => {
        recallSource = source
      },
      onChange: () => {},
    })
    settingsCtx.settings.installSection(ctx, IDENTITY_NS, IdentitySectionSchema, identityEntry(config), {
      setSource: (source) => {
        identitySource = source
      },
      onChange: () => {},
    })
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
    // The project-notes snapshot: rendering is synchronous and side-effect
    // free (prompt-only since 0.6 — nothing is written to the project).
    const notes: ProjectNotesSnapshot = settings.notesEnabled
      ? ctx.get('projectNotes')?.snapshotFor(session.header?.cwd) ?? EMPTY_NOTES
      : EMPTY_NOTES
    // The identity snapshot (raw, unbudgeted — the section builders apply
    // `soulCharLimit`/`userCharLimit` at assembly, the notes-section
    // precedent): seeding and scanner-side degradation live in the service.
    const identity: IdentitySnapshot = settings.identityEnabled
      ? ctx.get('identity')?.snapshotFor() ?? EMPTY_IDENTITY
      : EMPTY_IDENTITY
    if (memory === undefined) {
      sessionMemory.set(session, { content: '', index: '', notes, identity })
      hitLedger.set(session, [])
      return
    }
    const charLimit = settings.memoryCharLimit
    const maxEntries = settings.memoryMaxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES
    // No double injection: entries rendered into the project-notes section
    // are excluded from the memory section's snapshot/index while notes are
    // enabled.
    const exclude = settings.notesEnabled
      ? (entry: MemoryEntry): boolean => isRenderedEntry(entry, projectNameOf(session)) !== undefined
      : undefined
    sessionMemory.set(session, {
      content: readMemorySnapshot(memory, charLimit, exclude, maxEntries),
      index: readMemoryIndex(memory, charLimit, exclude),
      notes,
      identity,
    })
    // The standing round's ledger: the entries the frozen snapshot injected.
    hitLedger.set(session, settings.hitSignalEnabled ? standingLedger(memory, exclude) : [])
  }

  /**
   * The standing round's ledger: every active, non-stale entry the snapshot
   * reads, as a ledger item. Tokens come from content + summary + anchors —
   * everything an answer could echo back.
   */
  const standingLedger = (memory: MemoryStore, exclude: ((entry: MemoryEntry) => boolean) | undefined): LedgerEntry[] => {
    const items: LedgerEntry[] = []
    for (const entry of memory.list()) {
      if (entry.staleSince !== undefined || entry.status === 'superseded') continue
      if (exclude?.(entry) === true) continue
      items.push({ id: entry.id, tokens: ledgerTokens(entry) })
    }
    return items
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
    } catch (error) {
      // Best-effort: keep serving the previous frozen snapshot on failure, but stay observable.
      ctx.get('memory')?.reportFailure('compaction-refreeze', error)
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
      // Soft-decayed and superseded entries stay hidden until deliberately
      // recalled through the tool surface.
      const hits = result.entries.filter(entry => entry.staleSince === undefined && entry.status !== 'superseded')
      if (hits.length === 0) return next()
      memory.markRecalled(hits.map(entry => entry.id))
      // The auto-recall fence replaces the standing round's injected set for
      // the hit ledger: these are the entries the model sees THIS round.
      const session = sessionOf(payload)
      if (settings.hitSignalEnabled && session !== undefined) hitLedger.set(session, hits.map(toLedgerEntry))
      const block = buildAutoRecallBlock(hits, AUTO_RECALL_CHAR_LIMIT)
      if (block.length === 0) return next()
      const recallMessage = createUserMessage({
        content: [{ type: 'text', text: block }],
        source: { kind: 'plugin', plugin: 'dsh-memory-context' },
      })
      return { kind: 'enter', messages: [...payload.messages, recallMessage] }
    } catch (error) {
      // Recall must never break the step: fall through unchanged, but stay observable.
      ctx.get('memory')?.reportFailure('auto-recall', error)
      return next()
    }
  })

  // Usage-hit recording (write-path rework Step 2.2, opt-in via
  // `hitSignalEnabled`): when the assistant answers, weigh the answer text
  // against the round's injected-entry ledger; echoes above the threshold
  // book one `hitCount` per entry. Fire-and-forget and never blocks the
  // event. The standing round's ledger is cleared after one answer — a hit
  // belongs to the answer that echoed it, not to every later turn.
  ctx.on('session/event', (session: Session, event) => {
    if (event.type !== 'assistant/message') return
    const settings = current()
    if (!settings.hitSignalEnabled) return
    const ledger = hitLedger.get(session)
    if (ledger === undefined || ledger.length === 0) return
    const text = messageText(event)
    if (text === undefined || text.length === 0) return
    const memory = ctx.get('memory')
    if (memory === undefined) return
    hitLedger.delete(session)
    try {
      const hits = computeHits(ledger, text, settings.hitSignalThreshold)
      if (hits.length === 0) return
      void memory.markHits(hits).catch((error: unknown) => {
        // A failed hit write is a lost usage signal, never a broken session.
        memory.reportFailure('mark-hits', error)
      })
    } catch (error) {
      // The overlap computation must never break the event stream.
      memory.reportFailure('hit-compute', error)
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

  ctx.effect(() => ctx.systemPrompt.section({
    name: SOUL_SECTION_NAME,
    order: SOUL_SECTION_ORDER,
    text: (context: AssembleContext): string => {
      const settings = current()
      if (!settings.identityEnabled) return ''
      const session = context.agent?.session
      const snapshot = session === undefined ? undefined : sessionMemory.get(session)
      return buildSoulSectionText(snapshot?.identity.soul ?? '', settings.soulCharLimit)
    },
  }), 'memory-context.soul-section()')

  ctx.effect(() => ctx.systemPrompt.section({
    name: USER_PROFILE_SECTION_NAME,
    order: USER_PROFILE_SECTION_ORDER,
    text: (context: AssembleContext): string => {
      const settings = current()
      if (!settings.identityEnabled) return ''
      const session = context.agent?.session
      const snapshot = session === undefined ? undefined : sessionMemory.get(session)
      return buildUserProfileSectionText(snapshot?.identity.user ?? '', settings.userCharLimit)
    },
  }), 'memory-context.user-profile-section()')
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

/**
 * One injected entry awaiting a possible hit: its id plus the token bag the
 * hit computation weighs (content + summary + anchors). Recorded into the
 * session-side ledger at injection time.
 */
export interface LedgerEntry {
  readonly id: MemoryId
  /** The entry's weighted token bag: content + summary + anchors. */
  readonly tokens: ReadonlySet<string>
}

/**
 * The token bag a hit verdict weighs: content + summary tokens (the answer
 * can echo the wording) plus the anchors (the answer can echo the hard
 * tokens). Same tokenizer the retrieval plane uses.
 */
function ledgerTokens(entry: MemoryEntry): Set<string> {
  return new Set([
    ...tokenizeForSearch(`${entry.content}\n${entry.summary ?? ''}`),
    ...entry.anchors ?? [],
  ])
}

/** Project one recalled entry into its ledger shape. */
function toLedgerEntry(entry: MemoryEntry): LedgerEntry {
  return { id: entry.id, tokens: ledgerTokens(entry) }
}

/** The session whose pre-step payload this is (the waterfall's owner). */
function sessionOf(payload: { agent?: { session?: Session } }): Session | undefined {
  return payload.agent?.session
}

/**
 * Decide which of the round's injected entries the assistant's answer echoes
 * (write-path rework Step 2.2): an entry is hit when the IDF-weighted share
 * of its tokens (content + summary + anchors) that the answer restates
 * reaches the threshold. Coverage over the ENTRY's token bag — not a
 * symmetric overlap — is the calibrated notion: a long answer that merely
 * mentions the entry's topic stays far below it, while an answer restating
 * the fact's substance crosses it. The IDF weights (measured over the
 * round's ledger + the answer) let an entry-specific token (an identifier, a
 * repo path) dominate a word every entry shares. Measured bands over the
 * calibration fixtures: a genuine restatement 0.5–0.7, an incidental
 * mention 0.05–0.12, unrelated ~0 — the default threshold (0.25) sits
 * mid-band. Pure; the store's `markHits` owns persistence.
 * @param ledger - the entries injected this round.
 * @param answerText - the assistant's answer text.
 * @param threshold - the weighted coverage hit threshold.
 * @returns the hit entry ids (deduplicated, in ledger order).
 */
export function computeHits(ledger: readonly LedgerEntry[], answerText: string, threshold: number): MemoryId[] {
  if (ledger.length === 0) return []
  const answerTokens = uniqueTokens(answerText)
  if (answerTokens.size === 0) return []
  // IDF over the round's corpus: the injected entries' bags plus the answer.
  const stats = buildCorpusStats([...ledger.map(item => [...item.tokens].join(' ')), answerText])
  const hits: MemoryId[] = []
  for (const item of ledger) {
    if (item.tokens.size === 0) continue
    let restated = 0
    let total = 0
    for (const token of item.tokens) {
      const weight = idfOf(stats, token)
      total += weight
      if (answerTokens.has(token)) restated += weight
    }
    if (total > 0 && restated / total >= threshold) hits.push(item.id)
  }
  return hits
}
