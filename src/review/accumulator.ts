/**
 * The periodic-review projection accumulator: a pure, synchronous fold over
 * `user/message` events (keyword/correction signals) and `tool/result` events
 * (tool-call failures) that collects candidate memory fragments. No LLM runs
 * here — the {@link agent/pre-step} listener drains the accumulator once it
 * reaches the configured threshold and runs one extraction call.
 *
 * @module @chenhw7/dsh-memory/review/accumulator
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The projection key this unit owns in the {@link SessionProjectionMap}. */
export const MEMORY_REVIEW_PROJECTION_KEY = 'memory-review-candidates'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Accumulated candidate memory fragments awaiting LLM extraction. */
    'memory-review-candidates': AccumulatorView
  }
}

/** One candidate fragment collected by the accumulator. */
export interface MemoryCandidate {
  /** The text fragment that matched a signal. */
  readonly text: string
  /** Which signal class matched (`keyword`, `correction`, or `tool-failure`). */
  readonly signal: string
  /** Seq of the session event the fragment came from. */
  readonly seq: number
}

/** Internal accumulator state (plain JSON per the projection contract). */
export interface AccumulatorState {
  /** Collected candidate fragments, in collection order. */
  readonly candidates: readonly MemoryCandidate[]
  /** Number of candidates collected so far (a derived length, cached for the threshold check). */
  readonly count: number
}

/** The wire payload (read-side projection) is the accumulator state itself. */
export type AccumulatorView = AccumulatorState

/** Keyword hits in user messages: explicit instruction to remember. */
const KEYWORD_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'keyword', re: /记住/ },
  { name: 'keyword', re: /别忘了/ },
  { name: 'keyword', re: /以后都/ },
  { name: 'keyword', re: /remember\s+that/i },
  { name: 'keyword', re: /don'?t\s+forget/i },
  { name: 'keyword', re: /from\s+now\s+on/i },
]

/** Correction signals in user messages: the user revises a prior statement. */
const CORRECTION_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'correction', re: /不对/ },
  { name: 'correction', re: /不要/ },
  { name: 'correction', re: /no,?\s+i\s+said/i },
  { name: 'correction', re: /that'?s\s+wrong/i },
  { name: 'correction', re: /actually/i },
]

/** The empty-log state for the accumulator. */
export const emptyAccumulator: AccumulatorState = { candidates: [], count: 0 }

/**
 * Extract plain text from a message event's content blocks.
 * @param event - a `user/message` or `assistant/message` session event.
 * @returns the concatenated text, or `undefined` when the event carries no text.
 */
export function messageText(event: SessionEvent): string | undefined {
  let content: readonly { readonly type: string; readonly text?: string }[] | undefined
  if (event.type === 'user/message') {
    content = event.data.content
  } else if (event.type === 'assistant/message') {
    content = event.data.message.content
  } else {
    return undefined
  }
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * Detect the first matching signal in a user message. Keyword hits take
 * priority over correction signals when both match.
 * @param text - the message text to scan.
 * @returns the matching signal name, or `undefined` when no rule fires.
 */
export function detectSignal(text: string): string | undefined {
  for (const { name, re } of KEYWORD_PATTERNS) {
    if (re.test(text)) return name
  }
  for (const { name, re } of CORRECTION_PATTERNS) {
    if (re.test(text)) return name
  }
  return undefined
}

/**
 * Extract a failure fragment from a `tool/result` event that carries an error.
 * @param event - a `tool/result` session event.
 * @returns the failure description text, or `undefined` when the event has no error.
 */
export function toolFailureText(event: SessionEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const data = event.data as { error?: { name: string; code: string }; message?: { content?: { type: string; text?: string }[] } }
  if (data.error === undefined) return undefined
  // Extract text from the result content if available, plus the error code.
  const parts: string[] = []
  const content = data.message?.content
  if (content !== undefined) {
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  const errorInfo = `tool error: ${data.error.name} (${data.error.code})`
  return parts.length > 0 ? `${errorInfo} — ${parts.join(' ')}` : errorInfo
}

/**
 * The projection's `apply` transition: fold one committed event into the
 * accumulator. Returns the SAME state reference for events that do not
 * contribute a candidate (the registry's `Object.is` gate).
 *
 * Signal sources:
 * - `user/message` — keyword hits (explicit "remember" intent) and corrections
 *   (user revises a prior statement).
 * - `tool/result` — tool-call failures (§3.6 richer signals): a failed tool
 *   execution may carry a durable workaround worth remembering.
 *
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state (same reference when the event contributes nothing).
 */
export function applyAccumulator(state: AccumulatorState, event: SessionEvent): AccumulatorState {
  if (event.type === 'user/message') {
    const text = messageText(event)
    if (text === undefined) return state
    const signal = detectSignal(text)
    if (signal === undefined) return state
    const candidate: MemoryCandidate = { text, signal, seq: event.seq }
    return { candidates: [...state.candidates, candidate], count: state.count + 1 }
  }
  if (event.type === 'tool/result') {
    const text = toolFailureText(event)
    if (text === undefined) return state
    const candidate: MemoryCandidate = { text, signal: 'tool-failure', seq: event.seq }
    return { candidates: [...state.candidates, candidate], count: state.count + 1 }
  }
  return state
}

/** Zod schema for the accumulator's wire payload. */
export const accumulatorSchema: ZodType<AccumulatorView> = zod.object({
  candidates: zod.array(zod.object({
    text: zod.string(),
    signal: zod.string(),
    seq: zod.number(),
  })),
  count: zod.number(),
})
