/**
 * In-process route-table fake LLM: an OpenAI-compatible chat-completions
 * endpoint over `node:http`, bound to 127.0.0.1 on a random port, zero
 * dependencies. This is the caller-supplied service behind the boot path's
 * `mode: 'external'` — the content-aware M2 fallback the suite design names
 * when the harness mock server's ordered-sequence behavior cannot route by
 * request content (eval/harness/llm-mock.ts header, MEASURED ROUTING ABILITY).
 *
 * Routing is by request-body content and is framing-independent: the routes
 * are consulted in order and the first route whose `match` accepts the raw
 * request body wins; otherwise the fixed `defaultReply` answers. Every
 * request that arrives is recorded verbatim (path + raw body) for assertions.
 * The reply is framed by the request's `accept` header: a client asking for
 * `text/event-stream` (the harness deepseek adapter always does — adapter.ts
 * sends `accept: text/event-stream` and its `parseSse` raises STREAM_CLOSED
 * at EOF without the `[DONE]` sentinel) receives a single-event
 * OpenAI-compatible SSE stream ending in `data: [DONE]`; every other client
 * (the eval judge's bare fetch) receives the plain JSON envelope
 * `choices[0].message.content`. Error replies stay JSON in both framings.
 *
 * The implementation is a pure handler plus a thin server shell — the handler
 * is exported for pure-function tests, the shell only owns sockets, the port,
 * and the capture array.
 *
 * @module eval/harness/fake-llm
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** Bearer key used when the caller does not supply one. */
export const DEFAULT_FAKE_LLM_API_KEY = 'eval-fake-key'

/** The only route the server serves; everything else is a 404. */
export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions'

/** One scripted response: the first route whose matcher accepts the raw body answers. */
export interface FakeRoute {
  /** Decide from the raw request-body text (the wire JSON, not a parsed object). */
  match: (requestBody: string) => boolean
  /** Verbatim `choices[0].message.content` of the reply. */
  reply: string
}

/** One captured request: verbatim path (with query, as received) and raw body. */
export interface FakeLlmRequestRecord {
  path: string
  body: string
}

/** A started fake LLM server this process owns. */
export interface FakeLlmServer {
  /** Base URL including the `/v1` namespace, e.g. `http://127.0.0.1:<port>/v1`. */
  readonly baseUrl: string
  /** Every request received so far, in arrival order. */
  readonly requests: ReadonlyArray<FakeLlmRequestRecord>
  /** Stop accepting requests and close idle keep-alive sockets; idempotent. */
  stop(): Promise<void>
}

/** Options for {@link startFakeLlmServer}. */
export interface StartFakeLlmServerOptions {
  /** Route table, consulted in order per request (default: empty). */
  routes?: FakeRoute[] | undefined
  /** Reply used when no route matches. */
  defaultReply: string
  /** Expected bearer key (default {@link DEFAULT_FAKE_LLM_API_KEY}). */
  apiKey?: string | undefined
}

/** Options for the pure handler; the same shape {@link startFakeLlmServer} takes. */
export interface FakeLlmHandlerOptions {
  routes?: readonly FakeRoute[] | undefined
  defaultReply: string
  apiKey?: string | undefined
}

/** The request slice the pure handler judges. */
export interface FakeLlmHttpRequest {
  method: string
  /** Raw request path as received, including any query string. */
  path: string
  body: string
  /** Raw `Authorization` header value, absent when the client sent none. */
  authorization?: string | undefined
  /** Raw `Accept` header value, absent when the client sent none. */
  accept?: string | undefined
}

/** The handler's verdict: an HTTP status, a content type, and a body to write back. */
export interface FakeLlmHttpResponse {
  status: number
  contentType: string
  body: string
}

/** OpenAI-shaped error envelope for the non-200 replies. */
function errorBody(message: string): string {
  return JSON.stringify({ error: { message, type: 'invalid_request_error' } })
}

/** The terminal SSE sentinel the harness adapter's parser requires before EOF. */
const SSE_DONE = 'data: [DONE]\n\n'

/**
 * Frame one reply as a single-event OpenAI-compatible SSE stream: one content
 * delta, then `[DONE]`. The reply rides inside `JSON.stringify`, so embedded
 * newlines can never break the event framing.
 */
function sseBody(reply: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n${SSE_DONE}`
}

/** Whether the client asked for an event stream (the harness adapter always does). */
function wantsEventStream(accept: string | undefined): boolean {
  return (accept ?? '').includes('text/event-stream')
}

/** Resolve the reply content for one parsed chat-completions body. */
function routeReply(requestBody: string, options: FakeLlmHandlerOptions): string {
  for (const route of options.routes ?? []) {
    if (route.match(requestBody)) return route.reply
  }
  return options.defaultReply
}

/**
 * Pure request handler: bearer-key gate, route table, accept-driven framing
 * (SSE for `text/event-stream` clients, JSON otherwise). No socket, no
 * capture — the server shell records and writes.
 */
export function handleFakeLlmRequest(request: FakeLlmHttpRequest, options: FakeLlmHandlerOptions): FakeLlmHttpResponse {
  const apiKey = options.apiKey ?? DEFAULT_FAKE_LLM_API_KEY
  if (request.authorization !== `Bearer ${apiKey}`) {
    return { status: 401, contentType: 'application/json', body: errorBody('invalid API key') }
  }
  // The path is matched without its query string; the capture keeps it verbatim.
  const pathname = request.path.split('?')[0] ?? request.path
  if (pathname !== CHAT_COMPLETIONS_PATH) {
    return { status: 404, contentType: 'application/json', body: errorBody(`unknown path ${JSON.stringify(pathname)}`) }
  }
  if (request.method !== 'POST') {
    return { status: 405, contentType: 'application/json', body: errorBody(`method ${JSON.stringify(request.method)} not allowed`) }
  }
  const reply = routeReply(request.body, options)
  if (wantsEventStream(request.accept)) {
    return { status: 200, contentType: 'text/event-stream', body: sseBody(reply) }
  }
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: reply } }] }),
  }
}

/**
 * Start the fake LLM server on 127.0.0.1 with a kernel-assigned port
 * (`listen(0)` — the port is read only after the listening callback, never
 * scanned). The options object is consulted per request, so mutating the
 * passed routes array (or the other fields) between requests re-scripts the
 * running server — the intended scripting seam for stateful test sequences.
 */
export async function startFakeLlmServer(options: StartFakeLlmServerOptions): Promise<FakeLlmServer> {
  const handlerOptions: FakeLlmHandlerOptions = {
    ...(options.routes !== undefined ? { routes: options.routes } : {}),
    defaultReply: options.defaultReply,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  }
  const requests: FakeLlmRequestRecord[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { raw += chunk })
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body: raw })
      const response = handleFakeLlmRequest(
        {
          method: req.method ?? '',
          path: req.url ?? '',
          body: raw,
          ...(req.headers['authorization'] !== undefined ? { authorization: req.headers['authorization'] } : {}),
          ...(req.headers['accept'] !== undefined ? { accept: req.headers['accept'] } : {}),
        },
        handlerOptions,
      )
      res.writeHead(response.status, { 'Content-Type': response.contentType })
      res.end(response.body)
    })
    req.on('error', () => {
      // The client aborted mid-body: there is no reply to deliver and nothing
      // to record — the request never completed.
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    // Unreachable for a TCP listener bound before this line; guarded for the
    // type, and loud if the runtime ever contradicts it.
    throw new Error('eval fake-llm: server address missing after listen')
  }
  const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`
  let stopped = false
  return {
    baseUrl,
    get requests(): ReadonlyArray<FakeLlmRequestRecord> {
      return requests
    },
    stop: async (): Promise<void> => {
      if (stopped) return
      stopped = true
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error !== undefined ? reject(error) : resolve()))
        // Idle keep-alive sockets would otherwise hold close() open until the
        // server's own keep-alive timeout; drop them so teardown is prompt.
        server.closeIdleConnections()
      })
    },
  }
}
