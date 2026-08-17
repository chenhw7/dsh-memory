import { describe, expect, it } from 'vitest'
import { scanContent } from '../src/scanner.ts'
import { MemoryId } from '../src/brand.ts'
import { MemoryStore, validateProjectScope } from '../src/index.ts'
import { parseExtractedMemories, buildFlushMessages } from '../src/review/extract.ts'
import { applyAccumulator, detectSignal, emptyAccumulator } from '../src/review/accumulator.ts'
import { buildMemorySectionText, MEMORY_POLICY_TEXT } from '../src/context/policy.ts'

describe('memory-plugin smoke', () => {
  it('scanner rejects secrets', () => {
    const r = scanContent('my key is sk-ant-' + 'x'.repeat(40))
    expect(r.allowed).toBe(false)
  })
  it('scanner allows plain text', () => {
    expect(scanContent('用户喜欢简洁回答').allowed).toBe(true)
  })
  it('MemoryId mints a branded string', () => {
    expect(typeof MemoryId()).toBe('string')
  })
  it('validateProjectScope rejects project without name', () => {
    expect(() => validateProjectScope({ scope: 'project', content: 'x' })).toThrow()
  })
  it('MemoryStore is an abstract class', () => {
    expect(typeof MemoryStore).toBe('function')
    expect(() => new MemoryStore()).toThrow() // abstract cannot instantiate
  })
  it('parseExtractedMemories parses scope: content lines', () => {
    const r = parseExtractedMemories('user: likes coffee\nbad line\nglobal: note')
    expect(r).toHaveLength(2)
    expect(r[0].scope).toBe('user')
  })
  it('accumulator collects keyword hits', () => {
    const s = applyAccumulator(emptyAccumulator, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '记住我的偏好' }] } } as never)
    expect(s.count).toBe(1)
  })
  it('detectSignal finds correction', () => {
    expect(detectSignal('no, I said X')).toBe('correction')
  })
  it('policy builds text per mode', () => {
    expect(buildMemorySectionText('off', '', '')).toBe('')
    expect(buildMemorySectionText('policy-only', '', '')).toBe(MEMORY_POLICY_TEXT)
    expect(buildMemorySectionText('full', '', 'content')).toContain('memory-context')
  })
})
