import { describe, it, expect } from 'vitest'
import { detectConflict, detectConflicts, type SessionFact } from '../src/context/conflict.ts'

describe('detectConflict (§3.11)', () => {
  it('returns "fresh" when no correction facts are present', () => {
    const entry = { id: 'e1', content: 'use pnpm here' }
    const facts: SessionFact[] = [{ text: 'install dependencies', isCorrection: false }]
    expect(detectConflict(entry, facts).status).toBe('fresh')
  })

  it('returns "fresh" when a correction fact has no token overlap', () => {
    const entry = { id: 'e1', content: 'use pnpm here' }
    const facts: SessionFact[] = [{ text: 'the moon is round', isCorrection: true }]
    expect(detectConflict(entry, facts).status).toBe('fresh')
  })

  it('returns "conflicting" when a correction with a signal word overlaps significantly', () => {
    const entry = { id: 'e1', content: 'use pnpm here' }
    const facts: SessionFact[] = [{ text: 'actually use npm not pnpm here', isCorrection: true }]
    const result = detectConflict(entry, facts)
    expect(result.status).toBe('conflicting')
    expect(result.conflictingFact).toBe('actually use npm not pnpm here')
  })

  it('returns "stale" when a correction overlaps but has no contradiction signal', () => {
    const entry = { id: 'e1', content: 'use pnpm here' }
    const facts: SessionFact[] = [{ text: 'use pnpm v9 here', isCorrection: true }]
    const result = detectConflict(entry, facts)
    expect(result.status).toBe('stale')
  })

  it('detects CJK contradiction signals', () => {
    const entry = { id: 'e1', content: '用户偏好简洁的回答' }
    const facts: SessionFact[] = [{ text: '用户其实偏好详细回答，不对，之前说的简洁是错的', isCorrection: true }]
    const result = detectConflict(entry, facts)
    expect(result.status).toBe('conflicting')
  })

  it('returns "fresh" when similarity is too low even with a signal', () => {
    const entry = { id: 'e1', content: 'use pnpm here' }
    const facts: SessionFact[] = [{ text: 'actually the moon is not cheese', isCorrection: true }]
    expect(detectConflict(entry, facts).status).toBe('fresh')
  })
})

describe('detectConflicts (§3.11)', () => {
  it('returns empty array when no facts are provided', () => {
    const entries = [{ id: 'e1', content: 'fact A' }]
    expect(detectConflicts(entries, [])).toHaveLength(0)
  })

  it('returns only non-fresh results', () => {
    const entries = [
      { id: 'e1', content: 'use pnpm here' },
      { id: 'e2', content: 'the moon is round' },
    ]
    const facts: SessionFact[] = [{ text: 'actually use npm not pnpm', isCorrection: true }]
    const results = detectConflicts(entries, facts)
    expect(results).toHaveLength(1)
    expect(results[0]!.entryId).toBe('e1')
    expect(results[0]!.status).toBe('conflicting')
  })

  it('handles multiple conflicting entries', () => {
    const entries = [
      { id: 'e1', content: 'use pnpm here' },
      { id: 'e2', content: 'use pnpm for packages' },
      { id: 'e3', content: 'unrelated fact' },
    ]
    const facts: SessionFact[] = [{ text: 'actually do not use pnpm here', isCorrection: true }]
    const results = detectConflicts(entries, facts)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.every(r => r.status === 'conflicting' || r.status === 'stale')).toBe(true)
  })
})
