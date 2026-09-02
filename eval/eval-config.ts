/**
 * Eval-owned configuration from the deployment home: `$DSH_HOME/eval.yaml`
 * (else `~/.dsh/eval.yaml`).
 *
 * The file configures the eval's instruments, not the system under test —
 * today that is the rubric judge, a deliberate choice the operator makes per
 * L2 run (same-source self-grading is exactly what the file exists to avoid
 * defaulting into). The deployment's own settings.yaml stays the source for
 * the model under test; this file never overrides it.
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

/** Absolute path of the eval config document for one deployment home. */
export function evalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'eval.yaml')
}

/**
 * Load the `judge:` section of the deployment home's eval.yaml. Absent file or
 * absent section → `null` (the caller falls through its own chain). A present
 * section that is incomplete or malformed is a misconfiguration and fails loud:
 * a half-pasted instrument config must not silently degrade to skipped judging.
 * `apiKeyEnv` resolves from the eval process environment at load time.
 * @throws when the document is unparseable or the `judge:` section is malformed.
 */
export function loadEvalYamlJudge(env: NodeJS.ProcessEnv = process.env): EvalJudgeFileConfig | null {
  const documentPath = evalConfigPath(env)
  let raw: string
  try {
    raw = readFileSync(documentPath, 'utf8')
  } catch (error) {
    // ENOENT is simply no eval-owned configuration; any other read failure is
    // a broken deployment and must surface, not silently skip the judge.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`eval eval-config: ${documentPath} cannot be read: ${String(error)}`)
    }
    return null
  }
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
