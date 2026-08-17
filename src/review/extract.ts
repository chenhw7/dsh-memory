/**
 * LLM extraction for the memory-review plugin: build review/flush prompts,
 * run one {@link ctx.llm.stream} call routed on the session's request header,
 * parse the line-oriented output into memory entries, and store each through
 * {@link scanContent} + {@link MemoryStore.add}.
 *
 * Every extraction call is best-effort: a missing provider/model route, a
 * stream error, or a scanner rejection skips the offending entry without
 * throwing into the caller. The flush paths use fire-and-forget scheduling so
 * a slow or failing extraction never blocks `compaction/end` or
 * `session/disposed`.
 *
 * @module @chenhw7/dsh-memory/review/extract
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scanContent } from '../scanner.ts'
import type { AddMemoryInput, MemoryCategory, MemoryEntry, MemoryScope } from '../types.ts'
import type { MemoryStore } from '../index.ts'
import type { MemoryCandidate } from './accumulator.ts'

/** Producer attribution for the synthetic extraction request message. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-memory-review' } as const

/** System prompt for the periodic-review extraction. */
export const REVIEW_SYSTEM_PROMPT =
  'You are a memory extraction assistant. Read the conversation fragments below and extract durable, reusable memories the assistant should remember across sessions. Output one memory per line in the exact format "scope: content" where scope is one of "global", "project", or "user". Prioritize user preferences, corrections, and recurring patterns over task-specific or one-off details. Omit anything already present in the current memory snapshot. Output only the memory lines, nothing else.'

/** System prompt for the compaction/dispose flush (方案 C). */
export const FLUSH_SYSTEM_PROMPT =
  'The session is being compressed. Save anything worth remembering — prioritize user preferences, corrections, and recurring patterns over task-specific details. Output one memory per line in the exact format "scope: content" where scope is one of "global", "project", or "user". Output only the memory lines, nothing else.'

/** The valid scope tags a parsed line may declare. */
const SCOPE_TAGS: readonly MemoryScope[] = ['global', 'project', 'user']

/** One parsed memory entry awaiting scanner + store validation. */
export interface ParsedMemory {
  /** Which scope the extracted memory belongs to. */
  readonly scope: MemoryScope
  /** Human-readable memory content. */
  readonly content: string
  /** Optional category inferred from the matched signal, when available. */
  readonly category?: MemoryCategory
}

/**
 * Parse the line-oriented extraction output into memory entries. Each
 * non-empty line must read "scope: content"; lines without a recognized scope
 * tag or with empty content are dropped. The parsing is pure and synchronous.
 * @param text - the raw model output.
 * @returns the parsed entries, in output order.
 */
export function parseExtractedMemories(text: string): ParsedMemory[] {
  const results: ParsedMemory[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const scopeRaw = line.slice(0, colon).trim().toLowerCase()
    const content = line.slice(colon + 1).trim()
    if (content.length === 0) continue
    let scope: MemoryScope | undefined
    for (const tag of SCOPE_TAGS) {
      if (tag === scopeRaw) { scope = tag; break }
    }
    if (scope === undefined) continue
    results.push({ scope, content })
  }
  return results
}

/**
 * Render the current memory snapshot as a human-readable block for the
 * extraction prompt. Returns an empty string when the store has no entries.
 * @param memory - the live memory store, or `undefined` when none is mounted.
 * @returns the rendered snapshot text.
 */
export function renderMemorySnapshot(memory: MemoryStore | undefined): string {
  if (memory === undefined) return ''
  const entries = memory.list()
  if (entries.length === 0) return ''
  const lines = entries.map(renderEntry)
  return `Current memory snapshot:\n${lines.join('\n')}`
}

/** Render one memory entry as a single prompt line. */
function renderEntry(entry: MemoryEntry): string {
  const tag = entry.category === undefined ? `[${entry.scope}]` : `[${entry.scope}/${entry.category}]`
  const project = entry.projectName === undefined ? '' : ` (${entry.projectName})`
  return `- ${tag}${project} ${entry.content}`
}

/**
 * Build the messages for the periodic-review extraction prompt.
 * @param memorySnapshot - rendered current memory text (possibly empty).
 * @param candidates - the accumulated candidate fragments.
 * @returns the model-facing user message list.
 */
export function buildReviewMessages(memorySnapshot: string, candidates: readonly MemoryCandidate[]): Message[] {
  const fragments = candidates.map((c, i) => `[${i + 1}] (${c.signal}) ${c.text}`).join('\n')
  const parts = [
    memorySnapshot.length === 0 ? '' : `${memorySnapshot}\n\n`,
    'Conversation fragments to extract memories from:\n',
    fragments,
  ]
  const text = parts.join('')
  return [createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE })]
}

/**
 * Build the messages for the compaction/dispose flush prompt.
 * @param fragments - the raw conversation fragments being shadowed.
 * @returns the model-facing user message list.
 */
export function buildFlushMessages(fragments: readonly string[]): Message[] {
  const body = fragments.length === 0 ? '(no fragments available)' : fragments.map((f, i) => `[${i + 1}] ${f}`).join('\n')
  const text = `Conversation being compressed:\n${body}`
  return [createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE })]
}

/** Resolve the provider/model for an extraction call from the session header. */
function resolveTarget(session: Session): { provider: string; model: string } | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

/**
 * Collect the assembled text from one LLM stream. Throws on an error/aborted
 * finish; returns the concatenated text-block content on success.
 * @param ctx - context carrying the LLM seam.
 * @param options - the full request (provider selects the adapter).
 * @returns the assembled output text.
 */
export async function collectStreamText(ctx: Context, options: GenerateOptions): Promise<string> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  return textOf(assembler.blocks())
}

/** Extract the concatenated text from assembled content blocks. */
function textOf(blocks: readonly { readonly type: string; readonly text?: string }[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** Map a terminal stream finish to its fail-closed error (mirrors compaction). */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('memory extraction truncated at the token cap') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/**
 * Run one extraction call and parse its output. Resolves the provider/model
 * from the session's request header; returns an empty list when no route is
 * available or the stream fails (best-effort).
 * @param ctx - context carrying the LLM seam.
 * @param session - the session whose request header routes the call.
 * @param system - the system prompt.
 * @param messages - the model-facing user messages.
 * @param signal - optional abort signal.
 * @returns the parsed memory entries (possibly empty on failure).
 */
export async function extractMemories(
  ctx: Context,
  session: Session,
  system: string,
  messages: Message[],
  signal?: AbortSignal,
): Promise<ParsedMemory[]> {
  const target = resolveTarget(session)
  if (target === undefined) return []
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    system,
    sessionId: session.id,
    ...signal === undefined ? {} : { signal },
  }
  let text: string
  try {
    text = await collectStreamText(ctx, options)
  } catch (_extractionError) {
    return []
  }
  return parseExtractedMemories(text)
}

/**
 * Store parsed memory entries through the scanner and the memory store. Each
 * entry is independent: a scanner rejection or store failure skips that
 * entry without throwing. Does nothing when no memory store is mounted.
 * @param ctx - context carrying an optional `memory` service.
 * @param parsed - the entries to store.
 * @param category - optional category to attach to every entry.
 */
export async function storeMemories(
  ctx: Context,
  parsed: readonly ParsedMemory[],
  attachCategory?: MemoryCategory,
): Promise<void> {
  const memory = ctx.get('memory')
  if (memory === undefined) return
  for (const entry of parsed) {
    const scan = scanContent(entry.content)
    if (!scan.allowed) continue
    const category = entry.category ?? attachCategory
    const input: AddMemoryInput = category === undefined
      ? { scope: entry.scope, content: entry.content }
      : { scope: entry.scope, content: entry.content, category }
    try {
      await memory.add(input)
    } catch (_storeError) {
      // Best-effort: a store failure for one entry does not abort the rest.
    }
  }
}

/**
 * Run the periodic-review extraction: build the review prompt from the
 * current memory snapshot and the accumulated candidates, extract, and store.
 * Returns the number of entries actually stored.
 * @param ctx - context carrying the LLM and optional memory seams.
 * @param agent - the live agent whose session routes the call.
 * @param candidates - the accumulated candidate fragments.
 */
export async function runReviewExtraction(
  ctx: Context,
  agent: Agent,
  candidates: readonly MemoryCandidate[],
): Promise<number> {
  const memory = ctx.get('memory')
  const snapshot = renderMemorySnapshot(memory)
  const messages = buildReviewMessages(snapshot, candidates)
  const parsed = await extractMemories(ctx, agent.session, REVIEW_SYSTEM_PROMPT, messages)
  // A correction signal maps naturally to the `correction` category.
  const correctionOnly = candidates.length > 0 && candidates.every(c => c.signal === 'correction')
  await storeMemories(ctx, parsed, correctionOnly ? 'correction' : undefined)
  return parsed.length
}

/**
 * Run the compaction/dispose flush extraction: build the flush prompt from the
 * shadowed conversation fragments, extract, and store. Best-effort and
 * fire-and-forget at the call site.
 * @param ctx - context carrying the LLM and optional memory seams.
 * @param session - the session whose request header routes the call.
 * @param fragments - the raw conversation fragments being shadowed.
 * @param signal - optional abort signal.
 * @returns the number of parsed entries (before scanner/store filtering).
 */
export async function runFlushExtraction(
  ctx: Context,
  session: Session,
  fragments: readonly string[],
  signal?: AbortSignal,
): Promise<number> {
  const messages = buildFlushMessages(fragments)
  const parsed = await extractMemories(ctx, session, FLUSH_SYSTEM_PROMPT, messages, signal)
  await storeMemories(ctx, parsed)
  return parsed.length
}
