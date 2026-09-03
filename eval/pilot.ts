/**
 * Noise-slice pilot runner (Stage-0 gate; the proposal's steps 4–9).
 *
 * `npm run eval:pilot -- --build <dir>` runs the pre-registered decision
 * rules (eval/pilot-gate.ts) over the noise-v0 corpus, in run order:
 *
 *   G1 chain health        — mock full chain: no failures, prompt captured.
 *   G2 same-build A/B      — two mock runs, deterministic layer EQUAL.
 *   G3 anchor matchability — fake-LLM extraction-chain run (the routes in
 *                            eval/harness/noise-routes.ts): entryCount > 0,
 *                            fence present, anchors stand.
 *   G4 two-pass stability  — the same material judged twice: no entry or
 *                            question flips more than one tier.
 *   G5 calibration         — the author-pinned expected tiers all hit.
 *
 * G4/G5 need a judge instrument (the env-gated judgeFromEnv resolution,
 * same as the eval CLI) — the pilot is meaningless without one and fails
 * loud when it is absent. No CI: the judged lanes are env-gated on purpose.
 *
 * @module eval/pilot
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEvalYamlTurnBudget, resolveTurnBudget } from './eval-config.ts'
import { startFakeLlmServer, type FakeLlmServer } from './harness/fake-llm.ts'
import { buildNoiseRoutes } from './harness/noise-routes.ts'
import { judgeFromEnv, type JudgeConfig } from './judge.ts'
import { resolveEvalModel } from './model-route.ts'
import {
  abSelfDiffFailures,
  anchorMatchFailures,
  chainHealthFailures,
  judgeCalibration,
  loadDefaultPilotFixture,
  twoPassFlipFailures,
} from './pilot-gate.ts'
import { buildReport, diffReports, type EvalReport, type ScenarioResult } from './report.ts'
import { runScenarios, type RunOptions } from './runner.ts'
import { parseDataset, type EvalScenario } from './schema.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `usage:
  npm run eval:pilot -- --build <dir> [--dataset <file>] [--fixture <file>] [--concurrency N]

flags:
  --build <dir>         plugin build under test: package.json + lib/ (default: the repository root)
  --dataset <file>      noise corpus (default eval/datasets/noise-v0.jsonl)
  --fixture <file>      pilot fixture: routes + calibration (default eval/datasets/noise-v0.pilot.json)
  --concurrency N       scenarios in flight (default 2)`

interface PilotArgs {
  build: string
  dataset: string
  fixture: string
  concurrency: number
}

function parsePilotArgs(argv: readonly string[]): PilotArgs {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === undefined || !token.startsWith('--')) {
      throw new Error(`eval pilot: unexpected argument ${JSON.stringify(token ?? '')}\n${USAGE}`)
    }
    const name = token.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`eval pilot: --${name} needs a value\n${USAGE}`)
    }
    values.set(name, value)
    i += 1
  }
  const concurrencyRaw = values.get('concurrency') ?? '2'
  const concurrency = Number.parseInt(concurrencyRaw, 10)
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`eval pilot: --concurrency must be a positive integer, got ${JSON.stringify(concurrencyRaw)}\n${USAGE}`)
  }
  return {
    build: values.get('build') ?? REPO_ROOT,
    dataset: values.get('dataset') ?? join(REPO_ROOT, 'eval', 'datasets', 'noise-v0.jsonl'),
    fixture: values.get('fixture') ?? join(REPO_ROOT, 'eval', 'datasets', 'noise-v0.pilot.json'),
    concurrency,
  }
}

/** The model stamp a report carries; the mock route has none. */
function modelStampOf(mode: 'mock' | 'external', modelId: string | null): EvalReport['model'] {
  return mode === 'mock'
    ? { mode, provider: null, id: null, reasoningEffort: null }
    : { mode, provider: 'deepseek-official', id: modelId, reasoningEffort: null }
}

function runStamp(dataset: string, mode: 'mock' | 'external', modelId: string | null, memoryMode: 'index', judge: JudgeConfig | null, turnBudget: { wallSeconds: number; toolCalls: number }) {
  return {
    dataset,
    memoryMode,
    model: modelStampOf(mode, modelId),
    judge: judge === null ? null : { model: judge.model, baseUrl: judge.baseUrl },
    turnBudget,
  }
}

interface PassOptions {
  buildDir: string
  dataset: string
  mode: 'mock' | 'external'
  modelId: string | null
  baseUrl?: string
  judge: JudgeConfig | null
  concurrency: number
  turnBudget: { wallSeconds: number; toolCalls: number }
}

/** One dataset pass over the build under test (throwaway homes, runner-owned). */
async function runPass(scenarios: readonly EvalScenario[], options: PassOptions) {
  if (options.mode === 'external' && (options.modelId === null || options.baseUrl === undefined)) {
    throw new Error('eval pilot: the external route needs a model id and a base URL')
  }
  const runOptions: RunOptions = {
    buildDir: options.buildDir,
    mode: options.mode,
    ...(options.mode === 'external' ? { model: options.modelId as string, baseUrl: options.baseUrl as string } : {}),
    memoryMode: 'index',
    noMemory: false,
    judge: options.judge,
    concurrency: options.concurrency,
    turnBudget: options.turnBudget,
    onResult: printProgress,
  }
  return runScenarios(scenarios, runOptions)
}

function buildPassReport(outcome: { results: ScenarioResult[]; rubricVersions: { storage: string; recall: string } }, options: PassOptions, buildDir: string): EvalReport {
  return buildReport(outcome.results, {
    buildDir,
    rubricVersions: outcome.rubricVersions,
    ...runStamp(options.dataset, options.mode, options.modelId, 'index', options.judge, options.turnBudget),
  })
}

function printProgress(result: ScenarioResult): void {
  if (result.error !== null) {
    process.stdout.write(`eval pilot: FAIL ${result.scenarioId} — ${result.error}\n`)
    return
  }
  const hits = result.questions.filter(question => question.standingHit === true).length
  const measurable = result.questions.filter(question => question.standingHit !== null).length
  process.stdout.write(
    `eval pilot: ok ${result.scenarioId} (${String(result.questions.length)} questions, standing hit `
    + `${String(hits)}/${String(measurable)}, entries ${String(result.mediumAfter?.entryCount ?? 0)})\n`,
  )
}

const gateFailures: string[] = []

function gate(name: string, failures: readonly string[]): void {
  if (failures.length === 0) {
    process.stdout.write(`eval pilot: PASS ${name}\n`)
    return
  }
  process.stdout.write(`eval pilot: FAIL ${name} — ${String(failures.length)} failure(s)\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  gateFailures.push(...failures.map(failure => `${name}: ${failure}`))
}

async function main(): Promise<void> {
  const args = parsePilotArgs(process.argv.slice(2))
  const scenarios = parseDataset(readFileSync(args.dataset, 'utf8'), args.dataset)
  const fixture = loadDefaultPilotFixture(args.fixture)
  const judge = judgeFromEnv()
  if (judge === null) {
    process.stderr.write('eval pilot: no judge environment found '
      + '(EVAL_JUDGE_BASE_URL/EVAL_JUDGE_API_KEY/EVAL_JUDGE_MODEL or DEEPSEEK_* fallbacks or the eval.yaml judge section) '
      + '— the pilot gates G4/G5 are judged and the pilot is meaningless without a judge\n')
    process.exitCode = 1
    return
  }
  const turnBudget = resolveTurnBudget({}, loadEvalYamlTurnBudget())
  const buildDir = resolve(args.build)
  const modelId = resolveEvalModel({}).model
  process.stdout.write(`eval pilot: ${String(scenarios.length)} noise scenarios, build ${buildDir}, judge ${judge.model} @ ${judge.baseUrl}\n`)

  // G1 — chain health over the deterministic mock chain.
  const g1 = await runPass(scenarios, {
    buildDir, dataset: args.dataset, mode: 'mock', modelId: null,
    judge: null, concurrency: args.concurrency, turnBudget,
  })
  gate('G1 chain health', chainHealthFailures(g1.results))

  // G2 — same-build A/B: two mock passes, the deterministic layer must be EQUAL.
  const mockPass = (label: string) =>
    runPass(scenarios, {
      buildDir, dataset: args.dataset, mode: 'mock', modelId: null,
      judge: null, concurrency: args.concurrency, turnBudget,
    }).then(outcome => {
      process.stdout.write(`eval pilot: ${label} pass complete\n`)
      return outcome
    })
  const [baseline, candidate] = await Promise.all([mockPass('baseline'), mockPass('candidate')])
  const mockOptions = { buildDir, dataset: args.dataset, mode: 'mock' as const, modelId: null, judge: null, concurrency: args.concurrency, turnBudget }
  const diff = diffReports(
    buildPassReport(baseline, mockOptions, buildDir),
    buildPassReport(candidate, mockOptions, buildDir),
  )
  gate('G2 same-build A/B', abSelfDiffFailures(diff))

  // G3 — extraction-chain evidence: the fake-LLM content routes drive the
  // real extraction chain; the written entries must stand on the anchors.
  const noise = buildNoiseRoutes(fixture.routes)
  const fake = await startFakeLlmServer({ routes: [...noise.routes], defaultReply: noise.defaultReply })
  try {
    const g3 = await runPass(scenarios, {
      buildDir, dataset: args.dataset, mode: 'external', modelId, baseUrl: fake.baseUrl,
      judge: null, concurrency: args.concurrency, turnBudget,
    })
    gate('G3 anchor matchability', anchorMatchFailures(g3.results))

    // G4 — two judged passes over the SAME material: no entry or question
    // may flip more than one tier between the passes.
    process.stdout.write('eval pilot: judge pass A\n')
    const passA = await runPass(scenarios, {
      buildDir, dataset: args.dataset, mode: 'external', modelId, baseUrl: fake.baseUrl,
      judge, concurrency: args.concurrency, turnBudget,
    })
    process.stdout.write('eval pilot: judge pass B\n')
    const passB = await runPass(scenarios, {
      buildDir, dataset: args.dataset, mode: 'external', modelId, baseUrl: fake.baseUrl,
      judge, concurrency: args.concurrency, turnBudget,
    })
    gate('G4 two-pass stability', twoPassFlipFailures(passA.results, passB.results))
  } finally {
    await fake.stop()
  }

  // G5 — calibration: the author-pinned tiers must all hit.
  const outcomes = await judgeCalibration(fixture.calibration, judge)
  gate('G5 calibration', outcomes.flatMap(outcome =>
    outcome.mismatches.length === 0 ? [] : [`${outcome.id}: ${outcome.mismatches.join('; ')}`],
  ))

  if (gateFailures.length > 0) {
    process.stdout.write(`\neval pilot: FAIL — ${String(gateFailures.length)} gate failure(s)\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write('\neval pilot: PASS — all five gates hold\n')
}

try {
  await main()
} catch (error) {
  process.stderr.write(`eval pilot: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
