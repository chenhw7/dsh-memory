import { describe, it, expect } from 'vitest'
import { MemoryId, scanContent, validateProjectScope, validateContent } from '../src/index.ts'
import type { AddMemoryInput, AuditEntry, MemoryEntry, MemoryHealth, MemorySearchQuery } from '../src/index.ts'
import { MemoryStore } from '../src/index.ts'

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
