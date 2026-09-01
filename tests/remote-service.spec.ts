import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryId, scanContent, validateProjectScope, validateContent } from '../src/index.ts'
import type { AddMemoryInput, AuditEntry, MemoryEntry, MemoryHealth, MemorySearchQuery } from '../src/index.ts'
import { MemoryStore } from '../src/index.ts'
import { Config as RemoteServiceConfig, MemoryRemoteService } from '../src/remote/index.ts'
import type { MemoryEntryJson, RemoteConfig } from '../src/remote/index.ts'

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

  override async getRaw(id: string): Promise<MemoryEntry | undefined> {
    const entry = this.map.get(id)
    if (entry === undefined) return undefined
    this.auditLog.push({
      id: `audit-${this.auditLog.length + 1}` as never,
      op: 'readRaw',
      entryId: entry.id,
      scope: entry.scope,
      source: 'ui',
      ts: Date.now(),
      contentPreview: entry.content.slice(0, 100),
    })
    return entry
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

  override async archiveEntry(id: string): Promise<MemoryEntry | undefined> {
    const existing = this.map.get(id)
    if (existing === undefined) return undefined
    const updated = { ...existing, staleSince: Date.now() }
    this.map.set(id, updated)
    return updated
  }

  override async unarchiveEntry(id: string): Promise<MemoryEntry | undefined> {
    const existing = this.map.get(id)
    if (existing === undefined) return undefined
    const { staleSince: _cleared, ...rest } = existing
    const updated = rest as MemoryEntry
    this.map.set(id, updated)
    return updated
  }

  private readonly failures = new Map<string, number>()

  override reportFailure(site: string): void {
    this.failures.set(site, (this.failures.get(site) ?? 0) + 1)
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
      ...this.failures.size > 0 ? { backgroundFailures: Object.fromEntries(this.failures) } : {},
    }
  }

  override exportAuditLog(): readonly AuditEntry[] {
    return [...this.auditLog]
  }
}

/** Mount the remote service over a seeded store; returns both handles. */
function setup(
  entries: Array<Omit<MemoryEntry, 'id'> & { id?: string }> = [],
  config: RemoteConfig = { remoteWritesEnabled: false },
) {
  const ctx = new Context()
  const store = new TestMemoryStore()
  for (const entry of entries) store.seed(entry)
  ctx.provide('memory', store)
  const service = new MemoryRemoteService(ctx, config)
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

  it('projects accessCount and importance onto the wire entry', () => {
    const { service } = setup([
      entry({ scope: 'global', content: 'scored', accessCount: 7, importance: 4 }),
      entry({ scope: 'global', content: 'unscored' }),
    ])

    const page = service.list({})
    const scored = page.entries.find(e => e.content === 'scored') as MemoryEntryJson
    const unscored = page.entries.find(e => e.content === 'unscored') as MemoryEntryJson
    expect(scored.accessCount).toBe(7)
    expect(scored.importance).toBe(4)
    expect(unscored.accessCount).toBeUndefined()
    expect(unscored.importance).toBeUndefined()
  })

  it('keeps stale entries searchable (soft decay does not hide them)', () => {
    const { service } = setup([
      entry({ scope: 'global', content: 'always pin the environment before installing', staleSince: BASE }),
    ])

    const found = service.search({ query: 'environment' })
    expect(found.total).toBe(1)
    expect(found.entries[0]?.staleSince).toBe(BASE)
  })

  it('redacts scanner-blocked content and summary in the display projection', () => {
    const secret = 'my key is sk-' + 'a'.repeat(48)
    const { service } = setup([
      entry({ scope: 'global', content: secret, summary: 'leaks ' + secret }),
    ])

    const page = service.list({})
    expect(page.entries[0]?.content).toContain('[BLOCKED')
    expect(page.entries[0]?.content).not.toContain('sk-')
    expect(page.entries[0]?.summary).toContain('[BLOCKED')
  })

  it('getRaw returns the unredacted entry and appends a readRaw audit record', async () => {
    const secret = 'my key is sk-' + 'a'.repeat(48)
    const { service, store } = setup([
      entry({ scope: 'global', content: secret, id: 'mem-raw-1' }),
    ])
    expect(store.exportAuditLog()).toHaveLength(0)

    const result = await service.getRaw({ id: 'mem-raw-1' })
    expect(result.found).toBe(true)
    expect(result.entry?.content).toBe(secret)

    const audit = store.exportAuditLog()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.op).toBe('readRaw')
    expect(audit[0]?.source).toBe('ui')
  })

  it('getRaw reports found: false for an absent id and logs nothing', async () => {
    const { service, store } = setup()
    const result = await service.getRaw({ id: 'missing' })
    expect(result.found).toBe(false)
    expect(store.exportAuditLog()).toHaveLength(0)
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

  it('projects background failure counters onto the wire result', () => {
    const { service, store } = setup()
    store.reportFailure('janitor', new Error('decay pass failed'))
    store.reportFailure('janitor')
    expect(service.health().backgroundFailures).toEqual({ janitor: 2 })
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

describe('memoryRemote write guard (SEC-04)', () => {
  const WRITE_CALLS = [
    { method: 'add', call: (s: MemoryRemoteService) => s.add({ scope: 'global', content: 'x' }), expectError: true },
    { method: 'update', call: (s: MemoryRemoteService) => s.update({ id: 'mem-1', content: 'x' }), expectError: true },
    { method: 'removeEntry', call: (s: MemoryRemoteService) => s.removeEntry({ id: 'mem-1' }), expectError: false },
    { method: 'pin', call: (s: MemoryRemoteService) => s.pin({ id: 'mem-1', pinned: true }), expectError: false },
    { method: 'archive', call: (s: MemoryRemoteService) => s.archive({ id: 'mem-1', archived: true }), expectError: false },
    { method: 'suggestAdopt', call: (s: MemoryRemoteService) => s.suggestAdopt({ id: 'sug-1' }), expectError: true },
    { method: 'suggestReject', call: (s: MemoryRemoteService) => s.suggestReject({ id: 'sug-1' }), expectError: false },
  ] as const

  it('the deployed schema default denies remote writes even with no config row', async () => {
    // Production resolves the config through the schemastery schema, not the
    // constructor's fallback parameter — this pins the schema default itself,
    // so deleting `.default(false)` from Config fails here exactly as a
    // fresh deployment would experience it.
    const result = (RemoteServiceConfig as { '~standard': { validate(v: unknown): { value?: RemoteConfig } } })['~standard'].validate(undefined)
    expect(result.value?.remoteWritesEnabled).toBe(false)
  })

  it('rejects every write method by default while reads keep working', async () => {
    const { store, service } = setup([entry({ scope: 'global', content: 'untouched', id: 'mem-1' })])

    for (const { call } of WRITE_CALLS) {
      // The guard returns the wire-shaped refusal instead of throwing —
      // a rejected write must never surface as a transport-level error.
      await expect(call(service)).resolves.toBeDefined()
    }
    // Nothing got through: the one seeded entry is still there, unmutated.
    expect(store.get('mem-1' as never)?.content).toBe('untouched')
    expect(store.list()).toHaveLength(1)
    // Reads are unaffected — the management UI still works under the fence.
    expect(service.list({}).total).toBe(1)
    expect(service.health().totalEntries).toBe(1)
    expect(service.projects()).toEqual({ projects: [] })
    expect(service.suggestList()).toEqual({ suggestions: [] })
  })

  it('carries the deployment-disabled error message on the methods that have an error field', async () => {
    const { service } = setup([entry({ scope: 'global', content: 'a', id: 'mem-1' })])

    const added = await service.add({ scope: 'global', content: 'x' })
    expect(added).toEqual({ error: 'remote writes are disabled on this deployment' })
    const updated = await service.update({ id: 'mem-1', content: 'x' })
    expect(updated).toEqual({ found: false, error: 'remote writes are disabled on this deployment' })
    const adopted = await service.suggestAdopt({ id: 'sug-1' })
    expect(adopted).toEqual({ found: false, error: 'remote writes are disabled on this deployment' })
  })

  it('admits every write method once the deployment enables remote writes', async () => {
    const { store, service } = setup(
      [entry({ scope: 'global', content: 'editable', id: 'mem-1' })],
      { remoteWritesEnabled: true },
    )

    await expect(service.add({ scope: 'global', content: 'fresh write' })).resolves.toMatchObject({
      entry: { content: 'fresh write' },
    })
    await expect(service.update({ id: 'mem-1', content: 'edited' })).resolves.toMatchObject({
      entry: { content: 'edited' },
      found: true,
    })
    await expect(service.pin({ id: 'mem-1', pinned: true })).resolves.toMatchObject({ found: true })
    // Archive/unarchive round-trip: the guard must be the only thing between
    // the wire method and the store toggle (the store contract itself — the
    // staleSince stamp semantics — is covered by the store specs).
    const archived = await service.archive({ id: 'mem-1', archived: true })
    expect(archived.found).toBe(true)
    expect(archived.entry?.staleSince).toBeGreaterThan(0)
    const unarchived = await service.archive({ id: 'mem-1', archived: false })
    expect(unarchived.found).toBe(true)
    expect(unarchived.entry?.staleSince).toBeUndefined()
    await expect(service.removeEntry({ id: 'mem-1' })).resolves.toEqual({ removed: true })
    expect(store.list()).toHaveLength(1)
  })

  it("refuses removeEntry/pin/archive/suggestReject with the method's own no-op shape, not an error field", async () => {
    const { service } = setup([entry({ scope: 'global', content: 'a', id: 'mem-1' })])

    await expect(service.removeEntry({ id: 'mem-1' })).resolves.toEqual({ removed: false })
    await expect(service.pin({ id: 'mem-1', pinned: true })).resolves.toEqual({ found: false })
    await expect(service.archive({ id: 'mem-1', archived: true })).resolves.toEqual({ found: false })
    await expect(service.suggestReject({ id: 'sug-1' })).resolves.toEqual({ rejected: false })
  })

  it('checks the store only after the guard — a refused write never reaches the store', async () => {
    const { store, service } = setup([entry({ scope: 'global', content: 'keep me', id: 'mem-1' })])
    const addSpy = vi.fn(() => Promise.resolve({ entry: store.get('mem-1' as never)! }))
    Object.defineProperty(store, 'add', { value: addSpy })

    await service.add({ scope: 'global', content: 'should not land' })
    expect(addSpy).not.toHaveBeenCalled()
    expect(store.list()).toHaveLength(1)
  })
})
