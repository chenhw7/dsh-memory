/**
 * Rubric-file contract for eval/rubric/{storage,recall}-v2.md — the versioned
 * scoring rubrics the judge's system prompt is generated from
 * (.agents/notes/implemented/testing/2026-09-01-harness-eval-suite.md,
 * "Scoring rubric"; the v2 anchor upgrades per
 * .agents/notes/proposed/testing/2026-09-03-eval-audit-and-noisy-corpus.zh.md,
 * 第一步).
 *
 * Guards the instrument, not its wording: the version line must lead the file
 * (cross-version scores are never compared), every scored dimension must be
 * anchored in the text, the judge output protocol must be spelled out, and no
 * placeholder markers may survive. The v2 rubrics must carry the four anchor
 * upgrades (dim1 normalization guidance, the stale same-topic neighbor tier,
 * the medium-diff updated-entry basis, the pinned scope/category ground
 * truth). The v1 pair stays in the tree as the FROZEN scale historical
 * reports were stamped with: it keeps its own version stamp and is no longer
 * referenced by the judge. Rubric files, like the dataset, must end with
 * exactly one trailing newline.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUBRIC_DIR = join(ROOT, 'eval', 'rubric')
const storageRubric = readFileSync(join(RUBRIC_DIR, 'storage-v2.md'), 'utf8')
const recallRubric = readFileSync(join(RUBRIC_DIR, 'recall-v2.md'), 'utf8')
const storageFrozen = readFileSync(join(RUBRIC_DIR, 'storage-v1.md'), 'utf8')
const recallFrozen = readFileSync(join(RUBRIC_DIR, 'recall-v1.md'), 'utf8')

/** Placeholder markers a finished rubric must never carry. */
const PLACEHOLDER_MARKS = ['TODO', 'FIXME', 'TBD', '待定', '占位'] as const

function placeholderMarks(text: string): string[] {
  return PLACEHOLDER_MARKS.filter(mark => text.includes(mark))
}

describe('eval rubric files (active pair: v2)', () => {
  it('both rubrics lead with the v2 version line and end with exactly one newline', () => {
    for (const [name, text] of [
      ['storage-v2.md', storageRubric],
      ['recall-v2.md', recallRubric],
    ] as const) {
      expect(text.split('\n')[0], `${name}: first line must be the version stamp`).toBe('Rubric version: 2')
      expect(text.endsWith('\n'), `${name}: must end with a newline`).toBe(true)
      expect(text.endsWith('\n\n'), `${name}: must end with exactly one newline`).toBe(false)
    }
  })

  it('storage rubric anchors all four dimensions, the scope cap, precision, and the JSON protocol', () => {
    const lowered = storageRubric.toLowerCase()
    for (const dimension of ['content fidelity', 'scope & category', 'retrievability', 'merge behavior']) {
      expect(lowered, `missing dimension heading: ${dimension}`).toContain(dimension)
    }
    for (const tier of ['**0 —', '**1 —', '**2 —']) {
      expect(storageRubric, `missing anchored tier ${tier}`).toContain(tier)
    }
    for (const token of ['storage precision', 'Scope cap', 'traceability', 'plantedId', 'contentFidelity', 'scopeAndCategory', 'retrievability', 'mergeBehavior', 'evidence', 'total']) {
      expect(storageRubric, `missing protocol/metric token: ${token}`).toContain(token)
    }
  })

  it('recall rubric defines the mechanical items, both judged scales, and the JSON protocol', () => {
    const lowered = recallRubric.toLowerCase()
    for (const item of ['standing hit', 'noise ratio', 'injection cost', 'injection quality', 'answer correctness']) {
      expect(lowered, `missing item definition: ${item}`).toContain(item)
    }
    for (const tier of ['**0 —', '**1 —', '**2 —', '**3 —']) {
      expect(recallRubric, `missing anchored tier ${tier}`).toContain(tier)
    }
    for (const token of ['injectionQuality', 'answerCorrectness', 'evidence']) {
      expect(recallRubric, `missing protocol token: ${token}`).toContain(token)
    }
  })

  it('storage v2 carries the medium-diff basis and the pinned scope/category ground truth', () => {
    // P0#1: updated entries (id in storeBefore + content/scope/category/summary
    // diff) enter the judged population and the precision denominator.
    for (const token of ['Medium-diff', 'updated: true', 'written', 'storeBefore', 'expectedScope', 'expectedCategory', 'factText']) {
      expect(storageRubric, `missing v2 anchor token: ${token}`).toContain(token)
    }
    // P1/dim1 anchor: normalizing obvious typos is not fabrication; keeping
    // the noisy wording is not a loss.
    const lowered = storageRubric.toLowerCase()
    expect(lowered).toContain('not fabrication')
    expect(storageRubric).toContain('NOT a')
  })

  it('recall v2 carries the stale same-topic neighbor tier and the annotated-staleness rule', () => {
    // P0#3: an accurate-but-unsuperseded same-topic neighbor is an explicit
    // tier-1 case; an annotated (superseded) neighbor does not demote a
    // clean injection.
    const lowered = recallRubric.toLowerCase()
    expect(lowered).toContain('same-topic neighbor')
    expect(lowered).toContain('annotation')
    // Conflict-discrimination questions (prog101/prog116) judge against the
    // annotated-staleness wording.
    expect(recallRubric).toContain('过时')
  })

  it('neither rubric carries placeholder markers', () => {
    expect(placeholderMarks(storageRubric), 'storage rubric placeholders').toEqual([])
    expect(placeholderMarks(recallRubric), 'recall rubric placeholders').toEqual([])
  })
})

describe('eval rubric files (frozen pair: v1)', () => {
  it('the v1 rubrics stay in the tree with their v1 stamps, untouched', () => {
    expect(storageFrozen.split('\n')[0]).toBe('Rubric version: 1')
    expect(recallFrozen.split('\n')[0]).toBe('Rubric version: 1')
    expect(storageFrozen.endsWith('\n')).toBe(true)
    expect(recallFrozen.endsWith('\n')).toBe(true)
  })
})
