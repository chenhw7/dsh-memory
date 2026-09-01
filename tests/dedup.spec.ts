import { describe, it, expect } from 'vitest'
import {
  findDuplicate,
  mergeContent,
  toDedupCandidate,
  DEDUP_SIMILARITY_THRESHOLD,
  JUDGE_SYSTEM_PROMPT,
  buildJudgePrompt,
  parseJudgeVerdict,
} from '../src/review/dedup.ts'
import {
  buildCorpusStats,
  uniqueTokens,
  weightedOverlapSimilarity,
  tokenizeForSearch,
} from '../src/store/bm25.ts'
import type { MemoryEntry } from '../src/types.ts'

describe('uniqueTokens (shared tokenizer, replaces the per-character dedup tokenizer)', () => {
  it('splits Latin words into lowercase tokens', () => {
    expect(uniqueTokens('Use pnpm here')).toEqual(new Set(['use', 'pnpm', 'here']))
  })

  it('emits CJK unigrams AND adjacent bigrams (same vocabulary as BM25 search)', () => {
    // 用 no stop-word table: every character survives, word-level bigrams added.
    expect(uniqueTokens('用户偏好简洁回答')).toEqual(new Set([
      '用', '户', '偏', '好', '简', '洁', '回', '答',
      '用户', '户偏', '偏好', '好简', '简洁', '洁回', '回答',
    ]))
  })

  it('collapses duplicates into a set', () => {
    expect(uniqueTokens('pnpm pnpm pnpm')).toEqual(new Set(['pnpm']))
  })

  it('returns empty set for empty/whitespace content', () => {
    expect(uniqueTokens('')).toEqual(new Set())
    expect(uniqueTokens('   ')).toEqual(new Set())
  })

  it('is exactly tokenizeForSearch deduplicated (one shared tokenizer)', () => {
    expect([...uniqueTokens('记忆系统')]).toEqual([...new Set(tokenizeForSearch('记忆系统'))])
  })
})

describe('weightedOverlapSimilarity (IDF-weighted overlap, shared by dedup + conflict)', () => {
  it('returns 1 for identical sets', () => {
    const a = uniqueTokens('use pnpm here')
    expect(weightedOverlapSimilarity(buildCorpusStats(['use pnpm here']), a, a)).toBe(1)
  })

  it('returns 0 for disjoint sets', () => {
    const stats = buildCorpusStats(['alpha', 'beta'])
    expect(weightedOverlapSimilarity(stats, new Set(['alpha']), new Set(['beta']))).toBe(0)
  })

  it('returns 0 for both empty', () => {
    expect(weightedOverlapSimilarity(buildCorpusStats(['x']), new Set(), new Set())).toBe(0)
  })

  it('ACCEPTANCE: 上海/海南 and 中国/美国 score far below the old no-IDF Jaccard (0.5)', () => {
    // Old per-character tokenizer + unweighted Jaccard scored both pairs 0.5,
    // pushing unrelated place/country names into the duplicate band. Under
    // corpus-IDF weighting the only shared token (海 / 国) is downweighted to
    // near zero — the pairs must stay strictly below the dedup line.
    for (const [a, b] of [['上海', '海南'], ['中国', '美国']] as const) {
      const stats = buildCorpusStats([a, b])
      const score = weightedOverlapSimilarity(stats, uniqueTokens(a), uniqueTokens(b))
      expect(score, `${a} vs ${b} = ${score}`).toBeLessThan(DEDUP_SIMILARITY_THRESHOLD)
      expect(score).toBeLessThan(0.2)
    }
  })

  it('same-template sentences about different tools stay far below full overlap', () => {
    // 旧度量(等权 Jaccard 0.6)会把这判成重复。真实 store 的 corpus 含多
    // 条不同模板的条目,重复 bigram 的 IDF 被压低——这里用两条不同结构的
    // 条目作背景,断言这对的相似度显著低于完全同模板的两条。
    const a = '这个项目使用vitest'
    const b = '这个项目使用pnpm'
    const stats = buildCorpusStats([a, b, '用户偏好简洁的回答', 'deploy the service on friday'])
    const sameTemplate = weightedOverlapSimilarity(stats, uniqueTokens(a), uniqueTokens(b))
    expect(sameTemplate).toBeLessThan(0.8)
    // 对照:同模板但词面几乎不重叠的真重写(同义改写)在同一 corpus 下
    // 分数反而低——重写的分数主要由改写的词决定,不靠模板字符支撑;
    // 这正是 IDF 加权相对等权 Jaccard 的行为变化(旧度量两者都在 0.4+)。
    const synonymRewrite = weightedOverlapSimilarity(stats, uniqueTokens(a), uniqueTokens('项目选了vitest当测试器'))
    expect(synonymRewrite).toBeLessThan(DEDUP_SIMILARITY_THRESHOLD)
    expect(sameTemplate).toBeGreaterThan(synonymRewrite)
  })
})

describe('findDuplicate', () => {
  const existing = [
    { id: 'e1', scope: 'global', content: 'The user prefers concise answers' },
    { id: 'e2', scope: 'project', content: 'Use pnpm for package management' },
    { id: 'e3', scope: 'global', content: 'The network blocks npm proxy X' },
  ]

  it('finds a near-duplicate in the same scope', () => {
    // Very similar to e1, same scope.
    const dup = findDuplicate('User prefers concise answers', 'global', existing)
    expect(dup).toBe('e1')
  })

  it('returns undefined for a genuinely new memory', () => {
    const dup = findDuplicate('Always run tests before committing', 'global', existing)
    expect(dup).toBeUndefined()
  })

  it('does not match across different scopes', () => {
    // Similar to e2's content but in global scope — should not match.
    const dup = findDuplicate('Use pnpm for package management', 'global', existing)
    expect(dup).toBeUndefined()
  })

  it('returns undefined for empty candidate tokens', () => {
    const dup = findDuplicate('   ', 'global', existing)
    expect(dup).toBeUndefined()
  })

  it('respects the threshold', () => {
    // Low threshold: even loosely similar entries match.
    const dup = findDuplicate('user prefers answers concise', 'global', existing, 0.1)
    expect(dup).toBe('e1')
    // High threshold: a candidate sharing fewer content words doesn't match.
    const nodup = findDuplicate('user wants different content entirely', 'global', existing, 0.9)
    expect(nodup).toBeUndefined()
  })
})

describe('mergeContent', () => {
  it('returns the longer when one contains the other', () => {
    expect(mergeContent('use pnpm', 'use pnpm for this repo')).toBe('use pnpm for this repo')
    expect(mergeContent('use pnpm for this repo', 'use pnpm')).toBe('use pnpm for this repo')
  })

  it('appends new content when neither contains the other', () => {
    const merged = mergeContent('use pnpm', 'never commit lockfile')
    expect(merged).toBe('use pnpm never commit lockfile')
  })

  it('bounds growth: past the cap it keeps the longer side instead of appending', () => {
    const oldContent = 'o'.repeat(500)
    const newContent = 'n'.repeat(400)
    // 500 + 1 + 400 > 600 → no concatenation; the longer (old) side wins.
    expect(mergeContent(oldContent, newContent)).toBe(oldContent)
    expect(mergeContent(newContent, oldContent)).toBe(oldContent)
  })

  it('honors a custom cap and still merges under it', () => {
    expect(mergeContent('aaa', 'bbb', 10)).toBe('aaa bbb')
    expect(mergeContent('aaa'.repeat(3), 'bbb', 8)).toBe('aaaaaaaaa')
  })
})

describe('CJK dedup (Chinese context)', () => {
  it('catches Chinese near-duplicate rewrites', () => {
    const existing = [
      { id: 'c1', scope: 'user', content: '用户偏好简洁的回答' },
      { id: 'c2', scope: 'global', content: '这个项目使用pnpm' },
    ]
    // Near-duplicate rewrites of the same facts.
    expect(findDuplicate('用户喜欢简短的回答', 'user', existing)).toBe('c1')
    expect(findDuplicate('用户想要简洁的回复', 'user', existing)).toBe('c1')
    expect(findDuplicate('本项目使用pnpm包管理', 'global', existing)).toBe('c2')
  })

  it('does not merge unrelated Chinese sentences with shared structure', () => {
    const existing = [
      { id: 'c1', scope: 'global', content: '用户偏好简洁的回答' },
    ]
    // Different topic, same sentence template — should NOT match.
    expect(findDuplicate('用户喜欢在周末爬山', 'global', existing)).toBeUndefined()
    expect(findDuplicate('用户在公园里散步', 'global', existing)).toBeUndefined()
  })

  it('handles mixed CJK + Latin content', () => {
    // The two candidate rewrites share structural bigrams (项/目/使, 项目/
    // 使用) with the stored entry; a corpus of only those two texts cannot
    // tell them apart (no frequency signal) — so this pins the ranking, not
    // the absolute line: with unrelated corpus entries present, the shared
    // pnpm rewrite must score above the vitest one.
    const stored = '这个项目使用pnpm'
    const others = [
      '用户偏好简洁的回答',
      'the network blocks npm proxy x',
      'kubernetes autoscaling needs spot pools',
    ]
    const scoreOf = (content: string): number => {
      const corpus = [content, ...others, stored]
      const stats = buildCorpusStats(corpus)
      return weightedOverlapSimilarity(stats, uniqueTokens(content), uniqueTokens(stored))
    }
    // Rewrite mixes Chinese and English — shares the key content token 'pnpm'.
    expect(findDuplicate('项目使用pnpm作为包管理器', 'global', [
      { id: 'c1', scope: 'user', content: others[0]! },
      { id: 'm1', scope: 'global', content: stored },
    ])).toBe('m1')
    // The pnpm rewrite outscores the vitest one against the same entry —
    // corpus IDF downweights the shared frame, unlike the old unweighted
    // prefilter where both merged on the template characters alone.
    expect(scoreOf('项目使用pnpm作为包管理器')).toBeGreaterThan(scoreOf('项目使用vitest作为测试框架'))
  })
})

describe('LLM judge prompt and verdict parser (§3.4)', () => {
  it('JUDGE_SYSTEM_PROMPT contains the three verdict words', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('duplicate')
    expect(JUDGE_SYSTEM_PROMPT).toContain('update')
    expect(JUDGE_SYSTEM_PROMPT).toContain('new')
  })

  it('buildJudgePrompt presents existing and new content', () => {
    const prompt = buildJudgePrompt('use pnpm here', 'use pnpm for this repo')
    expect(prompt).toContain('use pnpm here')
    expect(prompt).toContain('use pnpm for this repo')
    expect(prompt).toContain('Existing memory:')
    expect(prompt).toContain('New candidate:')
  })

  it('parseJudgeVerdict recognizes "duplicate"', () => {
    expect(parseJudgeVerdict('duplicate')).toBe('duplicate')
    expect(parseJudgeVerdict('  Duplicate  ')).toBe('duplicate')
    expect(parseJudgeVerdict('DUPLICATE')).toBe('duplicate')
  })

  it('parseJudgeVerdict recognizes "update"', () => {
    expect(parseJudgeVerdict('update')).toBe('update')
    expect(parseJudgeVerdict('  Update  ')).toBe('update')
  })

  it('parseJudgeVerdict recognizes "new"', () => {
    expect(parseJudgeVerdict('new')).toBe('new')
    expect(parseJudgeVerdict('  New  ')).toBe('new')
  })

  it('parseJudgeVerdict defaults to "duplicate" on unrecognized input', () => {
    expect(parseJudgeVerdict('')).toBe('duplicate')
    expect(parseJudgeVerdict('maybe')).toBe('duplicate')
    expect(parseJudgeVerdict('they are the same')).toBe('duplicate')
    expect(parseJudgeVerdict('I think this is a duplicate')).toBe('duplicate')
  })
})

describe('toDedupCandidate', () => {
  it('projects a MemoryEntry to id/scope/content', () => {
    const entry: MemoryEntry = {
      id: 'abc' as never,
      scope: 'global',
      content: 'test content',
      createdAt: 1,
      updatedAt: 1,
    }
    const candidate = toDedupCandidate(entry)
    expect(candidate).toEqual({ id: 'abc', scope: 'global', content: 'test content' })
  })
})
