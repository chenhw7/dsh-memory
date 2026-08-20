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
import { MemoryStore, MemoryId, AuditId, scanContent, validateProjectScope } from '../index.ts'
import type {
  AddMemoryInput,
  AddMemoryResult,
  AuditEntry,
  AuditOp,
  AuditSource,
  MemoryEntry,
  MemorySearchQuery,
  SearchMemoryResult,
  UpdateMemoryInput,
} from '../types.ts'

/** Zod schema for one memory entry record on the durable medium. */
const memoryEntrySchema = z.object({
  id: z.string().min(1),
  scope: z.enum(['global', 'project', 'user']),
  category: z.enum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk']).optional(),
  content: z.string(),
  projectName: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** Zod schema for one audit-record entry on the durable medium. */
const auditEntrySchema = z.object({
  id: z.string().min(1),
  op: z.enum(['add', 'update', 'remove']),
  entryId: z.string().min(1),
  scope: z.enum(['global', 'project', 'user']),
  category: z.enum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk']).optional(),
  source: z.enum(['tool', 'review', 'flush', 'ui']),
  sessionId: z.string().optional(),
  ts: z.number(),
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

  constructor(entries: EntriesTable, audit: AuditTable, auditCap: number = DEFAULT_AUDIT_CAP) {
    super()
    this.entries = entries
    this.audit = audit
    this.auditCap = auditCap
  }

  override async add(input: AddMemoryInput): Promise<AddMemoryResult> {
    validateProjectScope(input)
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
    let all: MemoryEntry[] = []
    for (const [, entry] of this.entries.entries()) {
      if (query.scope !== undefined && entry.scope !== query.scope) continue
      if (query.category !== undefined && entry.category !== query.category) continue
      if (query.projectName !== undefined && entry.projectName !== query.projectName) continue
      if (query.query !== undefined && query.query.length > 0) {
        const needle = query.query.toLowerCase()
        if (!entry.content.toLowerCase().includes(needle)) continue
      }
      all.push(entry)
    }
    all.sort((a, b) => b.updatedAt - a.updatedAt)
    const total = all.length
    all = limit > 0 ? all.slice(0, limit) : all
    return { entries: all, total }
  }

  /**
   * List audit records, newest first. Each audit record captures one mutation.
   * @returns all audit entries ordered by `ts` descending (then `id` for stability).
   */
  listAudit(): readonly AuditEntry[] {
    const all: AuditEntry[] = []
    for (const [, record] of this.audit.entries()) all.push(record)
    all.sort((a, b) => b.ts - a.ts || (a.id > b.id ? -1 : 1))
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
    all.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
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
