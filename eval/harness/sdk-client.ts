/**
 * Minimal newline-delimited JSON-RPC 2.0 stdio client for the DeepSeek Harness
 * SDK runtime, hand-written against the wire shapes in the harness sources
 * (packages/sdk/protocol/src/{types,transport}.ts). Deliberately imports NO
 * harness-repo code at runtime: the eval suite must run against any installed
 * dsh build, and the protocol surface is three requests plus four
 * notifications.
 *
 * Wire: one JSON object per line on the child's stdout; frames with `id` and
 * `method` are requests, `id` alone responses, `method` alone notifications.
 * Server methods: initialize / session/prompt / shutdown. Server
 * notifications: session.event / session.status / subagent.started /
 * subagent.finished.
 *
 * The turn-event reducer is a pure export so vitest can cover session-event
 * handling without spawning the runtime.
 *
 * @module eval/harness/sdk-client
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** One parsed wire frame (the JSON-RPC 2.0 subset this client speaks). */
export interface WireFrame {
  jsonrpc: '2.0'
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

/** Minimal session-event envelope: the fields every consumer here reads. */
export interface SessionEventPayload {
  type: string
  seq: number
  data: Record<string, unknown>
}

/** One server-to-client notification. */
export interface HarnessNotification {
  method: string
  params: Record<string, unknown>
}

/** Options for one SDK runtime subprocess. */
export interface SdkStdioClientOptions {
  /** Absolute path of the dsh executable (built bin preferred). */
  dshBin: string
  /** Profile name to boot (`dsh --profile <name>`). */
  profile: string
  /** `--patch` overlay file paths, in argv order. */
  patches?: readonly string[]
  /** Complete child environment; must already carry DSH_HOME and credentials. */
  env: NodeJS.ProcessEnv
  /** Child working directory. */
  cwd?: string
  /** Human-readable description used in error context. */
  description?: string
}

/** A request timed out, or the transport died while it was pending. */
export class SdkTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SdkTransportError'
  }
}

/** The runtime answered outside the protocol (error frame, missing result). */
export class SdkProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SdkProtocolError'
  }
}

/** Retained stderr lines used to diagnose an unexpected runtime death. */
const STDERR_TAIL_LIMIT = 200

interface PendingEntry {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | undefined
}

interface SubscriptionState {
  queue: HarnessNotification[]
  waiters: Array<{ resolve: (notification: HarnessNotification) => void; reject: (error: Error) => void }>
  filter: (notification: HarnessNotification) => boolean
  failure: Error | undefined
  closed: boolean
}

/** One active notification subscription. */
export interface NotificationSubscription {
  /** Await the next matching notification; rejects when the transport dies. */
  next(): Promise<HarnessNotification>
  /** Stop delivering; queued items drop and pending waiters reject. */
  close(): void
}

/**
 * JSON-RPC client owning one `dsh --profile <name>` SDK runtime subprocess.
 * Frames flow as newline-delimited JSON over the child's stdio; stderr is
 * retained (bounded) for error context. Teardown walks the reference client's
 * dispose ladder: protocol shutdown, stdin-EOF, SIGTERM, SIGKILL.
 */
export class SdkStdioClient {
  private readonly options: SdkStdioClientOptions
  private child: ChildProcess | undefined
  private readBuffer = ''
  private stderrRemainder = ''
  private readonly pending = new Map<string, PendingEntry>()
  private readonly subscriptions = new Set<SubscriptionState>()
  private readonly stderrTail: string[] = []
  private exitCode: number | null | undefined
  private transportFailure: Error | undefined
  private closeTask: Promise<void> | undefined

  constructor(options: SdkStdioClientOptions) {
    this.options = options
  }

  /** Spawn the runtime and start reading frames. Idempotent while live. */
  start(): void {
    if (this.child !== undefined) return
    const args = ['--profile', this.options.profile]
    for (const patch of this.options.patches ?? []) args.push('--patch', patch)
    const child = spawn(process.execPath, [this.options.dshBin, ...args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.onData(chunk) })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.onStderr(chunk) })
    child.stderr?.once('close', () => { this.appendStderr(this.stderrRemainder); this.stderrRemainder = '' })
    // stdin writes racing the runtime's death EPIPE; the exit edge below owns
    // the real failure signal, so the stream-level error stays non-fatal.
    child.stdin?.on('error', () => {})
    child.once('error', (error) => {
      // A spawn failure destroys the pipes without an exit edge for the pending
      // requests, so the transport must fail them here.
      this.failTransport(new SdkTransportError(`SDK runtime failed to start: ${error.message}`))
    })
    child.once('exit', (code) => {
      this.exitCode = code
      this.failTransport(new SdkTransportError(this.closedError('SDK runtime exited')))
    })
  }

  /** Send one notification (no response expected). */
  notify(method: string, params?: object): void {
    this.writeFrame(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /**
   * Send one request and await its result.
   * @param method - the wire method.
   * @param params - request params; omitted params send `{}`.
   * @param timeoutMs - abandonment bound; the pending entry is dropped on
   * timeout (server-side work runs to completion or teardown).
   */
  request(method: string, params?: object, timeoutMs?: number): Promise<unknown> {
    this.start()
    if (this.transportFailure !== undefined) {
      return Promise.reject(new SdkTransportError(this.closedError('SDK runtime is not running')))
    }
    const id = `req_${randomUUID().replaceAll('-', '')}`
    return new Promise((resolve, reject) => {
      const entry: PendingEntry = { resolve, reject, timer: undefined }
      this.pending.set(id, entry)
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          // Abandonment, not cancellation: drop the entry and fail this caller
          // with process context; the server side runs to teardown.
          if (this.pending.get(id) === entry) this.pending.delete(id)
          reject(new SdkTransportError(`${method} timed out after ${String(timeoutMs)}ms${this.stderrContext()}`))
        }, timeoutMs)
      }
      try {
        this.writeFrame({ jsonrpc: '2.0', id, method, params: params ?? {} })
      } catch (error) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        if (this.pending.get(id) === entry) this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Subscribe to notifications passing `filter` (all when omitted). */
  subscribe(filter?: (notification: HarnessNotification) => boolean): NotificationSubscription {
    const state: SubscriptionState = {
      queue: [],
      waiters: [],
      filter: filter ?? (() => true),
      failure: this.transportFailure,
      closed: false,
    }
    this.subscriptions.add(state)
    return {
      next: () => this.nextFrom(state),
      close: () => {
        state.closed = true
        this.subscriptions.delete(state)
        for (const waiter of state.waiters.splice(0)) waiter.reject(new SdkTransportError('notification subscription closed'))
        state.queue.length = 0
      },
    }
  }

  /** Whether the child has exited. */
  get exited(): boolean {
    return this.exitCode !== undefined
  }

  /**
   * Shut the runtime down and reap it: protocol `shutdown` (best effort,
   * bounded), then stdin-EOF → SIGTERM → SIGKILL until the process exits.
   * Idempotent.
   */
  close(opts?: { shutdownTimeoutMs?: number; eofGraceMs?: number; termGraceMs?: number }): Promise<void> {
    this.closeTask ??= this.performClose(
      opts?.shutdownTimeoutMs ?? 10_000,
      opts?.eofGraceMs ?? 6_000,
      opts?.termGraceMs ?? 3_000,
    )
    return this.closeTask
  }

  private async performClose(shutdownTimeoutMs: number, eofGraceMs: number, termGraceMs: number): Promise<void> {
    const child = this.child
    if (child === undefined) return
    try {
      await this.request('shutdown', undefined, shutdownTimeoutMs)
    } catch (error) {
      // Diagnostic only: the dispose ladder below is the authoritative teardown
      // for a runtime that can no longer answer shutdown.
      this.appendStderr(`shutdown request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (this.exitCode !== undefined) return
    await this.terminate(child, eofGraceMs, termGraceMs)
  }

  /** The stdin-EOF → SIGTERM → SIGKILL ladder against one live child. */
  private terminate(child: ChildProcess, eofGraceMs: number, termGraceMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        child.off('exit', finish)
        resolve()
      }
      child.once('exit', finish)
      // EOF first: the SDK app binds its bounded shutdown to stdin end.
      child.stdin?.end()
      setTimeout(() => {
        if (this.exitCode !== undefined) { finish(); return }
        child.kill('SIGTERM')
        setTimeout(() => {
          if (this.exitCode !== undefined) { finish(); return }
          child.kill('SIGKILL')
          setTimeout(finish, 1_000).unref()
        }, termGraceMs).unref()
      }, eofGraceMs).unref()
    })
  }

  private nextFrom(state: SubscriptionState): Promise<HarnessNotification> {
    const queued = state.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (state.failure !== undefined) return Promise.reject(state.failure)
    if (state.closed) return Promise.reject(new SdkTransportError('notification subscription closed'))
    return new Promise((resolve, reject) => { state.waiters.push({ resolve, reject }) })
  }

  private dispatch(frame: WireFrame): void {
    // Responses carry an id and no method; requests carry both (the runtime
    // never sends requests on this surface), notifications a method only.
    if (frame.id !== undefined && frame.method === undefined) {
      this.resolvePending(String(frame.id), frame)
      return
    }
    if (frame.method === undefined) return
    const rawParams = frame.params
    const params = (rawParams !== undefined && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? rawParams
      : {}) as Record<string, unknown>
    const notification: HarnessNotification = { method: frame.method, params }
    for (const state of [...this.subscriptions]) {
      if (state.closed) continue
      let matches: boolean
      try {
        matches = state.filter(notification)
      } catch (error) {
        // A throwing filter fails only this subscription; the transport's read
        // loop and sibling subscriptions stay alive.
        state.failure = error instanceof Error ? error : new Error(String(error))
        this.subscriptions.delete(state)
        for (const waiter of state.waiters.splice(0)) waiter.reject(state.failure)
        continue
      }
      if (!matches) continue
      const waiter = state.waiters.shift()
      if (waiter !== undefined) waiter.resolve(notification)
      else state.queue.push(notification)
    }
  }

  private resolvePending(id: string, frame: WireFrame): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    this.pending.delete(id)
    if (frame.error !== undefined) {
      const code = frame.error.code === undefined ? '' : ` ${String(frame.error.code)}`
      pending.reject(new SdkProtocolError(`JSON-RPC error${code}: ${frame.error.message ?? 'unknown error'}`))
      return
    }
    pending.resolve(frame.result)
  }

  private failTransport(error: Error): void {
    if (this.transportFailure !== undefined) return
    this.transportFailure = error
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    for (const state of this.subscriptions) {
      if (state.closed) continue
      state.failure ??= error
      for (const waiter of state.waiters.splice(0)) waiter.reject(state.failure)
    }
  }

  private closedError(reason: string): string {
    const parts = [`${this.options.description ?? 'SDK runtime'}: ${reason}`]
    if (this.exitCode !== undefined) parts.push(`exit code: ${String(this.exitCode)}`)
    if (this.stderrTail.length > 0) parts.push(`stderr tail:\n${this.stderrTail.join('\n')}`)
    return parts.join('\n')
  }

  private writeFrame(frame: WireFrame): void {
    const stdin = this.child?.stdin
    if (stdin === null || stdin === undefined || stdin.destroyed) {
      throw new SdkTransportError('SDK runtime stdin is closed')
    }
    stdin.write(`${JSON.stringify(frame)}\n`)
  }

  private onData(chunk: string): void {
    this.readBuffer += chunk
    for (;;) {
      const newline = this.readBuffer.indexOf('\n')
      if (newline < 0) break
      const line = this.readBuffer.slice(0, newline).trim()
      this.readBuffer = this.readBuffer.slice(newline + 1)
      if (line.length === 0) continue
      let frame: WireFrame
      try {
        frame = JSON.parse(line) as WireFrame
      } catch {
        // Malformed peer lines are ignored, matching the reference transport's
        // framing contract (only JSON syntax errors reach this catch).
        continue
      }
      this.dispatch(frame)
    }
  }

  private onStderr(chunk: string): void {
    const text = this.stderrRemainder + chunk
    const lines = text.split('\n')
    // The tail after the last newline is a partial line; hold it back until the
    // stream closes or the next chunk completes it.
    this.stderrRemainder = lines.pop() ?? ''
    for (const line of lines) this.appendStderr(line)
  }

  private appendStderr(line: string): void {
    if (line.length === 0) return
    this.stderrTail.push(line)
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LIMIT)
    }
  }

  private stderrContext(): string {
    return this.stderrTail.length === 0 ? '' : `; stderr tail:\n${this.stderrTail.join('\n')}`
  }
}

/**
 * Whether one raw `session.event` is the durable enqueue receipt for
 * `messageId` (the agent/inbox/spliced event carrying the queued message).
 */
export function isInboxReceipt(event: SessionEventPayload, messageId: string): boolean {
  if (event.type !== 'agent/inbox/spliced') return false
  const inserted = event.data['inserted']
  return Array.isArray(inserted)
    && inserted.some(message => (message as { id?: unknown } | null)?.id === messageId)
}

/** Extract the concatenated text blocks of one message value. */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      (block as { type?: unknown } | null)?.type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
}

/** One observed tool call within a turn. */
export interface ObservedToolCall {
  /** The callId pairing a tool/call with its tool/result. */
  callId: string
  name: string
  args: unknown
  /**
   * `true` once the paired tool/result arrives and the call completed without
   * failing (no event-level `error`, result block not `isError`); an unpaired
   * call reads as failed. On the wire every tool/call gets exactly one
   * tool/result (packages/core/agent-loop/src/tool-calls.ts), so an unpaired
   * call in a closed turn is itself evidence of an aborted dispatch.
   */
  ok: boolean
  /** Pairing guard: each result is folded into its call exactly once. */
  settled?: true
}

/** Turn-scoped collection state fed by {@link collectSessionEvent}. */
export interface TurnCollector {
  /** Text of the LAST assistant message seen (the wire-final answer). */
  finalText: string
  /** Rendered system prompt from the latest request/header snapshot. */
  systemPrompt: string | undefined
  /** Tool calls in arrival order, paired with results when they land. */
  toolCalls: ObservedToolCall[]
}

/** An empty collector for one turn. */
export function emptyTurnCollector(): TurnCollector {
  return { finalText: '', systemPrompt: undefined, toolCalls: [] }
}

/**
 * Fold one session event into a turn collector. Pure outside the passed
 * collector; unrecognized event types are ignored (the session log carries
 * chunk and boundary records this layer never reads).
 */
export function collectSessionEvent(collector: TurnCollector, event: SessionEventPayload): void {
  switch (event.type) {
    case 'request/header': {
      const header = event.data['header'] as { system?: unknown } | undefined
      const system = header?.system
      collector.systemPrompt = typeof system === 'string' ? system : undefined
      return
    }
    case 'assistant/message':
      collector.finalText = messageText(event.data['message'])
      return
    case 'tool/call': {
      const raw = event.data['arguments']
      let args: unknown
      try {
        args = typeof raw === 'string' ? JSON.parse(raw) : raw
      } catch {
        // The model produced a non-JSON arguments string; the raw text is the
        // only faithful representation left, and the eval layer owns judging it.
        args = raw
      }
      collector.toolCalls.push({
        callId: String(event.data['callId'] ?? ''),
        name: String(event.data['name'] ?? ''),
        args,
        ok: false,
      })
      return
    }
    case 'tool/result': {
      // Wire shape (packages/llm/llm/src/message.ts): the tool-result message
      // is a user-role message whose content[0] is the single
      // `{ type: 'tool-result', toolCallId, isError }` block, and whose
      // `source.callId` is the message-level twin. The harness core invariant
      // requires the two to be equal and validates only content[0], so the
      // block is the primary read with `source.callId` as the fallback.
      const message = event.data['message'] as { content?: unknown; source?: unknown } | null | undefined
      const block = Array.isArray(message?.content)
        ? message.content[0] as { type?: unknown; toolCallId?: unknown; isError?: unknown } | null | undefined
        : undefined
      const callId = block !== null && block !== undefined && block['type'] === 'tool-result' && typeof block['toolCallId'] === 'string'
        ? block['toolCallId']
        : String((message?.source as { callId?: unknown } | null | undefined)?.callId ?? '')
      const call = collector.toolCalls.find(entry => entry.callId === callId && entry.settled === undefined)
      if (call !== undefined) {
        // ok = the call completed without failing: no event-level internal
        // failure identity (`error`), and the model-facing result block not
        // flagged `isError` (a scanner rejection or tool failure lands there).
        call.ok = event.data['error'] === undefined && block?.['isError'] !== true
        call.settled = true
      }
      return
    }
    default:
      // Chunks, step/turn boundaries, compaction records: not turn evidence.
      return
  }
}
