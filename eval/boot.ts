/**
 * Boot path for the eval suite: start a REAL harness subprocess with the
 * memory plugin mounted as a profile bundle inside a throwaway `$DSH_HOME`,
 * drive it over the SDK stdio protocol, and expose one prompt-per-turn
 * handle. This is the M0 milestone's load-bearing seam — later milestones
 * (M1 standing injection, M2 storage) build on exactly these shapes:
 *
 * ```ts
 * interface TurnResult { finalText: string; systemPrompt?: string; toolCalls: Array<{ name: string; args: unknown; ok: boolean }> }
 * interface HarnessHandle { readonly dshHome: string; prompt(text: string): Promise<TurnResult>; dispose(): Promise<void> }
 * startHarness(opts): Promise<HarnessHandle>
 * ```
 *
 * Boot wiring follows docs/HOST_CONTRACT.zh.md §10: bundle layers compose from
 * the profile manifest (eval/harness/profile-template/), the pinned user layer
 * sits below `--patch` overlays, and the SDK runtime's stdout carries
 * exclusively JSON-RPC frames.
 *
 * @module eval/boot
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startLlmMock, HARNESS_ROOT, type LlmMock } from './harness/llm-mock.ts'
import { materializeProfile, type ModelMode } from './harness/profile-template.ts'
import {
  SdkStdioClient,
  collectSessionEvent,
  emptyTurnCollector,
  isInboxReceipt,
  type HarnessNotification,
  type TurnCollector,
} from './harness/sdk-client.ts'

/** One driven turn's observed outcome. */
export interface TurnResult {
  /** Concatenated text of the turn's final assistant message. */
  finalText: string
  /** The assembled system prompt captured from this turn's request/header. */
  systemPrompt?: string
  /** Tool calls observed during the turn, paired with their results. */
  toolCalls: Array<{ name: string; args: unknown; ok: boolean }>
}

/** One live harness runtime this process owns. */
export interface HarnessHandle {
  /** The throwaway harness home the runtime writes into. */
  readonly dshHome: string
  /**
   * Run one prompt on the runtime's session and await its next idle.
   *
   * MUST be called serially per handle: turns share this handle's one
   * notification subscription, so concurrent prompts would fold each other's
   * events (mixed tool calls, crossed system prompts). Multi-session work
   * means a new handle per session over the same dshHome.
   */
  prompt(text: string): Promise<TurnResult>
  /** Shut the runtime down (protocol shutdown + dispose ladder). */
  dispose(): Promise<void>
}

/** Model route selection for one harness run. */
export interface HarnessModelOptions {
  /**
   * `mock` starts the in-process llm-mock and injects its env; `real` passes
   * through to the public endpoint with the resolved key; `external` injects
   * a caller-supplied OpenAI-compatible endpoint (the runner's per-scenario
   * route-table fake LLM) without starting anything in this process.
   */
  mode: ModelMode
  /** Provider route for the initialize handshake (default `deepseek-official`). */
  provider?: string
  /** Model route for the initialize handshake (default `deepseek-v4-flash`). */
  model?: string
  /**
   * Rendered `llm-pi-ai:` settings section mirroring the deployment's provider
   * profiles into the throwaway home; required when `provider` names a
   * non-DeepSeek route (the base bundle mounts the pi-ai adapter dormant, and
   * this section is what activates its routes).
   */
  piAiSection?: string
  /** Deployment home (the route's settings source); real mode points the child's
   * credentials row at its managed credentials document. */
  deploymentHome?: string
  /** The mirrored profiles' `apiKeyEnv` reference names, for the boot preflight. */
  credentialEnvRefs?: readonly string[]
  /** Thinking strength for the model under test (the deployment's declared default). */
  reasoningEffort?: string
  /** `external` only: endpoint base for `DEEPSEEK_BASE_URL`, e.g. `http://127.0.0.1:<port>/v1`. */
  baseUrl?: string
  /** `external` only: key for `DEEPSEEK_API_KEY` (default `eval-fake-key`). */
  apiKey?: string
}

/** Options for {@link startHarness}. */
export interface StartHarnessOptions {
  /** Plugin build under test: the directory holding the built package.json + lib/. */
  buildDir: string
  /** Throwaway harness home; materialized in place and owned by the handle. */
  dshHome: string
  /** Profile directory name (default `eval`). */
  profileName?: string
  /** Model route (default mock mode). */
  model?: HarnessModelOptions
  /**
   * Extra `--patch` overlays applied ABOVE the profile's pinned user layer —
   * the per-run override seam for the pinned config.
   */
  configPatches?: Array<Record<string, unknown>>
  /** Initialize handshake timeout in ms (default 30_000). */
  initializeTimeoutMs?: number
  /** Per-turn idle timeout in ms (default 120_000). */
  turnTimeoutMs?: number
  /**
   * Per-turn work budget enforced by the prompt collector; a breach throws and
   * the scenario fails loud (the SDK server exposes no interrupt — disposal by
   * the caller's teardown is the abort). Absent = unbounded; the eval CLI
   * always resolves one (flag > eval.yaml > defaults).
   */
  turnBudget?: TurnBudget
  /**
   * Behavior sequence override for the in-process mock (mock mode only), e.g.
   * `['tool_call_success']` to drive unbounded tool rounds — the turn budget's
   * end-to-end trigger and any future scripted mock run.
   */
  mockSequence?: readonly string[]
}

/** Per-turn work budget; `0` disables that dimension. */
export interface TurnBudget {
  /** Wall-clock ceiling for one turn, in seconds; `0` disables. */
  readonly wallSeconds: number
  /** Tool-call ceiling for one turn; `0` disables. */
  readonly toolCalls: number
}

/**
 * The budget verdict for one in-flight turn, as a pure function (the spawn
 * path stays out of vitest — this seam carries the thresholds). The idle
 * timeout only fires on notification silence, so a turn that streams
 * continuously (the measured 939–1151 s max-tokens hangs) or loops tool calls
 * (the 347-call marathon) is bounded only here.
 */
export function turnBudgetBreach(elapsedMs: number, toolCalls: number, budget: TurnBudget): string | null {
  if (budget.wallSeconds > 0 && elapsedMs > budget.wallSeconds * 1000) {
    return `wall ${String(Math.round(elapsedMs / 1000))}s > ${String(budget.wallSeconds)}s`
  }
  if (budget.toolCalls > 0 && toolCalls > budget.toolCalls) {
    return `toolCalls ${String(toolCalls)} > ${String(budget.toolCalls)}`
  }
  return null
}

/** Default dsh executable inside the harness workspace (built bin preferred). */
export function defaultDshBin(): string {
  return join(HARNESS_ROOT, 'apps', 'cli', 'lib', 'bin.js')
}

/** Loud preflight for the harness installation the eval drives. */
function assertDshBinAvailable(): void {
  if (existsSync(defaultDshBin())) return
  throw new Error(
    `eval boot: harness executable missing at ${defaultDshBin()} — point DSH_EVAL_HARNESS_ROOT `
    + 'at a built deepseek-harness checkout (apps/cli/lib/bin.js present) or build it with pnpm build',
  )
}

/** Whether the environment carries a non-empty value under `name`. */
function envHasValue(value: string | undefined): boolean {
  return value !== undefined && value.length > 0
}

/**
 * Whether the managed credentials document plausibly holds `name`. Probe,
 * never parse: the document layout (and every value in it) belongs to the
 * harness's credentials service, and a name is the only thing this layer may
 * look at. A document that exists but cannot be read is a broken deployment
 * and fails loud; an absent one simply holds nothing.
 */
function documentContains(documentPath: string | undefined, ref: string): boolean {
  if (documentPath === undefined) return false
  let raw: string
  try {
    raw = readFileSync(documentPath, 'utf8')
  } catch (error) {
    // ENOENT is simply no managed credential; any other read failure is a
    // broken deployment and must surface at boot, not mid-turn.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`eval boot: credentials document at ${documentPath} cannot be read: ${String(error)}`)
    }
    return false
  }
  return raw.includes(ref)
}

/**
 * Loud preflight for the mirrored pi-ai profiles: every `apiKeyEnv` reference
 * must resolve from the inherited environment or the deployment's managed
 * credentials document, so a missing credential fails at boot instead of
 * mid-turn with the harness's per-request `MISSING_CREDENTIAL`.
 */
function assertCredentialRefsResolvable(refs: readonly string[], credentialsPath: string | undefined): void {
  const missing: string[] = []
  for (const ref of refs) {
    if (envHasValue(process.env[ref]) || documentContains(credentialsPath, ref)) continue
    missing.push(ref)
  }
  if (missing.length > 0) {
    throw new Error(
      `eval boot: provider credential reference(s) ${JSON.stringify(missing)} resolve nowhere — export them `
      + 'in the environment or store them in the deployment\'s managed credentials document '
      + `${credentialsPath === undefined ? '' : `(${credentialsPath})`}`,
    )
  }
}

/**
 * Start one harness runtime subprocess.
 * @throws when the model route cannot be satisfied (real mode without a
 * reachable key) or the profile/bootstrap chain fails — all loud by design.
 */
/** Deterministic git identity for the sandboxed child home. */
const CHILD_GIT_CONFIG = '[user]\n\tname = dsh-eval\n\temail = dsh-eval@localhost\n[init]\n\tdefaultBranch = main\n'

/**
 * Materialize the child process's fake user home: an empty directory inside
 * the throwaway dshHome, plus a pinned git identity. The harness discovers
 * user skills at `$DSH_AGENTS_HOME ?? homedir()/.agents` (packages/skill/
 * skill-filesystem) and git identity at `~/.gitconfig`; an inherited outer
 * HOME leaked the running machine's global skills catalog into every model
 * request (~4.2K tokens re-sent per call) and let scenario fiction drive the
 * SUT into the real filesystem — the 2026-09-02 core-v0 real run lost 3 of 32
 * scenarios to a Lark OAuth wait, real-home exploration, and an unbounded
 * agent marathon. The fake home shares dshHome's lifecycle (deleted with it on
 * success, retained for forensics on failure) and is idempotent: a plant chain
 * opens two handles on one dshHome.
 */
export function materializeChildHome(dshHome: string): string {
  const home = join(dshHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.gitconfig'), CHILD_GIT_CONFIG)
  return home
}

export async function startHarness(options: StartHarnessOptions): Promise<HarnessHandle> {
  const mode = options.model?.mode ?? 'mock'
  const provider = options.model?.provider ?? 'deepseek-official'
  const model = options.model?.model ?? 'deepseek-v4-flash'
  const profileName = options.profileName ?? 'eval'
  const dshHome = options.dshHome
  const turnTimeoutMs = options.turnTimeoutMs ?? 120_000

  let mock: LlmMock | undefined
  // Real mode points the child's credentials row at the deployment's managed
  // credentials document (the web Models page's store) — the harness resolves
  // every reference per request from there, over the inherited environment.
  // The eval probes reference NAMES, never parses values.
  let credentialsPatch: Record<string, unknown> | undefined
  const childHome = materializeChildHome(dshHome)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The child must never see the outer deployment's harness state.
    DSH_HOME: dshHome,
    // The fake user home (materializeChildHome): the SUT's prompt must depend
    // on the build under test, not on the machine running the eval.
    HOME: childHome,
    // The dsh-base telemetry row drains to OTLP on exit; eval runs opt out.
    DSH_TELEMETRY_DISABLED: '1',
  }
  if (mode === 'mock') {
    mock = await startLlmMock({ ...(options.mockSequence !== undefined ? { sequence: options.mockSequence } : {}) })
    env['DEEPSEEK_BASE_URL'] = mock.baseUrl
    env['DEEPSEEK_API_KEY'] = mock.apiKey
  } else if (mode === 'external') {
    // The runner's route-table fake LLM: nothing is started in this process —
    // the endpoint is caller-owned (typically one per scenario), so only the
    // child env is injected. No settings-layer pin: the endpoint varies per
    // scenario and the document would go stale.
    const externalBaseUrl = options.model?.baseUrl
    if (externalBaseUrl === undefined || externalBaseUrl.length === 0) {
      throw new Error('eval boot: external mode requires model.baseUrl (the fake LLM endpoint base, e.g. http://127.0.0.1:<port>/v1)')
    }
    env['DEEPSEEK_BASE_URL'] = externalBaseUrl
    env['DEEPSEEK_API_KEY'] = options.model?.apiKey ?? 'eval-fake-key'
  } else if (mode !== 'real') {
    throw new Error(`eval boot: unknown model mode ${JSON.stringify(mode)}`)
  } else {
    // Real mode. The deployment home's managed credentials document — when it
    // exists — becomes the child's credential plane via a credentials-row path
    // patch; the eval itself never parses credential values.
    const deploymentHome = options.model?.deploymentHome
    const credentialsPath = deploymentHome !== undefined && deploymentHome.length > 0
      ? join(deploymentHome, '.credentials.yaml')
      : undefined
    if (provider !== 'deepseek-official') {
      // A pi-ai provider route: the base bundle mounts the adapter dormant and
      // the mirrored `llm-pi-ai:` settings section activates its routes — the
      // same activation the web Models page performs. The endpoint and key come
      // from the provider profile. The route is inherently live: mock and
      // external are deepseek-official shapes.
      if (options.model?.piAiSection === undefined || options.model.piAiSection.length === 0) {
        throw new Error(`eval boot: provider "${provider}" needs the deployment's llm-pi-ai settings section`)
      }
      assertCredentialRefsResolvable(options.model?.credentialEnvRefs ?? [], credentialsPath)
    } else if (!envHasValue(process.env['DEEPSEEK_API_KEY'])
      && !documentContains(credentialsPath, 'DEEPSEEK_API_KEY')) {
      throw new Error(
        'eval boot: real mode requires a DEEPSEEK key — set $DEEPSEEK_API_KEY in the environment '
        + `or store one in the deployment's managed credentials document`
        + `${credentialsPath === undefined ? '' : ` (${credentialsPath})`}`,
      )
    }
    if (credentialsPath !== undefined && existsSync(credentialsPath)) {
      credentialsPatch = { id: 'credentials', config: { path: credentialsPath } }
    }
  }

  // Everything from here that can throw runs under the startup-failure guard:
  // a failure must stop the in-process mock (if any) and reap the child, or a
  // leaked listener keeps the driver's event loop alive and the run hangs
  // instead of failing with exit code 1.
  let client: SdkStdioClient | undefined
  try {
    assertDshBinAvailable()
    materializeProfile(dshHome, profileName, {
      mode,
      buildDir: options.buildDir,
      ...(mock !== undefined ? { mockBaseUrl: mock.baseUrl } : {}),
      ...(options.model?.piAiSection !== undefined && options.model.piAiSection.length > 0
        ? { piAiSection: options.model.piAiSection }
        : {}),
    })

    // Per-run configPatches land as overlay files under the throwaway home
    // (never the repository) and ride `--patch`, the launcher's topmost layer.
    const patches: string[] = []
    const overlayPatches: Array<Record<string, unknown>> = [
      ...(options.configPatches ?? []),
      ...(credentialsPatch !== undefined ? [credentialsPatch] : []),
    ]
    for (const [index, patch] of overlayPatches.entries()) {
      const overlayDir = join(dshHome, 'eval-overlays')
      mkdirSync(overlayDir, { recursive: true })
      const file = join(overlayDir, `overlay-${String(index)}.yaml`)
      writeFileSync(file, `${JSON.stringify(Array.isArray(patch) ? patch : [patch], undefined, 2)}\n`)
      patches.push(file)
    }

    client = new SdkStdioClient({
      dshBin: defaultDshBin(),
      profile: profileName,
      patches,
      env,
      // The child runs with the throwaway home as cwd so the harness
      // credentials chain's project-.env fallback cannot read the eval
      // repository's own `.env` (the credentials row's documented fallback).
      cwd: dshHome,
      description: `dsh profile ${JSON.stringify(profileName)} (eval)`,
    })
    client.start()
    const effort = options.model?.reasoningEffort
    await client.request(
      'initialize',
      { cwd: dshHome, provider, model, ...(effort !== undefined && effort.length > 0 ? { reasoningEffort: effort } : {}) },
      options.initializeTimeoutMs ?? 30_000,
    )
  } catch (error) {
    // Startup-failure window teardown: stop the mock, reap the child (short
    // graces — a spawn failure has no live process to wait for), then rethrow
    // the ORIGINAL startup error. close() below is best-effort by contract and
    // its own diagnostics already rode along on the transport error context.
    try {
      await client?.close({ shutdownTimeoutMs: 2_000, eofGraceMs: 1_000, termGraceMs: 1_000 })
    } catch (closeError) {
      // Swallowed: the dispose ladder cannot fail a process that is already
      // failing, and no other diagnostic exists beyond the rethrown error.
    }
    await mock?.stop()
    throw error
  }

  // One SDK session for the handle's lifetime: a multi-turn conversation whose
  // memory snapshot froze at session creation (KV-cache contract) — the
  // standing-injection surface the suite measures. A follow-up session with a
  // fresh snapshot is a NEW handle over the same dshHome.
  const sessionId = `eval-${globalThis.crypto.randomUUID().replaceAll('-', '')}`
  let lastSystemPrompt: string | undefined
  const subscription = client.subscribe((notification) => notification.params['sessionId'] === sessionId)

  /**
   * One prompt's activity interval; the caller MUST await it before the next
   * prompt (serial per handle — concurrent turns share the subscription above
   * and would fold each other's events).
   */
  const prompt: (text: string) => Promise<TurnResult> = async (text) => {
    const collector: TurnCollector = emptyTurnCollector()
    const turnStartedAt = Date.now()
    const promptResult = await client.request(
      'session/prompt',
      { sessionId, contentBlocks: [{ type: 'text', text }] },
      turnTimeoutMs,
    )
    const messageId = (promptResult as { messageId?: unknown } | null)?.messageId
    if (typeof messageId !== 'string') {
      throw new Error(`eval boot: session/prompt returned no messageId: ${JSON.stringify(promptResult)}`)
    }
    // Collect from the queued message's durable receipt through the next idle,
    // mirroring the reference client's activity interval.
    let received = false
    for (;;) {
      const notification = await withTimeout(subscription.next(), turnTimeoutMs, 'waiting for session notifications')
      if (!received) {
        const event = eventOf(notification)
        if (event === undefined || !isInboxReceipt(event, messageId)) continue
        received = true
      }
      const event = eventOf(notification)
      if (event !== undefined) collectSessionEvent(collector, event)
      if (options.turnBudget !== undefined) {
        const breach = turnBudgetBreach(Date.now() - turnStartedAt, collector.toolCalls.length, options.turnBudget)
        if (breach !== null) {
          // Fail loud, not silent: the throw rides the scenario's error path
          // (kept home, partial results preserved) and the caller's teardown
          // reaps the still-running turn — the SDK server has no interrupt.
          throw new Error(`eval boot: turn budget exceeded (${breach}) — turn aborted, scenario fails`)
        }
      }
      if (notification.method === 'session.status'
        && notification.params['sessionId'] === sessionId
        && notification.params['status'] === 'idle') break
    }
    // A turn that ends idle without an assistant message is a failed turn (the
    // agent loop appends an assistant message on every completed or interrupted
    // step; a failed LLM call — a dead route, a missing credential — produces
    // none). Silence here would let a real-mode run score `ok` with no answers,
    // indistinguishable from a healthy judge-less run.
    if (collector.finalText.length === 0) {
      throw new Error(
        'eval boot: turn ended without an assistant message — the model route produced no answer '
        + `(last turn of session ${sessionId}); check the route's credentials and endpoint`,
      )
    }
    if (collector.systemPrompt !== undefined) lastSystemPrompt = collector.systemPrompt
    return {
      finalText: collector.finalText,
      // A turn without its own header snapshot (unchanged header) carries the
      // session's standing prompt forward.
      ...(collector.systemPrompt !== undefined
        ? { systemPrompt: collector.systemPrompt }
        : lastSystemPrompt !== undefined ? { systemPrompt: lastSystemPrompt } : {}),
      toolCalls: collector.toolCalls.map(call => ({ name: call.name, args: call.args, ok: call.ok })),
    }
  }

  const dispose: () => Promise<void> = async () => {
    subscription.close()
    try {
      await client.close()
    } finally {
      // The mock stops only AFTER the runtime's dispose ladder completes: the
      // dispose flush may still fire LLM calls while the runtime tears down,
      // so the mock must stay reachable through client.close(). Per handle,
      // the mock's lifetime is dispose's; a runner never stops it separately.
      await mock?.stop()
      mock = undefined
    }
  }

  return { dshHome, prompt, dispose }
}

/** The managed credentials document path under a harness home. */
function documentPath(dshHome: string): string {
  return join(dshHome, '.credentials.yaml')
}

/** Narrow a notification to its session.event payload when it is one. */
function eventOf(notification: HarnessNotification): { type: string; seq: number; data: Record<string, unknown> } | undefined {
  if (notification.method !== 'session.event') return undefined
  const event = notification.params['event']
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return undefined
  const record = event as Record<string, unknown>
  if (typeof record['type'] !== 'string') return undefined
  return {
    type: record['type'],
    seq: typeof record['seq'] === 'number' ? record['seq'] : 0,
    data: (record['data'] !== undefined && typeof record['data'] === 'object' && record['data'] !== null
      ? record['data']
      : {}) as Record<string, unknown>,
  }
}

/** Reject when a notification wait outlives `timeoutMs`. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`eval boot: ${what} timed out after ${String(timeoutMs)}ms`)) }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
