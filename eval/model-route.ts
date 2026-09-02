/**
 * Model-route resolution for the eval CLI: which model id the harness
 * initialize handshake receives for `real`/`external` runs.
 *
 * The SDK server mounts only the `deepseek-official` adapter as its launch
 * fallback, so the provider axis is pinned by the host and the endpoint is
 * chosen by the mode (`--base-url` for external, `DEEPSEEK_BASE_URL` or the
 * public API for real); the model id is what varies. The default follows the
 * deployment the suite runs on — the `agent-default-model.model` of the outer
 * `$DSH_HOME`'s `settings.yaml` — falling back to the stock DeepSeek route
 * when the deployment declares none. Every resolution names its source: a
 * fallback is observable, never silent.
 *
 * @module eval/model-route
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

/** Stock DeepSeek route when no `--model` and the deployment declares none. */
export const FALLBACK_EVAL_MODEL = 'deepseek-v4-flash'

/** Resolved model identity for one `real`/`external` eval run. */
export interface EvalModelRoute {
  /** Model id for the initialize handshake. */
  readonly model: string
  /** Where the id came from; the CLI prints every source. */
  readonly source: 'flag' | 'agent-default-model' | 'fallback'
  /** settings.yaml path, present when `source` is `agent-default-model`. */
  readonly origin?: string
  /**
   * Provider the deployment's `agent-default-model` declares, when present.
   * Informational only — the SDK profile pins the adapter, so a non-DeepSeek
   * deployment provider surfaces as a notice, never as a route.
   */
  readonly deploymentProvider?: string
}

/**
 * Resolve the model id for a `real`/`external` run: explicit `--model` wins,
 * then the deployment home's `agent-default-model.model`, then the stock
 * DeepSeek default. A settings document that exists but cannot serve a
 * well-formed route is a broken deployment and fails loud; an absent
 * document (or absent `agent-default-model`) legitimately falls back.
 * @throws when the deployment's settings.yaml exists but is unreadable,
 *   unparseable, or declares a malformed `agent-default-model`.
 */
export function resolveEvalModel(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): EvalModelRoute {
  if (flag !== undefined) return { model: flag, source: 'flag' }
  const settingsPath = join(env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'settings.yaml')
  let raw: string
  try {
    raw = readFileSync(settingsPath, 'utf8')
  } catch (error) {
    // ENOENT is simply no outer deployment (bare CI machine) — the stock
    // fallback stands. Any other read failure is a broken deployment.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`eval model-route: settings document at ${settingsPath} cannot be read: ${String(error)}`)
    }
    return { model: FALLBACK_EVAL_MODEL, source: 'fallback' }
  }
  let document: unknown
  try {
    document = parse(raw)
  } catch (error) {
    throw new Error(`eval model-route: settings document at ${settingsPath} is not valid YAML: ${String(error)}`)
  }
  const agentDefault = document !== null && typeof document === 'object'
    ? (document as Record<string, unknown>)['agent-default-model']
    : undefined
  if (agentDefault === undefined) return { model: FALLBACK_EVAL_MODEL, source: 'fallback' }
  if (agentDefault === null || typeof agentDefault !== 'object') {
    throw new Error(`eval model-route: agent-default-model at ${settingsPath} must be a mapping, got ${JSON.stringify(agentDefault)}`)
  }
  const record = agentDefault as Record<string, unknown>
  const model = record['model']
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error(`eval model-route: agent-default-model.model at ${settingsPath} must be a non-empty string`)
  }
  const deploymentProvider = record['provider']
  return {
    model,
    source: 'agent-default-model',
    origin: settingsPath,
    ...(typeof deploymentProvider === 'string' && deploymentProvider.length > 0 ? { deploymentProvider } : {}),
  }
}

/** One-line human description of a resolved route, for the CLI's stamp line. */
export function describeEvalModelRoute(route: EvalModelRoute): string {
  if (route.source === 'flag') return `--model flag`
  if (route.source === 'agent-default-model') return `agent-default-model at ${route.origin}`
  return 'fallback default (no --model, no agent-default-model in the deployment home)'
}
