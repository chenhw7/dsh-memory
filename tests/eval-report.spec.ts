/**
 * Pure aggregation for the eval suite (eval/report.ts): slice metrics,
 * report stamping, the A/B paired diff and the Markdown renderings — all
 * over constructed inputs, no I/O.
 */
import { describe, expect, it } from 'vitest'
import {
  buildReport,
  diffReports,
  renderAbDiffMarkdown,
  renderReportMarkdown,
  sliceMetrics,
  storagePrecision,
  type QuestionResult,
  type ScenarioResult,
  type StorageVerdictView,
} from '../eval/report.ts'

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

function scenario(overrides: Partial<ScenarioResult> & { scenarioId: string }): ScenarioResult {
  return {
    kind: 'seed',
    domain: 'programming',
    language: 'zh',
    memoryMode: 'index',
    systemPromptCaptured: true,
    fenceTags: ['memory-index'],
    injection: { chars: 400, tokens: 100 },
    questions: [],
    storage: null,
    mediumAfter: { entryCount: 2, auditSeq: 3 },
    error: null,
    keptHome: null,
    durationMs: 10,
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

describe('storagePrecision', () => {
  it('is the share of written entries tracing to a planted fact', () => {
    const verdicts = [
      verdict({ entryId: 'e1', plantedId: 'f1' }),
      verdict({ entryId: 'e2', plantedId: null }),
      verdict({ entryId: 'e3', plantedId: 'f2' }),
    ]
    expect(storagePrecision(['e1', 'e2', 'e3'], verdicts)).toBeCloseTo(2 / 3)
  })

  it('is null when unscored, nothing written, or the judge did not cover every written entry', () => {
    const verdicts = [verdict({ entryId: 'e1', plantedId: 'f1' })]
    expect(storagePrecision(['e1', 'e2'], verdicts)).toBeNull()
    expect(storagePrecision(['e1'], null)).toBeNull()
    expect(storagePrecision([], [])).toBeNull()
    expect(storagePrecision(['e1'], verdicts)).toBe(1)
  })

  it('invalid verdicts drop out of the precision denominator', () => {
    const verdicts = [
      verdict({ entryId: 'e1', plantedId: 'f1' }),
      verdict({ entryId: 'e2', plantedId: null, invalid: true, invalidReason: 'protocol JSON unparseable' }),
      verdict({ entryId: 'e3', plantedId: 'f2' }),
    ]
    expect(storagePrecision(['e1', 'e2', 'e3'], verdicts)).toBe(1)
  })
})

describe('sliceMetrics', () => {
  it('rates standing hits over measurable questions only and skips null judged scores', () => {
    const slice = sliceMetrics('total', [
      scenario({
        scenarioId: 's1',
        questions: [
          question({ questionId: 'q1', standingHit: true }),
          question({ questionId: 'q2', standingHit: false }),
          question({ questionId: 'qn', type: 'negative', requires: [], standingHit: null, factHits: null, noiseRatio: null, expectedStandingHit: false, injectionQuality: 3 }),
        ],
      }),
      scenario({ scenarioId: 's2', questions: [question({ questionId: 'q3', standingHit: true, injectionQuality: 1 })] }),
    ])
    expect(slice.standingHitRate).toBeCloseTo(2 / 3)
    expect(slice.injectionQuality).toBe(2)
    expect(slice.questions).toBe(4)
    expect(slice.scenarios).toBe(2)
  })

  it('aggregates storage means over scored written entries and precision over scenarios', () => {
    const slice = sliceMetrics('total', [
      scenario({
        scenarioId: 'p1',
        kind: 'plant',
        storage: {
          entryCount: 3,
          auditSeq: 9,
          writtenIds: ['e1', 'e2'],
          verdicts: [
            verdict({ entryId: 'e1', plantedId: 'f1', contentFidelity: 2, total: 8 }),
            verdict({ entryId: 'e2', plantedId: null, contentFidelity: 0, total: 2 }),
          ],
          judgeError: null,
        },
      }),
    ])
    expect(slice.storage?.scoredEntries).toBe(2)
    expect(slice.storage?.contentFidelity).toBe(1)
    expect(slice.storage?.precision).toBeCloseTo(0.5)
    expect(slice.storage?.total).toBe(5)
  })

  it('reports null (skipped) when the judge never ran', () => {
    const slice = sliceMetrics('total', [
      scenario({
        scenarioId: 'p1',
        kind: 'plant',
        storage: { entryCount: 1, auditSeq: 1, writtenIds: ['e1'], verdicts: null, judgeError: 'no judge env' },
      }),
    ])
    expect(slice.storage?.contentFidelity).toBeNull()
    expect(slice.storage?.precision).toBeNull()
    expect(slice.storage?.scoredEntries).toBe(0)
  })

  it('excludes invalid verdicts from the means and counts them separately', () => {
    const slice = sliceMetrics('total', [
      scenario({
        scenarioId: 'p1',
        kind: 'plant',
        storage: {
          entryCount: 2,
          auditSeq: 2,
          writtenIds: ['e1', 'e2'],
          verdicts: [
            verdict({ entryId: 'e1', plantedId: 'f1', total: 8, contentFidelity: 2 }),
            verdict({ entryId: 'e2', plantedId: null, total: 0, contentFidelity: 0, invalid: true, invalidReason: 'no JSON' }),
          ],
          judgeError: null,
        },
      }),
    ])
    expect(slice.storage?.scoredEntries).toBe(1)
    expect(slice.storage?.invalidEntries).toBe(1)
    expect(slice.storage?.total).toBe(8)
    expect(slice.storage?.precision).toBe(1)
  })
})

describe('buildReport', () => {
  const results = [
    scenario({ scenarioId: 'seed-zh', language: 'zh', questions: [question({ questionId: 'q1' })] }),
    scenario({
      scenarioId: 'plant-zh',
      kind: 'plant',
      language: 'zh',
      domain: 'daily-work',
      questions: [question({ questionId: 'q2', standingHit: false, noiseRatio: 0.5 })],
    }),
    scenario({
      scenarioId: 'plant-en',
      kind: 'plant',
      language: 'en',
      domain: 'life',
      memoryMode: 'full',
      questions: [question({ questionId: 'q3', type: 'negative', requires: [], standingHit: null, factHits: null, noiseRatio: null, expectedStandingHit: false })],
    }),
  ]

  it('stamps the run and produces totals plus kind/domain/language/type slices', () => {
    const report = buildReport(results, {
      buildDir: '/builds/candidate',
      dataset: 'eval/datasets/core-v0.jsonl',
      memoryMode: 'index',
      rubricVersions: { storage: '1', recall: '1' },
      judge: { model: 'judge-x', baseUrl: 'http://judge/v1' },
      generatedAt: '2026-09-01T00:00:00.000Z',
    })
    expect(report.schema).toBe('eval-report-v0')
    expect(report.generatedAt).toBe('2026-09-01T00:00:00.000Z')
    expect(report.totals.questions).toBe(3)
    expect(report.slices.map(slice => slice.label)).toEqual([
      'kind=seed', 'kind=plant', 'domain=programming', 'domain=daily-work', 'domain=life',
      'language=zh', 'language=en', 'type=single-hop', 'type=negative',
    ])
    expect(report.slices.find(slice => slice.label === 'type=negative')?.standingHitRate).toBeNull()
    expect(report.totals.standingHitRate).toBeCloseTo(0.5)
  })
})

describe('diffReports (A/B paired diff)', () => {
  const stamp = {
    dataset: 'eval/datasets/core-v0.jsonl',
    memoryMode: 'index' as const,
    rubricVersions: { storage: '1', recall: '1' },
    judge: null,
  }
  const build = (results: ScenarioResult[], buildDir: string) => buildReport(results, { ...stamp, buildDir })

  it('judges two identical deterministic layers exactly equal with zero judged deltas', () => {
    const results = [
      scenario({
        scenarioId: 's1',
        questions: [question({ questionId: 'q1', standingHit: true, noiseRatio: 0.25, injectionQuality: 3 })],
        storage: { entryCount: 2, auditSeq: 4, writtenIds: ['e1'], verdicts: [verdict({ entryId: 'e1', plantedId: 'f1', total: 8 })], judgeError: null },
      }),
    ]
    const diff = diffReports(build(results, '/b1'), build(results, '/b2'))
    expect(diff.deterministicEqual).toBe(true)
    expect(diff.scenarios[0]?.deterministicEqual).toBe(true)
    expect(diff.scenarios[0]?.judged).toEqual({ storageTotalDelta: 0, injectionQualityDelta: 0, answerCorrectnessDelta: null })
  })

  it('flags deterministic drift in mechanical state and entry counts', () => {
    const before = scenario({
      scenarioId: 's1',
      questions: [question({ questionId: 'q1', standingHit: true, noiseRatio: 0 })],
      injection: { chars: 400, tokens: 100 },
      mediumAfter: { entryCount: 2, auditSeq: 3 },
    })
    const after = scenario({
      scenarioId: 's1',
      questions: [question({ questionId: 'q1', standingHit: false, noiseRatio: 0 })],
      injection: { chars: 480, tokens: 120 },
      mediumAfter: { entryCount: 3, auditSeq: 5 },
    })
    const diff = diffReports(build([before], '/b1'), build([after], '/b2'))
    expect(diff.deterministicEqual).toBe(false)
    expect(diff.scenarios[0]?.differences).toEqual([
      'injection chars 400 → 480',
      'entry count 2 → 3',
      'question q1 mechanical state differs',
    ])
  })

  it('reports judged deltas as candidate − baseline, null when either side is unscored', () => {
    const questions = (quality: number | null): QuestionResult[] => [question({ questionId: 'q1', injectionQuality: quality })]
    const diff = diffReports(
      build([scenario({ scenarioId: 's1', questions: questions(1) })], '/b1'),
      build([scenario({ scenarioId: 's1', questions: questions(3) })], '/b2'),
    )
    expect(diff.scenarios[0]?.judged.injectionQualityDelta).toBe(2)
    const unscored = diffReports(
      build([scenario({ scenarioId: 's1', questions: questions(null) })], '/b1'),
      build([scenario({ scenarioId: 's1', questions: questions(3) })], '/b2'),
    )
    expect(unscored.scenarios[0]?.judged.injectionQualityDelta).toBeNull()
  })

  it('flags scenarios or questions missing from either side', () => {
    const diff = diffReports(
      build([scenario({ scenarioId: 's1', questions: [question({ questionId: 'q1' }), question({ questionId: 'q2' })] })], '/b1'),
      build([scenario({ scenarioId: 's1', questions: [question({ questionId: 'q1' })] }), scenario({ scenarioId: 's2' })], '/b2'),
    )
    expect(diff.deterministicEqual).toBe(false)
    const s1 = diff.scenarios.find(scenario => scenario.scenarioId === 's1')
    const s2 = diff.scenarios.find(scenario => scenario.scenarioId === 's2')
    expect(s1?.differences).toEqual(['question q2 missing from candidate'])
    expect(s2?.differences).toEqual(['scenario missing from baseline'])
  })
})

describe('markdown renderings', () => {
  const result = scenario({
    scenarioId: 'prog101-build-toolchain',
    kind: 'plant',
    domain: 'programming',
    questions: [question({ questionId: 'q1' }), question({ questionId: 'q2', standingHit: false })],
    storage: {
      entryCount: 2,
      auditSeq: 5,
      writtenIds: ['e1'],
      verdicts: [verdict({ entryId: 'e1', plantedId: 'f1', total: 7 })],
      judgeError: null,
    },
    error: 'boot failed loudly',
    keptHome: '/tmp/dsh-eval-run-keep',
  })
  const report = buildReport([result], {
    buildDir: '/builds/x',
    dataset: 'eval/datasets/core-v0.jsonl',
    memoryMode: 'index',
    rubricVersions: { storage: '1', recall: '1' },
    judge: { model: 'judge-x', baseUrl: 'http://judge/v1' },
    generatedAt: '2026-09-01T00:00:00.000Z',
  })

  it('renders stamp, slice tables and per-scenario rows including failures', () => {
    const markdown = renderReportMarkdown(report)
    expect(markdown).toContain('# Eval report — eval/datasets/core-v0.jsonl')
    expect(markdown).toContain('- build under test: `/builds/x`')
    expect(markdown).toContain('- rubric: storage v1, recall v1')
    expect(markdown).toContain('- judge: judge-x @ http://judge/v1')
    expect(markdown).toContain('| prog101-build-toolchain | plant | programming | zh | 2 | 1/2 |')
    expect(markdown).toContain('boot failed loudly (kept home /tmp/dsh-eval-run-keep)')
    expect(markdown).toContain('storage precision')
  })

  it('renders the judge as skipped when absent', () => {
    const unstamped = buildReport([result], {
      buildDir: '/builds/x',
      dataset: 'd',
      memoryMode: 'off',
      rubricVersions: { storage: '1', recall: '1' },
      judge: null,
      generatedAt: '2026-09-01T00:00:00.000Z',
    })
    expect(renderReportMarkdown(unstamped)).toContain('- judge: skipped (deterministic layer only)')
  })

  it('renders the A/B diff with per-scenario verdicts', () => {
    const diff = diffReports(
      buildReport([result], { buildDir: '/b1', dataset: 'd', memoryMode: 'index', rubricVersions: { storage: '1', recall: '1' }, judge: null, generatedAt: 't' }),
      buildReport([result], { buildDir: '/b2', dataset: 'd', memoryMode: 'index', rubricVersions: { storage: '1', recall: '1' }, judge: null, generatedAt: 't' }),
    )
    const markdown = renderAbDiffMarkdown(diff)
    expect(markdown).toContain('# Eval A/B — /b1 (baseline) vs /b2 (candidate)')
    expect(markdown).toContain('EQUAL across all scenarios')
    expect(markdown).toContain('| prog101-build-toolchain | equal |')
  })
})
