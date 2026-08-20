/**
 * Integration test for §3.4 dedup pipeline: feeds the synthetic duplicate
 * dataset through `storeMemories` against a real DomainMemoryStore and
 * verifies the ≤5% duplicate rate + ≥95% retention gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as memoryStore from '../src/store/index.ts'
import { DomainMemoryStore } from '../src/store/index.ts'
import { storeMemories } from '../src/review/extract.ts'
import { SEED_FACTS, CONTROL_FACTS } from './fixtures/dedup-dataset.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-dedup-'))
}

describe('dedup pipeline (§3.4)', () => {
  let ctx: Context
  let root: Fiber
  let store: DomainMemoryStore
  let dir: string

  beforeEach(async () => {
    dir = tempDir()
    ctx = new Context()
    root = await ctx.plugin(Storage)
    await ctx.plugin(storageJson, { root: dir })
    await ctx.plugin(storageDomain, { backend: 'json' })
    await ctx.plugin(memoryStore)
    store = ctx.get('memory') as DomainMemoryStore
  })

  afterEach(async () => {
    await root.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('merges near-duplicates: ≤5% duplicate rate, ≥95% retention', async () => {
    // Feed all seed facts + their rewrites (200 candidates) through storeMemories.
    // The dedup prefilter should merge the 3 rewrites into each seed → ~50 entries,
    // not 200.
    const parsed = SEED_FACTS.flatMap(fact =>
      [fact.original, ...fact.rewrites].map(content => ({
        scope: fact.scope,
        content,
      })),
    )
    await storeMemories(ctx, parsed, undefined, 'review', 'test-session')

    // Feed the 50 distinct control facts — each should create a new entry.
    const controlParsed = CONTROL_FACTS.map(f => ({ scope: f.scope, content: f.content }))
    await storeMemories(ctx, controlParsed, undefined, 'review', 'test-session')

    const all = store.list()
    // With a 0.25 Jaccard threshold, ~130/153 rewrites merge into their seed.
    // The remaining ~23 rewrites survive as separate entries. So total ≈
    // 50 seeds + ~23 unmerged rewrites + ~47 controls (3 control FPs merge).
    // The gate: duplicate rate (entries beyond the 100 distinct facts) ≤ 5%
    // of the 200 seed candidates, and ≥95% seed retention.
    const distinctExpected = SEED_FACTS.length + CONTROL_FACTS.length
    const duplicates = all.length - distinctExpected
    const duplicateRate = duplicates / (SEED_FACTS.length * 4)
    expect(duplicateRate, `duplicate rate ${duplicateRate.toFixed(3)} should be ≤ 0.05`).toBeLessThanOrEqual(0.05)

    // Retention: every seed fact's original content (or a merge containing it)
    // should be present in the store.
    let retained = 0
    for (const fact of SEED_FACTS) {
      const found = all.some(entry => entry.content.includes(fact.original) || fact.original.includes(entry.content))
      if (found) retained++
    }
    const retentionRate = retained / SEED_FACTS.length
    expect(retentionRate, `retention rate ${retentionRate.toFixed(3)} should be ≥ 0.95`).toBeGreaterThanOrEqual(0.95)

    // Every control fact should be present (they're all distinct).
    for (const control of CONTROL_FACTS) {
      const found = all.some(entry => entry.content === control.content || entry.content.includes(control.content))
      expect(found, `control fact missing: "${control.content}"`).toBe(true)
    }
  })

  it('model-initiated add is NOT deduped (intent wins)', async () => {
    // Tool writes go through store.add directly, not storeMemories — they
    // bypass the dedup prefilter by design.
    await store.add({ scope: 'global', content: 'The user prefers concise answers', source: 'tool' })
    await store.add({ scope: 'global', content: 'User prefers concise answers', source: 'tool' })
    // Both entries should exist (no dedup on tool-initiated adds).
    const all = store.list('global')
    expect(all.length).toBe(2)
  })
})
