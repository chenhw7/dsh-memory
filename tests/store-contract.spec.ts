import { describe, it, expect } from 'vitest'
import { MemoryId, scanContent, validateProjectScope } from '../src/index.ts'
import type { AddMemoryInput, MemoryEntry, MemorySearchQuery } from '../src/index.ts'
import { MemoryStore } from '../src/index.ts'

/**
 * A trivial in-memory MemoryStore for unit-testing the provider contract
 * without booting a full Cordis composition. The storage-domain-backed
 * provider is validated through a REAL composition in the integration suite.
 */
class TestMemoryStore extends MemoryStore {
  private readonly map = new Map<string, MemoryEntry>()

  override async add(input: AddMemoryInput): Promise<{ entry: MemoryEntry }> {
    validateProjectScope(input)
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
}

describe('DomainMemoryStore contract (via TestMemoryStore)', () => {
  it('adds and retrieves an entry', async () => {
    const store = new TestMemoryStore()
    const { entry } = await store.add({ scope: 'global', content: 'User prefers dark mode.' })
    expect(store.get(entry.id)).toBeDefined()
    expect(store.get(entry.id)!.content).toBe('User prefers dark mode.')
  })

  it('rejects secret content', async () => {
    const store = new TestMemoryStore()
    await expect(
      store.add({ scope: 'global', content: 'sk-abcdef0123456789abcdef0123456789ab' }),
    ).rejects.toThrow('rejected')
  })

  it('rejects project scope without projectName', async () => {
    const store = new TestMemoryStore()
    await expect(
      store.add({ scope: 'project', content: 'x' } as AddMemoryInput),
    ).rejects.toThrow('project-scoped')
  })

  it('lists by scope', async () => {
    const store = new TestMemoryStore()
    await store.add({ scope: 'global', content: 'g1' })
    await store.add({ scope: 'user', content: 'u1' })
    await store.add({ scope: 'global', content: 'g2' })
    expect(store.list('global').length).toBe(2)
    expect(store.list('user').length).toBe(1)
  })

  it('searches by substring', async () => {
    const store = new TestMemoryStore()
    await store.add({ scope: 'global', content: 'User likes Python.' })
    await store.add({ scope: 'global', content: 'User dislikes Java.' })
    const result = store.search({ query: 'python' })
    expect(result.total).toBe(1)
    expect(result.entries[0]!.content).toBe('User likes Python.')
  })

  it('updates content and scanner still runs', async () => {
    const store = new TestMemoryStore()
    const { entry } = await store.add({ scope: 'global', content: 'original' })
    await store.update(entry.id, { content: 'updated' })
    expect(store.get(entry.id)!.content).toBe('updated')
    await expect(
      store.update(entry.id, { content: 'sk-abcdef0123456789abcdef0123456789ab' }),
    ).rejects.toThrow('rejected')
  })

  it('removes entries', async () => {
    const store = new TestMemoryStore()
    const { entry } = await store.add({ scope: 'global', content: 'temp' })
    expect(await store.remove(entry.id)).toBe(true)
    expect(store.get(entry.id)).toBeUndefined()
    expect(await store.remove(entry.id)).toBe(false)
  })

  it('respects limit in search', async () => {
    const store = new TestMemoryStore()
    for (let i = 0; i < 5; i++) {
      await store.add({ scope: 'global', content: `entry-${i}` })
    }
    const result = store.search({ limit: 2 })
    expect(result.entries.length).toBe(2)
    expect(result.total).toBe(5)
  })
})
