import { describe, it, expect } from 'vitest'
import { MemoryId, scanContent, validateProjectScope, validateContent } from '../src/index.ts'
import type { AddMemoryInput, AuditEntry, MemoryEntry, MemoryHealth, MemorySearchQuery } from '../src/index.ts'
import { MemoryStore } from '../src/index.ts'
import { DomainMemoryStore } from '../src/store/index.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

/** In-memory stand-in for a storage-domain KV table (same shape as health.spec). */
function memTable<K extends string, V>(): KvTable<K, V> {
  const map = new Map<K, V>()
  return {
    get: key => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() { return map.size },
    put: async (key, value) => { map.set(key, value) },
    delete: async key => map.delete(key),
  }
}

/**
 * A trivial in-memory MemoryStore for unit-testing the provider contract
 * without booting a full Cordis composition. The storage-domain-backed
 * provider is validated through a REAL composition in the integration suite.
 */
class TestMemoryStore extends MemoryStore {
  private readonly map = new Map<string, MemoryEntry>()
  private readonly auditLog: AuditEntry[] = []

  override async add(input: AddMemoryInput): Promise<{ entry: MemoryEntry }> {
    validateProjectScope(input)
    validateContent(input.content)
    const scan = scanContent(input.content)
    if (!scan.allowed) {
      throw new Error(`rejected: ${scan.reasons.join('; ')}`)
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
    this.map.set(id, entry)
    return { entry }
  }

  /** Recall tracking is optional: the base-class default is a no-op. */
  override markRecalled(_ids: readonly string[]): void { /* no-op */ }

  override get(id: string): MemoryEntry | undefined {
    return this.map.get(id)
  }

  override list(scope?: MemoryEntry['scope'], projectName?: string): readonly MemoryEntry[] {
    const results = [...this.map.values()]
      .filter(e => scope === undefined || e.scope === scope)
      .filter(e => projectName === undefined || e.projectName === projectName)
      .sort((a, b) => a.createdAt - b.createdAt)
    return results
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
    if (!scan.allowed) {
      throw new Error(`rejected: ${scan.reasons.join('; ')}`)
    }
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

  override async janitor(_decayDays: number): Promise<number> {
    return 0
  }

  override health(): MemoryHealth {
    let global = 0, project = 0, user = 0, pinned = 0
    for (const [, entry] of this.map) {
      if (entry.scope === 'global') global++
      else if (entry.scope === 'project') project++
      else user++
      if (entry.pinned === true) pinned++
    }
    return { totalEntries: this.map.size, byScope: { global, project, user }, pinned, auditRecords: this.auditLog.length }
  }

  override exportAuditLog(): readonly AuditEntry[] {
    return [...this.auditLog]
  }
}

/**
 * The shared contract suite: any MemoryStore implementation MUST pass these
 * tests. Used by §3.9 to validate that a new provider conforms to the same
 * contract as the in-memory and storage-domain providers.
 */
export function runStoreContractSuite(name: string, makeStore: () => MemoryStore) {
  describe(`${name} — MemoryStore contract`, () => {
    it('adds and retrieves an entry', async () => {
      const store = makeStore()
      const { entry } = await store.add({ scope: 'global', content: 'User prefers dark mode.' })
      expect(store.get(entry.id)).toBeDefined()
      expect(store.get(entry.id)!.content).toBe('User prefers dark mode.')
    })

    it('rejects secret content', async () => {
      const store = makeStore()
      await expect(
        store.add({ scope: 'global', content: 'sk-abcdef0123456789abcdef0123456789ab' }),
      ).rejects.toThrow('rejected')
    })

    it('rejects project scope without projectName', async () => {
      const store = makeStore()
      await expect(
        store.add({ scope: 'project', content: 'x' } as AddMemoryInput),
      ).rejects.toThrow('project-scoped')
    })

    it('rejects empty content on add', async () => {
      const store = makeStore()
      await expect(store.add({ scope: 'global', content: '' })).rejects.toThrow('non-empty')
    })

    it('rejects whitespace-only content on add and update', async () => {
      const store = makeStore()
      await expect(store.add({ scope: 'global', content: '   ' })).rejects.toThrow('non-empty')
      const { entry } = await store.add({ scope: 'global', content: 'real' })
      await expect(store.update(entry.id, { content: '\n\t ' })).rejects.toThrow('non-empty')
    })

    it('markRecalled is a safe no-op for providers without recall tracking', async () => {
      const store = makeStore()
      expect(() => store.markRecalled(['any-id'])).not.toThrow()
      expect(() => store.markRecalled([])).not.toThrow()
    })

    it('lists by scope', async () => {
      const store = makeStore()
      await store.add({ scope: 'global', content: 'g1' })
      await store.add({ scope: 'user', content: 'u1' })
      await store.add({ scope: 'global', content: 'g2' })
      expect(store.list('global').length).toBe(2)
      expect(store.list('user').length).toBe(1)
    })

    it('searches by substring', async () => {
      const store = makeStore()
      await store.add({ scope: 'global', content: 'User likes Python.' })
      await store.add({ scope: 'global', content: 'User dislikes Java.' })
      const result = store.search({ query: 'python' })
      expect(result.total).toBe(1)
      expect(result.entries[0]!.content).toBe('User likes Python.')
    })

    it('updates content and scanner still runs', async () => {
      const store = makeStore()
      const { entry } = await store.add({ scope: 'global', content: 'original' })
      await store.update(entry.id, { content: 'updated' })
      expect(store.get(entry.id)!.content).toBe('updated')
      await expect(
        store.update(entry.id, { content: 'sk-abcdef0123456789abcdef0123456789ab' }),
      ).rejects.toThrow('rejected')
    })

    it('removes entries', async () => {
      const store = makeStore()
      const { entry } = await store.add({ scope: 'global', content: 'temp' })
      expect(await store.remove(entry.id)).toBe(true)
      expect(store.get(entry.id)).toBeUndefined()
      expect(await store.remove(entry.id)).toBe(false)
    })

    it('respects limit in search', async () => {
      const store = makeStore()
      for (let i = 0; i < 5; i++) {
        await store.add({ scope: 'global', content: `entry-${i}` })
      }
      const result = store.search({ limit: 2 })
      expect(result.entries.length).toBe(2)
      expect(result.total).toBe(5)
    })

    it('recordRecall: false keeps a search free of recall side effects', async () => {
      const store = makeStore()
      // Read-side consumers (management UI) browse through this flag: it must
      // never stamp lastRecalledAt or otherwise rewrite the matched entries.
      const { entry } = await store.add({ scope: 'global', content: 'management browsing stays silent' })
      store.search({ query: 'silent', recordRecall: false })
      await new Promise(resolve => { setTimeout(resolve, 50) })
      expect(store.get(entry.id)!.lastRecalledAt).toBeUndefined()
    })

    it('pin and unpin toggle the pinned flag', async () => {
      const store = makeStore()
      const { entry } = await store.add({ scope: 'project', content: 'pinned fact', projectName: 'demo' })
      const pinned = await store.pin(entry.id)
      expect(pinned!.pinned).toBe(true)
      const unpinned = await store.unpin(entry.id)
      expect(unpinned!.pinned).toBe(false)
    })

    it('health() returns entry counts', async () => {
      const store = makeStore()
      await store.add({ scope: 'global', content: 'g' })
      await store.add({ scope: 'user', content: 'u' })
      const h = store.health()
      expect(h.totalEntries).toBe(2)
      expect(h.byScope).toEqual({ global: 1, project: 0, user: 1 })
    })
  })
}

// Run the shared contract suite against the in-memory TestMemoryStore.
runStoreContractSuite('TestMemoryStore', () => new TestMemoryStore())

// The importance/accessCount use-signals are a domain-store behavior (recall
// stamping and the janitor live there), so they are tested against the real
// implementation rather than the in-memory stand-in.
describe('importance-signal (DomainMemoryStore)', () => {
  const makeStore = () => new DomainMemoryStore(memTable(), memTable(), memTable())

  it('stores a clamped add-time importance and leaves absent as absent', async () => {
    const store = makeStore()
    const { entry: high } = await store.add({ scope: 'global', content: 'assessed high', importance: 99 })
    expect(high.importance).toBe(5)
    const { entry: low } = await store.add({ scope: 'global', content: 'assessed low', importance: 0 })
    expect(low.importance).toBe(1)
    const { entry: none } = await store.add({ scope: 'global', content: 'not assessed' })
    expect(none.importance).toBeUndefined()
  })

  it('update with importance rewrites it; update without keeps the stored value', async () => {
    const store = makeStore()
    const { entry } = await store.add({ scope: 'global', content: 'keep my score', importance: 3 })
    const raised = await store.update(entry.id, { content: 'keep my score', importance: 99 })
    expect(raised!.importance).toBe(5)
    const untouched = await store.update(entry.id, { content: 'keep my score' })
    expect(untouched!.importance).toBe(5)
  })

  it('each recall stamp bumps accessCount by one', async () => {
    const store = makeStore()
    const { entry } = await store.add({ scope: 'global', content: 'recalled often' })
    expect(entry.accessCount).toBeUndefined()

    store.markRecalled([entry.id as string])
    // Fire-and-forget: let the stamp chain settle before asserting.
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(store.get(entry.id)!.accessCount).toBe(1)

    store.markRecalled([entry.id as string])
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(store.get(entry.id)!.accessCount).toBe(2)
  })

  it('search breaks score ties by importance (desc) before recency', async () => {
    const store = makeStore()
    const base = 1_700_000_000_000
    // All three match the query token; score is equal, so importance decides
    // ahead of updatedAt (the unimportant entry is the newest).
    await store.add({ scope: 'global', content: 'tiebreak token' }) // no importance
    const { entry: important } = await store.add({ scope: 'global', content: 'tiebreak token', importance: 5 })
    const { entry: mid } = await store.add({ scope: 'global', content: 'tiebreak token', importance: 3 })
    await store.update(important.id, { updatedAt: base } as never)
    await store.update(mid.id, { updatedAt: base + 1 } as never)

    const result = store.search({ query: 'tiebreak' })
    expect(result.total).toBe(3)
    expect(result.entries[0]!.id).toBe(important.id)
    expect(result.entries[1]!.id).toBe(mid.id)
  })

  it('importance 4–5 extends the janitor decay grace window 1.5×', async () => {
    const store = makeStore()
    const decayDays = 30
    const day = 24 * 60 * 60 * 1000
    const { entry: important } = await store.add({ scope: 'global', content: 'matters a lot', importance: 5 })
    const { entry: plain } = await store.add({ scope: 'global', content: 'no assessment' })
    // Advance exactly past the plain window but inside the 1.5× grace window.
    const now = Date.now() + decayDays * day * 1.2
    await store.janitor(decayDays, now)
    expect(store.get(plain.id)!.staleSince).toBeDefined()
    expect(store.get(important.id)!.staleSince).toBeUndefined()

    // Past 1.5× both are decayed.
    await store.janitor(decayDays, now + decayDays * day)
    expect(store.get(important.id)!.staleSince).toBeDefined()
  })

  it('recall clears a decay stamp regardless of importance', async () => {
    const store = makeStore()
    const { entry } = await store.add({ scope: 'global', content: 'revive me', importance: 5 })
    await store.janitor(1, Date.now() + 40 * 24 * 60 * 60 * 1000)
    expect(store.get(entry.id)!.staleSince).toBeDefined()

    store.markRecalled([entry.id as string])
    await new Promise(resolve => { setTimeout(resolve, 20) })
    const revived = store.get(entry.id)!
    expect(revived.staleSince).toBeUndefined()
    expect(revived.accessCount).toBe(1)
  })
})
