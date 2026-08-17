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
import { MemoryStore, MemoryId, scanContent, validateProjectScope } from '../index.ts'
import type {
  AddMemoryInput,
  AddMemoryResult,
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

/** The memory domain spec: one table of memory entries keyed by id. */
const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 0,
  tables: {
    entries: domainTable<MemoryId, MemoryEntry>(memoryEntrySchema as unknown as z.ZodType<MemoryEntry>),
  },
})

/** The opened memory domain handle, typed for the `entries` table. */
type MemoryDomain = Domain<typeof memoryDomainSpec>

/** The entries table from the opened domain. */
type EntriesTable = KvTable<MemoryId, MemoryEntry>

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

  ctx.effect(() => async () => { await domain.close() })

  ctx.provide('memory', new DomainMemoryStore(entries))
}

/**
 * MemoryStore implementation backed by a storage-domain KV table.
 * Reads are synchronous from memory; writes serialize on the domain chain.
 */
class DomainMemoryStore extends MemoryStore {
  private readonly entries: EntriesTable

  constructor(entries: EntriesTable) {
    super()
    this.entries = entries
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
    return updated
  }

  override async remove(id: MemoryId): Promise<boolean> {
    return this.entries.delete(id)
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
}
