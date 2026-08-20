import { describe, it, expect } from 'vitest'
import {
  tokenize,
  jaccardSimilarity,
  findDuplicate,
  mergeContent,
  toDedupCandidate,
} from '../src/review/dedup.ts'
import type { MemoryEntry } from '../src/types.ts'

describe('tokenize', () => {
  it('splits Latin words into lowercase tokens', () => {
    expect(tokenize('Use pnpm here')).toEqual(new Set(['use', 'pnpm', 'here']))
  })

  it('matches CJK characters per-character', () => {
    expect(tokenize('用户偏好简洁回答')).toEqual(new Set(['用', '户', '偏', '好', '简', '洁', '回', '答']))
  })

  it('deduplicates repeated tokens', () => {
    expect(tokenize('pnpm pnpm pnpm')).toEqual(new Set(['pnpm']))
  })

  it('returns empty set for empty/whitespace content', () => {
    expect(tokenize('')).toEqual(new Set())
    expect(tokenize('   ')).toEqual(new Set())
  })
})

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    const a = tokenize('use pnpm here')
    expect(jaccardSimilarity(a, a)).toBe(1)
  })

  it('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0)
  })

  it('returns correct fraction for partial overlap', () => {
    // a = {a, b, c}, b = {b, c, d} → intersection=2, union=4 → 0.5
    expect(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5)
  })

  it('returns 0 for both empty', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0)
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
    const dup = findDuplicate('user prefers answers concise', 'global', existing, 0.3)
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
