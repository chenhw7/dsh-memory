/**
 * Review runtime state survives the host's settings re-apply. A settings
 * change re-runs the `memory-review` entry's `apply` (fiber restart), so the
 * per-session high-water marks, extraction budget, and compaction event log
 * are held at module scope: after a restart, the same session must stay within
 * an already-spent budget and must still flush the compaction whose raw events
 * it already saw.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { MemoryStore } from '../src/index.ts'
import type { AddMemoryInput, MemoryEntry, MemoryId, MemorySearchQuery } from '../src/types.ts'
import { resolveInjectionSettings } from '../src/store/settings.ts'
import type { MemoryInjectionSettings } from '../src/store/settings.ts'
import * as review from '../src/review/index.ts'

/** A store stand-in that records what extraction wrote and keeps fixtures. */
class RecordingStore extends MemoryStore {
  readonly added: AddMemoryInput[] = []
  private readonly entries: MemoryEntry[] = []
  private readonly injection: MemoryInjectionSettings = resolveInjectionSettings({})

  addFixture(content: string): MemoryEntry {
    const entry: MemoryEntry = { id: `mem-${this.entries.length}` as MemoryId, scope: 'global', content, createdAt: this.entries.length, updatedAt: this.entries.length }
    this.entries.push(entry)
    return entry
  }

  override settings(): MemoryInjectionSettings { return this.injection }
  override async add(input: AddMemoryInput): Promise<{ entry: MemoryEntry }> {
    this.added.push(input)
    const entry = { ...input, id: `added-${this.added.length}` as MemoryId, createdAt: this.added.length, updatedAt: this.added.length } as MemoryEntry
    this.entries.push(entry)
    return { entry }
  }
  override get(id: string): MemoryEntry | undefined { return this.entries.find(entry => entry.id === id as MemoryId) }
  override list(scope?: MemoryEntry['scope']): readonly MemoryEntry[] {
    return scope === undefined ? this.entries : this.entries.filter(entry => entry.scope === scope)
  }
  override async update(id: string, input: { content?: string }): Promise<MemoryEntry | undefined> {
    const index = this.entries.findIndex(entry => entry.id === id as MemoryId)
    if (index < 0) return undefined
    const current = this.entries[index]!
    const next: MemoryEntry = { ...current, ...input, updatedAt: current.updatedAt + 1 }
    this.entries[index] = next
    return next
  }
  override async remove(): Promise<boolean> { return false }
  override search(query: MemorySearchQuery): { entries: readonly MemoryEntry[]; total: number } {
    return { entries: this.entries.slice(0, query.limit ?? 50), total: this.entries.length }
  }
  override async janitor(): Promise<number> { return 0 }
}

/** The accumulator shape the fake projection handle reports. */
interface FakeAccumulator {
  candidates: { text: string; signal: string; seq: number }[]
  count: number
  openCalls: Record<string, never>
  openStreaks: Record<string, never>
}

/** A session-shaped object the review pipeline can route on. */
function fakeSession(id: string): Session {
  return {
    id,
    header: {},
    requestHeader: () => ({ config: { provider: 'test', model: 'test' } }),
    deriveMessages: () => [],
  } as unknown as Session
}

/** Extraction output chunks for one canned answer. */
function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One recorded LLM request, as the fake seam saw it. */
type LlmCall = { messages?: unknown }

/** Give one request a moment to settle the fire-and-forget extraction. */
function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 20) })
}

/**
 * Seat the seams one composition needs: the LLM stream (answering every call
 * with `answer`), the memory service, and a projection registry whose handle
 * reports `state`.
 * @param ctx - composition root.
 * @param store - the memory service.
 * @param calls - every LLM request captured by the seam.
 * @param state - mutable accumulator state the projection handle reads.
 * @param answer - the extraction text every LLM call returns.
 */
function seatSeams(ctx: Context, store: RecordingStore, calls: LlmCall[], state: FakeAccumulator, answer: () => string): void {
  ctx.provide('llm', {
    stream: (options: LlmCall) => {
      calls.push(options)
      const text = answer()
      return (async function* () { for (const chunk of textChunks(text)) yield chunk })()
    },
  } as never)
  ctx.provide('memory', store)
  ctx.provide('sessionProjections', { register: async () => ({ stateOf: () => state }) } as never)
}

/**
 * Mount the review entry and wait for the projection registration to resolve.
 * @param ctx - composition root.
 * @param config - the entry config under test.
 */
async function mountReview(ctx: Context, config: review.Config): Promise<{ dispose: () => Promise<void> }> {
  const fiber = await ctx.plugin(review, config)
  // The projection handle arrives through `ctx.inject(...).then(...)`.
  await Promise.resolve()
  return fiber
}

/** The `agent/pre-step` payload the review drain reads. */
function stepPayload(session: Session): { agent: { session: Session }; signal: AbortSignal } {
  return { agent: { session }, signal: new AbortController().signal }
}

/** The inner waterfall result every step must return untouched. */
async function nextStep(): Promise<{ kind: string; messages: unknown[] }> {
  return { kind: 'enter', messages: [] }
}

const BASE_CONFIG: review.Config = {
  reviewEnabled: true,
  reviewCandidateThreshold: 1,
  flushOnCompaction: false,
  flushOnDispose: false,
  extractionBudget: 10,
  judgeEnabled: false,
  consolidation: 'legacy-judge',
  curatorEnabled: false,
}

describe('memory-review runtime state across a settings re-apply', () => {
  it('keeps the high-water mark for the same session', async () => {
    const ctx = new Context()
    const store = new RecordingStore()
    const calls: LlmCall[] = []
    const session = fakeSession('session-0')
    const state: FakeAccumulator = { candidates: [{ text: 'deploy with helm', signal: 'keyword', seq: 1 }], count: 1, openCalls: {}, openStreaks: {} }
    seatSeams(ctx, store, calls, state, () => 'global: use helm for deploys')

    const first = await mountReview(ctx, { ...BASE_CONFIG, extractionBudget: 10 })
    await ctx.waterfall('agent/pre-step', stepPayload(session), nextStep)
    await settle()
    expect(calls).toHaveLength(1)

    // The restarted fiber sees the same candidate again; the module-scoped
    // mark keeps it from draining a second time.
    await first.dispose()
    const second = await mountReview(ctx, { ...BASE_CONFIG, extractionBudget: 10 })
    await ctx.waterfall('agent/pre-step', stepPayload(session), nextStep)
    await settle()
    expect(calls).toHaveLength(1)

    // A genuinely new candidate still drains: the restarted fiber works.
    state.candidates = [{ text: 'the deploy uses helm now', signal: 'keyword', seq: 2 }]
    await ctx.waterfall('agent/pre-step', stepPayload(session), nextStep)
    await settle()
    expect(calls).toHaveLength(2)
    await second.dispose()
  })

  it('keeps the spent budget for the same session', async () => {
    const ctx = new Context()
    const store = new RecordingStore()
    const calls: LlmCall[] = []
    const session = fakeSession('session-1')
    const state: FakeAccumulator = { candidates: [{ text: 'deploy with helm', signal: 'keyword', seq: 1 }], count: 1, openCalls: {}, openStreaks: {} }
    seatSeams(ctx, store, calls, state, () => 'global: use helm for deploys')

    const first = await mountReview(ctx, { ...BASE_CONFIG, extractionBudget: 1 })
    await ctx.waterfall('agent/pre-step', stepPayload(session), nextStep)
    await settle()
    expect(calls).toHaveLength(1)
    expect(store.added).toHaveLength(1)

    // A settings change restarts the entry's fiber; only the module scope
    // survives. `seq 2` is new, so the high-water mark alone cannot stop it —
    // the spent budget (1 of 1) is what must survive the restart.
    await first.dispose()
    state.candidates = [{ text: 'the deploy uses helm now', signal: 'keyword', seq: 2 }]
    const second = await mountReview(ctx, { ...BASE_CONFIG, extractionBudget: 1 })
    await ctx.waterfall('agent/pre-step', stepPayload(session), nextStep)
    await settle()
    expect(calls).toHaveLength(1)
    await second.dispose()
  })

  it('keeps the compaction event log so the flush after a restart still fires', async () => {
    const ctx = new Context()
    const store = new RecordingStore()
    const calls: LlmCall[] = []
    const session = fakeSession('session-2')
    const state: FakeAccumulator = { candidates: [], count: 0, openCalls: {}, openStreaks: {} }
    seatSeams(ctx, store, calls, state, () => 'global: deploys run through helm')

    const first = await mountReview(ctx, { ...BASE_CONFIG, reviewCandidateThreshold: 2, flushOnCompaction: true })
    // The raw event the summary shadows, recorded by the module-scoped log.
    ctx.emit('session/event', session, { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'we deploy with helm now' }] } })
    ctx.emit('session/event', session, { type: 'compaction/summary', seq: 2, time: 2, data: { compactionId: 'c-1', shadowedSeqs: [1] } })

    await first.dispose()
    const second = await mountReview(ctx, { ...BASE_CONFIG, reviewCandidateThreshold: 2, flushOnCompaction: true })
    ctx.emit('session/event', session, { type: 'compaction/end', seq: 3, time: 3, data: { compactionId: 'c-1' } })
    await settle()

    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0]?.messages)).toContain('we deploy with helm now')
    expect(store.added).toHaveLength(1)
    await second.dispose()
  })

  it('curates a single oversized entry instead of requiring a pair', async () => {
    const ctx = new Context()
    const store = new RecordingStore()
    const calls: LlmCall[] = []
    const session = fakeSession('session-3')
    const state: FakeAccumulator = { candidates: [], count: 0, openCalls: {}, openStreaks: {} }
    const long = store.addFixture(`${'detail '.repeat(80)}single oversized entry`)
    seatSeams(ctx, store, calls, state, () => `${long.id as string}: concise rewrite`)

    const fiber = await mountReview(ctx, {
      ...BASE_CONFIG,
      reviewEnabled: false,
      curatorEnabled: true,
      curatorEveryNSessions: 1,
      curatorMinChars: 1,
      curatorMaxEntries: 5,
    })
    ctx.emit('session/created', session)
    await settle()

    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0]?.messages)).toContain(long.id as string)
    await fiber.dispose()
  })
})
