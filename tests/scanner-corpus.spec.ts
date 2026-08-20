import { describe, it, expect } from 'vitest'
import { scanContent } from '../src/scanner.ts'
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
