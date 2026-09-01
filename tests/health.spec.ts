/**
 * Background-path failure observability (§3.7): a failure swallowed by a
 * best-effort path must surface twice — one warn through the host logger
 * channel, one per-site counter in `health()` — instead of silently
 * vanishing. The audit append is the representative injection point: it is
 * the one background write on the primary mutation path, so its failure must
 * never break the write itself.
 */
import { describe, it, expect } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { DomainMemoryStore } from '../src/store/index.ts'
import type { AuditEntry } from '../src/types.ts'
import type { AuditId } from '../src/brand.ts'

/** In-memory stand-in for a storage-domain KV table. */
function memTable<K extends string, V>(): KvTable<K, V> {
  const map = new Map<K, V>()
  return {
    get: key => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() { return map.size },
    put: async (key, value) => { map.set(key, value) },
    update: async (key, fn) => { const cur = map.get(key); if (cur === undefined) throw new Error('missing-key'); const next = fn(cur); map.set(key, next); return next },
    delete: async key => map.delete(key),
  }
}

/** Audit table whose writes always fail, standing in for a broken medium. */
function brokenAuditTable(): KvTable<AuditId, AuditEntry> {
  const map = new Map<AuditId, AuditEntry>()
  return {
    get: key => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() { return map.size },
    put: async () => { throw new Error('audit medium is read-only') },
    delete: async key => map.delete(key),
  }
}

describe('background failure observability', () => {
  it('keeps the primary write intact when the audit append fails, and reports it', async () => {
    const warns: string[] = []
    const store = new DomainMemoryStore(memTable(), brokenAuditTable(), memTable(), 200, 200,
      { warn: message => { warns.push(message) } })

    const { entry } = await store.add({ scope: 'global', content: 'always run the linter before commit' })

    expect(entry.content).toBe('always run the linter before commit')
    expect(store.get(entry.id as string)?.content).toBe('always run the linter before commit')
    expect(warns).toEqual(['dsh-memory: audit-append failed: Error: audit medium is read-only'])
    expect(store.health().backgroundFailures).toEqual({ 'audit-append': 1 })
  })

  it('counts per site and formats one warn line per report', () => {
    const warns: string[] = []
    const store = new DomainMemoryStore(memTable(), memTable(), memTable(), 200, 200,
      { warn: message => { warns.push(message) } })

    store.reportFailure('judge', new Error('route missing'))
    store.reportFailure('judge')
    store.reportFailure('janitor', new Error('locked'))

    expect(warns).toEqual([
      'dsh-memory: judge failed: Error: route missing',
      'dsh-memory: judge failed',
      'dsh-memory: janitor failed: Error: locked',
    ])
    expect(store.health().backgroundFailures).toEqual({ judge: 2, janitor: 1 })
  })

  it('omits backgroundFailures from health() while no failure has occurred', () => {
    const store = new DomainMemoryStore(memTable(), memTable(), memTable())
    expect('backgroundFailures' in store.health()).toBe(false)
  })
})
