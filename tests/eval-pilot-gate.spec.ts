/**
 * The noise-slice pilot's pre-registered gates (eval/pilot-gate.ts): pure
 * G1–G4 over constructed results, the pilot fixture's wire validation, and
 * G5 calibration against a scripted fake-LLM judge (the eval fake server,
 * loopback — no credentials, deterministic).
 */
import { describe, expect, it } from 'vitest'
import { startFakeLlmServer } from '../eval/harness/fake-llm.ts'
import {
  abSelfDiffFailures,
  anchorMatchFailures,
  chainHealthFailures,
  judgeCalibration,
  loadDefaultPilotFixture,
  parsePilotFixture,
  twoPassFlipFailures,
  type CalibrationEntry,
  type CalibrationOutcome,
  type PilotFixture,
} from '../eval/pilot-gate.ts'
import type { JudgeConfig } from '../eval/judge.ts'
import type { AbDiff, QuestionResult, ScenarioResult, StorageVerdictView } from '../eval/report.ts'

function question(overrides: Partial<QuestionResult> & { questionId: string }): QuestionResult {
  return {
    type: 'single-hop',
    requires: ['f1'],
    standingHit: true,
    factHits: [true],
    noiseRatio: 0,
    expectedStandingHit: true,
    answer: null,
    injectionQuality: null,
    answerCorrectness: null,
    judgeError: null,
    judgeInvalidReason: null,
    ...overrides,
  }
}

function verdict(overrides: Partial<StorageVerdictView> & { entryId: string; plantedId: string | null }): StorageVerdictView {
  return {
    contentFidelity: 2,
    scopeAndCategory: 2,
    retrievability: 2,
    mergeBehavior: 2,
    total: 8,
    evidence: 'quote',
    ...overrides,
  }
}

function scenario(overrides: Partial<ScenarioResult> & { scenarioId: string }): ScenarioResult {
  return {
    kind: 'plant',
    domain: 'programming',
    language: 'zh',
    register: 'noisy',
    memoryMode: 'index',
    systemPromptCaptured: true,
    fenceTags: ['memory-index'],
    injection: { chars: 400, tokens: 100 },
    questions: [question({ questionId: 'q1' })],
    storage: {
      entryCount: 1,
      auditSeq: 1,
      writtenIds: ['e1'],
      updatedIds: [],
      verdicts: [verdict({ entryId: 'e1', plantedId: 'f1' })],
      judgeError: null,
    },
    mediumAfter: { entryCount: 1, auditSeq: 1 },
    error: null,
    keptHome: null,
    durationMs: 10,
    ...overrides,
  }
}

describe('G1 chain health', () => {
  it('passes a clean mock chain', () => {
    expect(chainHealthFailures([scenario({ scenarioId: 'n1' })])).toEqual([])
  })

  it('reports scenario errors and a missing captured prompt separately', () => {
    const failures = chainHealthFailures([
      scenario({ scenarioId: 'n1', error: 'turn budget breached' }),
      scenario({ scenarioId: 'n2', systemPromptCaptured: false }),
    ])
    expect(failures).toEqual([
      'n1: scenario error: turn budget breached',
      'n2: no system prompt captured (injection surface not probed)',
    ])
  })
})

describe('G2 same-build A/B self-diff', () => {
  function abDiff(scenarios: AbDiff['scenarios']): AbDiff {
    return { baseline: '/b', candidate: '/b', deterministicEqual: scenarios.every(s => s.deterministicEqual), scenarios }
  }
  const judged = { storageTotalDelta: null, injectionQualityDelta: null, answerCorrectnessDelta: null }

  it('passes an exactly equal deterministic layer', () => {
    expect(abSelfDiffFailures(abDiff([
      { scenarioId: 'n1', deterministicEqual: true, differences: [], judged },
      { scenarioId: 'n2', deterministicEqual: true, differences: [], judged },
    ]))).toEqual([])
  })

  it('names each scenario whose deterministic layer drifted', () => {
    const failures = abSelfDiffFailures(abDiff([
      { scenarioId: 'n1', deterministicEqual: true, differences: [], judged },
      { scenarioId: 'n2', deterministicEqual: false, differences: ['entry count 1 → 2', 'question q1 mechanical state differs'], judged },
    ]))
    expect(failures).toEqual(['n2: entry count 1 → 2; question q1 mechanical state differs'])
  })
})

describe('G3 anchor matchability', () => {
  it('skips seed scenarios (no storage result)', () => {
    expect(anchorMatchFailures([scenario({ scenarioId: 's1', kind: 'seed', storage: null })])).toEqual([])
  })

  it('fails the entryCount > 0 precondition when extraction wrote nothing', () => {
    const failures = anchorMatchFailures([
      scenario({ scenarioId: 'n1', storage: { entryCount: 0, auditSeq: 0, writtenIds: [], updatedIds: [], verdicts: null, judgeError: null } }),
    ])
    expect(failures).toEqual(['n1: precondition entryCount > 0 not met — extraction wrote nothing'])
  })

  it('fails when the memory fence is absent from the captured prompt', () => {
    const failures = anchorMatchFailures([scenario({ scenarioId: 'n1', fenceTags: ['project-notes'] })])
    expect(failures).toEqual(['n1: memory-index fence absent from the captured prompt'])
  })

  it('fails when a non-negative question does not stand, and skips negative questions', () => {
    const failures = anchorMatchFailures([scenario({
      scenarioId: 'n1',
      questions: [
        question({ questionId: 'q1', standingHit: false }),
        question({ questionId: 'q2', standingHit: null }),
        question({ questionId: 'qn', type: 'negative', requires: [], standingHit: null, factHits: null, noiseRatio: null, expectedStandingHit: false }),
      ],
    })])
    expect(failures).toEqual([
      'n1/q1: anchors did not stand on the written entries',
      'n1/q2: anchors did not stand on the written entries',
    ])
  })

  it('passes a run whose entries stand on the anchors', () => {
    expect(anchorMatchFailures([scenario({ scenarioId: 'n1' })])).toEqual([])
  })
})

describe('G4 two-pass stability', () => {
  it('passes two identical passes', () => {
    const passA = [scenario({ scenarioId: 'n1' })]
    expect(twoPassFlipFailures(passA, passA)).toEqual([])
  })

  it('reports each storage dimension that flips more than one tier (entry paired by id)', () => {
    const passA = [scenario({ scenarioId: 'n1' })]
    const passB = [scenario({
      scenarioId: 'n1',
      storage: { entryCount: 1, auditSeq: 1, writtenIds: ['e1'], updatedIds: [], verdicts: [verdict({ entryId: 'e1', plantedId: 'f1', contentFidelity: 0, total: 6 })], judgeError: null },
    })]
    // contentFidelity 2 → 0 and the derived total 8 → 6 are two dimensions.
    const failures = twoPassFlipFailures(passA, passB)
    expect(failures).toHaveLength(2)
    expect(failures[0]).toContain('n1/e1')
    expect(failures[0]).toContain('2 → 0')
    expect(failures[1]).toContain('n1/e1')
    expect(failures[1]).toContain('8 → 6')
  })

  it('tolerates a one-tier flip', () => {
    const passA = [scenario({ scenarioId: 'n1' })]
    const passB = [scenario({
      scenarioId: 'n1',
      storage: { entryCount: 1, auditSeq: 1, writtenIds: ['e1'], updatedIds: [], verdicts: [verdict({ entryId: 'e1', plantedId: 'f1', retrievability: 1, total: 7 })], judgeError: null },
    })]
    expect(twoPassFlipFailures(passA, passB)).toEqual([])
  })

  it('reports recall flips by question id and skips null (unjudged) dimensions', () => {
    const passA = [scenario({ scenarioId: 'n1', questions: [question({ questionId: 'q1', injectionQuality: 3 })] })]
    const passB = [scenario({
      scenarioId: 'n1',
      questions: [
        question({ questionId: 'q1', injectionQuality: 0 }),
        question({ questionId: 'q2', injectionQuality: null }),
      ],
    })]
    const failures = twoPassFlipFailures(passA, passB)
    expect(failures).toEqual(['n1/q1: injectionQuality flipped 3 → 0 (max 1)'])
  })

  it('skips invalid verdicts and scenarios missing from the second pass', () => {
    const passA = [
      scenario({ scenarioId: 'n1', storage: { entryCount: 1, auditSeq: 1, writtenIds: ['e1'], updatedIds: [], verdicts: [verdict({ entryId: 'e1', plantedId: 'f1' })], judgeError: null } }),
      scenario({ scenarioId: 'n2' }),
    ]
    const passB = [scenario({
      scenarioId: 'n1',
      storage: { entryCount: 1, auditSeq: 1, writtenIds: ['e1'], updatedIds: [], verdicts: [verdict({ entryId: 'e1', plantedId: null, contentFidelity: 0, total: 0, invalid: true, invalidReason: 'bad json' })], judgeError: null },
    })]
    expect(twoPassFlipFailures(passA, passB)).toEqual([])
  })
})

describe('pilot fixture wire validation', () => {
  function validFixture(): Record<string, unknown> {
    return {
      schema: 'eval-noise-pilot-v0',
      routes: [{
        scenarioId: 'n1',
        marker: 'mk',
        chatReply: 'reply',
        extraction: [{ factId: 'f1', scope: 'global', category: 'convention', summary: 's', content: 'c' }],
      }],
      calibration: [0, 1, 2].map(index => ({
        id: `c${index}`,
        plants: [{ id: 'f1', statement: 'stmt' }],
        storeBefore: [],
        siblings: [],
        entry: { id: `e${index}`, scope: 'global', content: `content ${index}` },
        expected: { plantedId: null, contentFidelity: 2, scopeAndCategory: 2, retrievability: 2, mergeBehavior: 2, total: 8 },
      })),
    }
  }
  const textOf = (fixture: Record<string, unknown>): string => JSON.stringify(fixture)

  it('accepts a valid fixture and projects pinned fact ground truth plus the updated flag', () => {
    const fixture = validFixture()
    const calibration = fixture['calibration'] as Record<string, unknown>[]
    const first = calibration[0]!
    first['plants'] = [{ id: 'f1', statement: 'stmt', expectedScope: 'user', expectedCategory: 'preference' }]
    first['entry'] = { id: 'e0', scope: 'global', content: 'content 0', updated: true }
    const parsed: PilotFixture = parsePilotFixture(textOf(fixture), 'inline')
    expect(parsed.calibration[0]!.plants[0]).toEqual({ id: 'f1', statement: 'stmt', expectedScope: 'user', expectedCategory: 'preference' })
    expect(parsed.calibration[0]!.entry).toEqual({ id: 'e0', scope: 'global', content: 'content 0', updated: true })
    expect(parsed.routes[0]!.extraction).toEqual([{ factId: 'f1', scope: 'global', category: 'convention', summary: 's', content: 'c' }])
  })

  it('rejects non-JSON and the wrong schema stamp', () => {
    expect(() => parsePilotFixture('not json', 'x')).toThrow(/invalid JSON/)
    const fixture = validFixture()
    fixture['schema'] = 'eval-noise-pilot-v9'
    expect(() => parsePilotFixture(textOf(fixture), 'x')).toThrow(/schema stamp/)
  })

  it('requires non-empty routes and 3–5 calibration entries', () => {
    const emptyRoutes = validFixture()
    emptyRoutes['routes'] = []
    expect(() => parsePilotFixture(textOf(emptyRoutes), 'x')).toThrow(/routes must be a non-empty array/)
    const twoCalibrations = validFixture()
    twoCalibrations['calibration'] = (twoCalibrations['calibration'] as unknown[]).slice(0, 2)
    expect(() => parsePilotFixture(textOf(twoCalibrations), 'x')).toThrow(/3–5 entries, got 2/)
    const sixCalibrations = validFixture()
    sixCalibrations['calibration'] = [...(sixCalibrations['calibration'] as unknown[]), { id: 'x' }, { id: 'y' }, { id: 'z' }]
    expect(() => parsePilotFixture(textOf(sixCalibrations), 'x')).toThrow(/3–5 entries, got 6/)
  })

  it('fails loud on malformed route, plant, entry, and expected fields', () => {
    const routeOf = (fixture: Record<string, unknown>): Record<string, unknown> => (fixture['routes'] as Record<string, unknown>[])[0]!
    const calibrationOf = (fixture: Record<string, unknown>): Record<string, unknown> => (fixture['calibration'] as Record<string, unknown>[])[0]!

    const noMarker = validFixture()
    routeOf(noMarker).marker = ''
    expect(() => parsePilotFixture(textOf(noMarker), 'x')).toThrow(/routes\[0\]\.marker/)

    const badScope = validFixture()
    routeOf(badScope).extraction = [{ factId: 'f1', scope: 'org', category: 'convention', summary: 's', content: 'c' }]
    expect(() => parsePilotFixture(textOf(badScope), 'x')).toThrow(/extraction\[0\]\.scope/)

    const noStatement = validFixture()
    calibrationOf(noStatement).plants = [{ id: 'f1' }]
    expect(() => parsePilotFixture(textOf(noStatement), 'x')).toThrow(/plants\[0\] needs id \+ statement/)

    const noEntryContent = validFixture()
    calibrationOf(noEntryContent).entry = { id: 'e0', scope: 'global' }
    expect(() => parsePilotFixture(textOf(noEntryContent), 'x')).toThrow(/needs id\/scope\/content/)

    const stringScore = validFixture()
    calibrationOf(stringScore).expected = { plantedId: null, contentFidelity: 'high', scopeAndCategory: 2, retrievability: 2, mergeBehavior: 2, total: 8 }
    expect(() => parsePilotFixture(textOf(stringScore), 'x')).toThrow(/expected\.contentFidelity is malformed/)
  })

  it('parses the shipped fixture: six routes, four calibration entries', () => {
    const fixture = loadDefaultPilotFixture(new URL('../eval/datasets/noise-v0.pilot.json', import.meta.url).pathname)
    expect(fixture.schema).toBe('eval-noise-pilot-v0')
    expect(fixture.routes).toHaveLength(6)
    expect(fixture.routes.map(route => route.scenarioId)).toEqual([
      'noise310-prog-context-dump',
      'noise311-work-voice-input',
      'noise312-prog-self-correction',
      'noise313-life-topic-drift',
      'noise314-prog-context-dump-en',
      'noise315-work-topic-drift-mixed',
    ])
    expect(fixture.routes.find(route => route.scenarioId === 'noise312-prog-self-correction')?.extraction).toHaveLength(2)
    expect(fixture.calibration).toHaveLength(4)
  })
})

describe('G5 calibration (scripted fake judge)', () => {
  const entries: CalibrationEntry[] = [
    {
      id: 'hit-a',
      plants: [{ id: 'f1', statement: '端口固定 15432' }],
      storeBefore: [],
      siblings: [],
      entry: { id: 'e1', scope: 'global', category: 'convention', content: '端口固定 15432' },
      expected: { plantedId: 'f1', contentFidelity: 2, scopeAndCategory: 2, retrievability: 2, mergeBehavior: 2, total: 8 },
    },
    {
      id: 'hit-b',
      plants: [{ id: 'f1', statement: '端口固定 15432' }],
      storeBefore: [],
      siblings: [],
      entry: { id: 'e2', scope: 'global', category: 'convention', content: '端口改成 9999 了' },
      expected: { plantedId: null, contentFidelity: 0, scopeAndCategory: 2, retrievability: 2, mergeBehavior: 2, total: 6 },
    },
  ]

  const judgeRoutes = [
    {
      match: (body: string): boolean => body.includes('calibration:hit-a'),
      reply: JSON.stringify({ plantedId: 'f1', contentFidelity: 2, scopeAndCategory: 2, retrievability: 2, mergeBehavior: 2, evidence: 'verbatim', total: 8 }),
    },
    {
      match: (body: string): boolean => body.includes('calibration:hit-b'),
      reply: JSON.stringify({ plantedId: null, contentFidelity: 0, scopeAndCategory: 2, retrievability: 2, mergeBehavior: 2, evidence: 'contradiction', total: 6 }),
    },
  ]

  async function runJudge(calibration: CalibrationEntry[], judgeConfig: JudgeConfig): Promise<CalibrationOutcome[]> {
    return judgeCalibration(calibration, judgeConfig)
  }

  it('hits every pinned tier when the judge agrees with the author', async () => {
    const server = await startFakeLlmServer({ routes: judgeRoutes, defaultReply: 'unreachable', apiKey: 'test-key' })
    try {
      const outcomes = await runJudge(entries, { baseUrl: server.baseUrl, apiKey: 'test-key', model: 'fake-judge' })
      expect(outcomes).toEqual([
        { id: 'hit-a', mismatches: [] },
        { id: 'hit-b', mismatches: [] },
      ])
    } finally {
      await server.stop()
    }
  })

  it('names every pinned tier the judge missed', async () => {
    const drifted: CalibrationEntry = { ...entries[1]!, expected: { ...entries[1]!.expected, total: 8 } }
    const server = await startFakeLlmServer({ routes: judgeRoutes, defaultReply: 'unreachable', apiKey: 'test-key' })
    try {
      const outcomes = await runJudge([drifted], { baseUrl: server.baseUrl, apiKey: 'test-key', model: 'fake-judge' })
      expect(outcomes).toEqual([{ id: 'hit-b', mismatches: ['total 6 ≠ 8'] }])
    } finally {
      await server.stop()
    }
  })

  it('records an invalid verdict as a mismatch with the parse reason', async () => {
    const unrouted: CalibrationEntry = { ...entries[0]!, id: 'bad' }
    const server = await startFakeLlmServer({ routes: [], defaultReply: 'not protocol JSON', apiKey: 'test-key' })
    try {
      const outcomes = await runJudge([unrouted], { baseUrl: server.baseUrl, apiKey: 'test-key', model: 'fake-judge' })
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.id).toBe('bad')
      expect(outcomes[0]!.mismatches[0]).toContain('verdict invalid')
    } finally {
      await server.stop()
    }
  })
})
