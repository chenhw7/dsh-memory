/**
 * The activity clock that decay and eviction share: an entry stays alive while
 * anything about it is recent — written/edited (`updatedAt`), recalled
 * (`lastRecalledAt`), or echoed by an answer (`lastHitAt`). Reading only
 * `lastRecalledAt ?? createdAt` decayed entries a user had just edited.
 */
import { describe, it, expect } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { DomainMemoryStore } from '../src/store/index.ts'
import { lastActiveTimestamp } from '../src/store/decay.ts'
import type { MemoryEntry, MemoryId } from '../src/types.ts'

/** In-memory stand-in for a storage-domain KV table. */
function memTable<K extends string, V>(): KvTable<K, V> {
  const map = new Map<K, V>()
  return {
    get: key => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() { return map.size },
    put: async (key, value) => { map.set(key, value) },
    update: async (key, fn) => {
      const current = map.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = fn(current)
      map.set(key, next)
      return next
    },
    delete: async key => map.delete(key),
  }
}

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

/** One entry with the timestamps under test. */
function entry(id: string, timestamps: { createdAt: number; updatedAt?: number; lastRecalledAt?: number; lastHitAt?: number }, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: id as MemoryId,
    scope: 'project',
    content: `fact ${id}`,
    projectName: 'demo',
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt ?? timestamps.createdAt,
    ...timestamps.lastRecalledAt !== undefined ? { lastRecalledAt: timestamps.lastRecalledAt } : {},
    ...timestamps.lastHitAt !== undefined ? { lastHitAt: timestamps.lastHitAt } : {},
    ...extra,
  } as MemoryEntry
}

/** Build a store whose entries table already holds `rows`. */
function storeWith(rows: readonly MemoryEntry[], entriesCap = 500): DomainMemoryStore {
  const table = memTable<string, MemoryEntry>()
  for (const row of rows) void table.put(row.id, row)
  return new DomainMemoryStore(table, memTable(), memTable(), memTable(), 500, 200, undefined, entriesCap)
}

describe('lastActiveTimestamp', () => {
  it('reads the newest of create, edit, recall, and hit', () => {
    expect(lastActiveTimestamp({ createdAt: T0 })).toBe(T0)
    expect(lastActiveTimestamp({ createdAt: T0, updatedAt: T0 + 1 })).toBe(T0 + 1)
    expect(lastActiveTimestamp({ createdAt: T0, updatedAt: T0 + 1, lastRecalledAt: T0 + 2 })).toBe(T0 + 2)
    expect(lastActiveTimestamp({ createdAt: T0, lastHitAt: T0 + 3, lastRecalledAt: T0 + 2 })).toBe(T0 + 3)
  })
})

describe('decay honors the full activity clock', () => {
  it('keeps an old entry that was edited recently and hard-decays the quiet one', async () => {
    const store = storeWith([
      entry('edited', { createdAt: T0, updatedAt: T0 + 29 * DAY }),
      entry('quiet', { createdAt: T0 }),
    ])
    await store.janitor(30, T0 + 30 * DAY)
    // Project scope hard-decays: the quiet row is gone, the edited one stays.
    expect(store.get('edited' as MemoryId)).toBeDefined()
    expect(store.get('quiet' as MemoryId)).toBeUndefined()
  })

  it('does not dormancy-stamp an old entry whose answer echoed it recently', async () => {
    const store = storeWith([
      entry('hit', { createdAt: T0, lastHitAt: T0 + 29 * DAY }),
    ])
    await store.janitor(30, T0 + 30 * DAY)
    expect(store.get('hit' as MemoryId)!.staleSince).toBeUndefined()
  })
})

describe('eviction honors the full activity clock', () => {
  it('evicts the longest-idle entry, not the oldest-created one', async () => {
    // `stale` is the oldest but was edited moments ago; `fresh` was created
    // later yet has been idle since creation. The cap forces exactly one
    // eviction.
    const store = storeWith([
      entry('stale', { createdAt: T0, updatedAt: T0 + 10 * DAY }),
      entry('fresh', { createdAt: T0 + DAY }),
    ], 2)
    await store.add({ scope: 'global', content: 'newest arrival' })
    expect(store.get('stale' as MemoryId)).toBeDefined()
    expect(store.get('fresh' as MemoryId)).toBeUndefined()
  })
})
