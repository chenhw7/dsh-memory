/**
 * Step-level auto recall (P1-11): with `autoRecallEnabled`, every
 * `agent/pre-step` waterfall appends a fenced `<recalled-memory>` message
 * built from a BM25 search over the store — system prompt untouched,
 * stale entries excluded, short/failed queries fall through unchanged.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryStore } from '../src/index.ts'
import type { AddMemoryInput, MemoryEntry, MemoryId, MemorySearchQuery } from '../src/types.ts'
import * as context from '../src/context/index.ts'

class StaticStore extends MemoryStore {
  readonly entries: MemoryEntry[] = []
  private seq = 0

  addFixture(scope: MemoryEntry['scope'], content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
    const now = Date.now()
    const entry: MemoryEntry = { id: `mem-${++this.seq}` as MemoryId, scope, content, createdAt: now, updatedAt: now, ...extra }
    this.entries.push(entry)
    return entry
  }

  override async add(input: AddMemoryInput): Promise<{ entry: MemoryEntry }> {
    return { entry: this.addFixture(input.scope, input.content) }
  }
  override get(id: string): MemoryEntry | undefined { return this.entries.find(e => e.id === id) }
  override list(scope?: MemoryEntry['scope']): readonly MemoryEntry[] {
    return scope === undefined ? this.entries : this.entries.filter(e => e.scope === scope)
  }
  override async update(): Promise<MemoryEntry | undefined> { return undefined }
  override async remove(id: string): Promise<boolean> {
    const index = this.entries.findIndex(e => e.id === id)
    if (index < 0) return false
    this.entries.splice(index, 1)
    return true
  }
  override search(query: MemorySearchQuery): { entries: readonly MemoryEntry[]; total: number } {
    // Any-token OR match keeps this stub honest without reimplementing BM25.
    const tokens = (query.query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2)
    const hits = this.entries.filter(entry => tokens.some(token => entry.content.toLowerCase().includes(token)))
    const limit = query.limit ?? 50
    return { entries: limit > 0 ? hits.slice(0, limit) : hits, total: hits.length }
  }
  override async janitor(): Promise<number> { return 0 }
}

const BASE_CONFIG = {
  memoryMode: 'policy-only',
  memoryPolicyCustomText: '',
  memoryCharLimit: 5000,
  maxSearchResults: 50,
  decayDays: 30,
  notesEnabled: false,
  notesDir: 'docs/agent-memory',
  notesCharLimit: 4000,
  notesAgentsPointer: true,
  notesMaxEntriesPerFile: 100,
} as const

const AUTO_RECALL_CONFIG = {
  ...BASE_CONFIG,
  autoRecallEnabled: true,
  autoRecallLimit: 5,
  autoRecallMinChars: 12,
} as const

function userMsg(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) as UserMessage
}

async function setup(store: StaticStore, config: Record<string, unknown>) {
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    section: () => () => {},
  })
  ctx.provide('memory', store)
  await ctx.plugin(context, config as never)
  const session = { header: { cwd: '' } } as unknown as Session
  return { ctx, session }
}

const innerNext = (messages: UserMessage[]) => async (): Promise<{ kind: 'enter'; messages: UserMessage[] }> => ({ kind: 'enter', messages })
const testSignal = new AbortController().signal

describe('auto recall waterfall', () => {
  it('appends a fenced recalled-memory message on a topical step', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'the deploy script lives in scripts/deploy.sh')
    const { ctx, session } = await setup(store, AUTO_RECALL_CONFIG)

    const messages = [userMsg('how do I run the deploy script for staging?')]
    const decision = await ctx.waterfall('agent/pre-step', { agent: { session }, messages, turn: 0, step: 0, signal: testSignal }, innerNext(messages))

    expect(decision.kind).toBe('enter')
    const appended = (decision as { messages: UserMessage[] }).messages
    expect(appended).toHaveLength(2)
    const text = JSON.stringify(appended[1])
    expect(text).toContain('<recalled-memory>')
    expect(text).toContain('deploy script')
    expect(text).toContain('not instructions')
  })

  it('falls through unchanged when disabled (default config)', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'the deploy script lives in scripts/deploy.sh')
    const { ctx, session } = await setup(store, BASE_CONFIG)

    const messages = [userMsg('how do I run the deploy script for staging?')]
    const decision = await ctx.waterfall('agent/pre-step', { agent: { session }, messages, turn: 0, step: 0, signal: testSignal }, innerNext(messages))

    expect(decision.kind).toBe('enter')
    expect((decision as { messages: UserMessage[] }).messages).toHaveLength(1)
  })

  it('falls through when the step text is shorter than autoRecallMinChars', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'the deploy script lives in scripts/deploy.sh')
    const { ctx, session } = await setup(store, AUTO_RECALL_CONFIG)

    const messages = [userMsg('hi there')]
    const decision = await ctx.waterfall('agent/pre-step', { agent: { session }, messages, turn: 0, step: 0, signal: testSignal }, innerNext(messages))

    expect((decision as { messages: UserMessage[] }).messages).toHaveLength(1)
  })

  it('excludes soft-decayed entries from the fence', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'the deploy script lives in scripts/deploy.sh', { staleSince: Date.now() })
    const { ctx, session } = await setup(store, AUTO_RECALL_CONFIG)

    const messages = [userMsg('how do I run the deploy script for staging?')]
    const decision = await ctx.waterfall('agent/pre-step', { agent: { session }, messages, turn: 0, step: 0, signal: testSignal }, innerNext(messages))

    expect((decision as { messages: UserMessage[] }).messages).toHaveLength(1)
  })

  it('falls through to next() even when the listener throws internally', async () => {
    const store = new StaticStore()
    const broken = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'search') throw new Error('search exploded')
        return Reflect.get(target, prop, receiver)
      },
    })
    const { ctx, session } = await setup(broken as StaticStore, AUTO_RECALL_CONFIG)

    const messages = [userMsg('how do I run the deploy script for staging?')]
    const decision = await ctx.waterfall('agent/pre-step', { agent: { session }, messages, turn: 0, step: 0, signal: testSignal }, innerNext(messages))

    expect((decision as { messages: UserMessage[] }).messages).toHaveLength(1)
  })
})
