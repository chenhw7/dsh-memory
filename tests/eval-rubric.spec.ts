/**
 * Rubric-file contract for eval/rubric/{storage,recall}-v1.md — the versioned
 * scoring rubrics the judge's system prompt is generated from
 * (.agents/notes/implemented/testing/2026-09-01-harness-eval-suite.md,
 * "Scoring rubric").
 *
 * Guards the instrument, not its wording: the version line must lead the file
 * (cross-version scores are never compared), every scored dimension must be
 * anchored in the text, the judge output protocol must be spelled out, and no
 * placeholder markers may survive. Rubric files, like the dataset, must end
 * with exactly one trailing newline.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const storageRubric = readFileSync(join(ROOT, 'eval', 'rubric', 'storage-v1.md'), 'utf8')
const recallRubric = readFileSync(join(ROOT, 'eval', 'rubric', 'recall-v1.md'), 'utf8')

/** Placeholder markers a finished rubric must never carry. */
const PLACEHOLDER_MARKS = ['TODO', 'FIXME', 'TBD', '待定', '占位'] as const

function placeholderMarks(text: string): string[] {
  return PLACEHOLDER_MARKS.filter(mark => text.includes(mark))
}

describe('eval rubric files', () => {
  it('both rubrics lead with the version line and end with exactly one newline', () => {
    for (const [name, text] of [
      ['storage-v1.md', storageRubric],
      ['recall-v1.md', recallRubric],
    ] as const) {
      expect(text.split('\n')[0], `${name}: first line must be the version stamp`).toBe('Rubric version: 1')
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

  it('neither rubric carries placeholder markers', () => {
    expect(placeholderMarks(storageRubric), 'storage rubric placeholders').toEqual([])
    expect(placeholderMarks(recallRubric), 'recall rubric placeholders').toEqual([])
  })
})
