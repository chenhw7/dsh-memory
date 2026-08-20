import { describe, it, expect, afterEach } from 'vitest'
import { scanContent, setAllowlist } from '../src/scanner.ts'
import { ATTACK_SAMPLES, LEGIT_SAMPLES } from './fixtures/scanner-corpus.ts'
import { parseExtractedMemories } from '../src/review/extract.ts'
import { EXTRACT_GOLDEN } from './fixtures/extract-golden.ts'

describe('scanner corpus regression (§3.1 golden set)', () => {
  describe('attack samples are rejected (zero FN)', () => {
    for (const { label, content } of ATTACK_SAMPLES) {
      it(`rejects: ${label}`, () => {
        const result = scanContent(content)
        expect(result.allowed, `should reject: ${label}`).toBe(false)
        expect(result.reasons.length).toBeGreaterThan(0)
      })
    }
  })

  describe('legit samples are allowed (zero FP)', () => {
    for (const { label, content } of LEGIT_SAMPLES) {
      it(`allows: ${label}`, () => {
        const result = scanContent(content)
        expect(result.allowed, `should allow: ${label}`).toBe(true)
        expect(result.reasons).toHaveLength(0)
      })
    }
  })
})

describe('extract parser golden cases (§3.1 golden set)', () => {
  for (const { label, input, expected } of EXTRACT_GOLDEN) {
    it(label, () => {
      const parsed = parseExtractedMemories(input)
      expect(parsed).toHaveLength(expected.length)
      for (let i = 0; i < expected.length; i++) {
        expect(parsed[i]!.scope).toBe(expected[i]!.scope)
        expect(parsed[i]!.content).toBe(expected[i]!.content)
      }
    })
  }
})

describe('scanner allowlist (§3.10)', () => {
  afterEach(() => {
    // Clear the allowlist after each test so tests don't leak state.
    setAllowlist({})
  })

  it('allows a redacted sample key that is in the allowlist', () => {
    // Use a sample long enough to trigger the DeepSeek pattern (sk- + 32 hex).
    const sampleKey = 'sk-' + '0'.repeat(32) + ' (redacted sample, not real)'
    // Without allowlist, this IS caught.
    expect(scanContent(sampleKey).allowed).toBe(false)

    // With allowlist, the expected sample value is allowed.
    setAllowlist({ 'DeepSeek API key': [sampleKey] })
    expect(scanContent(sampleKey).allowed).toBe(true)
  })

  it('still rejects a real key even when a different value is allowlisted', () => {
    const sampleKey = 'sk-' + '0'.repeat(32) + ' (redacted)'
    setAllowlist({ 'DeepSeek API key': [sampleKey] })
    const realKey = 'sk-' + 'a'.repeat(40)
    expect(scanContent(realKey).allowed).toBe(false)
  })

  it('clearing the allowlist restores rejection', () => {
    const sampleKey = 'sk-' + '0'.repeat(32) + ' (redacted)'
    setAllowlist({ 'DeepSeek API key': [sampleKey] })
    expect(scanContent(sampleKey).allowed).toBe(true)
    setAllowlist({})
    expect(scanContent(sampleKey).allowed).toBe(false)
  })
})
