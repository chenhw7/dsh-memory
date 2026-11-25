/**
 * System-prompt memory context injection and the `memory-autorecall` settings
 * entry.
 *
 * This function plugin contributes four system-prompt sections: `memory` at
 * order 6000 and `project-notes` at 6001 — after the host's tool guidance
 * (SECTION_ORDERS TOOL_* 1000–2900, TOOLS_SDK 5000) and before
 * DELIVERABLE_FILE_REFERENCES (9000), so a compaction re-freeze that changes
 * the memory/notes text no longer invalidates the prefix cache of every tool
 * section behind it (the OpenClaw CONTEXT_FILE_ORDER lesson: most-volatile
 * data last, closest to the cache boundary) — and — when the identity layer
 * is enabled — `soul` at 80 and `user-profile` at 81 (after the host's
 * deployment persona at order 0). On `session/created` it reads a frozen
 * snapshot of recalled memory from the optional `ctx.memory` store (global,
 * project, and user scopes) and freezes it per session so a running session
 * reuses the same recalled content across steps, preserving KV-cache prefix
 * stability. The section text is rebuilt at each assembly from the live
 * settings mode and the session's frozen snapshot.
 *
 * In `digest` mode (the default) the sections carry only frozen guidance;
 * the data rides as step-tail messages: a one-time `<memory-digest>` store
 * inventory appended to the session's first pre-step (re-appended once after
 * compaction) and, when auto recall is on, per-step `<recalled-memory>`
 * fences of BM25 hits — both merged into at most one plugin message per step,
 * so the frozen prefix itself never changes mid-session.
 *
 * The memory-family settings are four profile entries, each declaring its own
 * `Config`: `memory` (the store: injection budgets, search cap, decay),
 * `memory-notes`, `memory-autorecall` (this plugin), and `memory-identity`.
 * This plugin owns only the auto-recall slice and reads the other three from
 * the services that own them (`ctx.memory`, `ctx.projectNotes`,
 * `ctx.identity`), so every value a card writes is read back from the plugin
 * that declared it rather than from a shared namespace.
 *
 * @module @chenhw7/dsh-memory/context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { redactBlocked } from '../scanner.ts'
import type { MemoryEntry, MemoryId, MemoryScope } from '../types.ts'
import type { MemoryStore } from '../index.ts'
import { buildCorpusStats, tokenizeForSearch, uniqueTokens, idfOf } from '../store/bm25.ts'
import { messageText } from '../review/accumulator.ts'
import { annotateConflicts, type ConflictStatus } from './conflict.ts'
import type { ProjectNotesService, ProjectNotesSnapshot } from '../notes/index.ts'
import { isRenderedEntry } from '../notes/scope.ts'
import { DEFAULT_NOTES_SETTINGS } from '../notes/settings.ts'
import type { NotesSettings } from '../notes/settings.ts'
import type { IdentitySnapshot } from '../identity/index.ts'
import { EMPTY_IDENTITY } from '../identity/index.ts'
import { validateSeedDir } from '../identity/seeds.ts'
import { DEFAULT_IDENTITY_SETTINGS } from '../identity/settings.ts'
import type { IdentitySettings } from '../identity/settings.ts'
import { DEFAULT_INJECTION_SETTINGS } from '../store/settings.ts'
import type { MemoryInjectionSettings } from '../store/settings.ts'
import {
  AUTORECALL_FIELDS,
  DEFAULT_AUTO_RECALL_SETTINGS,
  resolveAutoRecallSettings,
} from './settings.ts'
import type { AutoRecallSettings } from './settings.ts'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: merges the `compaction/*` SessionEventMap declaration so the
// refreeze listener can narrow `compaction/end` and read its error field.
import type {} from '@deepseek-ai/dsh-compaction/types'
// Type-only: registers `agent/pre-step` on the Cordis event map for the
// auto-recall waterfall.
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MEMORY_CONTEXT_SOURCE } from '../sources.ts'
// Type-only: resolves the `systemPrompt` service and the `AssembleContext`
// slot the section text provider receives.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: merges the `agent` field into `AssembleContext` so the section
// text provider can recover the session whose frozen snapshot it reads.
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { buildMemorySectionText, buildNotesSectionText, buildAutoRecallBlock, buildSoulSectionText, buildUserProfileSectionText, buildMemoryDigestText, renderMemoryIndex, AUTO_RECALL_CHAR_LIMIT, MEMORY_DIGEST_POLICY_HINT, type MemoryMode, type IndexEntry } from './policy.ts'

export { buildMemorySectionText, buildAutoRecallBlock, buildMemoryDigestText, renderMemoryIndex, MEMORY_POLICY_TEXT, MEMORY_DIGEST_POLICY_HINT, MEMORY_CONTEXT_NOTE, MEMORY_INDEX_NOTE, AUTO_RECALL_NOTE } from './policy.ts'
export { buildNotesSectionText, buildSoulSectionText, buildUserProfileSectionText, PROJECT_NOTES_NOTE, SOUL_NOTE, USER_PROFILE_NOTE } from './policy.ts'
export type { MemoryMode, IndexEntry } from './policy.ts'

/** Cordis plugin name. */
export const name = 'memory-context'

/** The prompt registry is required; settings and memory are optional. */
export const inject = ['systemPrompt']

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
/**
 * Section order: after the host's tool guidance (TOOL_* 1000–2900, TOOLS_SDK
 * 5000) and before DELIVERABLE_FILE_REFERENCES (9000) — verified against the
 * installed host's SECTION_ORDERS (HOST_CONTRACT §3). Data sections sit as
 * late as possible so re-freezing them costs only the tail of the prefix.
 */
const SECTION_ORDER = 6000
/** The `project-notes` system-prompt section name. */
const NOTES_SECTION_NAME = 'project-notes'
/** Notes section order: right after the memory section, same volatility class. */
const NOTES_SECTION_ORDER = 6001
/** The `soul` system-prompt section name. */
const SOUL_SECTION_NAME = 'soul'
/** Soul section order: after the deployment persona (order 0), before memory (6000). */
const SOUL_SECTION_ORDER = 80
/** The `user-profile` system-prompt section name. */
const USER_PROFILE_SECTION_NAME = 'user-profile'
/** User-profile section order: right after the soul section. */
const USER_PROFILE_SECTION_ORDER = 81
/** Scopes read into the frozen per-session memory snapshot, in render order. */
const SNAPSHOT_SCOPES: readonly MemoryScope[] = ['global', 'project', 'user']

/**
 * The merged runtime view the injection surfaces read: the four settings
 * slices, each owned by the plugin entry that declares it. `memory-context`
 * owns only the auto-recall slice; the injection budgets come from the store
 * entry (`ctx.memory`), the notes budgets from the notes entry
 * (`ctx.projectNotes`), and the identity budgets from the identity entry
 * (`ctx.identity`) — the host's per-entry configuration model gives each
 * plugin its own `Config`, so shared knobs ride the owning service.
 */
export type MemoryConfig = MemoryInjectionSettings & NotesSettings & AutoRecallSettings & IdentitySettings

/** The `memory-autorecall` entry config — this plugin's own settings page. */
export const Config: z<AutoRecallSettings> = z.object(AUTORECALL_FIELDS)

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
 * Register the four memory system-prompt sections and the step-tail injection.
 * The section text is a function evaluated at each assembly: it reads the live
 * settings and the session's frozen memory snapshot, so a settings change takes
 * effect on the next assembly while the recalled content stays frozen for the
 * session.
 *
 * Settings reach this plugin from two places: its own entry config (the
 * auto-recall slice) and the services that own the other three entries. The
 * host re-runs `apply` when a card commits a change, so every read here sees
 * the value the user just saved.
 * @param ctx - Cordis context carrying the prompt registry.
 * @param config - the `memory-autorecall` entry config.
 */
export function apply(ctx: Context, config: AutoRecallSettings = DEFAULT_AUTO_RECALL_SETTINGS): void {
  const recall = resolveAutoRecallSettings(config)

  // Load-time loud gate for the identity entry: this plugin assembles the
  // identity sections, so it validates the seed directory before mounting.
  // Cordis swallows throws from `ctx.inject` callbacks (verified against the
  // installed runtime), so the gate cannot live in the identity plugin;
  // settings-overlay changes made live through the UI degrade observably
  // instead (reported failure + builtin-seed fallback, surfaced through
  // health()).
  const identitySettings = (): IdentitySettings => ctx.get('identity')?.settings() ?? DEFAULT_IDENTITY_SETTINGS
  const seedDir = identitySettings().identitySeedDir
  if (identitySettings().identityEnabled && seedDir.trim().length > 0) {
    validateSeedDir(seedDir)
  }

  /**
   * The merged runtime view across the four entries, re-read per event/call.
   * Each slice comes from the service that owns its entry; the builtin
   * defaults stand in when a service is not composed.
   */
  const current = (): MemoryConfig => ({
    ...ctx.get('memory')?.settings() ?? DEFAULT_INJECTION_SETTINGS,
    ...ctx.get('projectNotes')?.settings() ?? DEFAULT_NOTES_SETTINGS,
    ...recall,
    ...identitySettings(),
  })

  /**
   * The resolved notes settings. Notes budgets (and the deprecated
   * `notesCharLimit` derivation) resolve in ONE place —
   * {@link resolveNotesSettings} — so the injection side and the notes
   * service cannot drift.
   */
  const notesResolved = (): NotesSettings => ctx.get('projectNotes')?.settings() ?? DEFAULT_NOTES_SETTINGS

  // Per-session frozen memory snapshots (content + index), read once at session/created.
  const sessionMemory = new WeakMap<Session, FrozenSnapshot>()

  // Sessions that already received their one-time digest message. The flag is
  // set only after a NON-EMPTY emission: a zero budget or an empty store
  // leaves it unset, so raising the budget live takes effect on the next step.
  const digestSent = new WeakSet<Session>()

  // Usage-hit ledger (write-path rework Step 2): per session, the entries the
  // current round injected — the standing snapshot's entries (recorded at
  // freeze time) plus the latest auto-recall fence's hits. The
  // `assistant/message` listener weighs the answer against these and books the
  // echoes as store hits. A WeakMap: the ledger dies with its session.
  const hitLedger = new WeakMap<Session, LedgerEntry[]>()

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
    const notes = notesResolved()
    const memory = ctx.get('memory')
    // The project-notes snapshot: rendering is synchronous and side-effect
    // free (prompt-only since 0.6 — nothing is written to the project). The
    // per-kind budgets apply inside snapshotFor, i.e. HERE at freeze time.
    const notesSnapshot: ProjectNotesSnapshot = notes.notesEnabled
      ? ctx.get('projectNotes')?.snapshotFor(session.header?.cwd) ?? EMPTY_NOTES
      : EMPTY_NOTES
    // The identity snapshot (raw, unbudgeted — the section builders apply
    // `soulCharLimit`/`userCharLimit` at assembly, the notes-section
    // precedent): seeding and scanner-side degradation live in the service.
    const identity: IdentitySnapshot = settings.identityEnabled
      ? ctx.get('identity')?.snapshotFor() ?? EMPTY_IDENTITY
      : EMPTY_IDENTITY
    if (memory === undefined) {
      sessionMemory.set(session, { content: '', index: '', notes: notesSnapshot, identity })
      hitLedger.set(session, [])
      return
    }
    const charLimit = settings.memoryCharLimit
    const maxEntries = settings.memoryMaxEntries
    // No double injection: entries rendered into the project-notes section
    // are excluded from the memory section's snapshot/index while notes are
    // enabled.
    const exclude = notes.notesEnabled
      ? (entry: MemoryEntry): boolean => isRenderedEntry(entry, projectNameOf(session)) !== undefined
      : undefined
    // Both snapshots are frozen mode-agnostically: the section reads only the
    // one its live mode needs (content in `full`, index in `index`, neither in
    // `digest`), but freezing both means a live mode switch is served from the
    // same frozen snapshot until the next boundary rather than an empty one.
    const content = readMemorySnapshot(memory, charLimit, exclude, maxEntries)
    const index = readMemoryIndex(memory, charLimit, exclude)
    sessionMemory.set(session, {
      content,
      index,
      notes: notesSnapshot,
      identity,
    })
    // The standing round's ledger books hits against entries the FROZEN
    // prefix actually injected, so only the data-resident modes seed it: in
    // `full` the content snapshot, in `index` the existence lines. In
    // `digest`/`policy-only`/`custom`/`off` no entry data resides, so the
    // ledger starts empty and a fired auto-recall fence fills it per step
    // (below) — otherwise an answer could "hit" entries it was never shown.
    const standingInjectsEntries = (settings.memoryMode === 'full' && content.length > 0)
      || (settings.memoryMode === 'index' && index.length > 0)
    hitLedger.set(session, settings.hitSignalEnabled && standingInjectsEntries ? standingLedger(memory, exclude) : [])
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
  /**
   * The session's frozen snapshot, freezing it on first touch. Sessions created
   * before this fiber (re)applied — a settings change re-runs `apply`, which
   * replaces the per-session maps — have no entry yet; freezing lazily here
   * keeps their sections filled instead of blanking them until the next
   * `session/created`.
   */
  const snapshotOf = (session: Session): FrozenSnapshot => {
    const frozen = sessionMemory.get(session)
    if (frozen !== undefined) return frozen
    freezeFor(session)
    return sessionMemory.get(session) ?? { content: '', index: '', notes: EMPTY_NOTES, identity: EMPTY_IDENTITY }
  }


  // Compaction is the one sanctioned moment to break the KV-cache prefix —
  // the prompt rebuilds anyway — so re-freeze here to surface memories that
  // were learned mid-session (review/flush extraction) without paying the
  // staleness for the rest of the session (Hermes-style boundary invalidation).
  ctx.on('session/event', (session: Session, event) => {
    if (event.type !== 'compaction/end') return
    if (event.data.error !== undefined) return
    // The digest rides the message tail, so a rebuilt prefix re-arms it: the
    // next pre-step re-emits a fresh inventory reflecting mid-session writes.
    digestSent.delete(session)
    try {
      freezeFor(session)
    } catch (error) {
      // Best-effort: keep serving the previous frozen snapshot on failure, but stay observable.
      ctx.get('memory')?.reportFailure('compaction-refreeze', error)
    }
  }, { global: true })

  // Step-tail injection (P1-11 + digest mode): on every agent step, first
  // compute the session's pending one-time <memory-digest> inventory (digest
  // mode, store present, not yet sent this session), then the step's
  // auto-recall fence (BM25 over the store keyed on the user text). The two
  // blocks merge into at most ONE plugin message appended after the step's
  // messages (digest first) — the system prompt and its cached prefix stay
  // untouched. The digest is independent of auto-recall switches; neither
  // runs when the store is absent, and a failure falls through to `next()`
  // unchanged. Fence hits stamp a LIGHTWEIGHT recall (lastRecalledAt only) so
  // lexical query matches never inflate `accessCount` (the eviction signal).
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const settings = current()
      const memory = ctx.get('memory')
      if (memory === undefined) return next()
      const session = sessionOf(payload)

      // The one-time digest: an inventory, not a recall — no markRecalled,
      // no hit ledger. Notes-rendered entries are excluded by the same
      // predicate the snapshot uses, so nothing shows up twice. The
      // per-session flag is set only once the message is actually returned
      // (below), so a throw in the recall branch cannot silently consume it.
      let digestBlock = ''
      let digestEmitting = false
      if (settings.memoryMode === 'digest' && settings.memoryDigestCharLimit > 0 && session !== undefined && !digestSent.has(session)) {
        const exclude = notesResolved().notesEnabled
          ? (entry: MemoryEntry): boolean => isRenderedEntry(entry, projectNameOf(session)) !== undefined
          : undefined
        const digest = buildMemoryDigestText(memory.list(), settings.memoryDigestCharLimit, exclude)
        if (digest.length > 0) {
          digestBlock = digest
          digestEmitting = true
        }
      }

      // The per-step recall fence.
      let recallBlock = ''
      if (settings.autoRecallEnabled) {
        const query = payload.messages.map(userMessageText).join('\n').trim()
        if (query.length >= settings.autoRecallMinChars) {
          // recordRecall: false — the search itself must not count as a tool
          // read; the single lightweight stamp below is the fence's whole
          // write to recall metadata.
          const result = memory.search({ query, limit: settings.autoRecallLimit, recordRecall: false })
          // Soft-decayed and superseded entries stay hidden until deliberately
          // recalled through the tool surface.
          const hits = result.entries.filter(entry => entry.staleSince === undefined && entry.status !== 'superseded')
          if (hits.length > 0) {
            memory.markRecalled(hits.map(entry => entry.id), 'fence')
            // The auto-recall fence replaces the standing round's injected set for
            // the hit ledger: these are the entries the model sees THIS round.
            if (settings.hitSignalEnabled && session !== undefined) hitLedger.set(session, hits.map(toLedgerEntry))
            recallBlock = buildAutoRecallBlock(hits, AUTO_RECALL_CHAR_LIMIT)
          }
        }
      }

      if (digestBlock.length === 0 && recallBlock.length === 0) return next()
      const text = [digestBlock, recallBlock].filter(block => block.length > 0).join('\n\n')
      // The digest inventory and the recall fence are one message: a `snapshot`
      // with one named contribution each, so a consumer can present them apart
      // and knows a later fence supersedes this round's set.
      const sections = [
        ...digestBlock.length > 0 ? [{ name: 'memory-digest', text: digestBlock }] : [],
        ...recallBlock.length > 0 ? [{ name: 'recalled-memory', text: recallBlock }] : [],
      ]
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'memory-context', form: 'snapshot', sections },
      })
      // Committed to emitting: mark the digest sent only now, so any failure
      // above falls through with the flag intact and the digest re-tries.
      if (digestEmitting && session !== undefined) digestSent.add(session)
      return { kind: 'enter', messages: [...payload.messages, message] }
    } catch (error) {
      // Injection must never break the step: fall through unchanged, but stay observable.
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
      const snapshot = session === undefined ? undefined : snapshotOf(session)
      const memoryContent = snapshot?.content ?? ''
      const indexContent = snapshot?.index ?? ''
      return buildMemorySectionText(settings.memoryMode, settings.memoryPolicyCustomText, memoryContent, indexContent)
    },
  }), 'memory-context.section()')

  ctx.effect(() => ctx.systemPrompt.section({
    name: NOTES_SECTION_NAME,
    order: NOTES_SECTION_ORDER,
    text: (context: AssembleContext): string => {
      const notes = notesResolved()
      if (!notes.notesEnabled) return ''
      const session = context.agent?.session
      const snapshot = session === undefined ? undefined : snapshotOf(session)
      // The frozen snapshot already applied the entry-level budgets at freeze
      // time; the live budgets here are the assembly-side final defense
      // (fenceWithin caps the whole section at their sum plus the fence frame).
      return buildNotesSectionText(
        snapshot?.notes.conventions ?? '',
        snapshot?.notes.pitfalls ?? '',
        notes.notesConventionsCharLimit,
        notes.notesPitfallsCharLimit,
      )
    },
  }), 'memory-context.notes-section()')

  ctx.effect(() => ctx.systemPrompt.section({
    name: SOUL_SECTION_NAME,
    order: SOUL_SECTION_ORDER,
    text: (context: AssembleContext): string => {
      const settings = current()
      if (!settings.identityEnabled) return ''
      const session = context.agent?.session
      const snapshot = session === undefined ? undefined : snapshotOf(session)
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
      const snapshot = session === undefined ? undefined : snapshotOf(session)
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
