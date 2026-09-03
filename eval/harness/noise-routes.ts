/**
 * Deterministic content-routed fake-LLM routes for the noise slice's
 * extraction-chain evidence run (the proposal's step 7: the harness mock
 * routes by request order, not content, so it cannot test "does extraction
 * find a fact buried mid-way through a noisy turn" — see
 * eval/harness/llm-mock.ts, MEASURED ROUTING ABILITY).
 *
 * One in-process fake-LLM server stands behind the whole run (external
 * mode): the conversational SUT turns, the periodic-review extraction and
 * the dispose flush all hit it, and the route table decides per request.
 * Routes are consulted in order and the first match wins
 * (eval/harness/fake-llm.ts):
 *
 * WHY THE REVIEW PATH, NOT THE DISPOSE FLUSH: measured 2026-09-03 against
 * the installed harness (SDK stdio path) — on `shutdown` the server emits
 * `session/disposed` and hard-exits ~26 ms later (`process.exit(0)` right
 * after the root-fiber dispose that closes the store); the harness invokes
 * dispose listeners fire-and-forget and owes them no milliseconds. The
 * plugin's dispose flush is itself fire-and-forget, and its LLM round-trip
 * plus store write lands inside that window only by luck — the write is
 * not guaranteed to settle before the child dies. The eval therefore drives
 * the automatic extraction chain through the PERIODIC REVIEW instead: the
 * noise lane pins `reviewCandidateThreshold: 1` (eval/runner.ts
 * noisyReviewPatch) and every marker turn carries an explicit memory
 * keyword (the accumulator's candidate trigger, linted by
 * tests/eval-noise-dataset.spec.ts), so the review fires on the next
 * pre-step — mid-session 1, where the process lives for seconds and the
 * write is guaranteed to settle before session 2's snapshot freezes.
 *
 * 1. DISPOSE FLUSH, per scenario — the body carries the flush system
 *    prompt AND the scenario's marker: EMPTY reply. If the flush's
 *    round-trip ever wins the exit race, an empty reply parses to zero
 *    entries, so it can never write a second copy of the planted set.
 * 2. REVIEW EXTRACTION, per scenario — the body carries the review system
 *    prompt AND the scenario's marker: reply with that scenario's
 *    author-pinned extraction lines (the oracle extraction: exactly the
 *    planted facts, clean, in the parse protocol's `scope: [category]
 *    [summary:…] content` lines). The lines come from the pilot fixture
 *    (eval/datasets/noise-v0.pilot.json) and are linted against the corpus
 *    by tests/eval-noise-dataset.spec.ts (markers live in the keyword
 *    turns, anchors survive, scope/category match the pins).
 * 3. DEDUP JUDGE — the body carries the dedup-judge system prompt: reply
 *    `duplicate`, the fail-closed safe verdict — a prefilter hit merges
 *    into the existing entry instead of creating a parallel one.
 *    Unreachable in this lane (the review writes against an empty store),
 *    kept as the safe default if the lane ever gains a second writer.
 * 4. CONVERSATIONAL TURN, per scenario — the body carries the scenario's
 *    marker: reply with that scenario's scripted chat answer.
 * 5. DEFAULT — a fixed generic acknowledgement.
 *
 * The marker/prompt strings are coupled to src/review (the extraction and
 * dedup system prompts, src/review/extract.ts / src/review/dedup.ts); a
 * prompt rewording stops the matching route and the evidence run then
 * writes nothing, which the pilot's entryCount > 0 gate fails loud on.
 *
 * @module eval/harness/noise-routes
 */

import type { FakeRoute } from './fake-llm.ts'

/** Leading clause of FLUSH_SYSTEM_PROMPT (src/review/extract.ts). */
export const FLUSH_PROMPT_MARKER = 'The session is being compressed'

/** Leading clause of REVIEW_SYSTEM_PROMPT (src/review/extract.ts). */
export const REVIEW_PROMPT_MARKER = 'You are a memory extraction assistant'

/** Leading clause of JUDGE_SYSTEM_PROMPT (src/review/dedup.ts). */
export const DEDUP_JUDGE_PROMPT_MARKER = 'You are a memory dedup judge'

/** The dedup verdict that merges into the existing entry (src/review/dedup.ts protocol). */
const DEDUP_JUDGE_REPLY_DUPLICATE = 'duplicate'

/** An extraction reply that parses to zero entries (the flush lane's safe no-op). */
const EMPTY_EXTRACTION_REPLY = ''

/**
 * One author-pinned extraction line: what the oracle extraction writes for
 * one planted fact of one noisy scenario. The line is rendered into the
 * extraction parse protocol (`scope: [category] [summary:…] content`) by
 * {@link extractionLineReply}.
 */
export interface NoiseExtractionLine {
  readonly factId: string
  readonly scope: 'global' | 'project' | 'user'
  readonly category: string
  /** Index-line summary (the ≤80-char budget the renderer applies). */
  readonly summary: string
  /** The clean entry content (the extraction's output, not the noisy turn). */
  readonly content: string
}

/** The per-scenario fake-LLM script: marker, chat reply, extraction lines. */
export interface NoiseRouteScript {
  readonly scenarioId: string
  /** Distinctive substring of one of the scenario's user turns (route key). */
  readonly marker: string
  /** Scripted SUT answer for the scenario's conversational turns. */
  readonly chatReply: string
  readonly extraction: readonly NoiseExtractionLine[]
}

/** A started route table: the routes plus the default reply for no match. */
export interface NoiseRouteTable {
  readonly routes: readonly FakeRoute[]
  readonly defaultReply: string
}

/**
 * Render one extraction line into the parse protocol
 * (src/review/extract.ts `parseExtractedMemories`):
 * `scope: [category] [summary:…] content`.
 */
export function extractionLineReply(line: NoiseExtractionLine): string {
  return `${line.scope}: [${line.category}] [summary:${line.summary}] ${line.content}`
}

/**
 * Build the ordered route table for one noise-slice evidence run from the
 * fixture's per-scenario scripts. The review routes are the extraction lane
 * (see the module header for the dispose-flush race they replace); marker
 * uniqueness is the lint's job (tests/eval-noise-dataset.spec.ts) — a
 * colliding marker would simply make two scenarios share one extraction
 * reply, which the anchor-matchability gate would flag.
 */
export function buildNoiseRoutes(scripts: readonly NoiseRouteScript[]): NoiseRouteTable {
  const routes: FakeRoute[] = []
  for (const script of scripts) {
    // Most specific first: the flush prompt marker AND the scenario marker —
    // and the reply is the safe no-op (the dispose flush must never write).
    routes.push({
      match: body => body.includes(FLUSH_PROMPT_MARKER) && body.includes(script.marker),
      reply: EMPTY_EXTRACTION_REPLY,
    })
    // The review prompt marker AND the scenario marker: the oracle extraction.
    routes.push({
      match: body => body.includes(REVIEW_PROMPT_MARKER) && body.includes(script.marker),
      reply: script.extraction.map(extractionLineReply).join('\n'),
    })
  }
  routes.push({
    match: body => body.includes(DEDUP_JUDGE_PROMPT_MARKER),
    reply: DEDUP_JUDGE_REPLY_DUPLICATE,
  })
  for (const script of scripts) {
    routes.push({ match: body => body.includes(script.marker), reply: script.chatReply })
  }
  return {
    routes,
    defaultReply: '收到，我先看一下，稍后给你结论。',
  }
}
