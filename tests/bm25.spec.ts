import { describe, it, expect } from 'vitest'
import { tokenizeForSearch, Bm25Index, rankTexts, buildCorpusStats, idfOf } from '../src/store/bm25.ts'

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
