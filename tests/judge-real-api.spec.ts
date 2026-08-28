/**
 * Real-API integration test for the LLM dedup judge (§3.4).
 *
 * This test calls a real LLM API endpoint to verify the judge prompt produces
 * correct verdicts on cases the cheap prefilter cannot resolve — especially
 * CJK "same-template different-topic" pairs. It is gated behind environment
 * variables so it only runs when explicitly requested:
 *
 *   JUDGE_API_BASE=https://<your-openai-compatible-gateway>/v1
 *   JUDGE_API_KEY=<your-api-key>
 *   JUDGE_API_MODEL=<your-model-id>
 *
 * When any of these is absent, the suite is skipped (not failed).
 *
 * The test uses the standard OpenAI chat-completions API directly (not the
 * dsh-llm stream adapter) because a real dsh Cordis composition is not
 * available in the test environment. The judge prompt and verdict parser
 * are the same production code paths exported from dedup.ts.
 */

import { describe, it, expect } from 'vitest'
import { JUDGE_SYSTEM_PROMPT, buildJudgePrompt, parseJudgeVerdict, type JudgeVerdict } from '../src/review/dedup.ts'

const API_BASE = process.env.JUDGE_API_BASE ?? ''
const API_KEY = process.env.JUDGE_API_KEY ?? ''
const API_MODEL = process.env.JUDGE_API_MODEL ?? ''

const hasApi = API_BASE.length > 0 && API_KEY.length > 0 && API_MODEL.length > 0

/**
 * SSRF guard: the endpoint comes from an environment variable, so parse and
 * validate it into an explicit URL object before any request — absolute
 * http(s) only, host not loopback/private-range/metadata. The fetch below uses
 * this returned object, never the raw env string.
 */
function resolveEndpoint(base: string): URL {
  const url = new URL(base)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`JUDGE_API_BASE must be an http(s) URL, got protocol ${url.protocol}`)
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const blocked =
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') ||
    host === '0.0.0.0' || host === '::1' ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
  if (blocked) throw new Error(`JUDGE_API_BASE host "${host}" is loopback/private/metadata; refusing to fetch`)
  return url
}

/** Call the OpenAI-compatible chat-completions endpoint with the judge prompt. */
async function callJudge(existing: string, candidate: string): Promise<JudgeVerdict> {
  const endpoint = resolveEndpoint(API_BASE)
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/chat/completions'
  const prompt = buildJudgePrompt(existing, candidate)
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: API_MODEL,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 200,
    }),
  })
  if (!res.ok) throw new Error(`API returned ${res.status}: ${await res.text()}`)
  const data = await res.json() as { choices: { message: { content: string } }[] }
  const content = data.choices[0]?.message?.content ?? ''
  return parseJudgeVerdict(content)
}

describe.skipIf(!hasApi)('LLM judge — real API integration (§3.4)', () => {
  // Allow generous timeout for real API calls.
  it('returns "new" for same-template different-topic CJK pair', async () => {
    const verdict = await callJudge('这个项目使用pnpm', '这个项目使用vitest')
    expect(verdict).toBe('new')
  }, 30000)

  it('returns "new" for same-template different-topic English pair', async () => {
    const verdict = await callJudge('This repo uses pnpm', 'This repo uses vitest')
    expect(verdict).toBe('new')
  }, 30000)

  it('returns "duplicate" for same-fact different-wording CJK pair', async () => {
    const verdict = await callJudge('用户偏好简洁的回答', '用户喜欢简短的回答')
    expect(verdict).toBe('duplicate')
  }, 30000)

  it('returns "duplicate" for same-fact different-wording English pair', async () => {
    const verdict = await callJudge('The user prefers concise answers', 'User likes short responses')
    expect(verdict).toBe('duplicate')
  }, 30000)

  it('returns "update" for a more precise version of the same fact', async () => {
    const verdict = await callJudge('use pnpm here', 'use pnpm v9 here')
    expect(verdict).toBe('update')
  }, 30000)

  it('returns "update" for a CJK correction', async () => {
    const verdict = await callJudge('构建失败在Node18上', '构建失败在Node16上，不是Node18')
    expect(verdict).toBe('update')
  }, 30000)
})
