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
import { MemoryStore, MemoryId, AuditId, scanContent, validateProjectScope, validateContent } from '../index.ts'
import { Bm25Index, tokenizeForSearch } from './bm25.ts'
import type {
  AddMemoryInput,
  AddMemoryResult,
  AuditEntry,
  AuditOp,
  AuditSource,
  MemoryEntry,
  MemoryHealth,
  MemorySearchQuery,
  SearchMemoryResult,
  UpdateMemoryInput,
} from '../types.ts'

/** Zod schema for one memory entry record on the durable medium. */
const memoryEntrySchema = z.object({
  id: z.string().min(1),
  scope: z.enum(['global', 'project', 'user']),
  category: z.enum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk', 'procedure']).optional(),
  content: z.string(),
  projectName: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  pinned: z.boolean().optional(),
  lastRecalledAt: z.number().optional(),
  staleSince: z.number().optional(),
})

/** Zod schema for one audit-record entry on the durable medium. */
const auditEntrySchema = z.object({
  id: z.string().min(1),
  op: z.enum(['add', 'update', 'remove']),
  entryId: z.string().min(1),
  scope: z.enum(['global', 'project', 'user']),
  category: z.enum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk', 'procedure']).optional(),
  source: z.enum(['tool', 'review', 'flush', 'ui', 'janitor']),
  sessionId: z.string().optional(),
  ts: z.number(),
  seq: z.number().optional(),
  contentPreview: z.string(),
})

/**
 * The memory domain spec: `entries` (memory records keyed by id) plus `audit`
 * (mutation audit trail). Domain version stays at 0 — the `audit` table is a
 * forward-compatible addition: storage-json reads only declared tables and
 * initializes any absent table as an empty map, so existing v0 media reopen
 * without migration.
 */
const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 0,
  tables: {
    entries: domainTable<MemoryId, MemoryEntry>(memoryEntrySchema as unknown as z.ZodType<MemoryEntry>),
    audit: domainTable<AuditId, AuditEntry>(auditEntrySchema as unknown as z.ZodType<AuditEntry>),
  },
})

/** The opened memory domain handle, typed for its tables. */
type MemoryDomain = Domain<typeof memoryDomainSpec>

/** The entries table from the opened domain. */
type EntriesTable = KvTable<MemoryId, MemoryEntry>

/** The audit table from the opened domain. */
type AuditTable = KvTable<AuditId, AuditEntry>

/** Maximum audit records retained; oldest are trimmed on overflow. */
const DEFAULT_AUDIT_CAP = 200

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

  ctx.effect(() => async () => { await domain.close() })

  ctx.provide('memory', new DomainMemoryStore(entries, audit))
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
  private readonly auditCap: number
  /** Last audit `seq` handed out; lazily initialized from the medium on first append. */
  private auditSeq: number | undefined

  constructor(entries: EntriesTable, audit: AuditTable, auditCap: number = DEFAULT_AUDIT_CAP) {
    super()
    this.entries = entries
    this.audit = audit
    this.auditCap = auditCap
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
    const now = Date.now()
    const id = MemoryId()
    const entry: MemoryEntry = {
      id,
      scope: input.scope,
      category: input.category,
      content: input.content,
      projectName: input.projectName,
      createdAt: now,
      updatedAt: now,
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
    const updated: MemoryEntry = {
      ...existing,
      content: newContent,
      category: input.category ?? existing.category,
      updatedAt: Date.now(),
    }
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
    // Rank by BM25 relevance (desc), then pinned entries (desc), then by
    // recency (updatedAt desc). Pinned entries surface early even among
    // equal-relevance matches — pin means "the user wants this remembered".
    const pinOf = (entry: MemoryEntry): number => entry.pinned === true ? 1 : 0
    ranked.sort((a, b) => b.score - a.score || pinOf(b.entry) - pinOf(a.entry) || b.entry.updatedAt - a.entry.updatedAt)
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
   * `lastRecalledAt` on each entry so the janitor can track staleness.
   * `updatedAt` is intentionally left untouched: recalling is not mutating.
   */
  private async stampRecalled(entries: readonly MemoryEntry[]): Promise<void> {
    const now = Date.now()
    for (const entry of entries) {
      // Recall proves usefulness: it refreshes lastRecalledAt AND clears a
      // soft-decay stamp, bringing the entry back into injection surfaces.
      if (entry.lastRecalledAt === now && entry.staleSince === undefined) continue
      const { staleSince: _cleared, ...rest } = entry
      await this.entries.put(entry.id, { ...rest, lastRecalledAt: now })
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
      // global/user: soft decay only — stamp once, never auto-delete.
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
    }
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
    } catch {
      // Best-effort: an audit failure must never propagate to the caller.
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
