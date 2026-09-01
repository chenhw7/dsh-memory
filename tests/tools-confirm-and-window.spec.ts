/**
 * P1-1/P1-2 tool-side confirm mode and P1-5 time-window browsing:
 * - with `confirmBeforeWrite` enabled in the memory-review namespace,
 *   `memory_add` / `memory_replace` land proposals in the suggestion queue
 *   instead of writing entries (the model never self-promotes);
 * - `memory_list` accepts `since`/`until` epoch-ms bounds on createdAt.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId as CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { scanContent, validateProjectScope, MemoryStore } from '../src/index.ts'
import type { AddMemoryInput, AddSuggestionInput, AuditSource, MemoryEntry, MemoryId, MemoryHealth, MemorySearchQuery, MemorySuggestion } from '../src/types.ts'

import * as tool from '../src/tool/index.ts'

const testToolSignal = new AbortController().signal

/** In-memory stand-in for a storage-domain KV table. */
function memTable<K extends string, V>(): KvTable<K, V> {
  const map = new Map<K, V>()
  return {
    get: key => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() { return map.size },
    put: async (key, value) => { map.set(key, value) },
    update: async (key, fn) => { const cur = map.get(key); if (cur === undefined) throw new Error('missing-key'); const next = fn(cur); map.set(key, next); return next },
    delete: async key => map.delete(key),
  }
}

/**
 * A controllable store: add() takes the next timestamp from a scripted queue
 * so time-window tests can pin exact createdAt values; suggestions are
 * recorded for confirm-mode assertions.
 */
class ScriptedTimeStore extends MemoryStore {
  readonly rows = new Map<string, MemoryEntry>()
  readonly proposals: AddSuggestionInput[] = []
  private seq = 0

  /** Timestamps handed to successive add() calls. */
  clock: number[] = []

  override async add(input: AddMemoryInput): Promise<{ entry: MemoryEntry }> {
    validateProjectScope(input)
    const scan = scanContent(input.content)
    if (!scan.allowed) throw new Error(`rejected: ${scan.reasons.join('; ')}`)
    const now = this.clock.length > 0 ? this.clock.shift()! : Date.now()
    const id = `mem-${++this.seq}` as MemoryId
    const entry: MemoryEntry = {
      id,
      scope: input.scope,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      ...input.category !== undefined ? { category: input.category } : {},
      ...input.projectName !== undefined ? { projectName: input.projectName } : {},
    }
    this.rows.set(id, entry)
    return { entry }
  }

  override get(id: string): MemoryEntry | undefined {
    return this.rows.get(id)
  }

  override list(scope?: MemoryEntry['scope'], projectName?: string): readonly MemoryEntry[] {
    return [...this.rows.values()]
      .filter(e => scope === undefined || e.scope === scope)
      .filter(e => projectName === undefined || e.projectName === projectName)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  override async update(id: string, input: { content?: string; category?: MemoryEntry['category'] }): Promise<MemoryEntry | undefined> {
    const existing = this.rows.get(id)
    if (existing === undefined) return undefined
    const updated: MemoryEntry = { ...existing, content: input.content ?? existing.content, updatedAt: Date.now() }
    this.rows.set(id, updated)
    return updated
  }

  override async remove(id: string): Promise<boolean> {
    return this.rows.delete(id)
  }

  override search(query: MemorySearchQuery): { entries: readonly MemoryEntry[]; total: number } {
    const all = this.list(query.scope as MemoryEntry['scope'] | undefined).filter(e =>
      query.query === undefined || query.query.length === 0 || e.content.toLowerCase().includes(query.query.toLowerCase()))
    return { entries: all, total: all.length }
  }

  override async janitor(): Promise<number> { return 0 }

  override health(): MemoryHealth {
    return { totalEntries: this.rows.size, byScope: { global: 0, project: 0, user: 0 }, pinned: 0, auditRecords: 0 }
  }

  override exportAuditLog(): readonly [] { return [] }

  override async observeSuggestion(input: AddSuggestionInput): Promise<MemorySuggestion> {
    this.proposals.push(input)
    const now = Date.now()
    return {
      id: `sg-${this.proposals.length}` as never,
      scope: input.scope,
      content: input.content,
      hits: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      source: input.source as AuditSource,
      ...input.targetEntryId !== undefined ? { targetEntryId: input.targetEntryId } : {},
    }
  }
}

async function setup(settings?: { maxSearchResults?: number; confirmBeforeWrite?: boolean }): Promise<{ ctx: Context; store: ScriptedTimeStore }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const store = new ScriptedTimeStore()
  ctx.provide('memory', store)
  if (settings !== undefined) {
    ctx.provide('settings', {
      get: (ns: string) => ns === 'memory-review'
        ? { confirmBeforeWrite: settings.confirmBeforeWrite ?? false }
        : { maxSearchResults: settings.maxSearchResults ?? 50 },
    })
  }
  await ctx.plugin(tool, { maxSearchResults: 50 })
  return { ctx, store }
}

let callCounter = 0
function callTool(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
  })
}

describe('memory_list time windows (P1-5)', () => {
  const DAY = 24 * 60 * 60 * 1000
  const T1 = 1_700_000_000_000
  const T2 = T1 + DAY
  const T3 = T1 + 2 * DAY

  async function seed(): Promise<{ ctx: Context; store: ScriptedTimeStore }> {
    const env = await setup()
    env.store.clock = [T1, T2, T3]
    await callTool(env.ctx, 'memory_add', { scope: 'global', content: 'day one fact' })
    await callTool(env.ctx, 'memory_add', { scope: 'global', content: 'day two fact' })
    await callTool(env.ctx, 'memory_add', { scope: 'global', content: 'day three fact' })
    return env
  }

  it('since keeps entries created at or after the bound', async () => {
    const { ctx } = await seed()
    const result = await callTool(ctx, 'memory_list', { since: T2 })
    const value = result.value as { total: number; entries: { content: string }[]; earliest: number }
    expect(value.total).toBe(2)
    expect(value.entries.map(e => e.content)).toEqual(['day three fact', 'day two fact'])
    expect(value.earliest).toBe(T2)
  })

  it('until keeps entries created at or before the bound', async () => {
    const { ctx } = await seed()
    const result = await callTool(ctx, 'memory_list', { until: T2 })
    const value = result.value as { total: number; entries: { content: string }[] }
    expect(value.total).toBe(2)
    expect(value.entries.map(e => e.content)).toEqual(['day two fact', 'day one fact'])
  })

  it('since+until brackets an inclusive window and pages inside it', async () => {
    const { ctx } = await seed()
    const result = await callTool(ctx, 'memory_list', { since: T1 + 1, until: T3 - 1 })
    let value = result.value as { total: number; entries: { content: string }[] }
    expect(value.total).toBe(1)
    expect(value.entries[0]!.content).toBe('day two fact')
    // Pagination composes with the window: newest-first page 3 of 3.
    const page = await callTool(ctx, 'memory_list', { since: T1, until: T3, limit: 2, offset: 2 })
    value = page.value as { total: number; entries: { content: string }[] }
    expect(value.total).toBe(3)
    expect(value.entries.map(e => e.content)).toEqual(['day one fact'])
  })

  it('an empty window over a non-empty store suggests widening the filters', async () => {
    const { ctx } = await seed()
    const result = await callTool(ctx, 'memory_list', { since: T3 + DAY, until: T3 + 2 * DAY })
    const value = result.value as { total: number; hint?: string }
    expect(value.total).toBe(0)
    expect(value.hint).toBeTruthy()
  })

  it('combines with the scope filter', async () => {
    const env = await setup()
    env.store.clock = [T1, T2]
    await callTool(env.ctx, 'memory_add', { scope: 'global', content: 'g early' })
    await callTool(env.ctx, 'memory_add', { scope: 'user', content: 'u late' })
    const result = await callTool(env.ctx, 'memory_list', { scope: 'user', since: T1 })
    const value = result.value as { total: number; entries: { scope: string }[] }
    expect(value.total).toBe(1)
    expect(value.entries[0]!.scope).toBe('user')
  })
})

describe('tool writes under human-confirm mode (P1-1/P1-2)', () => {
  it('memory_add queues a proposal and stores nothing when confirmBeforeWrite is on', async () => {
    const { ctx, store } = await setup({ confirmBeforeWrite: true })
    const result = await callTool(ctx, 'memory_add', { scope: 'global', content: 'proposed convention', category: 'convention' })
    expect(result.isError).toBe(false)
    const value = result.value as { entry?: unknown; pending?: boolean; suggestionId?: string }
    expect(value.entry).toBeUndefined()
    expect(value.pending).toBe(true)
    expect(value.suggestionId).toBe('sg-1')
    expect(store.rows.size).toBe(0)
    expect(store.proposals).toHaveLength(1)
    expect(store.proposals[0]).toMatchObject({ scope: 'global', content: 'proposed convention', category: 'convention', source: 'tool' })
  })

  it('memory_replace against an existing entry targets it (P1-2) without rewriting it', async () => {
    const { ctx, store } = await setup({ confirmBeforeWrite: true })
    // Seed directly through the store: under confirm mode the tool path
    // queues instead of writing, so the fixture needs a pre-existing entry.
    const { entry: before } = await store.add({ scope: 'global', content: 'current truth', source: 'ui' })

    const result = await callTool(ctx, 'memory_replace', { id: before.id, content: 'proposed new truth' })
    const value = result.value as { found: boolean; pending?: boolean; suggestionId?: string; entry?: unknown }
    expect(value.found).toBe(true)
    expect(value.pending).toBe(true)
    expect(value.entry).toBeUndefined()
    // The targeted entry keeps its old content until a human adopts.
    expect(store.get(before.id)!.content).toBe('current truth')
    expect(store.proposals[0]).toMatchObject({ targetEntryId: before.id, content: 'proposed new truth', source: 'tool' })
  })

  it('memory_replace on an absent id still reports found:false in confirm mode', async () => {
    const { ctx, store } = await setup({ confirmBeforeWrite: true })
    const result = await callTool(ctx, 'memory_replace', { id: 'missing', content: 'nope' })
    const value = result.value as { found: boolean }
    expect(value.found).toBe(false)
    expect(store.proposals).toHaveLength(0)
  })

  it('writes stay direct when confirmBeforeWrite is off (default behavior unchanged)', async () => {
    const { ctx, store } = await setup({ confirmBeforeWrite: false })
    const result = await callTool(ctx, 'memory_add', { scope: 'global', content: 'direct write' })
    const value = result.value as { entry?: { content: string }; pending?: boolean }
    expect(value.pending).toBeUndefined()
    expect(value.entry!.content).toBe('direct write')
    expect(store.rows.size).toBe(1)

    const replaceResult = await callTool(ctx, 'memory_replace', { id: value.entry && [...store.rows.values()][0]!.id, content: 'direct rewrite' })
    const replaceValue = replaceResult.value as { entry?: { content: string }; pending?: boolean }
    expect(replaceValue.pending).toBeUndefined()
    expect(replaceValue.entry!.content).toBe('direct rewrite')
    expect(store.proposals).toHaveLength(0)
  })

  it('a deployment without the memory-review namespace composed keeps automatic writes', async () => {
    const { ctx, store } = await setup(undefined)
    const result = await callTool(ctx, 'memory_add', { scope: 'global', content: 'auto path' })
    const value = result.value as { entry?: { content: string }; pending?: boolean }
    expect(value.pending).toBeUndefined()
    expect(store.rows.size).toBe(1)
  })
})
