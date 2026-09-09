/**
 * Step-tail injection: the `agent/pre-step` waterfall appends at most ONE
 * plugin message per step, merging the session's one-time `<memory-digest>`
 * inventory (digest mode) with the fenced `<recalled-memory>` block from a
 * BM25 search (auto recall). System prompt untouched; stale/superseded entries
 * excluded; short/failed queries fall through unchanged; fence hits stamp a
 * LIGHTWEIGHT recall (lastRecalledAt only, never accessCount).
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryStore } from '../src/index.ts'
import type { AddMemoryInput, MemoryEntry, MemoryId, MemorySearchQuery, RecallSource } from '../src/types.ts'
import * as context from '../src/context/index.ts'

class StaticStore extends MemoryStore {
  readonly entries: MemoryEntry[] = []
  /** markRecalled calls captured for assertions (ids + source tier). */
  readonly recallStamps: { ids: string[]; source: RecallSource }[] = []
  /** The last search query the store received (recordRecall observability). */
  lastSearch: MemorySearchQuery | undefined
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
    this.lastSearch = query
    // Any-token OR match keeps this stub honest without reimplementing BM25.
    const tokens = (query.query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2)
    const hits = this.entries.filter(entry => tokens.some(token => entry.content.toLowerCase().includes(token)))
    const limit = query.limit ?? 50
    return { entries: limit > 0 ? hits.slice(0, limit) : hits, total: hits.length }
  }
  override markRecalled(ids: readonly string[], source: RecallSource = 'tool'): void {
    this.recallStamps.push({ ids: [...ids], source })
  }
  override async janitor(): Promise<number> { return 0 }
}

const BASE_CONFIG = {
  memoryMode: 'policy-only',
  memoryPolicyCustomText: '',
  memoryCharLimit: 5000,
  memoryMaxEntries: 20,
  maxSearchResults: 50,
  decayDays: 30,
  notesEnabled: false,
  notesMaxEntriesPerFile: 100,
  // Explicitly off: the factory default is ON (its own test below).
  autoRecallEnabled: false,
} as const

const AUTO_RECALL_CONFIG = {
  ...BASE_CONFIG,
  autoRecallEnabled: true,
  autoRecallLimit: 5,
  autoRecallMinChars: 12,
} as const

const DIGEST_CONFIG = {
  ...BASE_CONFIG,
  memoryMode: 'digest',
  memoryDigestCharLimit: 800,
} as const

/** An in-memory settings provider for live-budget tests (settings-live pattern). */
class TestSettingsProvider extends SettingsProvider {
  override get writable() { return true }
  private doc: Record<string, unknown> = {}
  protected override async load(): Promise<Record<string, unknown>> { return this.doc }
  protected override async persist(ns: Parameters<SettingsProvider['update']>[0], section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: section }
  }
}

function userMsg(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) as UserMessage
}

async function setup(store: StaticStore, config: Record<string, unknown>, withSettings = false) {
  const ctx = new Context()
  if (withSettings) await ctx.plugin(TestSettingsProvider)
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

function stepPayload(session: Session, messages: UserMessage[]) {
  return { agent: { session }, messages, turn: 0, step: 0, signal: testSignal }
}

describe('auto recall waterfall', () => {
  it('appends a fenced recalled-memory message on a topical step', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'the deploy script lives in scripts/deploy.sh')
    const { ctx, session } = await setup(store, AUTO_RECALL_CONFIG)

    const messages = [userMsg('how do I run the deploy script for staging?')]
    const decision = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))

    expect(decision.kind).toBe('enter')
    const appended = (decision as { messages: UserMessage[] }).messages
    expect(appended).toHaveLength(2)
    const text = JSON.stringify(appended[1])
    expect(text).toContain('<recalled-memory>')
    expect(text).toContain('deploy script')
    expect(text).toContain('not instructions')
  })

  it('falls through unchanged when explicitly disabled', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'the deploy script lives in scripts/deploy.sh')
    const { ctx, session } = await setup(store, BASE_CONFIG)

    const messages = [userMsg('how do I run the deploy script for staging?')]
    const decision = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))

    expect(decision.kind).toBe('enter')
    expect((decision as { messages: UserMessage[] }).messages).toHaveLength(1)
  })

  it('is on by factory default (schema default true)', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'the deploy script lives in scripts/deploy.sh')
    // No autoRecall keys at all: the Config schema default (true) applies.
    const { ctx, session } = await setup(store, { ...BASE_CONFIG, autoRecallEnabled: undefined })

    const messages = [userMsg('how do I run the deploy script for staging?')]
    const decision = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    expect((decision as { messages: UserMessage[] }).messages).toHaveLength(2)
  })

  it('falls through when the step text is shorter than autoRecallMinChars', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'the deploy script lives in scripts/deploy.sh')
    const { ctx, session } = await setup(store, AUTO_RECALL_CONFIG)

    const messages = [userMsg('hi there')]
    const decision = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))

    expect((decision as { messages: UserMessage[] }).messages).toHaveLength(1)
  })

  it('excludes soft-decayed entries from the fence', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'the deploy script lives in scripts/deploy.sh', { staleSince: Date.now() })
    const { ctx, session } = await setup(store, AUTO_RECALL_CONFIG)

    const messages = [userMsg('how do I run the deploy script for staging?')]
    const decision = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))

    expect((decision as { messages: UserMessage[] }).messages).toHaveLength(1)
  })

  it('stamps a lightweight recall: fence source, search not counted', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'the deploy script lives in scripts/deploy.sh')
    const { ctx, session } = await setup(store, AUTO_RECALL_CONFIG)

    const messages = [userMsg('how do I run the deploy script for staging?')]
    await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))

    // The fence's search must NOT count as a tool read…
    expect(store.lastSearch?.recordRecall).toBe(false)
    // …and the one stamp it writes is the lightweight fence tier.
    expect(store.recallStamps).toHaveLength(1)
    expect(store.recallStamps[0]).toMatchObject({ source: 'fence' })
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
    const decision = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))

    expect((decision as { messages: UserMessage[] }).messages).toHaveLength(1)
  })
})

describe('digest emission (digest mode)', () => {
  it('appends the digest inventory once per session, before any recall block', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'cordis plugins register services', { category: 'insight', anchors: ['cordis'] })
    store.addFixture('project', 'this repo uses pnpm', { category: 'convention', projectName: 'dsh-memory' })
    const { ctx, session } = await setup(store, DIGEST_CONFIG)

    const messages = [userMsg('tell me about the repository conventions')]
    const first = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    const appendedFirst = (first as { messages: UserMessage[] }).messages
    expect(appendedFirst).toHaveLength(2)
    const text = JSON.stringify(appendedFirst[1])
    expect(text).toContain('<memory-digest>')
    expect(text).toContain('project · dsh-memory: convention ×1')
    expect(text).toContain('global: insight ×1')
    expect(text).toContain('cordis')
    expect(text).toContain('[2 entries]')

    // Second step of the same session: the digest is NOT re-appended.
    const second = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    expect((second as { messages: UserMessage[] }).messages).toHaveLength(1)
  })

  it('digest does not count as a recall: no markRecalled, no search', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'a stored fact about the environment', { anchors: ['env'] })
    const { ctx, session } = await setup(store, DIGEST_CONFIG)

    const messages = [userMsg('anything stored about the environment here?')]
    await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))

    expect(store.recallStamps).toHaveLength(0)
    expect(store.lastSearch).toBeUndefined()
  })

  it('merges digest and recall into ONE message, digest first', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'the deploy script lives in scripts/deploy.sh', { anchors: ['deploy'] })
    const { ctx, session } = await setup(store, { ...DIGEST_CONFIG, autoRecallEnabled: true, autoRecallLimit: 5, autoRecallMinChars: 12 })

    const messages = [userMsg('how do I run the deploy script for staging?')]
    const decision = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    const appended = (decision as { messages: UserMessage[] }).messages
    // One plugin message, not two.
    expect(appended).toHaveLength(2)
    const text = JSON.stringify(appended[1])
    expect(text).toContain('<memory-digest>')
    expect(text).toContain('<recalled-memory>')
    expect(text.indexOf('<memory-digest>')).toBeLessThan(text.indexOf('<recalled-memory>'))
  })

  it('digest fires even when auto recall skips a short step (independent switches)', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'a stored fact', { anchors: ['fact'] })
    const { ctx, session } = await setup(store, { ...DIGEST_CONFIG, autoRecallEnabled: true, autoRecallLimit: 5, autoRecallMinChars: 12 })

    const messages = [userMsg('hi')]
    const decision = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    const appended = (decision as { messages: UserMessage[] }).messages
    expect(appended).toHaveLength(2)
    const text = JSON.stringify(appended[1])
    expect(text).toContain('<memory-digest>')
    expect(text).not.toContain('<recalled-memory>')
  })

  it('compaction/end re-arms the digest for the next step', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'a stored fact', { anchors: ['fact'] })
    const { ctx, session } = await setup(store, DIGEST_CONFIG)

    const messages = [userMsg('first step of the session')]
    await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    const second = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    expect((second as { messages: UserMessage[] }).messages).toHaveLength(1)

    // A failed compaction does not re-arm…
    ctx.emit('session/event', session, { type: 'compaction/end', seq: 90, time: 0, data: { compactionId: 'c9', error: new Error('boom') } })
    const afterFail = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    expect((afterFail as { messages: UserMessage[] }).messages).toHaveLength(1)

    // …a successful one does: the rebuilt prefix gets a fresh inventory.
    ctx.emit('session/event', session, { type: 'compaction/end', seq: 91, time: 0, data: { compactionId: 'c1' } })
    const afterCompaction = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    const appended = (afterCompaction as { messages: UserMessage[] }).messages
    expect(appended).toHaveLength(2)
    expect(JSON.stringify(appended[1])).toContain('<memory-digest>')
  })

  it('a zero budget emits nothing and does not set the per-session flag (live raise applies next step)', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'a stored fact', { anchors: ['fact'] })
    const { ctx, session } = await setup(store, { ...DIGEST_CONFIG, memoryDigestCharLimit: 0 }, true)

    const messages = [userMsg('first step of the session')]
    const first = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    expect((first as { messages: UserMessage[] }).messages).toHaveLength(1)

    // Raising the budget live takes effect on the very next step — proof the
    // disabled step never set the sent flag.
    await ctx.settings.update('memory', { memoryDigestCharLimit: 800 })
    const second = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    const appended = (second as { messages: UserMessage[] }).messages
    expect(appended).toHaveLength(2)
    expect(JSON.stringify(appended[1])).toContain('<memory-digest>')
  })

  it('no digest in other modes; no digest message without a session', async () => {
    const store = new StaticStore()
    store.addFixture('global', 'a stored fact', { anchors: ['fact'] })
    const { ctx, session } = await setup(store, BASE_CONFIG)
    const messages = [userMsg('first step of the session')]
    const decision = await ctx.waterfall('agent/pre-step', stepPayload(session, messages), innerNext(messages))
    expect(JSON.stringify(decision)).not.toContain('<memory-digest>')

    // digest mode but no session on the payload: the per-session digest cannot
    // ride (nothing to deduplicate against).
    const { ctx: ctx2 } = await setup(new StaticStore(), { ...DIGEST_CONFIG, autoRecallEnabled: false }, false)
    const noSession = [userMsg('first step of the session')]
    const decision2 = await ctx2.waterfall('agent/pre-step', { messages: noSession, turn: 0, step: 0, signal: testSignal }, innerNext(noSession))
    expect(JSON.stringify(decision2)).not.toContain('<memory-digest>')
  })
})
