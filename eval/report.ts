/**
 * Pure aggregation for the eval suite: per-scenario results (filled in by
 * eval/runner.ts) roll up into slice metrics, a stamped report, and the A/B
 * paired diff. No I/O — JSON and Markdown rendering are pure functions over
 * constructed inputs, which is what the vitest specs cover.
 *
 * @module eval/report
 */

import type { InjectionCost } from './mechanical.ts'

export type QuestionType = 'single-hop' | 'multi-hop' | 'paraphrase' | 'negative'
export type ScenarioKind = 'plant' | 'seed'
export type EffectiveMemoryMode = 'index' | 'full' | 'off'

/** One scored question's outcome (mechanical + judged items, raw values kept). */
export interface QuestionResult {
  readonly questionId: string
  readonly type: QuestionType
  /** Fact ids the question needs; empty exactly for negative questions. */
  readonly requires: readonly string[]
  /** Mechanical standing hit; `null` = not measurable (negative / no prompt). */
  readonly standingHit: boolean | null
  /** Per-required-fact hits, aligned with `requires`. */
  readonly factHits: readonly boolean[] | null
  /** Mechanical noise ratio; `null` = not measurable (negative / no lines). */
  readonly noiseRatio: number | null
  /**
   * Corpus semantics preserved raw: a negative question expects NO standing
   * assertion of its (never-stated) topic, so `false`; every positive
   * question expects its facts standing.
   */
  readonly expectedStandingHit: boolean
  /** Model answer; `null` in mock runs (answerCorrectness stays unscored). */
  readonly answer: string | null
  /** Judged injection quality (0–3); `null` = judge skipped or failed. */
  readonly injectionQuality: number | null
  /** Judged answer correctness (0–2); `null` = no answer / judge skipped. */
  readonly answerCorrectness: number | null
  /** Judge infrastructure failure (thrown call). */
  readonly judgeError: string | null
  /** Judge protocol failure (invalid after the single re-judge) — scored null, counted separately. */
  readonly judgeInvalidReason: string | null
}

/** One storage verdict, verbatim from the judge (eval/rubric/storage-v1.md protocol). */
export interface StorageVerdictView {
  readonly entryId: string
  readonly plantedId: string | null
  readonly contentFidelity: number
  readonly scopeAndCategory: number
  readonly retrievability: number
  readonly mergeBehavior: number
  readonly total: number
  readonly evidence: string
  /** Judge protocol failure — zero placeholder scores, excluded from aggregates. */
  readonly invalid?: boolean | undefined
  readonly invalidReason?: string | undefined
}

/** The storage half of a plant scenario (judge-independent facts + verdicts). */
export interface StorageResult {
  /** Entries in the medium after the run. */
  readonly entryCount: number
  /** Max audit seq after the run (quiesced). */
  readonly auditSeq: number
  /** Ids written during the session (not present in storeBefore). */
  readonly writtenIds: readonly string[]
  /** Judge verdicts; `null` = judge skipped (storage metrics unscored). */
  readonly verdicts: readonly StorageVerdictView[] | null
  /** Judge failure message when verdicts could not be produced. */
  readonly judgeError: string | null
}

/** One executed scenario's full raw outcome. */
export interface ScenarioResult {
  readonly scenarioId: string
  readonly kind: ScenarioKind
  readonly domain: string
  readonly language: string
  readonly memoryMode: EffectiveMemoryMode
  readonly systemPromptCaptured: boolean
  readonly fenceTags: readonly string[]
  readonly injection: InjectionCost | null
  readonly questions: readonly QuestionResult[]
  /** Plant scenarios only; `null` for seed scenarios. */
  readonly storage: StorageResult | null
  /** The medium's final settled state (entry count + audit counter); `null` when the run failed early. */
  readonly mediumAfter: { readonly entryCount: number; readonly auditSeq: number } | null
  /** Scenario-level failure; the throwaway home is preserved when set. */
  readonly error: string | null
  /** Preserved temp `$DSH_HOME` for debugging — only set on failure. */
  readonly keptHome: string | null
  readonly durationMs: number
}

/** Storage metrics for one slice (means over valid scored written entries). */
export interface StorageSlice {
  readonly scoredEntries: number
  /** Verdicts the judge protocol recorded invalid — excluded above, counted here. */
  readonly invalidEntries: number
  readonly contentFidelity: number | null
  readonly scopeAndCategory: number | null
  readonly retrievability: number | null
  readonly mergeBehavior: number | null
  readonly total: number | null
  /** Share of written entries tracing to a planted fact (rubric-defined; `null` unscored). */
  readonly precision: number | null
}

/** Aggregated metrics for one slice (a domain, kind, language, question type, or the total). */
export interface SliceMetrics {
  readonly label: string
  readonly scenarios: number
  readonly questions: number
  readonly standingHitRate: number | null
  readonly noiseRatio: number | null
  readonly injectionQuality: number | null
  readonly answerCorrectness: number | null
  /** Mean per-scenario injection cost. */
  readonly injectionCostChars: number | null
  readonly injectionCostTokens: number | null
  readonly storage: StorageSlice | null
  readonly errors: number
}

/** The full run report (JSON shape). */
export interface EvalReport {
  readonly schema: 'eval-report-v0'
  readonly generatedAt: string
  readonly buildDir: string
  readonly dataset: string
  readonly memoryMode: EffectiveMemoryMode
  /**
   * Model identity of the scored run: `provider`/`id` name the initialize
   * handshake route; both `null` for the deterministic mock route. The
   * reasoning effort rides with the identity — answers differ by effort, so
   * scores never leave it behind.
   */
  readonly model: {
    readonly mode: 'mock' | 'real' | 'external'
    readonly provider: string | null
    readonly id: string | null
    readonly reasoningEffort: string | null
  }
  readonly rubricVersions: { readonly storage: string; readonly recall: string }
  readonly judge: { readonly model: string; readonly baseUrl: string } | null
  /**
   * The per-turn work budget the run enforced (`null` = unbounded): a breached
   * budget fails scenarios, so the scored population carries this calibration.
   */
  readonly turnBudget: { readonly wallSeconds: number; readonly toolCalls: number } | null
  readonly totals: SliceMetrics
  readonly slices: readonly SliceMetrics[]
  readonly scenarios: readonly ScenarioResult[]
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

/**
 * Storage precision for one scenario, per the storage rubric's harness
 * metric: share of entries WRITTEN during the session whose verdict traces
 * to a planted fact. Invalid verdicts (judge protocol failures) drop out of
 * numerator and denominator — they are counted separately on the slice.
 * `null` when unscored (no valid verdicts, incomplete coverage, or nothing
 * written).
 */
export function storagePrecision(writtenIds: readonly string[], verdicts: readonly StorageVerdictView[] | null): number | null {
  if (verdicts === null || writtenIds.length === 0) return null
  const written = new Set(writtenIds)
  const covered = verdicts.filter(verdict => written.has(verdict.entryId))
  if (covered.length < writtenIds.length) return null
  const valid = covered.filter(verdict => verdict.invalid !== true)
  if (valid.length === 0) return null
  const traceable = valid.filter(verdict => verdict.plantedId !== null).length
  return traceable / valid.length
}

/** Aggregate one scenario's storage verdicts into slice-level storage means. */
function storageSliceOf(result: ScenarioResult): StorageSlice | null {
  if (result.storage === null) return null
  const verdicts = result.storage.verdicts
  const written = new Set(result.storage.writtenIds)
  const scored = verdicts?.filter(verdict => written.has(verdict.entryId) && verdict.invalid !== true) ?? []
  const scoreable = verdicts !== null && scored.length > 0
  const meanOf = (pick: (verdict: StorageVerdictView) => number): number | null =>
    scoreable ? mean(scored.map(pick)) : null
  return {
    scoredEntries: scored.length,
    invalidEntries: (verdicts ?? []).filter(verdict => verdict.invalid === true).length,
    contentFidelity: meanOf(verdict => verdict.contentFidelity),
    scopeAndCategory: meanOf(verdict => verdict.scopeAndCategory),
    retrievability: meanOf(verdict => verdict.retrievability),
    mergeBehavior: meanOf(verdict => verdict.mergeBehavior),
    total: meanOf(verdict => verdict.total),
    precision: storagePrecision(result.storage.writtenIds, verdicts),
  }
}

function mergeStorageSlices(slices: readonly (StorageSlice | null)[]): StorageSlice | null {
  const present = slices.filter((slice): slice is StorageSlice => slice !== null)
  if (present.length === 0) return null
  const scored = present.filter(slice => slice.scoredEntries > 0)
  return {
    scoredEntries: present.reduce((sum, slice) => sum + slice.scoredEntries, 0),
    invalidEntries: present.reduce((sum, slice) => sum + slice.invalidEntries, 0),
    contentFidelity: mean(valuesOf(scored, slice => slice.contentFidelity)),
    scopeAndCategory: mean(valuesOf(scored, slice => slice.scopeAndCategory)),
    retrievability: mean(valuesOf(scored, slice => slice.retrievability)),
    mergeBehavior: mean(valuesOf(scored, slice => slice.mergeBehavior)),
    total: mean(valuesOf(scored, slice => slice.total)),
    precision: mean(valuesOf(present, slice => slice.precision)),
  }
}

/** Collect the defined values of one numeric field across slices. */
function valuesOf(slices: readonly StorageSlice[], pick: (slice: StorageSlice) => number | null): number[] {
  return slices.map(pick).filter((value): value is number => value !== null)
}

/**
 * Aggregate a question set (optionally scoped to the scenarios it came from)
 * into one {@link SliceMetrics}. Mechanical rates are means over measurable
 * questions only; judged means cover non-null verdicts only, so a skipped
 * judge yields `null` (skipped), never a silent zero.
 */
function metricsOf(label: string, scenarios: readonly ScenarioResult[], questions: readonly QuestionResult[]): SliceMetrics {
  const hits = questions
    .map(question => question.standingHit)
    .filter((hit): hit is boolean => hit !== null)
  const noises = questions
    .map(question => question.noiseRatio)
    .filter((noise): noise is number => noise !== null)
  const qualities = questions
    .map(question => question.injectionQuality)
    .filter((quality): quality is number => quality !== null)
  const answers = questions
    .map(question => question.answerCorrectness)
    .filter((answer): answer is number => answer !== null)
  const costs = scenarios
    .map(result => result.injection)
    .filter((cost): cost is InjectionCost => cost !== null)
  return {
    label,
    scenarios: scenarios.length,
    questions: questions.length,
    standingHitRate: hits.length === 0 ? null : hits.filter(hit => hit).length / hits.length,
    noiseRatio: mean(noises),
    injectionQuality: mean(qualities),
    answerCorrectness: mean(answers),
    injectionCostChars: mean(costs.map(cost => cost.chars)),
    injectionCostTokens: mean(costs.map(cost => cost.tokens)),
    storage: mergeStorageSlices(scenarios.map(storageSliceOf)),
    errors: scenarios.filter(result => result.error !== null).length,
  }
}

/** Aggregate a group of scenarios into one {@link SliceMetrics}. */
export function sliceMetrics(label: string, results: readonly ScenarioResult[]): SliceMetrics {
  return metricsOf(label, results, results.flatMap(result => result.questions))
}

/**
 * Build the stamped report: per-scenario detail + the slice breakdown
 * (domain / kind / language / question type) + totals. Stamps the rubric
 * versions, the judge identity and the build under test so scores are never
 * read without their calibration.
 */
export function buildReport(
  results: readonly ScenarioResult[],
  stamp: {
    buildDir: string
    dataset: string
    memoryMode: EffectiveMemoryMode
    /**
     * Model identity of the scored run (provider/id `null` for the mock route).
     */
    model: { mode: 'mock' | 'real' | 'external'; provider: string | null; id: string | null; reasoningEffort: string | null }
    rubricVersions: { storage: string; recall: string }
    judge: { model: string; baseUrl: string } | null
    turnBudget: { wallSeconds: number; toolCalls: number } | null
    generatedAt?: string
  },
): EvalReport {
  const by = (pick: (result: ScenarioResult) => string): Map<string, ScenarioResult[]> => {
    const groups = new Map<string, ScenarioResult[]>()
    for (const result of results) {
      const key = pick(result)
      const group = groups.get(key)
      if (group !== undefined) group.push(result)
      else groups.set(key, [result])
    }
    return groups
  }
  const slices: SliceMetrics[] = []
  for (const [key, pick] of [
    ['kind', (result: ScenarioResult): string => result.kind],
    ['domain', (result: ScenarioResult): string => result.domain],
    ['language', (result: ScenarioResult): string => result.language],
  ] as const) {
    for (const [value, group] of by(pick)) slices.push(sliceMetrics(`${key}=${value}`, group))
  }
  const allQuestions = results.flatMap(result => result.questions)
  for (const type of ['single-hop', 'multi-hop', 'paraphrase', 'negative'] as const) {
    const typed = allQuestions.filter(question => question.type === type)
    if (typed.length === 0) continue
    const owning = results.filter(result => result.questions.some(question => question.type === type))
    slices.push(metricsOf(`type=${type}`, owning, typed))
  }
  return {
    schema: 'eval-report-v0',
    generatedAt: stamp.generatedAt ?? new Date().toISOString(),
    buildDir: stamp.buildDir,
    dataset: stamp.dataset,
    memoryMode: stamp.memoryMode,
    model: stamp.model,
    rubricVersions: stamp.rubricVersions,
    judge: stamp.judge,
    turnBudget: stamp.turnBudget,
    totals: sliceMetrics('total', results),
    slices,
    scenarios: [...results],
  }
}

const percent = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`
const num = (value: number | null, digits = 2): string => value === null ? '—' : value.toFixed(digits)

/**
 * Render the report as Markdown: a stamp header, the totals, one slice table
 * and a per-scenario table (including kept-home paths for failures).
 */
export function renderReportMarkdown(report: EvalReport): string {
  const lines: string[] = []
  lines.push(`# Eval report — ${report.dataset}`)
  lines.push('')
  lines.push(`- build under test: \`${report.buildDir}\``)
  lines.push(`- generated: ${report.generatedAt}`)
  lines.push(`- model under test: ${report.model.id === null
    ? `mock (${report.model.mode} route, deterministic)`
    : `${report.model.provider}/${report.model.id} (${report.model.mode} route${report.model.reasoningEffort === null ? '' : `, effort ${report.model.reasoningEffort}`})`}`)
  lines.push(`- memory mode: ${report.memoryMode}`)
  lines.push(`- rubric: storage v${report.rubricVersions.storage}, recall v${report.rubricVersions.recall}`)
  lines.push(`- judge: ${report.judge === null ? 'skipped (deterministic layer only)' : `${report.judge.model} @ ${report.judge.baseUrl}`}`)
  lines.push(`- turn budget: ${report.turnBudget === null
    ? 'unbounded'
    : `${String(report.turnBudget.wallSeconds)}s wall / ${String(report.turnBudget.toolCalls)} tool calls (0 = off)`}`)
  lines.push('')
  lines.push('## Totals')
  lines.push('')
  lines.push(...sliceTable([report.totals]))
  lines.push('')
  lines.push('## Slices')
  lines.push('')
  lines.push(...sliceTable(report.slices))
  lines.push('')
  lines.push('## Per scenario')
  lines.push('')
  lines.push('| scenario | kind | domain | lang | questions | standing hit | noise | cost chars | storage precision | error |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const scenario of report.scenarios) {
    const hits = scenario.questions.filter(question => question.standingHit === true).length
    const measurable = scenario.questions.filter(question => question.standingHit !== null).length
    const noises = scenario.questions
      .map(question => question.noiseRatio)
      .filter((noise): noise is number => noise !== null)
    const noise = noises.length === 0 ? null : noises.reduce((sum, value) => sum + value, 0) / noises.length
    lines.push(
      `| ${scenario.scenarioId} | ${scenario.kind} | ${scenario.domain} | ${scenario.language} `
      + `| ${String(scenario.questions.length)} `
      + `| ${measurable === 0 ? '—' : `${String(hits)}/${String(measurable)}`} `
      + `| ${num(noise)} | ${num(scenario.injection === null ? null : scenario.injection.chars, 0)} `
      + `| ${percent(scenario.storage === null ? null : storagePrecision(scenario.storage.writtenIds, scenario.storage.verdicts))} `
      + `| ${scenario.error === null
        ? scenario.keptHome === null ? '' : `kept home ${scenario.keptHome}`
        : `${scenario.error}${scenario.keptHome === null ? '' : ` (kept home ${scenario.keptHome})`}`} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

function sliceTable(slices: readonly SliceMetrics[]): string[] {
  const lines: string[] = []
  lines.push('| slice | scenarios | questions | standing hit | noise | inj. quality | answer | cost chars | storage precision | storage invalid | errors |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const slice of slices) {
    lines.push(
      `| ${slice.label} | ${String(slice.scenarios)} | ${String(slice.questions)} `
      + `| ${percent(slice.standingHitRate)} | ${num(slice.noiseRatio)} | ${num(slice.injectionQuality)} `
      + `| ${num(slice.answerCorrectness)} | ${num(slice.injectionCostChars, 0)} `
      + `| ${percent(slice.storage === null ? null : slice.storage.precision)} `
      + `| ${slice.storage === null ? '—' : String(slice.storage.invalidEntries)} `
      + `| ${String(slice.errors)} |`,
    )
  }
  return lines
}

/** Per-scenario A/B diff: deterministic layers compared exactly, judged layers as deltas. */
export interface AbScenarioDiff {
  readonly scenarioId: string
  readonly deterministicEqual: boolean
  /** Human-readable list of deterministic differences (empty when equal). */
  readonly differences: readonly string[]
  readonly judged: {
    readonly storageTotalDelta: number | null
    readonly injectionQualityDelta: number | null
    readonly answerCorrectnessDelta: number | null
  }
}

/** The A/B paired diff between two reports (same dataset, two builds). */
export interface AbDiff {
  readonly baseline: string
  readonly candidate: string
  readonly deterministicEqual: boolean
  readonly scenarios: readonly AbScenarioDiff[]
}

/** Question-level deterministic fingerprint: the exactly-comparable mechanical values. */
function questionFingerprint(question: QuestionResult): string {
  return JSON.stringify({
    id: question.questionId,
    hit: question.standingHit,
    hits: question.factHits,
    noise: question.noiseRatio,
    expected: question.expectedStandingHit,
  })
}

function meanJudged(questions: readonly QuestionResult[], pick: (question: QuestionResult) => number | null): number | null {
  const values = questions.map(pick).filter((value): value is number => value !== null)
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * Pair two reports per scenario and question. The deterministic layer
 * (standing hits, noise ratios, injection cost, injected fence shape, stored
 * entry count) must reproduce exactly under the mock model; judged layer
 * differences are reported as candidate − baseline mean deltas (`null` when
 * either side is unscored).
 */
export function diffReports(baseline: EvalReport, candidate: EvalReport): AbDiff {
  const baselineById = new Map(baseline.scenarios.map(scenario => [scenario.scenarioId, scenario]))
  const scenarioIds = [...new Set([...baseline.scenarios, ...candidate.scenarios].map(scenario => scenario.scenarioId))]
  const diffs: AbScenarioDiff[] = scenarioIds.map((scenarioId) => {
    const before = baselineById.get(scenarioId)
    const after = candidate.scenarios.find(scenario => scenario.scenarioId === scenarioId)
    const differences: string[] = []
    if (before === undefined) differences.push('scenario missing from baseline')
    if (after === undefined) differences.push('scenario missing from candidate')
    if (before !== undefined && after !== undefined) {
      if (before.memoryMode !== after.memoryMode) {
        differences.push(`memoryMode ${before.memoryMode} → ${after.memoryMode}`)
      }
      if (JSON.stringify(before.fenceTags) !== JSON.stringify(after.fenceTags)) {
        differences.push(`fence tags ${JSON.stringify(before.fenceTags)} → ${JSON.stringify(after.fenceTags)}`)
      }
      const costBefore = before.injection?.chars ?? null
      const costAfter = after.injection?.chars ?? null
      if (costBefore !== costAfter) differences.push(`injection chars ${String(costBefore)} → ${String(costAfter)}`)
      if (before.mediumAfter?.entryCount !== after.mediumAfter?.entryCount) {
        differences.push(`entry count ${String(before.mediumAfter?.entryCount ?? null)} → ${String(after.mediumAfter?.entryCount ?? null)}`)
      }
      const beforeByQuestion = new Map(before.questions.map(question => [question.questionId, question]))
      const afterByQuestion = new Map(after.questions.map(question => [question.questionId, question]))
      for (const [questionId, beforeQuestion] of beforeByQuestion) {
        const afterQuestion = afterByQuestion.get(questionId)
        if (afterQuestion === undefined) {
          differences.push(`question ${questionId} missing from candidate`)
          continue
        }
        if (questionFingerprint(beforeQuestion) !== questionFingerprint(afterQuestion)) {
          differences.push(`question ${questionId} mechanical state differs`)
        }
      }
      for (const questionId of afterByQuestion.keys()) {
        if (!beforeByQuestion.has(questionId)) differences.push(`question ${questionId} missing from baseline`)
      }
    }
    const judged = {
      storageTotalDelta: before === undefined || after === undefined
        || before.storage === null || after.storage === null
        ? null
        : delta(meanVerdictTotal(after.storage.verdicts), meanVerdictTotal(before.storage.verdicts)),
      injectionQualityDelta: before === undefined || after === undefined
        ? null
        : delta(meanJudged(after.questions, q => q.injectionQuality), meanJudged(before.questions, q => q.injectionQuality)),
      answerCorrectnessDelta: before === undefined || after === undefined
        ? null
        : delta(meanJudged(after.questions, q => q.answerCorrectness), meanJudged(before.questions, q => q.answerCorrectness)),
    }
    return {
      scenarioId,
      deterministicEqual: differences.length === 0,
      differences,
      judged,
    }
  })
  return {
    baseline: baseline.buildDir,
    candidate: candidate.buildDir,
    deterministicEqual: diffs.every(diff => diff.deterministicEqual),
    scenarios: diffs,
  }
}

function meanVerdictTotal(verdicts: readonly StorageVerdictView[] | null): number | null {
  const valid = verdicts?.filter(verdict => verdict.invalid !== true) ?? []
  if (valid.length === 0) return null
  return valid.reduce((sum, verdict) => sum + verdict.total, 0) / valid.length
}

function delta(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : after - before
}

/**
 * Render the A/B diff as Markdown: one row per scenario (deterministic
 * verdict, judged deltas) and a summary line.
 */
export function renderAbDiffMarkdown(diff: AbDiff): string {
  const lines: string[] = []
  lines.push(`# Eval A/B — ${diff.baseline} (baseline) vs ${diff.candidate} (candidate)`)
  lines.push('')
  lines.push(`Deterministic layer: ${diff.deterministicEqual ? 'EQUAL across all scenarios' : 'DIFFERS'}`)
  lines.push('')
  lines.push('| scenario | deterministic | judged deltas (storage total / inj. quality / answer) |')
  lines.push('|---|---|---|')
  for (const scenario of diff.scenarios) {
    const judged = scenario.judged
    const judgedText = [
      num(judged.storageTotalDelta),
      num(judged.injectionQualityDelta),
      num(judged.answerCorrectnessDelta),
    ].join(' / ')
    lines.push(
      `| ${scenario.scenarioId} | ${scenario.deterministicEqual ? 'equal' : `DIFFERS: ${scenario.differences.join('; ')}`} | ${judgedText} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}
