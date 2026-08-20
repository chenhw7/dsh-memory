import { describe, expect, it } from 'vitest'
import {
  buildMemorySectionText,
  renderMemoryIndex,
  MEMORY_CONTEXT_NOTE,
  MEMORY_POLICY_TEXT,
  type MemoryMode,
  type IndexEntry,
} from '../src/context/policy.ts'

describe('buildMemorySectionText', () => {
  const memoryContent = '## global\n- prefers tabs over spaces\n## user\n- likes concise answers'
  const indexContent = 'global · abc-123 · prefers tabs over spaces'

  it('returns empty text for off mode', () => {
    expect(buildMemorySectionText('off', undefined, memoryContent)).toBe('')
    expect(buildMemorySectionText('off', 'custom policy', '')).toBe('')
  })

  it('returns only the policy block for policy-only mode', () => {
    expect(buildMemorySectionText('policy-only', undefined, memoryContent)).toBe(MEMORY_POLICY_TEXT)
    expect(buildMemorySectionText('policy-only', 'ignored custom text', memoryContent)).toBe(MEMORY_POLICY_TEXT)
  })

  it('returns the custom policy text for custom mode, ignoring memory content', () => {
    expect(buildMemorySectionText('custom', 'do not use memory tools here', memoryContent)).toBe(
      'do not use memory tools here',
    )
  })

  it('falls back to empty text for custom mode with no custom text', () => {
    expect(buildMemorySectionText('custom', undefined, memoryContent)).toBe('')
    expect(buildMemorySectionText('custom', '', memoryContent)).toBe('')
  })

  it('wraps memory content in <memory-context> and appends the policy block for full mode', () => {
    const text = buildMemorySectionText('full', undefined, memoryContent)
    expect(text).toBe(
      `<memory-context>\n${MEMORY_CONTEXT_NOTE}\n\n${memoryContent}\n</memory-context>\n\n${MEMORY_POLICY_TEXT}`,
    )
  })

  it('returns only the policy block for full mode when the frozen content is empty', () => {
    expect(buildMemorySectionText('full', undefined, '')).toBe(MEMORY_POLICY_TEXT)
  })

  it('wraps the index in <memory-index> and appends the policy block for index mode', () => {
    const text = buildMemorySectionText('index', undefined, memoryContent, indexContent)
    expect(text).toContain('<memory-index>')
    expect(text).toContain(indexContent)
    expect(text).toContain(MEMORY_POLICY_TEXT)
  })

  it('returns only the policy block for index mode when the index is empty', () => {
    expect(buildMemorySectionText('index', undefined, memoryContent, '')).toBe(MEMORY_POLICY_TEXT)
  })

  it('covers every mode without falling through', () => {
    const modes: MemoryMode[] = ['full', 'policy-only', 'custom', 'off', 'index']
    for (const mode of modes) {
      expect(typeof buildMemorySectionText(mode, undefined, '', '')).toBe('string')
    }
  })
})

describe('renderMemoryIndex (§3.12)', () => {
  const entries: IndexEntry[] = [
    { id: 'g1', scope: 'global', content: 'network blocks npm proxy X', updatedAt: 100 },
    { id: 'p1', scope: 'project', category: 'convention', projectName: 'demo', content: 'use pnpm here', updatedAt: 300 },
    { id: 'u1', scope: 'user', content: 'prefers concise answers', updatedAt: 200 },
    { id: 'p2', scope: 'project', category: 'convention', projectName: 'demo', content: 'never commit lockfile', updatedAt: 250 },
  ]

  it('returns empty for no entries', () => {
    expect(renderMemoryIndex([], 5000)).toBe('')
  })

  it('returns empty for zero budget', () => {
    expect(renderMemoryIndex(entries, 0)).toBe('')
  })

  it('orders by relevance tier (project → user → global), then recency', () => {
    const text = renderMemoryIndex(entries, 5000)
    const lines = text.split('\n')
    // Project entries first (p1 newer than p2), then user, then global.
    expect(lines[0]).toContain('p1')
    expect(lines[1]).toContain('p2')
    expect(lines[2]).toContain('u1')
    expect(lines[3]).toContain('g1')
  })

  it('renders one existence line per entry with scope/category/project/id/content', () => {
    const text = renderMemoryIndex(entries, 5000)
    expect(text).toContain('project/convention · demo · p1 · use pnpm here')
    expect(text).toContain('global · g1 · network blocks npm proxy X')
  })

  it('truncates content to ~80 chars in the index line', () => {
    const long = 'x'.repeat(200)
    const e: IndexEntry[] = [{ id: 'long1', scope: 'global', content: long, updatedAt: 1 }]
    const text = renderMemoryIndex(e, 5000)
    expect(text).toContain('x'.repeat(80))
    expect(text).not.toContain('x'.repeat(81))
  })

  it('collapses the tail into category roll-up lines when the budget is exhausted', () => {
    // Budget fits ~1-2 lines; the remaining entries roll up.
    // The header overhead is ~246 chars (MEMORY_INDEX_NOTE + framing).
    const text = renderMemoryIndex(entries, 320)
    // The tail is summarized: either with category roll-up lines (×N) or a
    // count-only fallback when even the roll-up exceeds the budget.
    expect(text).toMatch(/\d+ more/)
    // At least one full line was rendered before the roll-up.
    expect(text).toContain('·')
  })

  it('emits category roll-up lines (×N) when the budget fits the roll-up', () => {
    // Budget fits 3 lines + the roll-up text, but not all 4 lines.
    const text = renderMemoryIndex(entries, 380)
    expect(text).toContain('×')
  })
})
