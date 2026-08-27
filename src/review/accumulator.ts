/**
 * The periodic-review projection accumulator: a pure, synchronous fold over
 * session events that collects candidate memory fragments. No LLM runs here —
 * the {@link agent/pre-step} listener drains the accumulator once it reaches
 * the configured threshold and runs one extraction call.
 *
 * Signal sources (§5 of docs/PROJECT_NOTES.zh-CN.md):
 * - `user/message` — keyword hits (explicit "remember" intent) and corrections
 *   (the user revises a prior statement).
 * - `tool/call` + `tool/result` — **failure-streak pairing**: consecutive
 *   same-signature tool failures followed by a success emit one
 *   `pitfall-resolved` candidate (the workaround is verified by the success).
 *   One-shot failures no longer become candidates; the compaction/dispose
 *   flush still sees full events as the safety net.
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

/** The signal emitted when a failure streak is resolved by a success. */
export const PITFALL_RESOLVED_SIGNAL = 'pitfall-resolved'

/** One candidate fragment collected by the accumulator. */
export interface MemoryCandidate {
  /** The text fragment that matched a signal. */
  readonly text: string
  /** Which signal class matched (`keyword`, `correction`, or `pitfall-resolved`). */
  readonly signal: string
  /** Seq of the session event the fragment came from. */
  readonly seq: number
}

/** A registered tool call awaiting its result, keyed by callId. */
export interface OpenCall {
  /** The invoked tool's name. */
  readonly name: string
  /** The normalized signature (toolName + normalized primary argument). */
  readonly signature: string
  /** Seq of the `tool/call` event. */
  readonly seq: number
}

/** One open failure streak for a signature. */
export interface OpenStreak {
  /** Consecutive failure count so far. */
  readonly count: number
  /** Truncated description of the most recent failure (error identity + text). */
  readonly lastErrorText: string
  /** Seq of the first failure in the streak. */
  readonly firstSeq: number
  /** Seq of the most recent failure (drives LRU eviction). */
  readonly lastSeq: number
}

/** Internal accumulator state (plain JSON per the projection contract). */
export interface AccumulatorState {
  /** Collected candidate fragments, in collection order. */
  readonly candidates: readonly MemoryCandidate[]
  /** Number of candidates collected so far (a derived length, cached for the threshold check). */
  readonly count: number
  /** Tool calls awaiting their results, keyed by callId (capped). */
  readonly openCalls: Record<string, OpenCall>
  /** Open failure streaks, keyed by signature (capped, LRU-evicted). */
  readonly openStreaks: Record<string, OpenStreak>
}

/** The wire payload (read-side projection) is the accumulator state itself. */
export type AccumulatorView = AccumulatorState

/**
 * Keyword hits in user messages: explicit instruction to remember. The
 * collection layer only widens the funnel — admission conservatism (explicit
 * demand or repeated theme) is enforced by the extraction prompt, so a
 * missed pattern here is free loss while a false hit is cheap.
 */
const KEYWORD_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  // Chinese explicit-remember intents.
  { name: 'keyword', re: /记住/ },
  { name: 'keyword', re: /别忘了/ },
  { name: 'keyword', re: /以后都/ },
  { name: 'keyword', re: /记下来/ },
  { name: 'keyword', re: /记一下/ },
  { name: 'keyword', re: /帮我记/ },
  // English explicit-remember intents.
  { name: 'keyword', re: /remember\s+that/i },
  { name: 'keyword', re: /don'?t\s+forget/i },
  { name: 'keyword', re: /from\s+now\s+on/i },
  { name: 'keyword', re: /keep\s+in\s+mind/i },
  { name: 'keyword', re: /make\s+a\s+note/i },
  { name: 'keyword', re: /for\s+the\s+record/i },
]

/**
 * Correction signals in user messages: the user revises a prior statement.
 * Same funnel philosophy as the keyword patterns above.
 */
const CORRECTION_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  // Chinese revisions of a prior statement.
  { name: 'correction', re: /不对/ },
  { name: 'correction', re: /不要/ },
  { name: 'correction', re: /其实是?/ },
  { name: 'correction', re: /应该是/ },
  { name: 'correction', re: /搞错了/ },
  { name: 'correction', re: /说错了/ },
  // English revisions of a prior statement.
  { name: 'correction', re: /no,?\s+i\s+said/i },
  { name: 'correction', re: /that'?s\s+wrong/i },
  { name: 'correction', re: /actually/i },
  { name: 'correction', re: /i\s+meant/i },
  { name: 'correction', re: /no,?\s+it'?s/i },
]

/** Cap on concurrently open tool calls retained in the projection state. */
const OPEN_CALLS_CAP = 64
/** Cap on concurrently tracked failure streaks (LRU-evicted). */
const OPEN_STREAKS_CAP = 8
/** Maximum length of one normalized signature. */
const SIGNATURE_LIMIT = 120
/** Maximum length of the stored per-streak error text. */
const STREAK_ERROR_TEXT_LIMIT = 500

/** The empty-log state for the accumulator. */
export const emptyAccumulator: AccumulatorState = { candidates: [], count: 0, openCalls: {}, openStreaks: {} }

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
 * Argument keys that carry the "primary target" of a tool call, used to
 * specialize a signature: `command`-style keys collapse to the first two
 * tokens; path-style keys use the path value verbatim.
 */
const COMMAND_KEYS: readonly string[] = ['command', 'cmd']
const PATH_KEYS: readonly string[] = ['path', 'file', 'filePath', 'file_path', 'targetFile', 'target_file']

/**
 * Normalize a tool invocation into a failure-streak signature:
 * `toolName:argument-key`. Shell-like `command` arguments collapse to the
 * first two tokens (`npm test`, `pnpm build`); path-like arguments use the
 * path; everything else falls back to the bare tool name. Unparsable
 * argument JSON also falls back to the bare tool name.
 * @param name - the invoked tool's name.
 * @param argumentsJson - the raw arguments JSON string from the `tool/call` event.
 * @returns the normalized signature (≤ {@link SIGNATURE_LIMIT} chars).
 */
export function toolSignature(name: string, argumentsJson: string): string {
  let signature = name
  try {
    const args: unknown = JSON.parse(argumentsJson)
    if (args !== null && typeof args === 'object') {
      const record = args as Record<string, unknown>
      for (const key of COMMAND_KEYS) {
        const value = record[key]
        if (typeof value === 'string' && value.trim().length > 0) {
          const tokens = value.trim().split(/\s+/).slice(0, 2).join(' ')
          signature = `${name}:${tokens}`
          return signature.slice(0, SIGNATURE_LIMIT)
        }
      }
      for (const key of PATH_KEYS) {
        const value = record[key]
        if (typeof value === 'string' && value.trim().length > 0) {
          signature = `${name}:${value.trim()}`
          return signature.slice(0, SIGNATURE_LIMIT)
        }
      }
    }
  } catch {
    // Unparsable arguments fall back to the bare tool name.
  }
  return signature.slice(0, SIGNATURE_LIMIT)
}

/**
 * Extract a truncated failure description from a `tool/result` event that
 * carries an error: the error identity plus the result's text blocks (nested
 * inside each `tool-result` block's `content`).
 * @param event - a `tool/result` session event with `data.error` present.
 * @returns the failure description text (≤ {@link STREAK_ERROR_TEXT_LIMIT} chars).
 */
function failureDescription(event: SessionEvent<'tool/result'>): string {
  const data = event.data
  const parts: string[] = []
  for (const block of data.message?.content ?? []) {
    if (block.type !== 'tool-result') continue
    for (const inner of block.content) {
      if (inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
    }
  }
  const errorInfo = `tool error: ${data.error!.name} (${data.error!.code})`
  const text = parts.length > 0 ? `${errorInfo} — ${parts.join(' ')}` : errorInfo
  return text.slice(0, STREAK_ERROR_TEXT_LIMIT)
}

/** Evict the oldest entries of a plain-JSON record by a numeric seq accessor, in-place. */
function evictToCap<T>(record: Record<string, T>, cap: number, seqOf: (value: T) => number): void {
  const keys = Object.keys(record)
  if (keys.length <= cap) return
  const sorted = [...keys].sort((a, b) => seqOf(record[a]!) - seqOf(record[b]!))
  for (const key of sorted.slice(0, keys.length - cap)) {
    delete record[key]
  }
}

/**
 * The projection's `apply` transition: fold one committed event into the
 * accumulator. Returns the SAME state reference for events that do not
 * contribute any change (the registry's `Object.is` gate).
 *
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @param pitfallThreshold - consecutive same-signature failures required
 *   before a following success emits a `pitfall-resolved` candidate.
 * @returns the next state (same reference when the event changes nothing).
 */
export function applyAccumulator(state: AccumulatorState, event: SessionEvent, pitfallThreshold = 2): AccumulatorState {
  if (event.type === 'user/message') {
    const text = messageText(event)
    if (text === undefined) return state
    const signal = detectSignal(text)
    if (signal === undefined) return state
    const candidate: MemoryCandidate = { text, signal, seq: event.seq }
    return { ...state, candidates: [...state.candidates, candidate], count: state.count + 1 }
  }
  if (event.type === 'tool/call') {
    const callId = String(event.data.callId)
    const openCalls = { ...state.openCalls, [callId]: { name: event.data.name, signature: toolSignature(event.data.name, event.data.arguments), seq: event.seq } }
    evictToCap(openCalls, OPEN_CALLS_CAP, call => call.seq)
    return { ...state, openCalls }
  }
  if (event.type === 'tool/result') {
    const block = event.data.message?.content?.[0]
    const callId = block !== undefined && block.type === 'tool-result' ? String(block.toolCallId) : undefined
    const call = callId !== undefined ? state.openCalls[callId] : undefined
    if (call === undefined) return state
    const openCalls = { ...state.openCalls }
    delete openCalls[callId!]
    if (event.data.error !== undefined) {
      // Failure: start or extend the streak for this signature.
      const existing = state.openStreaks[call.signature]
      const streak: OpenStreak = {
        count: (existing?.count ?? 0) + 1,
        lastErrorText: failureDescription(event),
        firstSeq: existing?.firstSeq ?? event.seq,
        lastSeq: event.seq,
      }
      const openStreaks = { ...state.openStreaks, [call.signature]: streak }
      evictToCap(openStreaks, OPEN_STREAKS_CAP, s => s.lastSeq)
      return { ...state, openCalls, openStreaks }
    }
    // Success: resolve the streak if it reached the threshold; either way the
    // call is closed (result received) and the streak ends.
    const streak = state.openStreaks[call.signature]
    if (streak === undefined) return { ...state, openCalls }
    const openStreaks = { ...state.openStreaks }
    delete openStreaks[call.signature]
    if (streak.count < pitfallThreshold) {
      return { ...state, openCalls, openStreaks }
    }
    const candidate: MemoryCandidate = {
      text: `tool "${call.name}" (signature: ${call.signature}) failed ${streak.count} time(s) before succeeding. Last error: ${streak.lastErrorText}. Streak spans seqs ${streak.firstSeq}–${streak.lastSeq}, resolved by the call at seq ${call.seq}.`,
      signal: PITFALL_RESOLVED_SIGNAL,
      seq: event.seq,
    }
    return { ...state, openCalls, openStreaks, candidates: [...state.candidates, candidate], count: state.count + 1 }
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
  openCalls: zod.record(zod.string(), zod.object({
    name: zod.string(),
    signature: zod.string(),
    seq: zod.number(),
  })),
  openStreaks: zod.record(zod.string(), zod.object({
    count: zod.number(),
    lastErrorText: zod.string(),
    firstSeq: zod.number(),
    lastSeq: zod.number(),
  })),
})
