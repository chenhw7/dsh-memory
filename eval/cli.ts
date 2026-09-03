/**
 * CLI for the eval suite. `npm run eval` scores one build against a dataset;
 * `npm run eval:ab` scores two builds and emits the paired diff. All state
 * lives in throwaway `$DSH_HOME`s — nothing is written into the repository;
 * the report JSON lands only at the explicitly given `--out` path (default:
 * printed to stdout).
 *
 * Failure is loud: scenario errors and (when --judge was requested) judge
 * failures set exit code 1 and print the preserved `DSH_HOME` paths.
 *
 * @module eval/cli
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEvalYamlTurnBudget, resolveTurnBudget } from './eval-config.ts'
import { judgeFromEnv, type JudgeConfig } from './judge.ts'
import { describeEvalModelRoute, resolveEvalModel, type EvalModelRoute } from './model-route.ts'
import {
  buildReport,
  diffReports,
  renderAbDiffMarkdown,
  renderReportMarkdown,
  type AbDiff,
  type ScenarioResult,
} from './report.ts'
import { runScenarios, type RunOptions } from './runner.ts'
import { parseDataset, type EvalScenario } from './schema.ts'

const USAGE = `usage:
  npm run eval -- --dataset <file> --build <dir> [--mode mock|real|external] [--provider <id>] [--model <id>] [--base-url <url>] [--api-key <key>]
                  [--judge] [--memory-mode index|full] [--no-memory] [--filter <id>[,<id>...]] [--concurrency N]
                  [--turn-wall-seconds N] [--turn-tool-calls N] [--out <file>]
  npm run eval:ab -- --baseline <dir> --candidate <dir> [same flags; --build not allowed]

flags:
  --dataset <file>      scenario corpus (JSONL), relative to cwd (required)
  --build <dir>         plugin build under test: package.json + lib/ (eval mode, required)
  --baseline/--candidate <dir>   the two builds for the paired A/B run
  --mode mock|real|external      model route (default mock; external needs --base-url)
  --provider <id>       provider route for --mode real (default: the deployment home's
                        agent-default-model.provider, else deepseek-official); non-DeepSeek
                        providers run through the deployment's llm-pi-ai settings section
  --model <id>          model id for real|external (default: the deployment home's
                        agent-default-model.model, else deepseek-v4-flash; printed per run)
  --judge               enable the rubric judge when the judge environment is present
  --memory-mode index|full       injection-mode axis (default index)
  --no-memory           memory injection off — the control group
  --filter <ids>        comma-separated id substrings selecting scenarios
  --concurrency N       scenarios in flight (default 4)
  --turn-wall-seconds N per-turn wall-clock budget, 0 = off (default 180; eval.yaml
                        turnBudget wins when the flag is absent)
  --turn-tool-calls N   per-turn tool-call budget, 0 = off (default 32; eval.yaml
                        turnBudget wins when the flag is absent)
  --out <file>          report JSON path (default: print only)`

interface CliArgs {
  readonly dataset: string
  readonly build?: string
  readonly baseline?: string
  readonly candidate?: string
  readonly mode: 'mock' | 'real' | 'external'
  readonly provider?: string
  readonly model?: string
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly judge: boolean
  readonly memoryMode: 'index' | 'full'
  readonly noMemory: boolean
  readonly filter?: string
  readonly concurrency: number
  readonly turnWallSeconds?: number
  readonly turnToolCalls?: number
  readonly out?: string
}

const BOOLEAN_FLAGS = new Set(['judge', 'no-memory'])
const VALUE_FLAGS = new Set([
  'dataset', 'build', 'baseline', 'candidate', 'mode', 'provider', 'model', 'base-url', 'api-key',
  'memory-mode', 'filter', 'concurrency', 'turn-wall-seconds', 'turn-tool-calls', 'out',
])

/** Parse and validate argv (already stripped of the `ab` subcommand token). */
function parseCliArgs(argv: readonly string[]): { ab: boolean; args: CliArgs } {
  const ab = argv[0] === 'ab'
  const rest = ab ? argv.slice(1) : argv
  const values = new Map<string, string | true>()
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token === undefined || !token.startsWith('--')) {
      throw new Error(`eval cli: unexpected argument ${JSON.stringify(token ?? '')}\n${USAGE}`)
    }
    const name = token.slice(2)
    if (BOOLEAN_FLAGS.has(name)) {
      values.set(name, true)
      continue
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new Error(`eval cli: unknown flag --${name}\n${USAGE}`)
    }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`eval cli: --${name} needs a value\n${USAGE}`)
    }
    values.set(name, value)
    i += 1
  }

  const required = (flag: string): string => {
    const value = values.get(flag)
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`eval cli: --${flag} is required\n${USAGE}`)
    }
    return value
  }
  const optional = (flag: string): string | undefined => {
    const value = values.get(flag)
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  const mode = optional('mode') ?? 'mock'
  if (mode !== 'mock' && mode !== 'real' && mode !== 'external') {
    throw new Error(`eval cli: --mode must be mock|real|external, got ${JSON.stringify(mode)}\n${USAGE}`)
  }
  const memoryMode = optional('memory-mode') ?? 'index'
  if (memoryMode !== 'index' && memoryMode !== 'full') {
    throw new Error(`eval cli: --memory-mode must be index|full, got ${JSON.stringify(memoryMode)}\n${USAGE}`)
  }
  const concurrencyRaw = optional('concurrency') ?? '4'
  const concurrency = Number.parseInt(concurrencyRaw, 10)
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`eval cli: --concurrency must be a positive integer, got ${JSON.stringify(concurrencyRaw)}\n${USAGE}`)
  }
  const nonNegative = (flag: string): number | undefined => {
    const raw = optional(flag)
    if (raw === undefined) return undefined
    const value = Number.parseInt(raw, 10)
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`eval cli: --${flag} must be a non-negative integer (0 = off), got ${JSON.stringify(raw)}\n${USAGE}`)
    }
    return value
  }
  const turnWallSeconds = nonNegative('turn-wall-seconds')
  const turnToolCalls = nonNegative('turn-tool-calls')

  // The boot contract routes keys per mode: mock starts the in-process mock,
  // real resolves the key itself (or activates the deployment's pi-ai route),
  // external takes both from the caller.
  const model = optional('model')
  const provider = optional('provider')
  const baseUrl = optional('base-url')
  const apiKey = optional('api-key')
  if (mode === 'external' && baseUrl === undefined) {
    throw new Error(`eval cli: --mode external requires --base-url\n${USAGE}`)
  }
  if (mode !== 'external' && (baseUrl !== undefined || apiKey !== undefined)) {
    throw new Error(`eval cli: --base-url/--api-key apply only to --mode external\n${USAGE}`)
  }
  if (mode === 'mock' && (model !== undefined || provider !== undefined)) {
    throw new Error(
      `eval cli: --model/--provider apply only to live routes — --mode mock is the deterministic `
      + `deepseek-official shape and reads nothing\n${USAGE}`,
    )
  }
  if (mode === 'external' && provider !== undefined) {
    throw new Error(
      `eval cli: --provider applies only to --mode real (external impersonates the deepseek-official `
      + `adapter wire)\n${USAGE}`,
    )
  }

  if (ab) {
    if (optional('build') !== undefined) throw new Error(`eval cli: --build is not allowed with ab (use --baseline/--candidate)\n${USAGE}`)
  } else {
    if (optional('baseline') !== undefined || optional('candidate') !== undefined) {
      throw new Error(`eval cli: --baseline/--candidate belong to eval:ab\n${USAGE}`)
    }
  }

  const filter = optional('filter')
  const out = optional('out')

  return {
    ab,
    args: {
      dataset: required('dataset'),
      ...(ab
        ? { baseline: required('baseline'), candidate: required('candidate') }
        : { build: required('build') }),
      mode,
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      judge: values.get('judge') === true,
      memoryMode,
      noMemory: values.get('no-memory') === true,
      ...(filter !== undefined ? { filter } : {}),
      concurrency,
      ...(turnWallSeconds !== undefined ? { turnWallSeconds } : {}),
      ...(turnToolCalls !== undefined ? { turnToolCalls } : {}),
      ...(out !== undefined ? { out } : {}),
    },
  }
}

/** Select scenarios by comma-separated id substrings; an empty match fails loud. */
function applyFilter(scenarios: readonly EvalScenario[], filter: string | undefined): EvalScenario[] {
  if (filter === undefined) return [...scenarios]
  const tokens = filter.split(',').map(token => token.trim()).filter(token => token.length > 0)
  if (tokens.length === 0) throw new Error('eval cli: --filter holds no ids')
  const matched = scenarios.filter(scenario => tokens.some(token => scenario.id.includes(token)))
  if (matched.length === 0) {
    throw new Error(`eval cli: --filter ${JSON.stringify(filter)} matched none of the ${String(scenarios.length)} scenarios`)
  }
  return matched
}

function runOptionsOf(
  args: CliArgs,
  buildDir: string,
  judge: JudgeConfig | null,
  modelRoute: EvalModelRoute | null,
  turnBudget: { wallSeconds: number; toolCalls: number },
): RunOptions {
  return {
    buildDir,
    mode: args.mode,
    ...(modelRoute !== null ? { model: modelRoute.model, provider: modelRoute.provider } : {}),
    ...(modelRoute?.piAiSection !== undefined ? { piAiSection: modelRoute.piAiSection } : {}),
    ...(modelRoute?.deploymentHome !== undefined ? { deploymentHome: modelRoute.deploymentHome } : {}),
    ...(modelRoute?.credentialEnvRefs !== undefined ? { credentialEnvRefs: modelRoute.credentialEnvRefs } : {}),
    ...(modelRoute?.reasoningEffort !== undefined ? { reasoningEffort: modelRoute.reasoningEffort } : {}),
    ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
    ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
    memoryMode: args.memoryMode,
    noMemory: args.noMemory,
    judge,
    concurrency: args.concurrency,
    turnBudget,
    onResult: printProgress,
  }
}

function printProgress(result: ScenarioResult): void {
  if (result.error !== null) {
    process.stdout.write(`eval: FAIL ${result.scenarioId} — ${result.error}\n`)
    return
  }
  const hits = result.questions.filter(question => question.standingHit === true).length
  const measurable = result.questions.filter(question => question.standingHit !== null).length
  process.stdout.write(
    `eval: ok ${result.scenarioId} (${String(result.questions.length)} questions, standing hit `
    + `${String(hits)}/${String(measurable)}, cost ${String(result.injection === null ? -1 : result.injection.chars)} chars)\n`,
  )
}

/** Exit 1 when scenarios failed or (judge requested) judged data is missing. */
function failOnErrors(scenarios: readonly ScenarioResult[], judgeWanted: boolean): void {
  const failed = scenarios.filter(scenario => scenario.error !== null)
  const judgeBroken = judgeWanted ? scenarios.filter(hasJudgeError) : []
  if (failed.length === 0 && judgeBroken.length === 0) return
  process.stderr.write(
    `eval cli: FAILED — ${String(failed.length)} scenario error(s), ${String(judgeBroken.length)} judge-error scenario(s)\n`,
  )
  for (const scenario of failed) {
    process.stderr.write(`  - ${scenario.scenarioId}: ${scenario.error}${scenario.keptHome === null ? '' : ` (kept DSH_HOME: ${scenario.keptHome})`}\n`)
  }
  for (const scenario of judgeBroken) {
    for (const question of scenario.questions) {
      if (question.judgeError !== null) process.stderr.write(`  - ${scenario.scenarioId}/${question.questionId}: judge: ${question.judgeError}\n`)
    }
    if (scenario.storage !== null && scenario.storage.judgeError !== null) {
      process.stderr.write(`  - ${scenario.scenarioId}: storage judge: ${scenario.storage.judgeError}\n`)
    }
  }
  process.exitCode = 1
}

function hasJudgeError(scenario: ScenarioResult): boolean {
  return scenario.questions.some(question => question.judgeError !== null)
    || (scenario.storage !== null && scenario.storage.judgeError !== null)
}

function writeJson(path: string, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, undefined, 2)}\n`)
}

async function runSingle(
  scenarios: readonly EvalScenario[],
  args: CliArgs,
  judge: JudgeConfig | null,
  modelRoute: EvalModelRoute | null,
  turnBudget: { wallSeconds: number; toolCalls: number },
): Promise<void> {
  const buildDir = resolve(args.build ?? '')
  const outcome = await runScenarios(scenarios, runOptionsOf(args, buildDir, judge, modelRoute, turnBudget))
  const report = buildReport(outcome.results, {
    buildDir,
    dataset: args.dataset,
    memoryMode: outcome.memoryMode,
    model: modelStampOf(args, modelRoute),
    rubricVersions: outcome.rubricVersions,
    judge: outcome.judge,
    turnBudget,
  })
  process.stdout.write(renderReportMarkdown(report))
  if (args.out === undefined) {
    process.stdout.write(`\n${JSON.stringify(report, undefined, 2)}\n`)
  } else {
    writeJson(args.out, report)
    process.stdout.write(`report JSON written to ${args.out}\n`)
  }
  failOnErrors(report.scenarios, args.judge)
}

async function runAb(
  scenarios: readonly EvalScenario[],
  args: CliArgs,
  judge: JudgeConfig | null,
  modelRoute: EvalModelRoute | null,
  turnBudget: { wallSeconds: number; toolCalls: number },
): Promise<void> {
  const baselineDir = resolve(args.baseline ?? '')
  const candidateDir = resolve(args.candidate ?? '')
  process.stdout.write(`eval ab: baseline build ${baselineDir}\n`)
  const baselineOutcome = await runScenarios(scenarios, runOptionsOf(args, baselineDir, judge, modelRoute, turnBudget))
  process.stdout.write(`eval ab: candidate build ${candidateDir}\n`)
  const candidateOutcome = await runScenarios(scenarios, runOptionsOf(args, candidateDir, judge, modelRoute, turnBudget))

  const modelStamp = modelStampOf(args, modelRoute)
  const baselineReport = buildReport(baselineOutcome.results, {
    buildDir: baselineDir,
    dataset: args.dataset,
    memoryMode: baselineOutcome.memoryMode,
    model: modelStamp,
    rubricVersions: baselineOutcome.rubricVersions,
    judge: baselineOutcome.judge,
    turnBudget,
  })
  const candidateReport = buildReport(candidateOutcome.results, {
    buildDir: candidateDir,
    dataset: args.dataset,
    memoryMode: candidateOutcome.memoryMode,
    model: modelStamp,
    rubricVersions: candidateOutcome.rubricVersions,
    judge: candidateOutcome.judge,
    turnBudget,
  })
  const diff: AbDiff = diffReports(baselineReport, candidateReport)

  process.stdout.write(renderAbDiffMarkdown(diff))
  const payload = { schema: 'eval-ab-v0', baseline: baselineReport, candidate: candidateReport, diff }
  if (args.out === undefined) {
    process.stdout.write(`\n${JSON.stringify(payload, undefined, 2)}\n`)
  } else {
    writeJson(args.out, payload)
    process.stdout.write(`A/B JSON written to ${args.out}\n`)
  }
  failOnErrors([...baselineReport.scenarios, ...candidateReport.scenarios], args.judge)
}

/** Flag pair for the model-route resolver; absent flags stay absent (exact optionals). */
function flagsOf(args: CliArgs): { provider?: string; model?: string } {
  return {
    ...(args.provider !== undefined ? { provider: args.provider } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
  }
}

/** Report stamp for the scored model identity; the mock route has none. */
function modelStampOf(args: CliArgs, modelRoute: EvalModelRoute | null): { mode: 'mock' | 'real' | 'external'; provider: string | null; id: string | null; reasoningEffort: string | null } {
  return {
    mode: args.mode,
    ...(modelRoute !== null
      ? {
          provider: modelRoute.provider,
          id: modelRoute.model,
          ...(modelRoute.reasoningEffort !== undefined ? { reasoningEffort: modelRoute.reasoningEffort } : { reasoningEffort: null }),
        }
      : { provider: null, id: null, reasoningEffort: null }),
  }
}

async function main(): Promise<void> {
  const { ab, args } = parseCliArgs(process.argv.slice(2))
  const scenarios = parseDataset(readFileSync(args.dataset, 'utf8'), args.dataset)
  const matched = applyFilter(scenarios, args.filter)

  // `real` names the provider/model route explicitly or via the deployment
  // home's agent-default-model (a non-DeepSeek provider rides the deployment's
  // llm-pi-ai settings section); `external` impersonates the deepseek-official
  // adapter wire, so its provider is fixed and only the model id resolves;
  // the mock route stays hermetic and resolves nothing.
  let modelRoute: EvalModelRoute | null = null
  if (args.mode === 'real') {
    modelRoute = resolveEvalModel(flagsOf(args))
  } else if (args.mode === 'external') {
    // External impersonates the deepseek-official wire: only the model id resolves.
    const resolved = resolveEvalModel(args.model !== undefined ? { model: args.model } : {})
    modelRoute = {
      provider: 'deepseek-official',
      model: resolved.model,
      source: resolved.source,
      ...(resolved.origin !== undefined ? { origin: resolved.origin } : {}),
    }
  }
  if (modelRoute !== null) {
    const piAiNotice = modelRoute.piAiSection !== undefined
      ? ', llm-pi-ai routes mirrored from the deployment settings'
      : ''
    const effortNotice = modelRoute.reasoningEffort !== undefined ? `, effort ${modelRoute.reasoningEffort}` : ''
    process.stdout.write(
      `eval cli: model under test ${modelRoute.provider}/${modelRoute.model} `
      + `(${describeEvalModelRoute(modelRoute)}${effortNotice})${piAiNotice}\n`,
    )
  }
  // Per-turn work budget: an explicit flag wins per dimension, then the eval
  // config's turnBudget section, then the built-in defaults. Resolved once and
  // stamped into every report so scored populations carry their calibration.
  const turnBudget = resolveTurnBudget(
    {
      ...(args.turnWallSeconds !== undefined ? { wallSeconds: args.turnWallSeconds } : {}),
      ...(args.turnToolCalls !== undefined ? { toolCalls: args.turnToolCalls } : {}),
    },
    loadEvalYamlTurnBudget(),
  )
  process.stdout.write(`eval: ${String(matched.length)}/${String(scenarios.length)} scenarios from ${args.dataset}`
    + `, mode ${args.mode}, memory ${args.noMemory ? 'off' : args.memoryMode}${args.judge ? ', judge requested' : ''}`
    + `, turn budget ${String(turnBudget.wallSeconds)}s/${String(turnBudget.toolCalls)} calls (0 = off)\n`)

  const judge = args.judge ? judgeFromEnv() : null
  if (args.judge && judge === null) {
    process.stderr.write('eval cli: --judge requested but no judge environment found '
      + '(EVAL_JUDGE_BASE_URL/EVAL_JUDGE_API_KEY/EVAL_JUDGE_MODEL or DEEPSEEK_* fallbacks); judged metrics will be skipped\n')
  }
  if (ab) await runAb(matched, args, judge, modelRoute, turnBudget)
  else await runSingle(matched, args, judge, modelRoute, turnBudget)
}

try {
  await main()
} catch (error) {
  // Usage/parse/IO failures fail loud with the message, not a bare stack.
  process.stderr.write(`eval cli: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
