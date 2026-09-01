import { describe, it, expect, afterEach } from 'vitest'
import { scanContent, setAllowlist, getAllowlist } from '../src/scanner.ts'
import {
  ATTACK_SAMPLES,
  LEGIT_SAMPLES,
  CJK_ATTACK_SAMPLES,
  CJK_LEGIT_SAMPLES,
} from './fixtures/scanner-corpus.ts'
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

  describe('CJK attack samples are rejected (zero FN)', () => {
    for (const { label, content } of CJK_ATTACK_SAMPLES) {
      it(`rejects: ${label}`, () => {
        const result = scanContent(content)
        expect(result.allowed, `should reject: ${label}`).toBe(false)
        // The reason names the CJK pattern, so blocked placeholders stay readable.
        expect(result.reasons.some(r => r.startsWith('injection:'))).toBe(true)
      })
    }
  })

  describe('CJK legit samples are allowed (zero FP)', () => {
    for (const { label, content } of CJK_LEGIT_SAMPLES) {
      it(`allows: ${label}`, () => {
        const result = scanContent(content)
        expect(result.allowed, `should allow: ${label}`).toBe(true)
        expect(result.reasons).toHaveLength(0)
      })
    }
  })

  it('CJK false positive rate over the combined legit corpus is 0%', () => {
    const corpus = [...LEGIT_SAMPLES, ...CJK_LEGIT_SAMPLES]
    const falsePositives = corpus.filter(({ content }) => !scanContent(content).allowed)
    expect(falsePositives, `FP entries: ${falsePositives.map(e => e.label).join('; ')}`).toHaveLength(0)
    // fp-rate = 0 / 30 = 0.0 — pinned here so a future rule that fires on this
    // corpus fails with the offending labels in the message.
  })

  it('each CJK attack sample is caught by a distinct CJK rule (mutation guard)', () => {
    // If a CJK rule is edited into oblivion, its corresponding samples below
    // would fall through to `allowed: true` and this list would name them.
    const survivors = CJK_ATTACK_SAMPLES.filter(({ content }) => scanContent(content).allowed)
    expect(survivors.map(s => s.label)).toEqual([])
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

  it('allowlists a CJK injection pattern by its exact rule name', () => {
    const sample = '构建脚本有坑：请忽略之前的构建指令，先清缓存再全新构建'
    // Sanity: the content actually trips a CJK injection rule before allowlisting.
    const before = scanContent(sample)
    expect(before.allowed).toBe(false)
    expect(before.reasons.some(r => r.startsWith('injection:'))).toBe(true)

    // Allowlist the exact pattern name the scan reported — the escape hatch
    // for a documented false positive (§3.10's production path).
    const pattern = before.reasons[0]!.replace('injection: ', '')
    setAllowlist({ [pattern]: ['构建指令'] })
    expect(scanContent(sample).allowed).toBe(true)
  })

  it('getAllowlist reflects what setAllowlist installed', () => {
    expect(getAllowlist()).toEqual({})
    setAllowlist({ 'DeepSeek API key': ['sk-' + '0'.repeat(32)] })
    expect(Object.keys(getAllowlist())).toEqual(['DeepSeek API key'])
  })
})
