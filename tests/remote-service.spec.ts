import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryId, scanContent, validateProjectScope, validateContent } from '../src/index.ts'
import type { AddMemoryInput, AuditEntry, MemoryEntry, MemoryHealth, MemorySearchQuery } from '../src/index.ts'
import { MemoryStore } from '../src/index.ts'
import { MemoryRemoteService } from '../src/remote/index.ts'
import type { MemoryEntryJson } from '../src/remote/index.ts'

/**
 * Unit tests for the @Remote service wrapping the memory store — the wire
 * layer behind the memory-management UI (§3.8). Covers the phase-1 additions:
 * the `projects` aggregation, the `staleSince` entry passthrough, and the
 * `stale` health counter, plus list pagination boundaries. The store is a
 * trivial in-memory MemoryStore (same style as tests/store-contract.spec.ts);
 * the storage-backed provider is validated by the integration suite.
 */
class TestMemoryStore extends MemoryStore {
  private readonly map = new Map<string, MemoryEntry>()
  private readonly auditLog: AuditEntry[] = []
  private nextId = 0

  /** Seed one entry verbatim, bypassing add() so tests control every field. */
  seed(entry: Omit<MemoryEntry, 'id'> & { id?: string }): MemoryEntry {
    const id = (entry.id ?? `mem-${++this.nextId}`) as MemoryId
    const full: MemoryEntry = { ...entry, id }
    this.map.set(id, full)
    return full
  }

  override async add(input: AddMemoryInput): Promise<{ entry: MemoryEntry }> {
    validateProjectScope(input)
    validateContent(input.content)
    const scan = scanContent(input.content)
    if (!scan.allowed) throw new Error(`rejected: ${scan.reasons.join('; ')}`)
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
    this.map.set(id, entry)
    return { entry }
  }

  override get(id: string): MemoryEntry | undefined {
    return this.map.get(id)
  }

  override list(scope?: MemoryEntry['scope'], projectName?: string): readonly MemoryEntry[] {
    return [...this.map.values()]
      .filter(e => scope === undefined || e.scope === scope)
      .filter(e => projectName === undefined || e.projectName === projectName)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  override async update(
    id: string,
    input: { content?: string; category?: MemoryEntry['category'] },
  ): Promise<MemoryEntry | undefined> {
    const existing = this.map.get(id)
    if (existing === undefined) return undefined
    const newContent = input.content ?? existing.content
    validateContent(newContent)
    const scan = scanContent(newContent)
    if (!scan.allowed) throw new Error(`rejected: ${scan.reasons.join('; ')}`)
    const updated: MemoryEntry = {
      ...existing,
      content: newContent,
      category: input.category ?? existing.category,
      updatedAt: Date.now(),
    }
    this.map.set(id, updated)
    return updated
  }

  override async remove(id: string): Promise<boolean> {
    return this.map.delete(id)
  }

  override search(query: MemorySearchQuery): { entries: readonly MemoryEntry[]; total: number } {
    let all = [...this.map.values()]
      .filter(e => query.scope === undefined || e.scope === query.scope)
      .filter(e => query.category === undefined || e.category === query.category)
      .filter(e => query.projectName === undefined || e.projectName === query.projectName)
      .filter(
        e =>
          query.query === undefined ||
          query.query.length === 0 ||
          e.content.toLowerCase().includes(query.query.toLowerCase()),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const total = all.length
    const limit = query.limit ?? 50
    all = limit > 0 ? all.slice(0, limit) : all
    return { entries: all, total }
  }

  override async pin(id: string): Promise<MemoryEntry | undefined> {
    const existing = this.map.get(id)
    if (existing === undefined) return undefined
    const updated = { ...existing, pinned: true }
    this.map.set(id, updated)
    return updated
  }

  override async unpin(id: string): Promise<MemoryEntry | undefined> {
    const existing = this.map.get(id)
    if (existing === undefined) return undefined
    const updated = { ...existing, pinned: false }
    this.map.set(id, updated)
    return updated
  }

  override health(): MemoryHealth {
    let global = 0, project = 0, user = 0, pinned = 0, stale = 0
    for (const [, entry] of this.map) {
      if (entry.scope === 'global') global++
      else if (entry.scope === 'project') project++
      else user++
      if (entry.pinned === true) pinned++
      if (entry.staleSince !== undefined) stale++
    }
    return {
      totalEntries: global + project + user,
      byScope: { global, project, user },
      pinned,
      auditRecords: this.auditLog.length,
      stale,
    }
  }

  override exportAuditLog(): readonly AuditEntry[] {
    return [...this.auditLog]
  }
}

/** Mount the remote service over a seeded store; returns both handles. */
function setup(entries: Array<Omit<MemoryEntry, 'id'> & { id?: string }> = []) {
  const ctx = new Context()
  const store = new TestMemoryStore()
  for (const entry of entries) store.seed(entry)
  ctx.provide('memory', store)
  const service = new MemoryRemoteService(ctx)
  return { ctx, store, service: ctx.memoryRemote ?? service }
}

const BASE = 1_700_000_000_000

function entry(overrides: Partial<MemoryEntry> & { scope: MemoryEntry['scope']; content: string }): Omit<MemoryEntry, 'id'> & { id?: string } {
  return { createdAt: BASE, updatedAt: BASE, ...overrides }
}

describe('memoryRemote.projects', () => {
  it('aggregates distinct project names across project entries, sorted', () => {
    const { service } = setup([
      entry({ scope: 'project', content: 'a', projectName: 'zeta' }),
      entry({ scope: 'project', content: 'b', projectName: 'alpha' }),
      entry({ scope: 'project', content: 'c', projectName: 'alpha' }),
      entry({ scope: 'project', content: 'd', projectName: 'mica' }),
    ])

    expect(service.projects()).toEqual({ projects: ['alpha', 'mica', 'zeta'] })
  })

  it('ignores non-project scopes and unnamed project entries', () => {
    const { service } = setup([
      entry({ scope: 'global', content: 'g' }),
      entry({ scope: 'user', content: 'u' }),
      // A project row without a name is malformed but must not crash the
      // aggregation or contribute an empty-string entry.
      entry({ scope: 'project', content: 'anonymous' }),
      entry({ scope: 'project', content: 'named', projectName: 'web' }),
    ])

    expect(service.projects()).toEqual({ projects: ['web'] })
  })

  it('returns an empty list on an empty store and without the store service', () => {
    expect(setup().service.projects()).toEqual({ projects: [] })

    const bareCtx = new Context()
    new MemoryRemoteService(bareCtx)
    expect((bareCtx.memoryRemote as MemoryRemoteService).projects()).toEqual({ projects: [] })
  })
})

describe('memoryRemote entry projection', () => {
  it('passes staleSince through to the wire entry', () => {
    const { service } = setup([
      entry({ scope: 'global', content: 'sleeping', staleSince: BASE + 5 }),
      entry({ scope: 'global', content: 'awake' }),
    ])

    const page = service.list({})
    const sleeping = page.entries.find(e => e.content === 'sleeping') as MemoryEntryJson
    const awake = page.entries.find(e => e.content === 'awake') as MemoryEntryJson
    expect(sleeping.staleSince).toBe(BASE + 5)
    expect(awake.staleSince).toBeUndefined()
  })

  it('keeps stale entries searchable (soft decay does not hide them)', () => {
    const { service } = setup([
      entry({ scope: 'global', content: 'always pin the environment before installing', staleSince: BASE }),
    ])

    const found = service.search({ query: 'environment' })
    expect(found.total).toBe(1)
    expect(found.entries[0]?.staleSince).toBe(BASE)
  })
})

describe('memoryRemote.health', () => {
  it('reports the stale count alongside the existing counters', () => {
    const { service } = setup([
      entry({ scope: 'global', content: 'a', staleSince: BASE }),
      entry({ scope: 'global', content: 'b', staleSince: BASE + 1 }),
      entry({ scope: 'user', content: 'c' }),
      entry({ scope: 'project', content: 'd', projectName: 'p', pinned: true }),
    ])

    const health = service.health()
    expect(health.totalEntries).toBe(4)
    expect(health.byScope).toEqual({ global: 2, project: 1, user: 1 })
    expect(health.pinned).toBe(1)
    expect(health.stale).toBe(2)
  })

  it('passes a zero stale count through, and omits the field when the store reports none', () => {
    const { service } = setup([entry({ scope: 'global', content: 'fresh' })])
    expect(service.health().stale).toBe(0)

    // A store implementation predating soft decay returns no stale field at
    // all; the wire projection must not invent one.
    const bare = new Context()
    const oldStore = new TestMemoryStore()
    oldStore.seed(entry({ scope: 'global', content: 'legacy' }))
    Object.defineProperty(oldStore, 'health', {
      value: () => ({
        totalEntries: 1,
        byScope: { global: 1, project: 0, user: 0 },
        pinned: 0,
        auditRecords: 0,
      }) as MemoryHealth,
    })
    bare.provide('memory', oldStore)
    new MemoryRemoteService(bare)
    expect((bare.memoryRemote as MemoryRemoteService).health().stale).toBeUndefined()
  })
})

describe('memoryRemote.list pagination', () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    entry({ scope: 'global', content: `row ${i}`, createdAt: BASE + i, updatedAt: BASE + i }))

  it('lists newest first so the UI first lazy batch surfaces fresh memories', () => {
    const { service } = setup(many)

    expect(service.list({}).entries.map(e => e.content)).toEqual([
      'row 6', 'row 5', 'row 4', 'row 3', 'row 2', 'row 1', 'row 0',
    ])
  })

  it('pages with offset+limit over the newest-first order and reports the unpaginated total', () => {
    const { service } = setup(many)

    expect(service.list({}).total).toBe(7)
    expect(service.list({ limit: 3 }).entries.map(e => e.content)).toEqual(['row 6', 'row 5', 'row 4'])
    expect(service.list({ limit: 3, offset: 6 }).entries.map(e => e.content)).toEqual(['row 0'])
    expect(service.list({ limit: 3, offset: 100 })).toEqual({ entries: [], total: 7 })
  })

  it('filters by scope and projectName before paging', () => {
    const { service } = setup([
      ...many,
      entry({ scope: 'project', content: 'proj row', projectName: 'web' }),
    ])

    expect(service.list({ scope: 'project' }).entries.map(e => e.content)).toEqual(['proj row'])
    expect(service.list({ scope: 'project', projectName: 'web' }).total).toBe(1)
    expect(service.list({ scope: 'project', projectName: 'other' }).total).toBe(0)
  })

  it('treats a non-positive limit as "no cap beyond the offset"', () => {
    const { service } = setup(many)

    expect(service.list({ limit: 0, offset: 5 }).entries.map(e => e.content)).toEqual(['row 1', 'row 0'])
  })
})

describe('memoryRemote.search recall suppression', () => {
  it('stamps management searches recordRecall:false so browsing never counts as recall', () => {
    const { store, service } = setup([entry({ scope: 'global', content: 'needle in store' })])

    const seen: MemorySearchQuery[] = []
    const original = store.search.bind(store)
    Object.defineProperty(store, 'search', {
      value: (query: MemorySearchQuery) => {
        seen.push(query)
        return original(query)
      },
    })

    const found = service.search({ query: 'needle' })
    expect(found.total).toBe(1)
    expect(seen[0]?.recordRecall).toBe(false)
  })
})
