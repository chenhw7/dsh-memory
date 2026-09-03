/**
 * The noise-slice pilot's pre-registered decision rules (the proposal's
 * step 8): the gate must be fixed BEFORE the first judged run, or it
 * degenerates into a rubber stamp. Five gates, in run order:
 *
 * G1 CHAIN HEALTH — the mock full chain over the noise slice: no scenario
 *    error, the opening system prompt captured (the injection surface was
 *    probed). The turn budget is enforced by the runner itself: a breach
 *    fails the scenario, so `error === null` already implies in-budget.
 *    (A mock plant run writes nothing, so no memory fence is expected here;
 *    the fence assertion belongs to G3, where the store is populated.)
 * G2 SAME-BUILD A/B — two mock runs of the same build over the noise slice:
 *    the deterministic layer must be EQUAL (the suite's invariant).
 * G3 ANCHOR MATCHABILITY — the fake-LLM extraction-chain run: every scenario
 *    must have written entries (entryCount > 0 is the PRECONDITION, not the
 *    assertion — the anchor ban guarantees "matchable after written", not
 *    "written"), the memory fence must be present, and every non-negative
 *    question must stand (the anchors hit on the actually-written entries).
 *    The chain writes through the PERIODIC REVIEW lane (mid-session, at
 *    agent/pre-step): the dispose flush is the documented race-loser on the
 *    SDK's hard-exit teardown — see the eval/harness/noise-routes.ts header.
 * G4 TWO-PASS STABILITY — the same material judged twice: no entry or
 *    question flips more than one tier between the two passes.
 * G5 CALIBRATION — the author-pinned expected tiers (3–5 noisy entries,
 *    the fixture beside this spec's corpus): the judge must hit every
 *    pinned tier. G4 measures retest reliability only; under temperature 0
 *    the judge can be "stably wrong", and only the calibration set measures
 *    validity.
 *
 * The gates are pure over constructed results (vitest covers them); the
 * orchestration that produces the results lives in eval/pilot.ts.
 *
 * @module eval/pilot-gate
 */

import { readFileSync } from 'node:fs'
import type { JudgedStoredEntry, JudgeConfig, PlantedFact, StoredEntry } from './judge.ts'
import { judgeStorage } from './judge.ts'
import type { AbDiff, ScenarioResult } from './report.ts'
import type { NoiseRouteScript } from './harness/noise-routes.ts'

/** The pilot fixture's schema stamp (eval/datasets/noise-v0.pilot.json). */
export const PILOT_FIXTURE_SCHEMA = 'eval-noise-pilot-v0'

/** One author-pinned calibration entry: a judge input plus its expected tiers. */
export interface CalibrationEntry {
  readonly id: string
  /** Author's note on which rubric anchor the entry exercises. */
  readonly note?: string
  readonly plants: PlantedFact[]
  readonly storeBefore: StoredEntry[]
  readonly siblings: JudgedStoredEntry[]
  readonly entry: JudgedStoredEntry
  /** The author's expected verdict tiers (the storage rubric's four dimensions + total). */
  readonly expected: {
    readonly plantedId: string | null
    readonly contentFidelity: number
    readonly scopeAndCategory: number
    readonly retrievability: number
    readonly mergeBehavior: number
    readonly total: number
  }
}

/** The whole pilot fixture: the fake-LLM route scripts plus the calibration set. */
export interface PilotFixture {
  readonly schema: string
  readonly routes: NoiseRouteScript[]
  readonly calibration: CalibrationEntry[]
}

/**
 * Load and shape-check the pilot fixture. The fixture is a wire boundary:
 * the fields are re-declared structurally here (zod would drag a runtime
 * dependency into a 2-file artifact whose contents are linted by the
 * corpus spec), and unknown shapes fail loud.
 * @param text - the raw JSON.
 * @param source - file path for error messages.
 * @throws when the schema stamp, a route, or a calibration entry is malformed.
 */
export function parsePilotFixture(text: string, source: string): PilotFixture {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    throw new Error(`eval pilot fixture ${source}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (json['schema'] !== PILOT_FIXTURE_SCHEMA) {
    throw new Error(`eval pilot fixture ${source}: schema stamp must be ${JSON.stringify(PILOT_FIXTURE_SCHEMA)}, got ${JSON.stringify(json['schema'])}`)
  }
  const routesRaw = json['routes']
  const calibrationRaw = json['calibration']
  if (!Array.isArray(routesRaw) || routesRaw.length === 0) {
    throw new Error(`eval pilot fixture ${source}: routes must be a non-empty array`)
  }
  if (!Array.isArray(calibrationRaw) || calibrationRaw.length < 3 || calibrationRaw.length > 5) {
    throw new Error(`eval pilot fixture ${source}: calibration must hold 3–5 entries, got ${Array.isArray(calibrationRaw) ? String(calibrationRaw.length) : typeof calibrationRaw}`)
  }
  const routes: NoiseRouteScript[] = routesRaw.map((row, index) => {
    const route = row as Record<string, unknown>
    for (const field of ['scenarioId', 'marker', 'chatReply'] as const) {
      if (typeof route[field] !== 'string' || (route[field] as string).length === 0) {
        throw new Error(`eval pilot fixture ${source}: routes[${index}].${field} must be a non-empty string`)
      }
    }
    if (!Array.isArray(route['extraction']) || route['extraction'].length === 0) {
      throw new Error(`eval pilot fixture ${source}: routes[${index}].extraction must be a non-empty array`)
    }
    return {
      scenarioId: route['scenarioId'] as string,
      marker: route['marker'] as string,
      chatReply: route['chatReply'] as string,
      extraction: route['extraction'].map((line, lineIndex) => {
        const entry = line as Record<string, unknown>
        for (const field of ['factId', 'scope', 'category', 'summary', 'content'] as const) {
          if (typeof entry[field] !== 'string' || (entry[field] as string).length === 0) {
            throw new Error(`eval pilot fixture ${source}: routes[${index}].extraction[${lineIndex}].${field} must be a non-empty string`)
          }
        }
        const scope = entry['scope']
        if (scope !== 'global' && scope !== 'project' && scope !== 'user') {
          throw new Error(`eval pilot fixture ${source}: routes[${index}].extraction[${lineIndex}].scope must be global|project|user, got ${JSON.stringify(scope)}`)
        }
        return {
          factId: entry['factId'] as string,
          scope: scope as NoiseRouteScript['extraction'][number]['scope'],
          category: entry['category'] as string,
          summary: entry['summary'] as string,
          content: entry['content'] as string,
        }
      }),
    }
  })
  const calibration: CalibrationEntry[] = calibrationRaw.map((row, index) => {
    const entry = row as Record<string, unknown>
    if (typeof entry['id'] !== 'string' || (entry['id'] as string).length === 0) {
      throw new Error(`eval pilot fixture ${source}: calibration[${index}].id must be a non-empty string`)
    }
    const expected = entry['expected'] as Record<string, unknown> | undefined
    if (expected === undefined) {
      throw new Error(`eval pilot fixture ${source}: calibration[${index}].expected is malformed`)
    }
    for (const field of ['plantedId', 'contentFidelity', 'scopeAndCategory', 'retrievability', 'mergeBehavior', 'total'] as const) {
      if (field === 'plantedId' ? typeof expected[field] !== 'string' && expected[field] !== null : typeof expected[field] !== 'number') {
        throw new Error(`eval pilot fixture ${source}: calibration[${index}].expected.${field} is malformed`)
      }
    }
    const plants = Array.isArray(entry['plants']) ? (entry['plants'] as Record<string, unknown>[]) : []
    for (const [plantIndex, plant] of plants.entries()) {
      if (typeof plant['id'] !== 'string' || typeof plant['statement'] !== 'string') {
        throw new Error(`eval pilot fixture ${source}: calibration[${index}].plants[${plantIndex}] needs id + statement`)
      }
    }
    const projectedPlants: PlantedFact[] = plants.map(plant => ({
      id: plant['id'] as string,
      statement: plant['statement'] as string,
      ...(typeof plant['expectedScope'] === 'string' ? { expectedScope: plant['expectedScope'] as PlantedFact['expectedScope'] } : {}),
      ...(typeof plant['expectedCategory'] === 'string' ? { expectedCategory: plant['expectedCategory'] } : {}),
    }))
    const stored = (rows: unknown): JudgedStoredEntry[] => {
      if (!Array.isArray(rows)) return []
      return (rows as Record<string, unknown>[]).map(row => {
        const scope = row['scope']
        if (row['id'] === undefined || row['content'] === undefined
          || (scope !== 'global' && scope !== 'project' && scope !== 'user')) {
          throw new Error(`eval pilot fixture ${source}: calibration[${index}] entry row needs id/scope/content`)
        }
        return {
          id: row['id'] as string,
          scope: scope as JudgedStoredEntry['scope'],
          content: row['content'] as string,
          ...(typeof row['category'] === 'string' ? { category: row['category'] } : {}),
          ...(typeof row['summary'] === 'string' ? { summary: row['summary'] } : {}),
          ...(typeof row['projectName'] === 'string' ? { projectName: row['projectName'] } : {}),
          ...(row['updated'] === true ? { updated: true } : {}),
        }
      })
    }
    const storeBefore = stored(entry['storeBefore'])
    const siblings = stored(entry['siblings'])
    const entryRow = stored([entry['entry']])[0]
    if (entryRow === undefined) {
      throw new Error(`eval pilot fixture ${source}: calibration[${index}].entry is malformed`)
    }
    return {
      id: entry['id'] as string,
      ...(typeof entry['note'] === 'string' ? { note: entry['note'] } : {}),
      plants: projectedPlants,
      storeBefore,
      siblings,
      entry: entryRow,
      expected: {
        plantedId: expected['plantedId'] as string | null,
        contentFidelity: expected['contentFidelity'] as number,
        scopeAndCategory: expected['scopeAndCategory'] as number,
        retrievability: expected['retrievability'] as number,
        mergeBehavior: expected['mergeBehavior'] as number,
        total: expected['total'] as number,
      },
    }
  })
  return { schema: PILOT_FIXTURE_SCHEMA, routes, calibration }
}

/** Read the default pilot fixture next to the datasets. */
export function loadDefaultPilotFixture(fixturePath: string): PilotFixture {
  return parsePilotFixture(readFileSync(fixturePath, 'utf8'), fixturePath)
}

/** G1 — chain health over the deterministic (mock) full chain. */
export function chainHealthFailures(results: readonly ScenarioResult[]): string[] {
  const failures: string[] = []
  for (const result of results) {
    if (result.error !== null) failures.push(`${result.scenarioId}: scenario error: ${result.error}`)
    if (!result.systemPromptCaptured) failures.push(`${result.scenarioId}: no system prompt captured (injection surface not probed)`)
  }
  return failures
}

/** G2 — the same-build A/B self-diff must be exactly equal on the deterministic layer. */
export function abSelfDiffFailures(diff: AbDiff): string[] {
  const failures: string[] = []
  if (!diff.deterministicEqual) {
    for (const scenario of diff.scenarios) {
      if (!scenario.deterministicEqual) failures.push(`${scenario.scenarioId}: ${scenario.differences.join('; ')}`)
    }
  }
  return failures
}

/**
 * G3 — anchor matchability on the extraction-chain run (review lane: the
 * scenario's marker keyword turn drains one review at threshold 1, and the
 * fake LLM replies with the oracle extraction lines). Per scenario: the
 * entryCount > 0 precondition, the memory fence, and the standing hits.
 */
export function anchorMatchFailures(results: readonly ScenarioResult[]): string[] {
  const failures: string[] = []
  for (const result of results) {
    const storage = result.storage
    if (storage === null) continue
    if (storage.entryCount === 0) {
      // The anchor ban guarantees "matchable after written", not "written":
      // a zero-entry run is an extraction miss the mock cannot see.
      failures.push(`${result.scenarioId}: precondition entryCount > 0 not met — extraction wrote nothing`)
      continue
    }
    if (!result.fenceTags.includes('memory-index')) {
      failures.push(`${result.scenarioId}: memory-index fence absent from the captured prompt`)
    }
    for (const question of result.questions) {
      if (question.type === 'negative') continue
      if (question.standingHit !== true) {
        failures.push(`${result.scenarioId}/${question.questionId}: anchors did not stand on the written entries`)
      }
    }
  }
  return failures
}

/** One comparable judged item between two passes, by stable key. */
interface Tiers {
  readonly scores: readonly (number | null)[]
}

function verdictTiers(verdict: { contentFidelity: number; scopeAndCategory: number; retrievability: number; mergeBehavior: number; total: number; invalid?: boolean | undefined } | undefined): Tiers | undefined {
  if (verdict === undefined || verdict.invalid === true) return undefined
  return { scores: [verdict.contentFidelity, verdict.scopeAndCategory, verdict.retrievability, verdict.mergeBehavior, verdict.total] }
}

/**
 * G4 — two-pass stability: the same material judged twice; no entry or
 * question may flip more than one tier on any dimension between the passes.
 */
export function twoPassFlipFailures(passA: readonly ScenarioResult[], passB: readonly ScenarioResult[], maxFlip = 1): string[] {
  const failures: string[] = []
  const bById = new Map(passB.map(result => [result.scenarioId, result]))
  for (const a of passA) {
    const b = bById.get(a.scenarioId)
    if (b === undefined) continue
    // Storage: pair verdicts by entry id (written or updated).
    if (a.storage !== null && b.storage !== null) {
      const aByEntry = new Map((a.storage.verdicts ?? []).map(verdict => [verdict.entryId, verdict]))
      for (const verdict of b.storage.verdicts ?? []) {
        const tiersA = verdictTiers(aByEntry.get(verdict.entryId))
        const tiersB = verdictTiers(verdict)
        if (tiersA === undefined || tiersB === undefined) continue
        tiersA.scores.forEach((scoreA, index) => {
          const scoreB = tiersB.scores[index]
          if (scoreB === undefined || scoreA === null || scoreB === null || Math.abs(scoreA - scoreB) <= maxFlip) return
          failures.push(`${a.scenarioId}/${verdict.entryId}: storage dimension ${String(index)} flipped ${String(scoreA)} → ${String(scoreB)} (max ${String(maxFlip)})`)
        })
      }
    }
    // Recall: pair questions by id.
    const aByQuestion = new Map(a.questions.map(question => [question.questionId, question]))
    for (const question of b.questions) {
      const qa = aByQuestion.get(question.questionId)
      if (qa === undefined) continue
      for (const [dimension, scoreA, scoreB] of [
        ['injectionQuality', qa.injectionQuality, question.injectionQuality],
        ['answerCorrectness', qa.answerCorrectness, question.answerCorrectness],
      ] as const) {
        if (scoreA === null || scoreB === null || Math.abs(scoreA - scoreB) <= maxFlip) continue
        failures.push(`${a.scenarioId}/${question.questionId}: ${dimension} flipped ${String(scoreA)} → ${String(scoreB)} (max ${String(maxFlip)})`)
      }
    }
  }
  return failures
}

/** One calibration outcome: the entry, its verdict, and the mismatched fields. */
export interface CalibrationOutcome {
  readonly id: string
  readonly mismatches: readonly string[]
}

/**
 * G5 — calibration: judge every author-pinned entry (one judge call per
 * entry, the storage protocol) and report which pinned tiers the judge
 * missed. An empty mismatch list across the whole set is the gate.
 */
export async function judgeCalibration(calibration: readonly CalibrationEntry[], judge: JudgeConfig): Promise<CalibrationOutcome[]> {
  const outcomes: CalibrationOutcome[] = []
  for (const item of calibration) {
    const verdicts = await judgeStorage(
      {
        plants: item.plants,
        storeBefore: item.storeBefore,
        siblings: item.siblings,
        entriesAfter: [item.entry],
        scenarioId: `calibration:${item.id}`,
      },
      judge,
    )
    const verdict = verdicts[0]
    const mismatches: string[] = []
    if (verdict === undefined || verdict.invalid === true) {
      mismatches.push(`verdict invalid${verdict?.invalidReason !== undefined ? `: ${verdict.invalidReason}` : ''}`)
    } else {
      const expected = item.expected
      if (verdict.plantedId !== expected.plantedId) mismatches.push(`plantedId ${JSON.stringify(verdict.plantedId)} ≠ ${JSON.stringify(expected.plantedId)}`)
      if (verdict.contentFidelity !== expected.contentFidelity) mismatches.push(`contentFidelity ${String(verdict.contentFidelity)} ≠ ${String(expected.contentFidelity)}`)
      if (verdict.scopeAndCategory !== expected.scopeAndCategory) mismatches.push(`scopeAndCategory ${String(verdict.scopeAndCategory)} ≠ ${String(expected.scopeAndCategory)}`)
      if (verdict.retrievability !== expected.retrievability) mismatches.push(`retrievability ${String(verdict.retrievability)} ≠ ${String(expected.retrievability)}`)
      if (verdict.mergeBehavior !== expected.mergeBehavior) mismatches.push(`mergeBehavior ${String(verdict.mergeBehavior)} ≠ ${String(expected.mergeBehavior)}`)
      if (verdict.total !== expected.total) mismatches.push(`total ${String(verdict.total)} ≠ ${String(expected.total)}`)
    }
    outcomes.push({ id: item.id, mismatches })
  }
  return outcomes
}
