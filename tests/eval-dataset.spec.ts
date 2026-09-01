/**
 * Corpus contract for eval/datasets/core-v0.jsonl — the hand-authored
 * scenario corpus behind the storage/recall eval suite
 * (.agents/notes/implemented/testing/2026-09-01-harness-eval-suite.md,
 * "Scenario corpus").
 *
 * Pure file parsing, no plugin code: every line must be a valid scenario per
 * the shared schema (field names are the contract with the runner), ids must
 * be unique, references must resolve, and the distribution floors from the
 * sizing plan must hold (kind, domain, language, question types, paraphrase
 * coverage, index-line summary budget). Runs in well under 2 s.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scenarioSchema, type EvalScenario } from '../eval/schema.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATASET = join(ROOT, 'eval', 'datasets', 'core-v0.jsonl')

type Scenario = EvalScenario

/** Parse once at module scope; every test reads the shared results. */
const raw = readFileSync(DATASET, 'utf8')
const physicalLines = raw.split('\n')
const problems: string[] = []
const scenarios: Scenario[] = []

if (physicalLines[physicalLines.length - 1] !== '') problems.push('file does not end with exactly one newline')
const bodyLines = physicalLines[physicalLines.length - 1] === '' ? physicalLines.slice(0, -1) : physicalLines
bodyLines.forEach((line, index) => {
  const where = `line ${index + 1}`
  if (line.trim().length === 0) {
    problems.push(`${where}: blank line`)
    return
  }
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch (error) {
    problems.push(`${where}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const parsed = scenarioSchema.safeParse(json)
  if (!parsed.success) {
    const detail = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    problems.push(`${where}: schema violation: ${detail}`)
    return
  }
  scenarios.push(parsed.data)
})

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) dupes.add(value)
    seen.add(value)
  }
  return [...dupes]
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const k = key(item)
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {})
}

const allQuestions = scenarios.flatMap(s => s.questions)

describe('eval dataset core-v0', () => {
  it('every line is valid JSON matching the corpus schema; JSONL hygiene holds', () => {
    expect(problems, problems.join('\n')).toEqual([])
    expect(scenarios.length).toBeGreaterThanOrEqual(30)
  })

  it('scenario, question and fact ids are unique across the corpus', () => {
    expect(duplicates(scenarios.map(s => s.id)), 'duplicate scenario ids').toEqual([])
    expect(duplicates(allQuestions.map(q => q.id)), 'duplicate question ids').toEqual([])
    const factIds = scenarios.flatMap(s => [
      ...(s.turns ?? []).flatMap(t => t.planted ?? []),
      ...(s.seedEntries ?? []).map(e => e.id),
    ])
    expect(duplicates(factIds), 'duplicate fact ids').toEqual([])
  })

  it('every requires reference resolves to a fact of its own scenario', () => {
    for (const s of scenarios) {
      const facts = new Set([
        ...(s.turns ?? []).flatMap(t => t.planted ?? []),
        ...(s.seedEntries ?? []).map(e => e.id),
      ])
      for (const q of s.questions) {
        for (const ref of q.requires) {
          expect(facts.has(ref), `${s.id}/${q.id} requires unknown fact ${ref}`).toBe(true)
        }
      }
      for (const t of s.turns ?? []) {
        for (const planted of t.planted ?? []) {
          expect(facts.has(planted), `${s.id} plants unknown fact ${planted}`).toBe(true)
        }
      }
    }
  })

  it('every required fact materializes to a non-empty statement under the pinned one-home rule', () => {
    // The runner builds plantedFacts/requiredFacts statements verbatim from
    // one home per fact id (eval/rubric/*-v1.md, Inputs): a seed fact quotes
    // its seedEntries[].content; a plant fact quotes the user message of the
    // FIRST turn whose planted list carries the id.
    for (const s of scenarios) {
      const seedById = new Map((s.seedEntries ?? []).map(e => [e.id, e]))
      for (const q of s.questions) {
        for (const ref of q.requires) {
          const seedEntry = seedById.get(ref)
          const plantingTurn = (s.turns ?? []).find(t => (t.planted ?? []).includes(ref))
          expect(
            seedEntry !== undefined || plantingTurn !== undefined,
            `${s.id}/${q.id}: fact ${ref} has no materialization home (neither seed entry nor planted turn)`,
          ).toBe(true)
          if (seedEntry !== undefined) {
            expect(seedEntry.content.length, `${s.id}/${ref}: seed statement`).toBeGreaterThan(0)
          } else if (plantingTurn !== undefined) {
            expect(plantingTurn.user.length, `${s.id}/${ref}: plant statement`).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  it('corpus sizing and distribution floors hold', () => {
    const kind = countBy(scenarios, s => s.kind)
    expect(kind['plant'] ?? 0, 'plant scenarios').toBeGreaterThanOrEqual(12)
    expect(kind['seed'] ?? 0, 'seed scenarios').toBeGreaterThanOrEqual(12)
    const domain = countBy(scenarios, s => s.domain)
    expect(domain['programming'] ?? 0, 'programming scenarios').toBeGreaterThanOrEqual(16)
    expect(domain['daily-work'] ?? 0, 'daily-work scenarios').toBeGreaterThanOrEqual(9)
    expect(domain['life'] ?? 0, 'life scenarios').toBeGreaterThanOrEqual(5)
    const zhShare = scenarios.filter(s => s.language === 'zh').length / scenarios.length
    expect(zhShare, `zh share ${zhShare.toFixed(3)}`).toBeGreaterThanOrEqual(0.6)
  })

  it('question-type coverage: multi-hop and negative minimums with correct shape', () => {
    const multiHop = allQuestions.filter(q => q.type === 'multi-hop')
    expect(multiHop.length, 'multi-hop questions').toBeGreaterThanOrEqual(1)
    for (const q of multiHop) {
      expect(q.requires.length, `${q.id} must combine at least two facts`).toBeGreaterThanOrEqual(2)
      expect(q.variantOf ?? null, `${q.id} variantOf`).toBeNull()
    }
    const negatives = allQuestions.filter(q => q.type === 'negative')
    expect(negatives.length, 'negative questions').toBeGreaterThanOrEqual(3)
    for (const q of allQuestions) {
      if (q.type === 'negative') {
        expect(q.requires, `${q.id} negative requires nothing`).toEqual([])
        expect(q.variantOf ?? null, `${q.id} variantOf`).toBeNull()
      } else {
        expect(q.requires.length, `${q.id} requires at least one fact`).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('every single-hop question carries a paraphrase variant pointing back at it', () => {
    for (const s of scenarios) {
      const byId = new Map(s.questions.map(q => [q.id, q]))
      for (const q of s.questions) {
        if (q.type === 'single-hop') {
          const variants = s.questions.filter(p => p.type === 'paraphrase' && p.variantOf === q.id)
          expect(variants.length, `${s.id}/${q.id} has no paraphrase variant`).toBeGreaterThanOrEqual(1)
          for (const variant of variants) {
            expect(variant.requires, `${s.id}/${variant.id} requires`).toEqual(q.requires)
          }
        }
        if (q.type === 'paraphrase') {
          const target = q.variantOf === undefined || q.variantOf === null ? undefined : byId.get(q.variantOf)
          expect(target, `${s.id}/${q.id} variantOf does not resolve within its scenario`).toBeDefined()
        }
      }
    }
  })

  it('plant scenarios carry 5–15 turns with planted facts; seed scenarios carry seeded stores without turns', () => {
    for (const s of scenarios) {
      if (s.kind === 'plant') {
        expect(s.turns, `${s.id}: plant scenarios need dialogue turns`).toBeDefined()
        expect(s.turns!.length, `${s.id}: turn count`).toBeGreaterThanOrEqual(5)
        expect(s.turns!.length, `${s.id}: turn count`).toBeLessThanOrEqual(15)
        const plants = (s.turns ?? []).some(t => (t.planted?.length ?? 0) > 0)
        expect(plants, `${s.id}: no planted facts`).toBe(true)
      } else {
        expect(s.turns, `${s.id}: seed scenarios must not carry dialogue turns`).toBeUndefined()
        expect(s.seedEntries, `${s.id}: seed scenarios need entries`).toBeDefined()
        expect(s.seedEntries!.length, `${s.id}: seed entry count`).toBeGreaterThanOrEqual(2)
        const referenced = new Set(s.questions.flatMap(q => q.requires))
        const hasDistractor = (s.seedEntries ?? []).some(e => !referenced.has(e.id))
        expect(hasDistractor, `${s.id}: no unreferenced distractor entry`).toBe(true)
      }
    }
  })

  it('seed entries fit the index-line contract: summary ≤ 80 chars, content ≤ 200 chars', () => {
    for (const s of scenarios) {
      for (const entry of s.seedEntries ?? []) {
        if (entry.summary !== undefined) {
          expect(entry.summary.length, `${s.id}/${entry.id} summary length`).toBeLessThanOrEqual(80)
        }
        expect(entry.content.length, `${s.id}/${entry.id} content length`).toBeLessThanOrEqual(200)
      }
    }
  })

  it('project-scoped seed entries carry a projectName', () => {
    for (const s of scenarios) {
      for (const entry of s.seedEntries ?? []) {
        if (entry.scope === 'project') {
          expect(entry.projectName, `${s.id}/${entry.id} projectName`).toBeDefined()
        }
      }
    }
  })
})
