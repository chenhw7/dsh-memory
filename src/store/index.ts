/**
 * storage-domain provider for the long-term memory store. Opens a `memory`
 * domain with one table (`entries`) keyed by `MemoryId` and implements the
 * {@link MemoryStore} abstract service against it. Reads are synchronous from
 * the domain's authoritative in-memory state; writes serialize on the domain's
 * write chain and reach the backend before updating memory.
 *
 * The provider is a function plugin that mounts on `ctx.memory` after the
 * `storage-domain` facility is available.
 *
 * @module @chenhw7/dsh-memory/store
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { MemoryStore, MemoryId, AuditId, SuggestionId, scanContent, validateProjectScope, validateContent } from '../index.ts'
import { Bm25Index, tokenizeForSearch } from './bm25.ts'
import { jaccardSimilarity, tokenize } from '../review/dedup.ts'
import type {
  AddMemoryInput,
  AddMemoryResult,
  AddSuggestionInput,
  AdoptSuggestionOverride,
  AuditEntry,
  AuditOp,
  AuditSource,
  MemoryEntry,
  MemoryHealth,
  MemorySearchQuery,
  MemorySuggestion,
  SearchMemoryResult,
  UpdateMemoryInput,
} from '../types.ts'

/** Zod schema for one memory entry record on the durable medium. */
const memoryEntrySchema = z.object({
  id: z.string().min(1),
  scope: z.enum(['global', 'project', 'user']),
  category: z.enum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk', 'procedure']).optional(),
  content: z.string(),
  summary: z.string().optional(),
  projectName: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  pinned: z.boolean().optional(),
  lastRecalledAt: z.number().optional(),
  staleSince: z.number().optional(),
  accessCount: z.number().optional(),
  importance: z.number().optional(),
})

/** Zod schema for one audit-record entry on the durable medium. */
const auditEntrySchema = z.object({
  id: z.string().min(1),
  op: z.enum(['add', 'update', 'remove', 'readRaw']),
  entryId: z.string().min(1),
  scope: z.enum(['global', 'project', 'user']),
  category: z.enum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk', 'procedure']).optional(),
  source: z.enum(['tool', 'review', 'flush', 'ui', 'janitor']),
  sessionId: z.string().optional(),
  ts: z.number(),
  seq: z.number().optional(),
  contentPreview: z.string(),
})

/** Zod schema for one pending suggestion in the human-review queue (P1-1). */
const suggestionSchema = z.object({
  id: z.string().min(1),
  scope: z.enum(['global', 'project', 'user']),
  category: z.enum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk', 'procedure']).optional(),
  content: z.string(),
  summary: z.string().optional(),
  projectName: z.string().optional(),
  hits: z.number(),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  targetEntryId: z.string().optional(),
  source: z.enum(['tool', 'review', 'flush', 'ui', 'janitor']),
  sessionId: z.string().optional(),
})

/**
 * The memory domain spec: `entries` (memory records keyed by id) plus `audit`
 * (mutation audit trail) plus `suggestions` (P1-1 pending-review queue).
 * Domain version stays at 0 — both later tables are forward-compatible
 * additions: storage-json reads only declared tables and initializes any
 * absent table as an empty map, so existing v0 media reopen without migration.
 */
const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 0,
  tables: {
    entries: domainTable<MemoryId, MemoryEntry>(memoryEntrySchema as unknown as z.ZodType<MemoryEntry>),
    audit: domainTable<AuditId, AuditEntry>(auditEntrySchema as unknown as z.ZodType<AuditEntry>),
    suggestions: domainTable<SuggestionId, MemorySuggestion>(suggestionSchema as unknown as z.ZodType<MemorySuggestion>),
  },
})

/** The opened memory domain handle, typed for its tables. */
type MemoryDomain = Domain<typeof memoryDomainSpec>

/** The entries table from the opened domain. */
type EntriesTable = KvTable<MemoryId, MemoryEntry>

/** The audit table from the opened domain. */
type AuditTable = KvTable<AuditId, AuditEntry>

/** The suggestions table from the opened domain (P1-1 review queue). */
type SuggestionsTable = KvTable<SuggestionId, MemorySuggestion>

/** Maximum audit records retained; oldest are trimmed on overflow. */
const DEFAULT_AUDIT_CAP = 200

/**
 * Maximum pending suggestions retained (P1-1). Overflow evicts the
 * lowest-signal rows first: fewest hits, then oldest `lastSeenAt`.
 */
const DEFAULT_SUGGESTION_CAP = 200

/**
 * Jaccard similarity above which two same-scope proposals count as the same
 * suggestion (re-observation, not a new row). Matches the entry-dedup
 * prefilter threshold so "the model keeps proposing X" and "X is already
 * stored" draw the same near-duplicate line.
 */
const SUGGESTION_DUP_THRESHOLD = 0.15

/**
 * Deterministic audit ordering: newest/oldest by `ts`, ties broken by the
 * monotonic append `seq`, then by id for records written before `seq` existed.
 * Ids are random UUIDs, so without `seq` a burst of writes inside one
 * millisecond would order non-deterministically.
 */
function compareAuditDesc(a: AuditEntry, b: AuditEntry): number {
  return b.ts - a.ts || (b.seq ?? 0) - (a.seq ?? 0) || (a.id < b.id ? -1 : 1)
}

/** Ascending counterpart of {@link compareAuditDesc} (append order). */
function compareAuditAsc(a: AuditEntry, b: AuditEntry): number {
  return a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0) || (a.id < b.id ? -1 : 1)
}

/** Cordis plugin name. */
export const name = 'memory-store-domain'

/** Services required before this provider can mount. */
export const inject = ['storageDomain']

/**
 * Mount the storage-domain memory store provider. Opens the `memory` domain
 * and registers a {@link MemoryStore} subclass on `ctx.memory`.
 * @param ctx - Cordis context with `storageDomain` injected.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain: MemoryDomain = await ctx.storageDomain.open(memoryDomainSpec)
  const entries: EntriesTable = domain.table('entries')
  const audit: AuditTable = domain.table('audit')
  const suggestions: SuggestionsTable = domain.table('suggestions')

  ctx.effect(() => async () => { await domain.close() })

  ctx.provide('memory', new DomainMemoryStore(entries, audit, suggestions, DEFAULT_AUDIT_CAP, DEFAULT_SUGGESTION_CAP, ctx.logger))
}

/**
 * MemoryStore implementation backed by a storage-domain KV table. Reads are
 * synchronous from memory; writes serialize on the domain chain. Every
 * successful mutation appends one record to the `audit` table (best-effort:
 * an audit failure never breaks the primary write).
 */
export class DomainMemoryStore extends MemoryStore {
  private readonly entries: EntriesTable
  private readonly audit: AuditTable
  private readonly suggestions: SuggestionsTable
  private readonly auditCap: number
  private readonly suggestionCap: number
  /** Warn channel for swallowed background-path failures; the host `ctx.logger`. */
  private readonly failureLogger: { warn(message: string): void } | undefined
  /** Per-site counts of swallowed failures, surfaced through `health()`. */
  private readonly failureCounts = new Map<string, number>()
  /** Last audit `seq` handed out; lazily initialized from the medium on first append. */
  private auditSeq: number | undefined

  constructor(
    entries: EntriesTable,
    audit: AuditTable,
    suggestions: SuggestionsTable,
    auditCap: number = DEFAULT_AUDIT_CAP,
    suggestionCap: number = DEFAULT_SUGGESTION_CAP,
    failureLogger?: { warn(message: string): void },
  ) {
    super()
    this.entries = entries
    this.audit = audit
    this.suggestions = suggestions
    this.auditCap = auditCap
    this.suggestionCap = suggestionCap
    this.failureLogger = failureLogger
  }

  override reportFailure(site: string, error?: unknown): void {
    this.failureCounts.set(site, (this.failureCounts.get(site) ?? 0) + 1)
    this.failureLogger?.warn(`dsh-memory: ${site} failed${error === undefined ? '' : `: ${String(error)}`}`)
  }

  /** Next monotonic audit sequence number (survives reopen via the medium). */
  private nextAuditSeq(): number {
    if (this.auditSeq === undefined) {
      let max = 0
      for (const [, record] of this.audit.entries()) max = Math.max(max, record.seq ?? 0)
      this.auditSeq = max
    }
    this.auditSeq += 1
    return this.auditSeq
  }

  override async add(input: AddMemoryInput): Promise<AddMemoryResult> {
    validateProjectScope(input)
    validateContent(input.content)
    const scan = scanContent(input.content)
    if (!scan.allowed) {
      throw new Error(`memory content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    const summaryScan = scanContent(input.summary ?? '')
    if (!summaryScan.allowed) {
      throw new Error(`memory summary rejected by scanner: ${summaryScan.reasons.join('; ')}`)
    }
    const now = Date.now()
    const id = MemoryId()
    const entry: MemoryEntry = {
      id,
      scope: input.scope,
      category: input.category,
      content: input.content,
      ...(input.summary !== undefined && input.summary.length > 0 ? { summary: input.summary } : {}),
      projectName: input.projectName,
      createdAt: now,
      updatedAt: now,
      ...clampImportance(input.importance),
    }
    await this.entries.put(id, entry)
    await this.appendAudit('add', id, entry, input.source, input.sessionId)
    return { entry }
  }

  override get(id: MemoryId): MemoryEntry | undefined {
    return this.entries.get(id)
  }

  override list(scope?: MemoryEntry['scope'], projectName?: string): readonly MemoryEntry[] {
    const results: MemoryEntry[] = []
    for (const [, entry] of this.entries.entries()) {
      if (scope !== undefined && entry.scope !== scope) continue
      if (projectName !== undefined && entry.projectName !== projectName) continue
      results.push(entry)
    }
    return results.sort((a, b) => a.createdAt - b.createdAt)
  }

  override async update(id: MemoryId, input: UpdateMemoryInput): Promise<MemoryEntry | undefined> {
    const existing = this.entries.get(id)
    if (existing === undefined) return undefined
    const newContent = input.content ?? existing.content
    validateContent(newContent)
    const scan = scanContent(newContent)
    if (!scan.allowed) {
      throw new Error(`memory content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    // Scans only what this call writes: an entry stored before summary scanning
    // existed stays updatable, so its summary can still be repaired or cleared.
    const summaryScan = scanContent(input.summary ?? '')
    if (!summaryScan.allowed) {
      throw new Error(`memory summary rejected by scanner: ${summaryScan.reasons.join('; ')}`)
    }
    // summary semantics: `undefined` = keep existing; `''` = explicitly clear;
    // a non-empty string = replace. Build the updated entry accordingly.
    const base: MemoryEntry = {
      ...existing,
      content: newContent,
      category: input.category ?? existing.category,
      updatedAt: Date.now(),
      // Only rewrite the field when the caller supplies one; `undefined`
      // keeps the stored importance (add-time assessment stands).
      ...clampImportance(input.importance),
    }
    const updated: MemoryEntry = input.summary === ''
      ? (() => { const { summary: _c, ...rest } = base; return rest as MemoryEntry })()
      : input.summary !== undefined
        ? { ...base, summary: input.summary }
        : base
    await this.entries.put(id, updated)
    await this.appendAudit('update', id, updated, input.source, input.sessionId)
    return updated
  }

  override async remove(id: MemoryId): Promise<boolean> {
    const existing = this.entries.get(id)
    if (existing === undefined) return false
    const removed = await this.entries.delete(id)
    if (removed) {
      await this.appendAudit('remove', id, existing, undefined, undefined)
    }
    return removed
  }

  override search(query: MemorySearchQuery): SearchMemoryResult {
    const limit = query.limit ?? 50
    // Structured filters first; scoring runs over the surviving candidates.
    const candidates: MemoryEntry[] = []
    for (const [, entry] of this.entries.entries()) {
      if (query.scope !== undefined && entry.scope !== query.scope) continue
      if (query.category !== undefined && entry.category !== query.category) continue
      if (query.projectName !== undefined && entry.projectName !== query.projectName) continue
      candidates.push(entry)
    }
    const queryTokens = query.query !== undefined && query.query.length > 0 ? tokenizeForSearch(query.query) : []
    let ranked: { entry: MemoryEntry; score: number }[]
    if (queryTokens.length > 0) {
      // BM25 over the filtered set: relevance-weighted (IDF × saturation),
      // CJK bigrams for word-level Chinese precision. OR semantics preserved —
      // any shared term scores above zero and keeps the document in play.
      const index = new Bm25Index(candidates.map(entry => tokenizeForSearch(entry.content)))
      const scores = index.scores(queryTokens)
      ranked = []
      candidates.forEach((entry, i) => {
        const score = scores[i] ?? 0
        if (score > 0) ranked.push({ entry, score })
      })
    } else {
      ranked = candidates.map(entry => ({ entry, score: 0 }))
    }
    // Rank by BM25 relevance (desc), then pinned entries (desc), then the
    // model-assessed importance (desc; absent reads as mid-range so unassessed
    // entries are not penalized), then by recency (updatedAt desc). Pinned
    // entries surface early even among equal-relevance matches — pin means
    // "the user wants this remembered"; importance is the model's weaker,
    // optional version of the same judgment.
    const pinOf = (entry: MemoryEntry): number => entry.pinned === true ? 1 : 0
    const importanceOf = (entry: MemoryEntry): number => entry.importance ?? 0
    ranked.sort((a, b) =>
      b.score - a.score
      || pinOf(b.entry) - pinOf(a.entry)
      || importanceOf(b.entry) - importanceOf(a.entry)
      || b.entry.updatedAt - a.entry.updatedAt)
    let all = ranked.map(r => r.entry)
    const total = all.length
    all = limit > 0 ? all.slice(0, limit) : all
    // Fire-and-forget: stamp the returned entries with a recall timestamp
    // so the janitor can decay entries that have not been recalled recently.
    // Read-only consumers (management UI) opt out via recordRecall: false —
    // merely viewing entries must not rewrite their recall metadata.
    if (query.recordRecall !== false) void this.stampRecalled(all)
    return { entries: all, total }
  }

  /**
   * Stamp entries with a recall timestamp (fire-and-forget). Updates
   * `lastRecalledAt` on each entry so the janitor can track staleness, and
   * bumps `accessCount` — the mechanical use-signal ranking and eviction
   * weigh. `updatedAt` is intentionally left untouched: recalling is not
   * mutating.
   */
  private async stampRecalled(entries: readonly MemoryEntry[]): Promise<void> {
    const now = Date.now()
    for (const entry of entries) {
      // Recall proves usefulness: it refreshes lastRecalledAt AND clears a
      // soft-decay stamp, bringing the entry back into injection surfaces.
      if (entry.lastRecalledAt === now && entry.staleSince === undefined) continue
      const { staleSince: _cleared, ...rest } = entry
      await this.entries.put(entry.id, {
        ...rest,
        lastRecalledAt: now,
        accessCount: (rest.accessCount ?? 0) + 1,
      })
    }
  }

  /**
   * Record that the caller actually surfaced the given entries to the model
   * (e.g. `memory_get` / `memory_list` tool results). Fire-and-forget; never
   * throws into the caller. The base-class default is a no-op so providers
   * without recall tracking stay contract-conformant.
   */
  override markRecalled(ids: readonly string[]): void {
    if (ids.length === 0) return
    void this.stampRecalled(ids.map(id => this.entries.get(id as MemoryId)).filter((e): e is MemoryEntry => e !== undefined))
  }

  // ─── Suggestion queue (P1-1 optional human-confirm mode) ──────────────────

  /**
   * Record one extraction/model proposal in the pending-review queue.
   *
   * Dedup semantics ("frequency is signal", evolve-style): when a similar
   * proposal already exists in the same scope — or one targeting the same
   * entry — the observation bumps its `hits` and refreshes `lastSeenAt`
   * instead of creating a row; missing metadata (category/summary) is filled
   * from the newer proposal, and strictly more informative content (a
   * superset) replaces the original. Otherwise the proposal joins with
   * `hits: 1`.
   * @param input - the proposal to record.
   * @returns the stored suggestion (existing row updated, or newly created).
   * @throws when the proposed content or summary fails validation or the scanner.
   */
  override async observeSuggestion(input: AddSuggestionInput): Promise<MemorySuggestion> {
    validateProjectScope({ ...input, projectName: input.projectName ?? (input.targetEntryId !== undefined ? this.entries.get(input.targetEntryId)?.projectName : undefined) })
    validateContent(input.content)
    const scan = scanContent(input.content)
    if (!scan.allowed) {
      throw new Error(`suggestion content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    const summaryScan = scanContent(input.summary ?? '')
    if (!summaryScan.allowed) {
      throw new Error(`suggestion summary rejected by scanner: ${summaryScan.reasons.join('; ')}`)
    }
    const now = Date.now()
    // Match against existing proposals: same target entry wins outright;
    // otherwise nearest-content in the same scope above the dedup threshold.
    let matched: MemorySuggestion | undefined
    for (const [, suggestion] of this.suggestions.entries()) {
      if (input.targetEntryId !== undefined) {
        if (suggestion.targetEntryId === input.targetEntryId) { matched = suggestion; break }
        continue
      }
      if (suggestion.scope !== input.scope) continue
      const similarity = jaccardSimilarity(tokenize(input.content), tokenize(suggestion.content))
      if (similarity > SUGGESTION_DUP_THRESHOLD) { matched = suggestion; break }
    }
    if (matched !== undefined) {
      const improved = input.content.length > matched.content.length && input.content.includes(matched.content)
      const updated: MemorySuggestion = {
        ...matched,
        content: improved ? input.content : matched.content,
        category: matched.category ?? input.category,
        summary: matched.summary ?? input.summary,
        projectName: matched.projectName ?? input.projectName,
        hits: matched.hits + 1,
        lastSeenAt: now,
      }
      await this.suggestions.put(matched.id, updated)
      return updated
    }
    const suggestion: MemorySuggestion = {
      id: SuggestionId(),
      scope: input.scope,
      content: input.content,
      hits: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      source: input.source,
      ...input.category !== undefined ? { category: input.category } : {},
      ...input.summary !== undefined ? { summary: input.summary } : {},
      ...input.projectName !== undefined ? { projectName: input.projectName } : {},
      ...input.targetEntryId !== undefined ? { targetEntryId: input.targetEntryId } : {},
      ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
    }
    await this.suggestions.put(suggestion.id, suggestion)
    await this.trimSuggestions()
    return suggestion
  }

  /**
   * List pending suggestions for the review UI: highest `hits` first (the
   * repeatedly-re-proposed signals float up), then most recently seen.
   */
  override listSuggestions(): readonly MemorySuggestion[] {
    const all: MemorySuggestion[] = []
    for (const [, suggestion] of this.suggestions.entries()) all.push(suggestion)
    return all.sort((a, b) => b.hits - a.hits || b.lastSeenAt - a.lastSeenAt || (a.id < b.id ? -1 : 1))
  }

  override getSuggestion(id: SuggestionId): MemorySuggestion | undefined {
    return this.suggestions.get(id)
  }

  /**
   * Adopt one pending suggestion — the human yes that turns a proposal into
   * memory. With `targetEntryId` set, the (possibly edited) content updates
   * the targeted entry (P1-2: the model's change applies only here);
   * otherwise a new entry is created. The override carries the "edit before
   * adopt" tweaks made in the review UI. The adopted write goes through the
   * full store contract (scanner included) and the audit trail with source
   * `'ui'`; the suggestion row is removed afterwards.
   * @param id - the suggestion id.
   * @param override - optional human edits applied on top of the proposal.
   * @returns the written entry, or `undefined` when the suggestion is gone.
   */
  override async adoptSuggestion(id: SuggestionId, override?: AdoptSuggestionOverride): Promise<MemoryEntry | undefined> {
    const suggestion = this.suggestions.get(id)
    if (suggestion === undefined) return undefined
    const content = override?.content ?? suggestion.content
    validateContent(content)
    const scan = scanContent(content)
    if (!scan.allowed) {
      throw new Error(`adopted content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    const category = override?.category !== undefined
      ? (override.category.length > 0 ? override.category : undefined)
      : suggestion.category
    const summary = override?.summary !== undefined
      ? (override.summary.length > 0 ? override.summary : undefined)
      : suggestion.summary
    let entry: MemoryEntry | undefined
    if (suggestion.targetEntryId !== undefined && this.entries.get(suggestion.targetEntryId) !== undefined) {
      entry = await this.update(suggestion.targetEntryId, {
        content,
        ...(category !== undefined ? { category } : {}),
        ...(summary !== undefined ? { summary } : { summary: '' }),
        source: 'ui',
      })
    } else {
      const result = await this.add({
        scope: suggestion.scope,
        content,
        source: 'ui',
        ...(category !== undefined ? { category } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(suggestion.projectName !== undefined ? { projectName: suggestion.projectName } : {}),
      })
      entry = result.entry
    }
    await this.suggestions.delete(id)
    return entry
  }

  /**
   * Reject one pending suggestion: the row leaves the queue and nothing is
   * written. @returns whether a suggestion was actually removed.
   */
  override async rejectSuggestion(id: SuggestionId): Promise<boolean> {
    return this.suggestions.delete(id)
  }

  /** Trim the suggestion queue to its cap, evicting the lowest-signal rows. */
  private async trimSuggestions(): Promise<void> {
    if (this.suggestions.size <= this.suggestionCap) return
    const all = [...this.suggestions.entries()].map(([, s]) => s)
    all.sort((a, b) => a.hits - b.hits || a.lastSeenAt - b.lastSeenAt)
    const excess = all.length - this.suggestionCap
    for (let i = 0; i < excess; i++) {
      await this.suggestions.delete(all[i]!.id)
    }
  }

  override async pin(id: MemoryId): Promise<MemoryEntry | undefined> {
    const existing = this.entries.get(id)
    if (existing === undefined) return undefined
    const updated: MemoryEntry = { ...existing, pinned: true }
    await this.entries.put(id, updated)
    return updated
  }

  override async unpin(id: MemoryId): Promise<MemoryEntry | undefined> {
    const existing = this.entries.get(id)
    if (existing === undefined) return undefined
    const updated: MemoryEntry = { ...existing, pinned: false }
    await this.entries.put(id, updated)
    return updated
  }

  /**
   * Archive one entry manually (P1-7): stamp `staleSince` (idempotent — an
   * already-stale entry is returned unchanged) and record a `'ui'`-sourced
   * audit update. Hidden from injection; still searchable; recall revives.
   */
  override async archiveEntry(id: MemoryId): Promise<MemoryEntry | undefined> {
    const existing = this.entries.get(id)
    if (existing === undefined) return undefined
    if (existing.staleSince !== undefined) return existing
    const updated: MemoryEntry = { ...existing, staleSince: Date.now() }
    await this.entries.put(id, updated)
    await this.appendAudit('update', id, updated, 'ui', undefined)
    return updated
  }

  /** Lift a manual or janitor dormancy stamp without counting it as a recall. */
  override async unarchiveEntry(id: MemoryId): Promise<MemoryEntry | undefined> {
    const existing = this.entries.get(id)
    if (existing === undefined || existing.staleSince === undefined) return existing
    const { staleSince: _cleared, ...rest } = existing
    const updated: MemoryEntry = rest as MemoryEntry
    await this.entries.put(id, updated)
    await this.appendAudit('update', id, updated, 'ui', undefined)
    return updated
  }

  /**
   * Run the janitor pass with the lifecycle's two-tier policy:
   * - `project` entries overdue by `decayDays` (pinned exempt) are REMOVED
   *   (hard decay, audited).
   * - `global`/`user` entries overdue (pinned exempt) are soft-decayed: the
   *   first overdue pass stamps `staleSince`, which hides them from injection
   *   surfaces while keeping them searchable; a later recall clears the stamp.
   * @param decayDays - days without recall before the policy applies.
   * @param now - evaluation clock; defaults to wall time (tests inject fixed clocks).
   * @returns the number of project entries removed.
   */
  override async janitor(decayDays: number, now: number = Date.now()): Promise<number> {
    if (decayDays <= 0) return 0
    const decayMs = decayDays * 24 * 60 * 60 * 1000
    let removed = 0
    for (const [, entry] of this.entries.entries()) {
      if (entry.pinned === true) continue
      // Use lastRecalledAt if available, otherwise fall back to createdAt.
      const lastActive = entry.lastRecalledAt ?? entry.createdAt
      if (now - lastActive < decayMs) continue
      if (entry.scope === 'project') {
        // Hard decay: remove and log to the audit store.
        const didRemove = await this.entries.delete(entry.id)
        if (didRemove) {
          removed++
          await this.appendAudit('remove', entry.id, entry, 'janitor', undefined)
        }
        continue
      }
      // global/user: soft decay only — stamp once, never auto-delete. A
      // model-assessed importance of 4–5 extends the grace window 1.5×: a
      // "this matters" judgment should survive a longer quiet period, while
      // low or unassessed entries keep the plain clock. Recall (accessCount)
      // stays the stronger signal — it clears decay outright via stampRecalled.
      const graceFactor = entry.importance !== undefined && entry.importance >= 4 ? 1.5 : 1
      if (now - lastActive < decayMs * graceFactor) continue
      if (entry.staleSince !== undefined) continue
      const stamped: MemoryEntry = { ...entry, staleSince: now }
      await this.entries.put(entry.id, stamped)
      await this.appendAudit('update', entry.id, stamped, 'janitor', undefined)
    }
    return removed
  }

  /**
   * List audit records, newest first. Each audit record captures one mutation.
   * @returns all audit entries ordered by `ts` descending (then `id` for stability).
   */
  listAudit(): readonly AuditEntry[] {
    const all: AuditEntry[] = []
    for (const [, record] of this.audit.entries()) all.push(record)
    all.sort(compareAuditDesc)
    return all
  }

  override health(): MemoryHealth {
    let global = 0, project = 0, user = 0, pinned = 0, stale = 0
    for (const [, entry] of this.entries.entries()) {
      if (entry.scope === 'global') global++
      else if (entry.scope === 'project') project++
      else user++
      if (entry.pinned === true) pinned++
      if (entry.staleSince !== undefined) stale++
    }
    const audit = this.listAudit()
    const lastActivityTs = audit.length > 0 ? audit[0]!.ts : undefined
    const lastExtractionRecord = audit.find(r => r.source === 'review' || r.source === 'flush')
    const lastExtractionTs = lastExtractionRecord?.ts
    return {
      totalEntries: global + project + user,
      byScope: { global, project, user },
      pinned,
      auditRecords: audit.length,
      stale,
      ...lastActivityTs !== undefined ? { lastActivityTs } : {},
      ...lastExtractionTs !== undefined ? { lastExtractionTs } : {},
      ...this.failureCounts.size > 0 ? { backgroundFailures: Object.fromEntries(this.failureCounts) } : {},
    }
  }

  override async getRaw(id: MemoryId): Promise<MemoryEntry | undefined> {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    await this.appendAudit('readRaw', id, entry, 'ui', undefined)
    return entry
  }

  override exportAuditLog(): readonly AuditEntry[] {
    const all: AuditEntry[] = []
    for (const [, record] of this.audit.entries()) all.push(record)
    all.sort(compareAuditAsc)
    return all
  }

  /**
   * Append one audit record after a successful mutation, then trim the table
   * to the cap (keep newest). Best-effort: a failure here is swallowed so it
   * never breaks the primary write path.
   */
  private async appendAudit(
    op: AuditOp,
    entryId: MemoryId,
    entry: Pick<MemoryEntry, 'scope' | 'category' | 'content'>,
    source: AuditSource | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    try {
      const record: AuditEntry = {
        id: AuditId(),
        op,
        entryId,
        scope: entry.scope,
        ...entry.category !== undefined ? { category: entry.category } : {},
        source: source ?? 'tool',
        ...sessionId !== undefined ? { sessionId } : {},
        ts: Date.now(),
        seq: this.nextAuditSeq(),
        contentPreview: preview(entry.content),
      }
      await this.audit.put(record.id, record)
      await this.trimAudit()
    } catch (error) {
      // Best-effort: an audit failure must never propagate to the caller.
      this.reportFailure('audit-append', error)
    }
  }

  /** Trim the audit table to the cap, deleting the oldest records. */
  private async trimAudit(): Promise<void> {
    if (this.audit.size <= this.auditCap) return
    const all: AuditEntry[] = []
    for (const [, record] of this.audit.entries()) all.push(record)
    all.sort(compareAuditAsc)
    const excess = all.length - this.auditCap
    for (let i = 0; i < excess; i++) {
      await this.audit.delete(all[i]!.id)
    }
  }
}

/** Truncate content to a scanner-clean ~100-char preview for the audit trail. */
function preview(content: string): string {
  const p = content.slice(0, 100)
  return scanContent(p).allowed ? p : '[content redacted]'
}

/** Importances land in 1–5 regardless of what the caller passed in. */
const IMPORTANCE_MIN = 1
const IMPORTANCE_MAX = 5

/**
 * Project an optional caller-supplied importance onto the entry-field spread:
 * absent input spreads nothing (stored value stands); out-of-range input is
 * clamped rather than rejected — a wrong assessment is not a protocol error.
 */
function clampImportance(importance: number | undefined): { importance: number } | Record<string, never> {
  if (importance === undefined || Number.isNaN(importance)) return {}
  const clamped = Math.min(IMPORTANCE_MAX, Math.max(IMPORTANCE_MIN, Math.round(importance)))
  return { importance: clamped }
}
