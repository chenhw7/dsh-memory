/**
 * Unit coverage for the eval fake LLM (eval/harness/fake-llm.ts): the pure
 * request handler (route table, bearer gate, reply envelope) and the server
 * shell (loopback random port, verbatim capture, quiescent teardown).
 *
 * Teardown follows dsh-ci-test-reliability: every started server is
 * registered for `afterEach` stop immediately after acquisition, so an
 * assertion failure cannot leak a listener across the lane.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  CHAT_COMPLETIONS_PATH,
  DEFAULT_FAKE_LLM_API_KEY,
  handleFakeLlmRequest,
  startFakeLlmServer,
  type FakeLlmServer,
  type StartFakeLlmServerOptions,
} from '../eval/harness/fake-llm.ts'

/** Servers started by the current case; stopped in afterEach even on failure. */
const running: FakeLlmServer[] = []

async function start(options: StartFakeLlmServerOptions): Promise<FakeLlmServer> {
  const server = await startFakeLlmServer(options)
  running.push(server)
  return server
}

afterEach(async () => {
  for (const server of running.splice(0)) {
    await server.stop()
  }
})

describe('fake llm pure handler', () => {
  const request = {
    method: 'POST',
    path: CHAT_COMPLETIONS_PATH,
    body: '{"model":"m","messages":[]}',
    authorization: `Bearer ${DEFAULT_FAKE_LLM_API_KEY}`,
  }

  it('answers the minimal OpenAI envelope with the default reply', () => {
    const response = handleFakeLlmRequest(request, { defaultReply: 'fallback text' })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ choices: [{ message: { content: 'fallback text' } }] })
  })

  it('answers with the first route whose matcher accepts the raw body', () => {
    const response = handleFakeLlmRequest(request, {
      routes: [
        { match: body => body.includes('"m"'), reply: 'first' },
        { match: () => true, reply: 'second' },
      ],
      defaultReply: 'fallback text',
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).choices[0].message.content).toBe('first')
  })

  it('falls back to the default reply when no route matches', () => {
    const response = handleFakeLlmRequest(request, {
      routes: [{ match: body => body.includes('absent-marker'), reply: 'routed' }],
      defaultReply: 'fallback text',
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).choices[0].message.content).toBe('fallback text')
  })

  it('rejects a wrong bearer key and a missing header with 401', () => {
    expect(handleFakeLlmRequest({ ...request, authorization: 'Bearer wrong' }, { defaultReply: 'x' }).status).toBe(401)
    expect(handleFakeLlmRequest({ ...request, authorization: `bearer ${DEFAULT_FAKE_LLM_API_KEY}` }, { defaultReply: 'x' }).status).toBe(401)
    expect(handleFakeLlmRequest({ ...request, authorization: undefined }, { defaultReply: 'x' }).status).toBe(401)
  })

  it('accepts the caller-supplied key', () => {
    const response = handleFakeLlmRequest(
      { ...request, authorization: 'Bearer secret-key' },
      { defaultReply: 'x', apiKey: 'secret-key' },
    )
    expect(response.status).toBe(200)
  })

  it('returns 404 for unknown paths (query string ignored) and 405 for wrong methods', () => {
    expect(handleFakeLlmRequest({ ...request, path: '/v1/other' }, { defaultReply: 'x' }).status).toBe(404)
    expect(handleFakeLlmRequest({ ...request, path: `${CHAT_COMPLETIONS_PATH}?api-version=x` }, { defaultReply: 'x' }).status).toBe(200)
    expect(handleFakeLlmRequest({ ...request, method: 'GET' }, { defaultReply: 'x' }).status).toBe(405)
  })

  it('frames the reply as a single-event SSE stream when the client accepts text/event-stream', () => {
    const response = handleFakeLlmRequest(
      { ...request, accept: 'text/event-stream' },
      { defaultReply: 'streamed reply' },
    )
    expect(response.status).toBe(200)
    expect(response.contentType).toBe('text/event-stream')
    expect(response.body).toBe('data: {"choices":[{"delta":{"content":"streamed reply"}}]}\n\ndata: [DONE]\n\n')
  })

  it('applies the route table in SSE framing and keeps error replies JSON', () => {
    const options = {
      routes: [{ match: (body: string) => body.includes('"m"'), reply: 'routed reply' }],
      defaultReply: 'fallback text',
    }
    const routed = handleFakeLlmRequest({ ...request, accept: 'text/event-stream' }, options)
    const firstFrame = routed.body.split('\n\n')[0] ?? ''
    expect(JSON.parse(firstFrame.replace(/^data: /, ''))).toEqual({ choices: [{ delta: { content: 'routed reply' } }] })
    const unauthorized = handleFakeLlmRequest({ ...request, accept: 'text/event-stream', authorization: 'Bearer wrong' }, options)
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.contentType).toBe('application/json')
    expect(JSON.parse(unauthorized.body).error.message).toBe('invalid API key')
  })
})

describe('fake llm server shell', () => {
  it('binds loopback on a kernel-assigned port with the /v1 namespace', async () => {
    const server = await start({ defaultReply: 'x' })
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  })

  it('serves the default reply and records every request verbatim', async () => {
    const server = await start({ defaultReply: 'fallback text' })
    const body = '{"model":"fake","messages":[{"role":"user","content":"你好"}]}'
    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEFAULT_FAKE_LLM_API_KEY}` },
      body,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ choices: [{ message: { content: 'fallback text' } }] })
    expect(server.requests).toEqual([{ path: '/v1/chat/completions', body }])
  })

  it('frames SSE replies end to end when the client accepts text/event-stream', async () => {
    const server = await start({ defaultReply: 'streamed reply' })
    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEFAULT_FAKE_LLM_API_KEY}`, Accept: 'text/event-stream' },
      body: '{"model":"fake","stream":true,"messages":[]}',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toBe('data: {"choices":[{"delta":{"content":"streamed reply"}}]}\n\ndata: [DONE]\n\n')
    expect(server.requests[0]?.body).toBe('{"model":"fake","stream":true,"messages":[]}')
  })

  it('routes by request-body content and keeps the capture in arrival order', async () => {
    const server = await start({
      routes: [{ match: body => body.includes('storage-marker'), reply: 'storage verdict' }],
      defaultReply: 'fallback text',
    })
    const call = (content: string): Promise<Response> => fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEFAULT_FAKE_LLM_API_KEY}` },
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    })
    expect(JSON.parse(await (await call('with storage-marker')).text()).choices[0].message.content).toBe('storage verdict')
    expect(JSON.parse(await (await call('unmatched')).text()).choices[0].message.content).toBe('fallback text')
    expect(server.requests.map(record => JSON.parse(record.body).messages[0].content)).toEqual([
      'with storage-marker',
      'unmatched',
    ])
  })

  it('enforces the bearer key over the wire', async () => {
    const server = await start({ defaultReply: 'x', apiKey: 'secret-key' })
    const reply = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-key' },
      body: '{}',
    })
    expect(reply.status).toBe(401)
    expect(server.requests).toHaveLength(1)
  })

  it('survives a client abort and keeps serving', async () => {
    const server = await start({ defaultReply: 'x' })
    const aborter = new AbortController()
    const aborted = fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEFAULT_FAKE_LLM_API_KEY}` },
      body: '{"partial":',
      signal: aborter.signal,
    }).then(
      () => 'completed',
      () => 'aborted',
    )
    aborter.abort()
    expect(await aborted).toBe('aborted')
    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEFAULT_FAKE_LLM_API_KEY}` },
      body: '{"ok":true}',
    })
    expect(response.status).toBe(200)
    expect(server.requests.at(-1)?.body).toBe('{"ok":true}')
  })

  it('stops to quiescence and is idempotent', async () => {
    const server = await start({ defaultReply: 'x' })
    const baseUrl = server.baseUrl
    await server.stop()
    await server.stop()
    await expect(fetch(`${baseUrl}/chat/completions`, { method: 'POST', body: '{}' })).rejects.toThrow()
  })
})
