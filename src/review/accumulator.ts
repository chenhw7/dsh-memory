/**
 * The periodic-review projection accumulator: a pure, synchronous fold over
 * session events that collects candidate memory fragments. No LLM runs here —
 * the {@link agent/pre-step} listener drains the accumulator once it reaches
 * the configured threshold and runs one extraction call.
 *
 * Signal sources:
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

/** The projection key this unit owns in the {@link SessionProjectionStateMap}. */
export const MEMORY_REVIEW_PROJECTION_KEY = 'memory-review-candidates'

// Host-only projection unit: the accumulated state is consumed by the review
// drain itself (`stateOf`), never exposed on the client wire (no `wire` view).
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Accumulated candidate memory fragments awaiting LLM extraction. */
    'memory-review-candidates': AccumulatorState
  }
}

/** The signal emitted when a failure streak is resolved by a success. */
export const PITFALL_RESOLVED_SIGNAL = 'pitfall-resolved'

/** One candidate fragment collected by the accumulator. */
export interface MemoryCandidate {
  /** The text fragment that matched a signal. */
  readonly text: string
  /**
   * Which signal class matched: `keyword` (an explicit remember request),
   * `preference` (a stated standing preference), `correction` (a revision of
   * a prior statement), or `pitfall-resolved` (a verified failure streak).
   */
  readonly signal: string
  /** Seq of the session event the fragment came from. */
  readonly seq: number
  /**
   * The assistant turn this candidate corrects, when the signal is a
   * correction: the extraction model reads it to resolve what "not that,
   * this" actually refers to. Truncated to {@link CONTEXT_CAP}.
   */
  readonly context?: string | undefined
  /**
   * An explicit remember request. Such a candidate does not wait for the
   * threshold: the user asked in words, so one fragment is reason enough to
   * run extraction (the review drain fires on a single strong candidate).
   */
  readonly strong?: boolean | undefined
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
  /**
   * The most recent assistant message text (truncated to {@link CONTEXT_CAP}),
   * kept so a later correction can carry what it revises.
   */
  readonly lastAssistantText?: string | undefined
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
  { name: 'keyword', re: /(请|务必|一定要)记/ },
  { name: 'keyword', re: /记着/ },
  // English explicit-remember intents.
  { name: 'keyword', re: /remember\s+that/i },
  { name: 'keyword', re: /don'?t\s+forget/i },
  { name: 'keyword', re: /from\s+now\s+on/i },
  { name: 'keyword', re: /keep\s+in\s+mind/i },
  { name: 'keyword', re: /make\s+a\s+note/i },
  { name: 'keyword', re: /for\s+the\s+record/i },
  { name: 'keyword', re: /\bremember\s+(this|it)\b/i },
  { name: 'keyword', re: /\bnote\s+that\b/i },
]

/**
 * Stated standing preferences: no request verb, but a durable rule the user
 * expects to hold. Weaker than a remember request — these wait for the
 * threshold — yet they are the most common way a preference actually reaches
 * the conversation, so missing them was the funnel's largest hole.
 */
const PREFERENCE_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  // Chinese statements of habit or standing instruction.
  { name: 'preference', re: /我喜欢/ },
  { name: 'preference', re: /我(习惯|偏好|倾向于)/ },
  { name: 'preference', re: /(请|以后)?一律(用|使用|走)/ },
  { name: 'preference', re: /(默认|统一|以后都)(用|使用|走)/ },
  { name: 'preference', re: /我们(这里|团队|项目)(都)?(习惯|用|要求)/ },
  // English statements of habit or standing instruction.
  { name: 'preference', re: /\bi\s+prefer\b/i },
  { name: 'preference', re: /\bi\s+(usually|typically|always|never)\b/i },
  { name: 'preference', re: /\b(always|never)\s+(use|run|write|prefer)\b/i },
  { name: 'preference', re: /\bplease\s+always\b/i },
  { name: 'preference', re: /\bour\s+(convention|standard|policy)\b/i },
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
  { name: 'correction', re: /不是.{1,20}而是/ },
  { name: 'correction', re: /别再用/ },
  { name: 'correction', re: /换回/ },
  { name: 'correction', re: /改(成|回|用)/ },
  // English revisions of a prior statement.
  { name: 'correction', re: /no,?\s+i\s+said/i },
  { name: 'correction', re: /that'?s\s+wrong/i },
  { name: 'correction', re: /actually/i },
  { name: 'correction', re: /i\s+meant/i },
  { name: 'correction', re: /no,?\s+it'?s/i },
  { name: 'correction', re: /instead\s+of/i },
  { name: 'correction', re: /use\s+\S+\s+instead/i },
  { name: 'correction', re: /stop\s+using/i },
]

/** Cap on the assistant context carried by one correction candidate. */
export const CONTEXT_CAP = 300
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

/** One detected signal with the strength the accumulator acts on. */
export interface DetectedSignal {
  /** The signal class name recorded on the candidate. */
  readonly name: string
  /** Explicit remember requests act on a single candidate. */
  readonly strong: boolean
}

/**
 * Detect the first matching signal in a user message. An explicit remember
 * request outranks a stated preference, which outranks a correction.
 * @param text - the message text to scan.
 * @returns the signal and its strength, or `undefined` when no rule fires.
 */
export function detectSignalDetail(text: string): DetectedSignal | undefined {
  for (const { name, re } of KEYWORD_PATTERNS) {
    if (re.test(text)) return { name, strong: true }
  }
  for (const { name, re } of PREFERENCE_PATTERNS) {
    if (re.test(text)) return { name, strong: false }
  }
  for (const { name, re } of CORRECTION_PATTERNS) {
    if (re.test(text)) return { name, strong: false }
  }
  return undefined
}

/**
 * The signal name alone, for callers that only need the class.
 * @param text - the message text to scan.
 * @returns the matching signal name, or `undefined` when no rule fires.
 */
export function detectSignal(text: string): string | undefined {
  return detectSignalDetail(text)?.name
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
 * carries an error: the error identity plus the result message's text blocks.
 * A tool result is its own `tool`-role message, so the text sits directly on
 * the message's content.
 * @param event - a `tool/result` session event with `data.error` present.
 * @returns the failure description text (≤ {@link STREAK_ERROR_TEXT_LIMIT} chars).
 */
function failureDescription(event: SessionEvent<'tool/result'>): string {
  const data = event.data
  const parts: string[] = []
  for (const block of data.message.content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
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
  if (event.type === 'assistant/message') {
    const text = messageText(event)
    if (text === undefined) return state
    const lastAssistantText = text.length > CONTEXT_CAP ? `${text.slice(0, CONTEXT_CAP)}…` : text
    return { ...state, lastAssistantText }
  }
  if (event.type === 'user/message') {
    const text = messageText(event)
    if (text === undefined) return state
    const detected = detectSignalDetail(text)
    if (detected === undefined) return state
    const candidate: MemoryCandidate = {
      text,
      signal: detected.name,
      seq: event.seq,
      ...detected.strong ? { strong: true } : {},
      // Only a correction needs the referent: "no, use pnpm" is meaningless
      // without the turn it revises.
      ...detected.name === 'correction' && state.lastAssistantText !== undefined ? { context: state.lastAssistantText } : {},
    }
    return { ...state, candidates: [...state.candidates, candidate], count: state.count + 1 }
  }
  if (event.type === 'tool/call') {
    const callId = String(event.data.callId)
    const openCalls = { ...state.openCalls, [callId]: { name: event.data.name, signature: toolSignature(event.data.name, event.data.arguments), seq: event.seq } }
    evictToCap(openCalls, OPEN_CALLS_CAP, call => call.seq)
    return { ...state, openCalls }
  }
  if (event.type === 'tool/result') {
    const callId = String(event.data.message.toolCallId)
    const call = state.openCalls[callId]
    if (call === undefined) return state
    const openCalls = { ...state.openCalls }
    delete openCalls[callId]
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

/** Zod schema validating the accumulator's persisted state before a fold seeds it. */
export const accumulatorSchema: ZodType<AccumulatorView> = zod.object({
  candidates: zod.array(zod.object({
    text: zod.string(),
    signal: zod.string(),
    seq: zod.number(),
    context: zod.string().optional(),
    strong: zod.boolean().optional(),
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
  lastAssistantText: zod.string().optional(),
})
