/**
 * In-process launcher for `@deepseek-ai/dsh-llm-mock-server` (the harness
 * workspace's built artifact, imported by absolute path — the package is
 * dependency-free over node builtins, so the import drags no harness runtime).
 *
 * MEASURED ROUTING ABILITY (probe, 2026-09-01, harness @ packages/
 * test-support/llm-mock-server): the mock does NOT route responses by request
 * content. Every accepted chat-completions request consumes the next entry of
 * one ordered `--sequence` of canned behaviors (success / tool_call_success /
 * faults / random), and every success-shaped response streams the single
 * fixed `successText` configured per server instance; two requests with
 * different user content both returned the identical text. Request bodies ARE
 * recorded verbatim per attempt (`server.requests[].body`) for assertions.
 * `tool_call_success` emits a fixed toolName/toolArguments pair. Consequence:
 * deterministic for standing-injection runs (the answer text is irrelevant),
 * but the M2 extraction scenarios need content-aware responses — they will
 * use the in-`eval/` route-table fake server the suite design names as the
 * fallback, not this server.
 *
 * @module eval/harness/llm-mock
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Harness workspace root; overridable for harness checkouts elsewhere. */
export const HARNESS_ROOT = process.env['DSH_EVAL_HARNESS_ROOT'] ?? '/home/chenhw7/deepseek-harness'

/** Built artifact of the mock server inside the harness workspace. */
export const MOCK_SERVER_LIB = join(HARNESS_ROOT, 'packages', 'test-support', 'llm-mock-server', 'lib', 'index.js')
/** Bearer token the eval wires into both the mock and the child env. */
export const MOCK_API_KEY = 'mock-key'

/** Wire shape of the started server (structural, keeps harness types out). */
interface MockLlmServerHandle {
  readonly baseURL: string
  readonly port: number
  close(): Promise<void>
}

/** A started mock server plus the env values the runtime child needs. */
export interface LlmMock {
  /** Base URL for `DEEPSEEK_BASE_URL`, including the `/v1` namespace. */
  readonly baseUrl: string
  /** Bearer key to send as `DEEPSEEK_API_KEY`. */
  readonly apiKey: string
  /** Stop accepting requests and close open streams. */
  stop(): Promise<void>
}

/** Options for the mock-backed eval LLM. */
export interface StartLlmMockOptions {
  /** Fixed success text; the mock streams this for every success-shaped request. */
  successText?: string
  /** Behavior sequence override (see the module header for the catalog). */
  sequence?: readonly string[]
}

/**
 * Start the mock LLM server in-process.
 * @throws when the harness workspace's built artifact is missing — the eval
 * suite requires a built harness checkout (see the module header).
 */
export async function startLlmMock(options: StartLlmMockOptions = {}): Promise<LlmMock> {
  if (!existsSync(HARNESS_ROOT)) {
    // Discoverability: the machine-default root is a convention, not a fact —
    // a missing root must name the env override, not surface as a deep
    // module-resolution stack trace.
    throw new Error(
      `eval llm-mock: harness root ${HARNESS_ROOT} does not exist — set DSH_EVAL_HARNESS_ROOT `
      + 'to a deepseek-harness checkout and build it (pnpm build) so apps/cli/lib/bin.js exists',
    )
  }
  if (!existsSync(MOCK_SERVER_LIB)) {
    throw new Error(
      `eval llm-mock: harness checkout at ${HARNESS_ROOT} is not built — the mock server lib is `
      + `missing at ${MOCK_SERVER_LIB}; run pnpm build in the checkout `
      + '(or point DSH_EVAL_HARNESS_ROOT at a built checkout)',
    )
  }
  // Dynamic import of the harness workspace's built artifact by absolute path:
  // the ONLY harness import in the eval layer, and only this file's.
  const mod = (await import(pathToFileURL(MOCK_SERVER_LIB).href)) as {
    startMockLlmServer(options: Record<string, unknown>): Promise<MockLlmServerHandle>
  }
  const server = await mod.startMockLlmServer({
    // One behavior, repeated forever: every request in the run gets the same
    // deterministic success. Per-request scripting (a sequence) is the caller's
    // knob via `sequence` when a run needs ordered behaviors.
    sequence: options.sequence ?? ['success'],
    repeatLast: true,
    successText: options.successText ?? 'mock response recovered',
    apiKey: MOCK_API_KEY,
    chunkSize: 64,
    chunkDelayMs: 0,
  })
  return {
    baseUrl: `${server.baseURL}/v1`,
    apiKey: MOCK_API_KEY,
    stop: () => server.close(),
  }
}
