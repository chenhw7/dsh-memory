/**
 * One-time migration into the SQLite backend (write-path rework Step 3.2):
 * the three transition states the plan pins —
 *
 * 1. sqlite boot over an empty database + non-empty medium → full import +
 *    the medium's meta table carries the `medium:migratedToSqlite` marker;
 * 2. sqlite boot with both sides populated → fail loud (a second writer
 *    kept writing the medium after the marker landed);
 * 3. host-medium boot over a marked medium → fail loud (two live sources
 *    of truth would diverge).
 *
 * Plus import fidelity: entries, audit, suggestions, and meta survive the
 * move verbatim (ids, timestamps, optional fields).
 *
 * Real composition (Storage + storage-json + storage-domain + the store
 * plugin) over mkdtemp homes; teardown removes every acquired directory.
 */
import { describe, it, expect } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as memoryStore from '../src/store/index.ts'
import { SqliteMemoryStore, SQLITE_MIGRATION_MARKER } from '../src/store/sqlite.ts'
import { SEED_TIMESTAMP } from '../eval/harness/seed-media.ts'

/** Wire the storage stack under a temp home with the sqlite backend selected. */
export async function sqliteComposition(dir: string): Promise<{ ctx: Context; root: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide(
    'dshHomePath',
    (...segments: string[]) => `${dir}/${segments.join('/')}`,
  )
  const root = await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: `${dir}/storages` })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(memoryStore, { storage: 'sqlite', crossProcessProbeMs: 0 })
  return { ctx, root: root as unknown as { dispose(): Promise<void> } }
}

/** Wire the same stack with the default host-medium backend. */
export async function hostMediumComposition(dir: string): Promise<{ ctx: Context; root: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide(
    'dshHomePath',
    (...segments: string[]) => `${dir}/${segments.join('/')}`,
  )
  const root = await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: `${dir}/storages` })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(memoryStore, { storage: 'host-medium', crossProcessProbeMs: 0 })
  return { ctx, root: root as unknown as { dispose(): Promise<void> } }
}

describe('sqlite migration (Step 3.2, real composition)', () => {
  it('an empty database over a non-empty medium imports everything and marks the medium', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-mig-'))
    try {
      // Seed the medium through the host-medium path: two entries + audit.
      const seed = await hostMediumComposition(dir)
      const store = seed.ctx.get('memory') as memoryStore.DomainMemoryStore
      const first = await store.add({ scope: 'global', content: '迁移前的第一条', source: 'ui', anchors: ['mig'] })
      const second = await store.add({ scope: 'project', content: '迁移前的第二条', projectName: 'demo', source: 'ui' })
      const beforeAuditCount = store.exportAuditLog().length
      await seed.root.dispose()

      // Now boot sqlite over the same home: the import must run.
      const { ctx, root } = await sqliteComposition(dir)
      const sqlite = ctx.get('memory') as unknown as SqliteMemoryStore
      expect(sqlite).toBeInstanceOf(SqliteMemoryStore)
      const entries = sqlite.list()
      expect(entries).toHaveLength(2)
      // Import fidelity: ids, content, scope, project attribution, anchors.
      const importedFirst = entries.find(entry => entry.id === first.entry.id)!
      expect(importedFirst).toBeDefined()
      expect(importedFirst.content).toBe('迁移前的第一条')
      expect(importedFirst.scope).toBe('global')
      expect(importedFirst.anchors).toEqual(['mig'])
      const importedSecond = entries.find(entry => entry.id === second.entry.id)!
      expect(importedSecond.content).toBe('迁移前的第二条')
      expect(importedSecond.projectName).toBe('demo')
      expect(importedSecond.createdAt).toBe(second.entry.createdAt)
      // The audit trail carries over verbatim.
      expect(sqlite.exportAuditLog().length).toBe(beforeAuditCount)
      // The medium now carries the marker in its meta table — and its data
      // tables are cleared: leftover rows would trip the both-sides guard on
      // the next sqlite boot over its own migration leftovers.
      const medium = JSON.parse(await readFile(`${dir}/storages/memory.json`, 'utf8')) as {
        tables?: { entries?: Record<string, unknown>; audit?: Record<string, unknown>; suggestions?: Record<string, unknown>; meta?: Record<string, { key?: string }> }
      }
      expect(medium.tables?.meta?.[SQLITE_MIGRATION_MARKER]?.key).toBe('medium')
      expect(Object.keys(medium.tables?.entries ?? {})).toHaveLength(0)
      expect(Object.keys(medium.tables?.audit ?? {})).toHaveLength(0)
      expect(Object.keys(medium.tables?.suggestions ?? {})).toHaveLength(0)
      await root.dispose()

      // The migrating home re-opens clean (the eval's two-session flow is
      // exactly this: session 1 migrates, session 2 re-opens the same home).
      const reopened = await sqliteComposition(dir)
      const reopenedStore = reopened.ctx.get('memory') as unknown as SqliteMemoryStore
      expect(reopenedStore.list()).toHaveLength(2)
      expect(reopenedStore.list().find(entry => entry.id === first.entry.id)?.content).toBe('迁移前的第一条')
      await reopened.root.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a host-medium boot over a marked medium fails loud', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-mig-'))
    try {
      // Produce a migrated medium by hand (the marker + a live entry).
      const document = {
        unit: { name: 'memory', version: 0 },
        global: null,
        tables: {
          entries: { 'seed-1': { id: 'seed-1', scope: 'global', content: 'post-migration entry', createdAt: SEED_TIMESTAMP, updatedAt: SEED_TIMESTAMP } },
          audit: {},
          suggestions: {},
          meta: { [SQLITE_MIGRATION_MARKER]: { key: 'medium', value: new Date().toISOString(), updatedAt: SEED_TIMESTAMP } },
        },
      }
      const { mkdir } = await import('node:fs/promises')
      await mkdir(`${dir}/storages`, { recursive: true })
      await writeFile(`${dir}/storages/memory.json`, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await expect(hostMediumComposition(dir)).rejects.toThrow(/migratedToSqlite/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('both sides populated (marker present + medium entries) fails loud at the sqlite boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-mig-'))
    try {
      // Medium with an entry AND the marker: a host-medium writer persisted
      // after the migration — the sqlite boot must refuse.
      const document = {
        unit: { name: 'memory', version: 0 },
        global: null,
        tables: {
          entries: { 'seed-1': { id: 'seed-1', scope: 'global', content: 'stale duplicate', createdAt: SEED_TIMESTAMP, updatedAt: SEED_TIMESTAMP } },
          audit: {},
          suggestions: {},
          meta: { [SQLITE_MIGRATION_MARKER]: { key: 'medium', value: new Date().toISOString(), updatedAt: SEED_TIMESTAMP } },
        },
      }
      const { mkdir } = await import('node:fs/promises')
      await mkdir(`${dir}/storages`, { recursive: true })
      await writeFile(`${dir}/storages/memory.json`, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await expect(sqliteComposition(dir)).rejects.toThrow(/second writer|after the migration/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
