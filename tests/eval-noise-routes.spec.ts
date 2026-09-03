/**
 * The noise slice's content-routed fake-LLM table (eval/harness/noise-routes.ts):
 * most-specific-first ordering, the extraction-line protocol rendering, the
 * per-scenario reply routing, and the default acknowledgement — driven through
 * the pure handler (eval/harness/fake-llm.ts), no sockets.
 */
import { describe, expect, it } from 'vitest'
import { handleFakeLlmRequest } from '../eval/harness/fake-llm.ts'
import {
  buildNoiseRoutes,
  DEDUP_JUDGE_PROMPT_MARKER,
  extractionLineReply,
  FLUSH_PROMPT_MARKER,
  REVIEW_PROMPT_MARKER,
  type NoiseRouteScript,
} from '../eval/harness/noise-routes.ts'

const SCRIPTS: NoiseRouteScript[] = [
  {
    scenarioId: 'n1',
    marker: 'marker-a',
    chatReply: 'reply-a',
    extraction: [
      { factId: 'f1', scope: 'global', category: 'convention', summary: 'sum-1', content: 'content-1' },
      { factId: 'f2', scope: 'user', category: 'preference', summary: 'sum-2', content: 'content-2' },
    ],
  },
  {
    scenarioId: 'n2',
    marker: 'marker-b',
    chatReply: 'reply-b',
    extraction: [
      { factId: 'f3', scope: 'project', category: 'tool-quirk', summary: 'sum-3', content: 'content-3' },
    ],
  },
]

const TABLE = buildNoiseRoutes(SCRIPTS)

/** One plain-JSON chat-completions request through the pure handler. */
function replyFor(body: string): string {
  const response = handleFakeLlmRequest(
    { method: 'POST', path: '/v1/chat/completions', body, authorization: 'Bearer eval-fake-key' },
    { routes: TABLE.routes, defaultReply: TABLE.defaultReply },
  )
  expect(response.status).toBe(200)
  const parsed = JSON.parse(response.body) as { choices: Array<{ message: { content: string } }> }
  return parsed.choices[0]!.message.content
}

describe('extraction line protocol', () => {
  it('renders one line as `scope: [category] [summary:…] content` (parseExtractedMemories input)', () => {
    expect(extractionLineReply(SCRIPTS[0]!.extraction[0]!)).toBe('global: [convention] [summary:sum-1] content-1')
  })
})

describe('route table shape', () => {
  it('orders per-scenario flush+review routes first, then dedup, chat routes; one default reply', () => {
    // 2 scenarios: 2 flush routes + 2 review routes + dedup + 2 chat routes.
    expect(TABLE.routes).toHaveLength(7)
    expect(TABLE.defaultReply).toBe('收到，我先看一下，稍后给你结论。')
    // The flush routes are the most specific (flush prompt AND scenario marker).
    expect(TABLE.routes[0]!.match(`{${JSON.stringify(FLUSH_PROMPT_MARKER)} ${JSON.stringify('marker-a')}}`)).toBe(true)
    expect(TABLE.routes[0]!.match(JSON.stringify('marker-a'))).toBe(false)
  })
})

describe('route selection (first match wins)', () => {
  it('the dispose flush gets the safe no-op — even with the scenario marker (the flush must never write)', () => {
    const body = JSON.stringify({ messages: [{ content: `${FLUSH_PROMPT_MARKER} … ${'marker-a'} …` }] })
    expect(replyFor(body)).toBe('')
  })

  it('a review prompt carrying the scenario marker gets that scenario\'s extraction lines, joined', () => {
    const body = JSON.stringify({ messages: [{ content: `${REVIEW_PROMPT_MARKER} … ${'marker-a'} …` }] })
    expect(replyFor(body)).toBe('global: [convention] [summary:sum-1] content-1\nuser: [preference] [summary:sum-2] content-2')
  })

  it('the review reply is per scenario: the other marker gets its own lines', () => {
    const body = JSON.stringify({ messages: [{ content: `${REVIEW_PROMPT_MARKER} … ${'marker-b'} …` }] })
    expect(replyFor(body)).toBe('project: [tool-quirk] [summary:sum-3] content-3')
  })

  it('a review prompt WITHOUT a scenario marker falls through to the default reply (still zero entries on parse)', () => {
    expect(replyFor(JSON.stringify({ content: REVIEW_PROMPT_MARKER }))).toBe(TABLE.defaultReply)
  })

  it('the dedup judge answers `duplicate` (fail-closed safe) — even when a scenario marker is also present', () => {
    const body = JSON.stringify({ messages: [{ content: `${DEDUP_JUDGE_PROMPT_MARKER} … ${'marker-a'} …` }] })
    expect(replyFor(body)).toBe('duplicate')
  })

  it('a conversational turn carrying the scenario marker gets its scripted chat reply', () => {
    expect(replyFor(JSON.stringify({ messages: [{ content: `请看一下 ${'marker-b'}` }] }))).toBe('reply-b')
  })

  it('an unmatched body gets the default acknowledgement', () => {
    expect(replyFor(JSON.stringify({ messages: [{ content: '无关内容' }] }))).toBe(TABLE.defaultReply)
  })
})
