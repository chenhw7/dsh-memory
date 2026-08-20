/**
 * Real-API integration test for the LLM dedup judge (§3.4).
 *
 * This test calls a real LLM API endpoint to verify the judge prompt produces
 * correct verdicts on cases the cheap prefilter cannot resolve — especially
 * CJK "same-template different-topic" pairs. It is gated behind environment
 * variables so it only runs when explicitly requested:
 *
 *   JUDGE_API_BASE=https://REDACTED/v1
 *   JUDGE_API_KEY=REDACTED
 *   JUDGE_API_MODEL=fuyao-coding-exp
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

/** Call the OpenAI-compatible chat-completions endpoint with the judge prompt. */
async function callJudge(existing: string, candidate: string): Promise<JudgeVerdict> {
  const prompt = buildJudgePrompt(existing, candidate)
  const res = await fetch(`${API_BASE}/chat/completions`, {
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
