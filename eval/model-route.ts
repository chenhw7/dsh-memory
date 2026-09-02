/**
 * Model-route resolution for the eval CLI: which provider and model id the
 * harness initialize handshake receives for `real` runs.
 *
 * The SDK profile mounts `llm-pi-ai` dormant — zero routes — until the user
 * settings document supplies an `llm-pi-ai:` section (exactly what the web
 * Models page writes), so a deployment's own provider routes are activated by
 * mirroring that section into the throwaway home, not by code. The route
 * therefore resolves in this order: explicit `--provider`/`--model` flags,
 * the deployment home's `agent-default-model`, then the stock DeepSeek pair.
 * Every resolution names its source; a settings document that exists but
 * cannot serve a well-formed route fails loud, an absent one falls back.
 *
 * The deployment home is `$DSH_HOME` (the same variable the harness itself
 * resolves), else `~/.dsh` — no hardcoded paths, so the suite is portable
 * across environments by construction.
 *
 * @module eval/model-route
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'

/** Stock DeepSeek route when no flags and the deployment declares none. */
export const FALLBACK_EVAL_PROVIDER = 'deepseek-official'
export const FALLBACK_EVAL_MODEL = 'deepseek-v4-flash'

/** Resolved model identity for one `real` eval run. */
export interface EvalModelRoute {
  /** Provider route for the initialize handshake. */
  readonly provider: string
  /** Model id for the initialize handshake. */
  readonly model: string
  /** Where the route came from; the CLI prints every source. */
  readonly source: 'flag' | 'agent-default-model' | 'fallback'
  /** settings.yaml path, present when the route came from the deployment. */
  readonly origin?: string
  /**
   * The deployment's `llm-pi-ai:` settings section, carried verbatim into the
   * throwaway home so the resolved route (and any sibling routes it defines)
   * registers live — the same activation the web Models page performs. Present
   * only when `provider` is not the stock DeepSeek route.
   */
  readonly piAiSection?: string
}

/** One provider profile inside the deployment's `llm-pi-ai.providers` mapping. */
function assertCredentialIsReference(profile: unknown, settingsPath: string, name: string): void {
  if (profile === null || typeof profile !== 'object') {
    throw new Error(`eval model-route: llm-pi-ai provider "${name}" at ${settingsPath} must be a mapping`)
  }
  const credentialFields = Object.keys(profile as Record<string, unknown>)
    .filter(field => field.toLowerCase().includes('key') && field !== 'apiKeyEnv')
  if (credentialFields.length > 0) {
    throw new Error(
      `eval model-route: llm-pi-ai provider "${name}" at ${settingsPath} carries inline credential field(s) `
      + `${JSON.stringify(credentialFields)} — the eval mirrors the deployment's settings document into a `
      + 'throwaway home, so credentials must stay behind apiKeyEnv references',
    )
  }
}

/**
 * Resolve the provider/model route for a `real` run: explicit flags win, then
 * the deployment home's `agent-default-model`, then the stock DeepSeek pair.
 * A non-DeepSeek provider requires the deployment settings to carry an
 * `llm-pi-ai:` section defining that route — mirroring the section into the
 * throwaway home activates it the same way the web Models page does. A
 * settings document that exists but is unreadable, unparseable, or declares a
 * malformed route is a broken deployment and fails loud; an absent document
 * (or absent sections) legitimately falls back.
 * @throws when the deployment's settings.yaml exists but cannot serve a
 *   well-formed route, or the named provider has no `llm-pi-ai` profile.
 */
export function resolveEvalModel(
  flags: { provider?: string; model?: string },
  env: NodeJS.ProcessEnv = process.env,
): EvalModelRoute {
  const settingsPath = join(env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'settings.yaml')
  let document: Record<string, unknown> | undefined
  let raw: string | undefined
  try {
    raw = readFileSync(settingsPath, 'utf8')
  } catch (error) {
    // ENOENT is simply no outer deployment (bare CI machine) — the stock
    // fallback stands. Any other read failure is a broken deployment.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`eval model-route: settings document at ${settingsPath} cannot be read: ${String(error)}`)
    }
  }
  if (raw !== undefined) {
    let parsed: unknown
    try {
      parsed = parse(raw)
    } catch (error) {
      throw new Error(`eval model-route: settings document at ${settingsPath} is not valid YAML: ${String(error)}`)
    }
    if (parsed === undefined || parsed === null) {
      document = {}
    } else if (typeof parsed === 'object') {
      document = parsed as Record<string, unknown>
    } else {
      throw new Error(`eval model-route: settings document at ${settingsPath} must be a mapping, got ${JSON.stringify(parsed)}`)
    }
  }

  const agentDefault = document?.['agent-default-model']
  if (agentDefault !== undefined && (agentDefault === null || typeof agentDefault !== 'object')) {
    throw new Error(`eval model-route: agent-default-model at ${settingsPath} must be a mapping, got ${JSON.stringify(agentDefault)}`)
  }
  const defaults = (agentDefault ?? {}) as Record<string, unknown>
  if (agentDefault !== undefined) {
    // A declared default is the deployment's whole route statement: a half
    // declaration (provider without model, or the reverse) would silently mix
    // the deployment's provider with the eval's stock fallback.
    for (const field of ['provider', 'model'] as const) {
      const value = defaults[field]
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`eval model-route: agent-default-model.${field} at ${settingsPath} must be a non-empty string`)
      }
    }
  }

  const provider = flags.provider ?? (defaults['provider'] as string | undefined) ?? FALLBACK_EVAL_PROVIDER
  const model = flags.model ?? (defaults['model'] as string | undefined) ?? FALLBACK_EVAL_MODEL
  if (provider === FALLBACK_EVAL_PROVIDER || document === undefined) {
    return {
      provider,
      model,
      source: sourceOf(flags, defaults),
      ...(document !== undefined ? { origin: settingsPath } : {}),
    }
  }

  const piAi = document['llm-pi-ai']
  if (piAi === undefined || piAi === null || typeof piAi !== 'object') {
    throw new Error(
      `eval model-route: provider "${provider}" needs an llm-pi-ai: section in ${settingsPath} `
      + `defining it as a provider profile — the eval mirrors that section into the throwaway home the way `
      + 'the web Models page writes it',
    )
  }
  const providers = (piAi as Record<string, unknown>)['providers']
  if (providers === null || typeof providers !== 'object' || !(provider in (providers as Record<string, unknown>))) {
    throw new Error(
      `eval model-route: provider "${provider}" is not defined under llm-pi-ai.providers in ${settingsPath}`,
    )
  }
  for (const [name, profile] of Object.entries(providers as Record<string, unknown>)) {
    assertCredentialIsReference(profile, settingsPath, name)
  }
  return {
    provider,
    model,
    source: sourceOf(flags, defaults),
    origin: settingsPath,
    piAiSection: stringify({ 'llm-pi-ai': piAi }),
  }
}

function sourceOf(flags: { provider?: string; model?: string }, defaults: Record<string, unknown>): 'flag' | 'agent-default-model' | 'fallback' {
  if (flags.provider !== undefined || flags.model !== undefined) return 'flag'
  if (defaults['provider'] !== undefined || defaults['model'] !== undefined) return 'agent-default-model'
  return 'fallback'
}

/** One-line human description of a resolved route, for the CLI's stamp line. */
export function describeEvalModelRoute(route: EvalModelRoute): string {
  if (route.source === 'flag') return `--provider/--model flags`
  if (route.source === 'agent-default-model') return `agent-default-model at ${route.origin}`
  return 'fallback default (no flags, no agent-default-model in the deployment home)'
}
