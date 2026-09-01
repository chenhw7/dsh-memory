import { describe, it, expect } from 'vitest'
import { tokenizeForSearch, Bm25Index, rankTexts, buildCorpusStats, buildCorpusStatsFromTokens, idfOf } from '../src/store/bm25.ts'
import { DomainMemoryStore } from '../src/store/index.ts'
import { MemoryId } from '../src/brand.ts'
import type { MemoryEntry } from '../src/types.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

/** In-memory stand-in for a storage-domain KV table (same shape as recall-golden). */
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

describe('tokenizeForSearch', () => {
  it('splits Latin runs into lowercase word tokens', () => {
    expect(tokenizeForSearch('Use PNPM here')).toEqual(['use', 'pnpm', 'here'])
  })

  it('emits CJK unigrams AND adjacent bigrams', () => {
    const tokens = tokenizeForSearch('记忆系统')
    expect(tokens).toContain('记')
    expect(tokens).toContain('忆')
    expect(tokens).toContain('记忆')
    expect(tokens).toContain('忆系')
    expect(tokens).toContain('系统')
  })

  it('keeps Latin and CJK streams separate', () => {
    const tokens = tokenizeForSearch('用 pnpm 构建')
    expect(tokens).toContain('pnpm')
    expect(tokens).toContain('构建')
    expect(tokens).toContain('构')
  })

  it('returns an empty bag for empty input', () => {
    expect(tokenizeForSearch('')).toEqual([])
  })
})

describe('tokenizeForSearch — conservative Latin stemming', () => {
  it('collapses plural/participle surface forms onto one stem', () => {
    // Long inflections collapse: testing→test, builds→build, deployed→deploy.
    // A short word wearing the suffix letters keeps its identity — the stem
    // must leave a ≥5-char stem, so tests/builds/boxes never lose characters
    // that would corrupt whole words (news, bring, aged stay whole).
    expect(tokenizeForSearch('testing')).toEqual(['test'])
    expect(tokenizeForSearch('tests')).toEqual(['tests'])
    expect(tokenizeForSearch('test')).toEqual(['test'])
    expect(tokenizeForSearch('builds')).toEqual(['build'])
    expect(tokenizeForSearch('deployed')).toEqual(['deploy'])
  })

  it('stems documents and queries identically, so inflected queries match', () => {
    const scores = rankTexts('unit testing', [
      'component testing runs through vitest',
      'unrelated cooking recipe',
    ])
    expect(scores[0]).toBeGreaterThan(0)
    expect(scores[1]).toBe(0)
  })

  it('does NOT over-stem: etymology-bound suffixes and stem-final sibilants stay whole', () => {
    // -ion is derivational, not inflectional: configuration ≠ configure.
    expect(tokenizeForSearch('configuration')).toEqual(['configuration'])
    // -ss/-us/-is stems never lose their s (classes→class keeps the double s;
    // census/basis stay whole).
    expect(tokenizeForSearch('classes')).toEqual(['class'])
    expect(tokenizeForSearch('census')).toEqual(['census'])
    expect(tokenizeForSearch('basis')).toEqual(['basis'])
    // vowel+ses pairs and sibilant+es plurals only drop above the stem-length
    // guard: uses/churches stay whole (short), computers collapse.
    expect(tokenizeForSearch('uses')).toEqual(['uses'])
    expect(tokenizeForSearch('churches')).toEqual(['church'])
    expect(tokenizeForSearch('boxes')).toEqual(['boxes'])
    // short words are protected (min stem length).
    expect(tokenizeForSearch('is be as')).toEqual(['is', 'be', 'as'])
    // whole words wearing suffix letters never lose characters: news/lens/
    // bring/aged keep their identity.
    expect(tokenizeForSearch('news lens does bring aged speed')).toEqual(['news', 'lens', 'does', 'bring', 'aged', 'speed'])
    // digit runs and mixed alphanumerics pass through unchanged.
    expect(tokenizeForSearch('v2 x86 5432')).toEqual(['v2', 'x86', '5432'])
  })

  it('leaves the CJK path untouched (no stemming on unigrams or bigrams)', () => {
    expect(tokenizeForSearch('记忆系统测试中')).toEqual([
      '记', '忆', '系', '统', '测', '试', '中',
      '记忆', '忆系', '系统', '统测', '测试', '试中',
    ])
  })
})

describe('summary indexing (store search seam)', () => {
  it('surfaces an entry whose summary carries keywords absent from content', () => {
    // Via the real store: the query words exist ONLY in the summary field.
    const store = summaryStore(
      { id: 'm1', content: '始终先在分支上完成改动，确认流水线通过后再合入主干', summary: '代码合并策略：合并前必须通过 CI 检查' },
    )
    const result = store.search({ query: 'CI 检查', recordRecall: false })
    expect(result.total).toBeGreaterThanOrEqual(1)
    expect(result.entries[0]!.id).toBe('m1')
  })

  it('prefers summary matches over content-only competitors (implicit field boost)', () => {
    // Both entries mention 缓存, but only s4's summary carries the query's
    // 主动触发 framing — the merged bag must rank it first.
    const store = summaryStore(
      { id: 's4', content: 'Cache invalidation happens on the write path, not on a TTL clock', summary: '缓存失效由写路径主动触发而非到期' },
      { id: 'other', content: '缓存键带构建哈希，发布后自动整体刷新' },
    )
    const result = store.search({ query: '缓存 主动 触发 失效', recordRecall: false })
    expect(result.entries[0]!.id).toBe('s4')
  })

  it('cross-language direction: en summary rescues a zh-content entry for an en query', () => {
    const store = summaryStore(
      { id: 's4b', content: '缓存键带构建哈希，发布后自动整体刷新', summary: 'Cache entries expire by build hash, invalidating wholesale on deploy' },
    )
    const result = store.search({ query: 'cache expire wholesale', recordRecall: false })
    expect(result.total).toBeGreaterThanOrEqual(1)
    expect(result.entries[0]!.id).toBe('s4b')
  })

  it('entries without a summary keep pure content indexing', () => {
    const store = summaryStore(
      { id: 'plain', content: 'plain content with no summary field' },
    )
    const result = store.search({ query: 'plain', recordRecall: false })
    expect(result.total).toBe(1)
    // And a summary-only vocabulary must NOT match a summary-less entry.
    expect(store.search({ query: 'nothing', recordRecall: false }).total).toBe(0)
  })
})

/** DomainMemoryStore seeded with fixed-id entries (summary optional). */
function summaryStore(...specs: { id: string; content: string; summary?: string }[]): DomainMemoryStore {
  const entries = memTable<MemoryId, MemoryEntry>()
  for (const spec of specs) {
    const id = MemoryId(spec.id)
    void entries.put(id, {
      id,
      scope: 'global',
      content: spec.content,
      ...(spec.summary !== undefined ? { summary: spec.summary } : {}),
      createdAt: 1,
      updatedAt: 1,
    })
  }
  return new DomainMemoryStore(entries, memTable(), memTable())
}

describe('buildCorpusStatsFromTokens (pre-tokenized seam)', () => {
  it('produces identical df to tokenize-then-build over the same texts', () => {
    const texts = ['component tests run', 'testing the deployment', '记忆的检索']
    const fromTexts = buildCorpusStats(texts)
    const fromTokens = buildCorpusStatsFromTokens(texts.map(t => tokenizeForSearch(t)))
    expect(fromTokens.documentCount).toBe(fromTexts.documentCount)
    for (const term of ['test', 'run', 'deploy', '记忆', '检索']) {
      expect(fromTokens.documentFrequency(term)).toBe(fromTexts.documentFrequency(term))
    }
  })
})

describe('Bm25Index', () => {
  it('scores zero when nothing overlaps', () => {
    const index = new Bm25Index([['alpha'], ['beta']])
    expect(index.scores(['gamma'])).toEqual([0, 0])
  })

  it('gives every document zero for an empty query', () => {
    const index = new Bm25Index([['alpha'], ['beta']])
    expect(index.scores([])).toEqual([0, 0])
  })

  it('ranks term-dense documents above passing mentions', () => {
    const scores = new Bm25Index([
      ['pnpm', 'pnpm', 'pnpm', 'workspace'],
      ['node', 'pnpm', 'misc'],
    ]).scores(['pnpm'])
    expect(scores[0]).toBeGreaterThan(scores[1]!)
  })

  it('downweights terms common to all documents (IDF)', () => {
    // "the" is in both docs, "unique" only in doc 1 — the unique term must dominate.
    const scores = new Bm25Index([
      ['the', 'unique'],
      ['the', 'other'],
    ]).scores(['the'])
    const uniqueScores = new Bm25Index([
      ['the', 'unique'],
      ['the', 'other'],
    ]).scores(['unique'])
    // A ubiquitous term still scores ≥ 0 but strictly less than a rare one.
    expect(scores[0]).toBeGreaterThanOrEqual(0)
    expect(uniqueScores[0]).toBeGreaterThan(scores[0]!)
  })

  it('ACCEPTANCE: a small candidate pool cannot inflate a common term when full-corpus stats are injected', () => {
    // Corpus: 8 documents, a pure function particle ('的') in all 8, a content
    // bigram ('记忆') in 4. The filtered pool holds only 3 of them.
    const corpus = [
      '记忆的持久化', '记忆的检索', '记忆的注入', '记忆的衰减',
      '条目的折叠', '条目的排序', '条目的导出', '条目的合并',
    ]
    const stats = buildCorpusStats(corpus)
    expect(stats.documentCount).toBe(8)
    expect(stats.documentFrequency('的')).toBe(8)
    // Full-corpus idf for the particle is near zero…
    const particleIdf = idfOf(stats, '的')
    expect(particleIdf).toBeLessThan(0.1)
    // …while pool-local measurement over the 3-doc subset inflates it >2×.
    const poolStats = buildCorpusStats([corpus[0]!, corpus[1]!, corpus[4]!])
    expect(idfOf(poolStats, '的')).toBeGreaterThan(particleIdf * 2)
    // End to end: scoring the 3-doc pool WITH full-corpus stats weights the
    // content bigram strictly above the ubiquitous particle — under pool-local
    // stats the particle's idf would approach the content term's.
    const pool = [corpus[0]!, corpus[1]!, corpus[4]!]
    const contentIdf = idfOf(stats, '记忆')
    expect(contentIdf).toBeGreaterThan(particleIdf * 5)
    const withCorpus = new Bm25Index(pool.map(c => tokenizeForSearch(c)), stats).scores(tokenizeForSearch('记忆'))
    expect(withCorpus[0]).toBeGreaterThan(0)
  })
})

describe('rankTexts (store search seam)', () => {
  it('prefers the CJK bigram match over unigram-only overlap', () => {
    const scores = rankTexts('记忆系统', [
      '这个插件负责记忆系统的持久化',   // contains bigram 记忆 + 系统
      '这句话只提到如何记录日志',       // shares 记/录-style unigrams, no target bigram
    ])
    expect(scores[0]).toBeGreaterThan(scores[1]!)
  })

  it('preserves OR semantics: any shared token keeps the document in play', () => {
    const scores = rankTexts('python testing', [
      'we write python scripts',
      'vitest runs the testing suite',
      'unrelated cooking recipe',
    ])
    expect(scores[0]).toBeGreaterThan(0)
    expect(scores[1]).toBeGreaterThan(0)
    expect(scores[2]).toBe(0)
  })

  // Pins the semantics the memory_search query description promises to the model.
  it('does not match a substring of a Latin token', () => {
    expect(rankTexts('ython', ['we write python scripts'])[0]).toBe(0)
    expect(rankTexts('python', ['we write python scripts'])[0]).toBeGreaterThan(0)
  })
})
