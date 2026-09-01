/**
 * Recall evaluation baseline: runs the fixed golden set (35 entries,
 * 35 queries, en+zh; the original 24 plus the wave-3 synonym and inflection
 * slices) through the REAL DomainMemoryStore BM25 search and
 * asserts precision/recall floors so any future retrieval change (tokenizer,
 * weights, budgets) is judged against numbers instead of vibes.
 *
 * The same spec prints the per-mode standing injection cost table behind the
 * policy-only default-mode decision
 * (.agents/notes/implemented/architecture/2026-08-26-index-mode-stays-policy-only.md):
 * policy-only vs index vs full.
 *
 * Set DSH_MEMORY_EVAL_VERBOSE=1 to dump per-case rankings.
 */
import { describe, it, expect } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { DomainMemoryStore } from '../src/store/index.ts'
import { MemoryId } from '../src/brand.ts'
import {
  GOLDEN_ENTRIES,
  evaluateRecall,
  measureInjectionCost,
  formatCostRow,
} from '../src/benchmark/index.ts'
import { readMemorySnapshot, readMemoryIndex, buildMemorySectionText } from '../src/context/index.ts'

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

/** Build the fixture store over the real BM25 search implementation. */
async function fixtureStore(): Promise<DomainMemoryStore> {
  // Seed the entries table directly (the store takes its tables by constructor),
  // with deterministic ids and staggered timestamps.
  const entries = memTable<MemoryId, import('../src/types.ts').MemoryEntry>()
  let t = 1_700_000_000_000
  for (const entry of GOLDEN_ENTRIES) {
    const id = MemoryId(entry.id)
    await entries.put(id, {
      id,
      scope: entry.scope,
      content: entry.content,
      ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
      ...((entry as { category?: string }).category !== undefined
        ? { category: (entry as { category?: string }).category as never }
        : {}),
      ...(entry.scope === 'project' ? { projectName: 'demo-repo' } : {}),
      createdAt: ++t,
      updatedAt: t,
    })
  }
  return new DomainMemoryStore(entries, memTable(), memTable())
}

const verbose = process.env.DSH_MEMORY_EVAL_VERBOSE === '1'

describe('recall evaluation baseline (P1-4)', () => {
  it('meets the precision/recall floors on the golden set (en+zh)', async () => {
    const store = await fixtureStore()
    const report = evaluateRecall({ search: q => store.search({ query: q.query, limit: q.limit }) }, 5)

    if (verbose) {
      for (const c of report.perCase) {
        console.log(`${c.hit ? 'HIT ' : 'MISS'} p@5=${c.ranked.slice(0, 5).filter(id => c.expected.includes(id)).length}/5 rr=${c.reciprocalRank.toFixed(2)} [${c.lang}] ${c.query}\n     → ${c.ranked.slice(0, 5).join(', ')}`)
      }
    }

    // Floors sit just under the measured post-wave-3 baseline (35 cases with
    // the synonym + inflection slices, BM25 stemming + summary indexing
    // landed): success@5=100.0% P@1=82.9% MRR=0.902 zh=100.0%. The expanded
    // fixture diluted P@1 from the original 24-case baseline (91.7%) because
    // the paraphrase slice puts several summary-bearing entries in play for
    // the same query topic (e.g. 缓存 queries now rank s4/s4b alongside g6) —
    // MRR stays high since the relevant entry is always within the top two.
    // Floors exist to catch regressions, not to celebrate absolute numbers.
    expect(report.recallAtK).toBeGreaterThanOrEqual(0.85)
    expect(report.mrr).toBeGreaterThanOrEqual(0.75)
    expect(report.precisionAtOne).toBeGreaterThanOrEqual(0.6)
    // CJK slice must hold its own — the single-char+bigram tokenizer is the
    // point of differentiation, so a zh regression is a first-class failure.
    expect(report.zh.recallAtK).toBeGreaterThanOrEqual(0.8)

    console.log(
      `[recall-baseline] k=5 cases=${report.caseCount} `
      + `success@5=${(report.recallAtK * 100).toFixed(1)}% P@1=${(report.precisionAtOne * 100).toFixed(1)}% `
      + `MRR=${report.mrr.toFixed(3)} | zh success@5=${(report.zh.recallAtK * 100).toFixed(1)}% `
      + `en success@5=${(report.en.recallAtK * 100).toFixed(1)}%`,
    )
  })

  it('prints the standing injection-cost table for the three prompt modes (P1-8)', async () => {
    const store = await fixtureStore()
    const CHAR_LIMIT = 5000
    const snapshot = readMemorySnapshot(store, CHAR_LIMIT, undefined, 20)
    const index = readMemoryIndex(store, CHAR_LIMIT)
    const sectionOf = (mode: 'policy-only' | 'index' | 'full'): string =>
      buildMemorySectionText(mode, '', mode === 'full' ? snapshot : '', mode === 'index' ? index : '')

    // Index awareness coverage: entries whose existence line survived the budget.
    const indexLineCount = index.split('\n').filter(line => line.includes(' · ')).length
    const fullEntryCount = (snapshot.match(/^- /gm) ?? []).length

    const rows = [
      measureInjectionCost('policy-only', sectionOf('policy-only')),
      measureInjectionCost('index', sectionOf('index'), { entriesRendered: indexLineCount, indexLines: indexLineCount }),
      measureInjectionCost('full', sectionOf('full'), { entriesRendered: fullEntryCount }),
    ]

    console.log('\n[standing injection cost @35-entry fixture, charLimit=5000]')
    console.log(`mode          chars     approxTokens entriesRendered indexLines`)
    for (const row of rows) console.log(formatCostRow(row))
    console.log(`\nindex awareness coverage: ${indexLineCount}/${GOLDEN_ENTRIES.length} entries visible as existence lines`)

    // Sanity anchors (not performance claims):
    // - policy-only stays flat regardless of store size (zero entry content);
    // - both content modes render real material on this fixture;
    // - full respects its 20-entry cap while index fits all lines in budget.
    const [policyOnly, indexCost, full] = rows
    expect(policyOnly!.approxTokens).toBeGreaterThan(50)
    expect(indexCost!.approxTokens).toBeGreaterThan(50)
    expect(full!.approxTokens).toBeGreaterThan(50)
    expect(policyOnly!.entriesRendered).toBe(0)
    expect(indexCost!.entriesRendered).toBe(GOLDEN_ENTRIES.length)
    expect(full!.entriesRendered).toBeLessThan(GOLDEN_ENTRIES.length)
  })
})
