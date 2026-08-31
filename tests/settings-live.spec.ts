/**
 * Live settings tests: every bundle plugin re-reads its namespace per
 * event/call, so a frontend settings change applies without a restart, with
 * layering schema defaults < composition entry < user document.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId as CallId } from '@deepseek-ai/dsh-llm'
import { MemoryStore } from '../src/index.ts'
import type { MemoryEntry, MemoryId, MemorySearchQuery } from '../src/types.ts'
import * as tool from '../src/tool/index.ts'
import * as review from '../src/review/index.ts'
import * as context from '../src/context/index.ts'

/** In-memory settings provider: a raw-document store with no IO. */
class TestSettingsProvider extends SettingsProvider {
  override get writable() { return true }
  private doc: Record<string, unknown> = {}
  protected override async load(): Promise<Record<string, unknown>> { return this.doc }
  protected override async persist(ns: Parameters<SettingsProvider['update']>[0], section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: section }
  }
}

/** Minimal in-memory store (same shape as the one in tests/tools.spec.ts). */
class MiniStore extends MemoryStore {
  readonly janitorDays: number[] = []
  private readonly entries: MemoryEntry[] = []
  constructor(count: number) {
    super()
    for (let i = 0; i < count; i++) {
      this.entries.push({ id: `mem-${i}` as MemoryId, scope: 'global', content: `entry ${i}`, createdAt: i, updatedAt: i })
    }
  }
  override async add(): Promise<{ entry: MemoryEntry }> { throw new Error('unused') }
  override get(id: string): MemoryEntry | undefined { return this.entries.find(e => e.id === id as MemoryId) }
  override list(scope?: MemoryEntry['scope']): readonly MemoryEntry[] {
    return scope === undefined ? this.entries : this.entries.filter(e => e.scope === scope)
  }
  override async update(): Promise<MemoryEntry | undefined> { return undefined }
  override async remove(id: string): Promise<boolean> { return this.get(id) !== undefined }
  override search(query: MemorySearchQuery): { entries: readonly MemoryEntry[]; total: number } {
    const limit = query.limit ?? 50
    return { entries: limit > 0 ? this.entries.slice(0, limit) : this.entries, total: this.entries.length }
  }
  override async janitor(decayDays: number): Promise<number> { this.janitorDays.push(decayDays); return 0 }
}

const testSignal = new AbortController().signal
let callCounter = 0
const MEMORY_NS = 'memory' as const

describe('maxSearchResults — live layering via the memory namespace', () => {
  async function setup(compositionCap: number) {
    const ctx = new Context()
    await ctx.plugin(TestSettingsProvider)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('memory', new MiniStore(3))
    // memory-context registers the `memory` namespace; tool-memory reads from it.
    await ctx.plugin(context, {} as never)
    await ctx.plugin(tool, { maxSearchResults: compositionCap })
    return ctx
  }
  function search(ctx: Context) {
    return ctx.tools.execute({ signal: testSignal, callId: CallId(`call-${++callCounter}`), name: 'memory_search', arguments: {} })
  }
  type SearchResult = { entries: unknown[]; total: number }
  const count = async (ctx: Context) => ((await search(ctx)).value as SearchResult).entries.length

  it('composition entry is the base; the user namespace overlays it live', async () => {
    const ctx = await setup(2)
    // memory-context registers the `memory` namespace with schema defaults
    // (maxSearchResults=50), so all 3 entries are returned initially.
    expect(await count(ctx)).toBe(3)
    // user override in the `memory` namespace applies to the very next call.
    await ctx.settings.update(MEMORY_NS, { maxSearchResults: 1 })
    expect(await count(ctx)).toBe(1)
    // Reset falls back to the schema default (50).
    await ctx.settings.replace(MEMORY_NS, {})
    expect(await count(ctx)).toBe(3)
  })

  it('falls back to the composition entry when no settings service is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('memory', new MiniStore(3))
    await ctx.plugin(tool, { maxSearchResults: 2 })
    expect(await count(ctx)).toBe(2)
  })

  it('falls back to the composition entry when the settings provider unloads', async () => {
    const ctx = new Context()
    const settingsFiber = await ctx.plugin(TestSettingsProvider)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('memory', new MiniStore(3))
    await ctx.plugin(context, {} as never)
    await ctx.plugin(tool, { maxSearchResults: 2 })
    // The user layer applies live while the provider stands.
    await ctx.settings.update(MEMORY_NS, { maxSearchResults: 1 })
    expect(await count(ctx)).toBe(1)
    // Unloading the provider (not the consumer) drops every consumer back to
    // its composition entry: memory-context's installSection detach wiring and
    // tool-memory's namespace read both return to the entry cap.
    await settingsFiber.dispose()
    expect(await count(ctx)).toBe(2)
  })
})

describe('decayDays — live via the memory namespace, consumed by memory-review', () => {
  async function setup() {
    const ctx = new Context()
    await ctx.plugin(TestSettingsProvider)
    await ctx.plugin(SystemPrompt)
    ctx.provide('llm', {})
    const store = new MiniStore(0)
    ctx.provide('memory', store)
    // memory-context owns the `memory` namespace (where decayDays now lives);
    // memory-review reads it cross-namespace at each session/created event.
    await ctx.plugin(context, {} as never)
    await ctx.plugin(review, {})
    return { ctx, store }
  }

  it('janitor reads decayDays per session: default → user override → disabled', async () => {
    const { ctx, store } = await setup()
    // Schema default is 30.
    ctx.emit('session/created', {})
    expect(store.janitorDays).toEqual([30])
    // User override in the `memory` namespace applies to the next event.
    await ctx.settings.update(MEMORY_NS, { decayDays: 45 })
    ctx.emit('session/created', {})
    expect(store.janitorDays).toEqual([30, 45])
    // 0 disables the janitor on the next event.
    await ctx.settings.update(MEMORY_NS, { decayDays: 0 })
    ctx.emit('session/created', {})
    expect(store.janitorDays).toEqual([30, 45])
  })

  it('falls back to the schema default (30) when no settings service is mounted', async () => {
    const ctx = new Context()
    ctx.provide('llm', {})
    const store = new MiniStore(0)
    ctx.provide('memory', store)
    await ctx.plugin(review, {})
    ctx.emit('session/created', {})
    expect(store.janitorDays).toEqual([30])
  })
})
