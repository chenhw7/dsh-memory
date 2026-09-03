/**
 * Corpus contract for eval/datasets/noise-v0.jsonl + eval/datasets/noise-v0.pilot.json
 * — the noisy long-prompt slice (the proposal
 * .agents/notes/proposed/testing/2026-09-03-eval-audit-and-noisy-corpus.zh.md,
 * "第二步（噪声试点）"). Noise is an AUTHORED controlled variable: this spec
 * lints the floors the pilot relies on — scenario/language shape, the four
 * long-diff patterns, turn-length distribution, the unplanted-material share,
 * the anchor lint (every anchor token verbatim in the fact's materialized
 * home turn — corruption would guarantee a mechanical false miss), and the
 * pilot fixture's route scripts (markers unique and present, extraction lines
 * covering exactly the planted facts at the pinned scope/category).
 *
 * The noise style guide is the contract and is restated here as the review
 * checklist (its mechanical halves are the lints below):
 * - 锚定 token（工具名、数字、标识符、路径）永不出错 — the anchors lint;
 * - 负例、gold 与 required facts 的锚定表述保持干净 — authoring rule:
 *   the paraphrase questions of this slice may carry light typos, their
 *   golds and the negative questions must not (review gate, not lintable);
 * - turn 长度 150–600 字符、未埋点内容占六成以上 — the floors below.
 *
 * Pure function coverage over the corpus files; the only product import is
 * the accumulator's `detectSignal` (the candidate funnel the review
 * extraction lane relies on — the marker-turn lint asserts against it).
 * Runs in well under 2 s.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parsePilotFixture } from '../eval/pilot-gate.ts'
import { noisePatternSchema, scenarioSchema, type EvalScenario } from '../eval/schema.ts'
// The product's own candidate funnel (type-only plugin imports): reusing it
// keeps this lint from drifting from the runtime signal detection.
import { detectSignal } from '../src/review/accumulator.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATASET = join(ROOT, 'eval', 'datasets', 'noise-v0.jsonl')
const FIXTURE = join(ROOT, 'eval', 'datasets', 'noise-v0.pilot.json')

type Scenario = EvalScenario

/** Parse once at module scope; every test reads the shared results. */
const raw = readFileSync(DATASET, 'utf8')
const problems: string[] = []
const scenarios: Scenario[] = []

const physicalLines = raw.split('\n')
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

const fixture = parsePilotFixture(readFileSync(FIXTURE, 'utf8'), FIXTURE)
const byId = new Map(scenarios.map(scenario => [scenario.id, scenario]))

/** The materialized home turn of one planted fact (first turn carrying the id). */
function homeTurnOf(scenario: Scenario, factId: string): string {
  const turn = (scenario.turns ?? []).find(candidate => (candidate.planted ?? []).includes(factId))
  if (turn === undefined) throw new Error(`no planting turn for ${factId}`)
  return turn.user
}

describe('eval dataset noise-v0 (corpus floors)', () => {
  it('every line is valid JSON matching the corpus schema; JSONL hygiene holds', () => {
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('the slice is ≥6 all-noisy all-plant scenarios: zh 4 / en 1 / mixed 1', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(6)
    for (const scenario of scenarios) {
      expect(scenario.register, `${scenario.id}: register`).toBe('noisy')
      expect(scenario.kind, `${scenario.id}: kind`).toBe('plant')
    }
    const languages = scenarios.map(scenario => scenario.language)
    expect(languages.filter(language => language === 'zh').length).toBe(4)
    expect(languages.filter(language => language === 'en').length).toBe(1)
    expect(languages.filter(language => language === 'mixed').length).toBe(1)
  })

  it('the slice declares noise patterns covering all four long-diff patterns', () => {
    const union = new Set(scenarios.flatMap(scenario => scenario.patterns ?? []))
    for (const pattern of noisePatternSchema.options) {
      expect(union.has(pattern), `pattern ${pattern} uncovered by the slice`).toBe(true)
    }
  })

  it('turn-length distribution: planted turns 150–600 chars, every turn ≤ 600', () => {
    for (const scenario of scenarios) {
      for (const turn of scenario.turns ?? []) {
        expect(turn.user.length, `${scenario.id}: turn length`).toBeLessThanOrEqual(600)
        if ((turn.planted ?? []).length > 0) {
          expect(turn.user.length, `${scenario.id}: planted turn length`).toBeGreaterThanOrEqual(150)
        }
      }
    }
  })

  it('each scenario plants 1–2 facts, and the unplanted material is ≥ 60% of the message volume', () => {
    for (const scenario of scenarios) {
      const facts = scenario.plantFacts ?? []
      expect(facts.length, `${scenario.id}: plant fact count`).toBeGreaterThanOrEqual(1)
      expect(facts.length, `${scenario.id}: plant fact count`).toBeLessThanOrEqual(2)
      const plantedIds = (scenario.turns ?? []).flatMap(turn => turn.planted ?? [])
      expect(new Set(plantedIds).size, `${scenario.id}: planted id count`).toBe(plantedIds.length)
      const totalUser = (scenario.turns ?? []).reduce((sum, turn) => sum + turn.user.length, 0)
      const plantedChars = facts.reduce((sum, fact) => sum + (fact.factText?.length ?? 0), 0)
      expect((totalUser - plantedChars) / totalUser, `${scenario.id}: unplanted share`).toBeGreaterThanOrEqual(0.6)
    }
  })

  it('the anchors lint: every anchor token is verbatim in its fact\'s materialized home turn', () => {
    for (const scenario of scenarios) {
      for (const fact of scenario.plantFacts ?? []) {
        const home = homeTurnOf(scenario, fact.id)
        for (const anchor of fact.anchors ?? []) {
          expect(home.includes(anchor), `${scenario.id}/${fact.id}: anchor ${JSON.stringify(anchor)} corrupted or absent in the home turn`).toBe(true)
        }
      }
    }
  })

  it('the pilot carries scope ground truth: every noise plant pins expectedScope and expectedCategory', () => {
    for (const scenario of scenarios) {
      for (const fact of scenario.plantFacts ?? []) {
        expect(fact.expectedScope, `${scenario.id}/${fact.id}: expectedScope pin`).toBeDefined()
        expect(fact.expectedCategory, `${scenario.id}/${fact.id}: expectedCategory pin`).toBeDefined()
      }
    }
  })

  it('question hygiene: requires resolve, negatives are clean, 2–3 light-typo paraphrases in the slice', () => {
    let paraphrases = 0
    for (const scenario of scenarios) {
      const facts = new Set((scenario.turns ?? []).flatMap(turn => turn.planted ?? []))
      const byQuestion = new Map(scenario.questions.map(question => [question.id, question]))
      for (const question of scenario.questions) {
        if (question.type === 'negative') {
          expect(question.requires, `${scenario.id}/${question.id}: negative requires nothing`).toEqual([])
        } else {
          for (const ref of question.requires) {
            expect(facts.has(ref), `${scenario.id}/${question.id}: requires unknown fact ${ref}`).toBe(true)
          }
        }
        if (question.type === 'paraphrase') {
          paraphrases += 1
          const parent = question.variantOf === undefined || question.variantOf === null ? undefined : byQuestion.get(question.variantOf)
          expect(parent, `${scenario.id}/${question.id}: variantOf must resolve within its scenario`).toBeDefined()
          expect(question.q, `${scenario.id}/${question.id}: a paraphrase must reword its parent`).not.toBe(parent?.q)
        }
      }
    }
    expect(paraphrases, 'slice paraphrase count').toBeGreaterThanOrEqual(2)
    expect(paraphrases, 'slice paraphrase count').toBeLessThanOrEqual(3)
  })
})

describe('eval pilot fixture (route scripts)', () => {
  it('routes cover exactly the noise scenarios, with markers that are unique and present in the owning turns', () => {
    const routeIds = fixture.routes.map(route => route.scenarioId)
    expect(routeIds).toHaveLength(scenarios.length)
    expect(new Set(routeIds).size, 'duplicate route scenario ids').toBe(routeIds.length)
    for (const route of fixture.routes) {
      const scenario = byId.get(route.scenarioId)
      expect(scenario, `route for unknown scenario ${route.scenarioId}`).toBeDefined()
      const ownTurns = (scenario?.turns ?? []).map(turn => turn.user).join(' ')
      expect(ownTurns.includes(route.marker), `${route.scenarioId}: marker ${JSON.stringify(route.marker)} absent from its own turns`).toBe(true)
      for (const other of scenarios) {
        if (other.id === route.scenarioId) continue
        expect((other.turns ?? []).map(turn => turn.user).join(' ').includes(route.marker),
          `${route.scenarioId}: marker ${JSON.stringify(route.marker)} leaks into ${other.id}`).toBe(false)
      }
    }
  })

  it('the marker turn triggers a review candidate (the extraction lane needs the keyword funnel)', () => {
    // The evidence run extracts via the periodic review: its LLM body carries
    // only the candidate fragments, so the scenario's marker must live in a
    // turn that also trips the accumulator's signal detection (an explicit
    // memory keyword or a correction) — otherwise the review route never
    // matches and the scenario writes nothing.
    for (const route of fixture.routes) {
      const scenario = byId.get(route.scenarioId)
      if (scenario === undefined) continue
      const markerTurn = (scenario.turns ?? []).find(turn => turn.user.includes(route.marker))
      expect(markerTurn, `${route.scenarioId}: no turn carries the marker`).toBeDefined()
      expect(detectSignal(markerTurn!.user),
        `${route.scenarioId}: marker turn trips no review candidate — the extraction lane would write nothing`).toBeDefined()
    }
  })

  it('each extraction line covers exactly its scenario\'s planted facts at the pinned scope/category, with anchors intact', () => {
    for (const route of fixture.routes) {
      const scenario = byId.get(route.scenarioId)
      if (scenario === undefined) continue
      const factById = new Map((scenario.plantFacts ?? []).map(fact => [fact.id, fact]))
      const routeIds = route.extraction.map(line => line.factId)
      expect(new Set(routeIds), `${route.scenarioId}: extraction fact ids must equal the planted set`).toEqual(new Set(factById.keys()))
      for (const line of route.extraction) {
        const fact = factById.get(line.factId)
        expect(fact, `${route.scenarioId}: extraction line for unplanted fact ${line.factId}`).toBeDefined()
        expect(line.scope, `${route.scenarioId}/${line.factId}: route scope`).toBe(fact?.expectedScope)
        expect(line.category, `${route.scenarioId}/${line.factId}: route category`).toBe(fact?.expectedCategory)
        expect(line.summary.length, `${route.scenarioId}/${line.factId}: summary budget`).toBeLessThanOrEqual(80)
        for (const anchor of fact?.anchors ?? []) {
          expect(line.summary.includes(anchor) || line.content.includes(anchor),
            `${route.scenarioId}/${line.factId}: anchor ${JSON.stringify(anchor)} missing from summary+content`).toBe(true)
        }
      }
    }
  })

  it('the calibration set holds 3–5 author-pinned entries', () => {
    expect(fixture.calibration.length).toBeGreaterThanOrEqual(3)
    expect(fixture.calibration.length).toBeLessThanOrEqual(5)
    for (const item of fixture.calibration) {
      expect(item.plants.length, `${item.id}: at least one plant`).toBeGreaterThanOrEqual(1)
      // storeBefore may share its id with `entry` — that IS the medium-diff
      // update case (an updated entry keeps its id); the uniqueness gates are
      // within storeBefore, within siblings, and entry-vs-siblings.
      expect(new Set(item.storeBefore.map(row => row.id)).size, `${item.id}: duplicate storeBefore ids`).toBe(item.storeBefore.length)
      expect(new Set(item.siblings.map(row => row.id)).size, `${item.id}: duplicate sibling ids`).toBe(item.siblings.length)
      expect(item.siblings.some(row => row.id === item.entry.id), `${item.id}: sibling collides with the entry under review`).toBe(false)
    }
  })
})
