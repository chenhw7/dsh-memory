import { describe, expect, it } from 'vitest'
import {
  buildMemorySectionText,
  MEMORY_CONTEXT_NOTE,
  MEMORY_POLICY_TEXT,
  type MemoryMode,
} from '../src/context/policy.ts'

describe('buildMemorySectionText', () => {
  const memoryContent = '## global\n- prefers tabs over spaces\n## user\n- likes concise answers'

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

  it('covers every mode without falling through', () => {
    const modes: MemoryMode[] = ['full', 'policy-only', 'custom', 'off']
    for (const mode of modes) {
      expect(typeof buildMemorySectionText(mode, undefined, '')).toBe('string')
    }
  })
})
