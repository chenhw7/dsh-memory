/**
 * Eval-owned configuration: `eval.yaml` in the project root (the repo the eval
 * CLI runs from), falling back to the deployment home's `$DSH_HOME/eval.yaml`
 * (else `~/.dsh/eval.yaml`), or the path named by `$DSH_EVAL_CONFIG` (tests and
 * CI use it to pin one file and to opt out).
 *
 * The file configures the eval's instruments, not the system under test —
 * today that is the rubric judge (a deliberate choice the operator makes per
 * L2 run — same-source self-grading is exactly what the file exists to avoid
 * defaulting into) and the per-turn work budget. The deployment's own
 * settings.yaml stays the source for the model under test; this file never
 * overrides it. The project-root copy holds a pasted credential, so it must
 * stay gitignored.
 *
 * @module eval/eval-config
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

/** The rubric judge route as declared in `eval.yaml`'s `judge:` section. */
export interface EvalJudgeFileConfig {
  /** OpenAI-compatible base URL including the version namespace. */
  baseUrl: string
  /** Pasted credential (kept out of the repository — this file lives in the deployment home). */
  apiKey: string
  /** Judge model id (deliberately distinct from the model under test). */
  model: string
  /** Reasoning effort passed through as the wire `reasoning_effort` param; absent = model default. */
  reasoningEffort?: string
}

/**
 * Candidate eval config paths, most specific first: `$DSH_EVAL_CONFIG` (an
 * explicit pointer), the project root's `eval.yaml` (the repo the CLI runs
 * from), then the deployment home's `eval.yaml`.
 */
export function evalConfigCandidates(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const explicit = env['DSH_EVAL_CONFIG']
  if (explicit !== undefined && explicit.length > 0) return [explicit]
  const deploymentHome = env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return [join(process.cwd(), 'eval.yaml'), join(deploymentHome, 'eval.yaml')]
}

/**
 * Load the `judge:` section of the eval config. Absent files or an absent
 * section → `null` (the caller falls through its own chain). A present section
 * that is incomplete or malformed is a misconfiguration and fails loud: a
 * half-pasted instrument config must not silently degrade to skipped judging.
 * `apiKeyEnv` resolves from the eval process environment at load time.
 * @throws when a candidate document is unparseable or its `judge:` section is malformed.
 */
export function loadEvalYamlJudge(env: NodeJS.ProcessEnv = process.env): EvalJudgeFileConfig | null {
  for (const documentPath of evalConfigCandidates(env)) {
    let raw: string
    try {
      raw = readFileSync(documentPath, 'utf8')
    } catch (error) {
      // ENOENT is simply no eval-owned configuration at this candidate; any
      // other read failure is a broken deployment and must surface, not
      // silently skip the judge.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`eval eval-config: ${documentPath} cannot be read: ${String(error)}`)
      }
      continue
    }
    return parseJudgeSection(documentPath, raw, env)
  }
  return null
}

function parseJudgeSection(documentPath: string, raw: string, env: NodeJS.ProcessEnv): EvalJudgeFileConfig | null {
  let parsed: unknown
  try {
    parsed = parse(raw)
  } catch (error) {
    throw new Error(`eval eval-config: ${documentPath} is not valid YAML: ${String(error)}`)
  }
  if (parsed === undefined || parsed === null) return null
  if (typeof parsed !== 'object') {
    throw new Error(`eval eval-config: ${documentPath} must be a mapping, got ${JSON.stringify(parsed)}`)
  }
  const judge = (parsed as Record<string, unknown>)['judge']
  if (judge === undefined) return null
  if (judge === null || typeof judge !== 'object') {
    throw new Error(`eval eval-config: judge at ${documentPath} must be a mapping, got ${JSON.stringify(judge)}`)
  }
  const record = judge as Record<string, unknown>
  const known = new Set(['baseURL', 'apiKey', 'apiKeyEnv', 'model', 'reasoningEffort'])
  const unknownKeys = Object.keys(record).filter(key => !known.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(`eval eval-config: judge at ${documentPath} carries unknown field(s) ${JSON.stringify(unknownKeys)}`)
  }
  const baseUrl = record['baseURL']
  const model = record['model']
  if (typeof baseUrl !== 'string' || baseUrl.length === 0 || typeof model !== 'string' || model.length === 0) {
    throw new Error(`eval eval-config: judge at ${documentPath} needs non-empty baseURL and model`)
  }
  const effort = record['reasoningEffort']
  if (effort !== undefined && (typeof effort !== 'string' || effort.length === 0)) {
    throw new Error(`eval eval-config: judge.reasoningEffort at ${documentPath} must be a non-empty string`)
  }
  const apiKeyField = record['apiKey']
  const apiKeyEnvField = record['apiKeyEnv']
  if (apiKeyField !== undefined && apiKeyEnvField !== undefined) {
    throw new Error(`eval eval-config: judge at ${documentPath} declares both apiKey and apiKeyEnv — pick one`)
  }
  let apiKey: string
  if (apiKeyField !== undefined) {
    if (typeof apiKeyField !== 'string' || apiKeyField.length === 0) {
      throw new Error(`eval eval-config: judge.apiKey at ${documentPath} is empty — paste the key or remove the field for apiKeyEnv`)
    }
    apiKey = apiKeyField
  } else if (typeof apiKeyEnvField === 'string' && apiKeyEnvField.length > 0) {
    const fromEnv = env[apiKeyEnvField]
    if (!isNonEmpty(fromEnv)) {
      throw new Error(`eval eval-config: judge.apiKeyEnv at ${documentPath} names ${JSON.stringify(apiKeyEnvField)}, `
        + 'which is not set in the eval process environment')
    }
    apiKey = fromEnv
  } else {
    throw new Error(`eval eval-config: judge at ${documentPath} needs apiKey or apiKeyEnv`)
  }
  return {
    baseUrl,
    apiKey,
    model,
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  }
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.length > 0
}

/** The per-turn work budget as declared in `eval.yaml`'s `turnBudget:` section. */
export interface EvalTurnBudgetFileConfig {
  /** Wall-clock ceiling for one turn, in seconds; `0` disables the wall cap. */
  wallSeconds: number
  /** Tool-call ceiling for one turn; `0` disables the call cap. */
  toolCalls: number
}

/** Built-in turn-budget defaults; a turn budget bounds one runaway agent turn. */
export const DEFAULT_TURN_WALL_SECONDS = 180
export const DEFAULT_TURN_TOOL_CALLS = 32

/**
 * Load the `turnBudget:` section of the eval config. Absent files or an absent
 * section → `null` (the caller falls back to its defaults). A present section
 * must carry both fields as non-negative integers (`0` = that cap is off) — a
 * half-pasted budget is a misconfiguration and fails loud, like every other
 * instrument field here. The first existing candidate document wins (the same
 * rule the judge section follows).
 * @throws when a candidate document is unparseable or its `turnBudget:` section is malformed.
 */
export function loadEvalYamlTurnBudget(env: NodeJS.ProcessEnv = process.env): EvalTurnBudgetFileConfig | null {
  for (const documentPath of evalConfigCandidates(env)) {
    let raw: string
    try {
      raw = readFileSync(documentPath, 'utf8')
    } catch (error) {
      // ENOENT is simply no eval-owned configuration at this candidate; any
      // other read failure is a broken deployment and must surface.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`eval eval-config: ${documentPath} cannot be read: ${String(error)}`)
      }
      continue
    }
    return parseTurnBudgetSection(documentPath, raw)
  }
  return null
}

function parseTurnBudgetSection(documentPath: string, raw: string): EvalTurnBudgetFileConfig | null {
  let parsed: unknown
  try {
    parsed = parse(raw)
  } catch (error) {
    throw new Error(`eval eval-config: ${documentPath} is not valid YAML: ${String(error)}`)
  }
  if (parsed === undefined || parsed === null) return null
  if (typeof parsed !== 'object') {
    throw new Error(`eval eval-config: ${documentPath} must be a mapping, got ${JSON.stringify(parsed)}`)
  }
  const section = (parsed as Record<string, unknown>)['turnBudget']
  if (section === undefined) return null
  if (section === null || typeof section !== 'object') {
    throw new Error(`eval eval-config: turnBudget at ${documentPath} must be a mapping, got ${JSON.stringify(section)}`)
  }
  const record = section as Record<string, unknown>
  const known = new Set(['wallSeconds', 'toolCalls'])
  const unknownKeys = Object.keys(record).filter(key => !known.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(`eval eval-config: turnBudget at ${documentPath} carries unknown field(s) ${JSON.stringify(unknownKeys)}`)
  }
  const wall = record['wallSeconds']
  const calls = record['toolCalls']
  if (wall === undefined || calls === undefined) {
    throw new Error(`eval eval-config: turnBudget at ${documentPath} needs both wallSeconds and toolCalls`)
  }
  if (typeof wall !== 'number' || !Number.isSafeInteger(wall) || wall < 0) {
    throw new Error(`eval eval-config: turnBudget.wallSeconds at ${documentPath} must be a non-negative integer, got ${JSON.stringify(wall)}`)
  }
  if (typeof calls !== 'number' || !Number.isSafeInteger(calls) || calls < 0) {
    throw new Error(`eval eval-config: turnBudget.toolCalls at ${documentPath} must be a non-negative integer, got ${JSON.stringify(calls)}`)
  }
  return { wallSeconds: wall, toolCalls: calls }
}

/**
 * Resolve the effective per-turn budget: an explicit CLI flag wins per
 * dimension, then the eval.yaml `turnBudget:` section, then the built-in
 * defaults. `0` on either layer explicitly disables that cap and wins the same
 * way a positive value does.
 */
export function resolveTurnBudget(
  flag: { wallSeconds?: number; toolCalls?: number },
  file: EvalTurnBudgetFileConfig | null,
): { wallSeconds: number; toolCalls: number } {
  return {
    wallSeconds: flag.wallSeconds ?? file?.wallSeconds ?? DEFAULT_TURN_WALL_SECONDS,
    toolCalls: flag.toolCalls ?? file?.toolCalls ?? DEFAULT_TURN_TOOL_CALLS,
  }
}
