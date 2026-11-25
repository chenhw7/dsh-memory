/**
 * Live settings tests: every plugin reads its knobs per event/call, so a
 * settings change applies without a restart. Under the host's per-entry
 * configuration model the layering is schema defaults < composition entry <
 * user document resolved by the HOST into that entry's `Config`, and a change
 * re-runs the entry's `apply`. Cross-entry knobs ride the owning service
 * (`ctx.memory.settings()`, `ctx.identity.settings()`, …), so a consumer never
 * caches a sibling's value.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolCallId as CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryStore } from '../src/index.ts'
import type { MemoryEntry, MemoryId, MemorySearchQuery } from '../src/types.ts'
import * as tool from '../src/tool/index.ts'
import * as review from '../src/review/index.ts'
import * as context from '../src/context/index.ts'
import * as identity from '../src/identity/index.ts'
import * as store from '../src/store/index.ts'
import * as notes from '../src/notes/index.ts'
import { resolveInjectionSettings } from '../src/store/settings.ts'
import type { MemoryInjectionSettings } from '../src/store/settings.ts'

/** Minimal in-memory store (same shape as the one in tests/tools.spec.ts). */
class MiniStore extends MemoryStore {
  readonly janitorDays: number[] = []
  private readonly entries: MemoryEntry[] = []
  /** The `memory` entry slice this stand-in publishes; see {@link MemoryStore.settings}. */
  private injection: MemoryInjectionSettings

  constructor(count: number, injection: Partial<MemoryInjectionSettings> = {}) {
    super()
    this.injection = resolveInjectionSettings(injection)
    for (let i = 0; i < count; i++) {
      this.entries.push({ id: `mem-${i}` as MemoryId, scope: 'global', content: `entry ${i}`, createdAt: i, updatedAt: i })
    }
  }

  /** Republish the slice — what re-running the `memory` entry's apply does. */
  setInjection(value: Partial<MemoryInjectionSettings>): void {
    this.injection = resolveInjectionSettings(value)
  }

  override settings(): MemoryInjectionSettings { return this.injection }
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

describe('maxSearchResults — the memory entry owns the cap', () => {
  async function setup(compositionCap = 50, injection: Partial<MemoryInjectionSettings> = {}) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeExecutor)
    const memory = new MiniStore(3, injection)
    ctx.provide('memory', memory)
    await ctx.plugin(tool, { maxSearchResults: compositionCap })
    return { ctx, memory }
  }

  type SearchResult = { entries: unknown[]; total: number }
  async function count(ctx: Context): Promise<number> {
    const batch = await ctx.tools.execute({
      signal: testSignal,
      calls: [{ type: 'tool-call', id: CallId(`call-${++callCounter}`), name: 'memory_search', arguments: '{}' }],
    })
    const settled = batch.results[0]!.result
    return (settled.value as SearchResult).entries.length
  }

  it('the store entry is the base; a live change applies to the very next call', async () => {
    const { ctx, memory } = await setup()
    // Schema default (50) caps nothing here, so all 3 entries come back.
    expect(await count(ctx)).toBe(3)
    // The user document lands in the `memory` entry; the host re-runs its
    // apply, which republishes the slice the tool reads per call.
    memory.setInjection({ maxSearchResults: 1 })
    expect(await count(ctx)).toBe(1)
    // Resetting the document falls back to the schema default (50).
    memory.setInjection({})
    expect(await count(ctx)).toBe(3)
  })

  it('the tool row\'s own cap never overrides the store entry', async () => {
    // A deployment whose tool row still carries the pre-migration key gets
    // the store entry's value: the cap belongs to the entry that owns it.
    const { ctx } = await setup(2)
    expect(await count(ctx)).toBe(3)
  })

  it('the cap is re-read per call, never cached in the tool', async () => {
    const { ctx, memory } = await setup()
    memory.setInjection({ maxSearchResults: 1 })
    expect(await count(ctx)).toBe(1)
    memory.setInjection({ maxSearchResults: 3 })
    expect(await count(ctx)).toBe(3)
  })
})

describe('decayDays — owned by the memory entry, consumed by memory-review', () => {
  async function setup() {
    const ctx = new Context()
    ctx.provide('llm', {})
    const memory = new MiniStore(0)
    ctx.provide('memory', memory)
    await ctx.plugin(review, {})
    return { ctx, memory }
  }

  it('the janitor reads decayDays per session: default → user override → disabled', async () => {
    const { ctx, memory } = await setup()
    // Schema default is 30.
    ctx.emit('session/created', {})
    expect(memory.janitorDays).toEqual([30])
    // A change to the `memory` entry applies to the next event.
    memory.setInjection({ decayDays: 45 })
    ctx.emit('session/created', {})
    expect(memory.janitorDays).toEqual([30, 45])
    // 0 disables the janitor on the next event.
    memory.setInjection({ decayDays: 0 })
    ctx.emit('session/created', {})
    expect(memory.janitorDays).toEqual([30, 45])
  })

  it('a composition without the memory service keeps session/created silent', async () => {
    const ctx = new Context()
    ctx.provide('llm', {})
    await ctx.plugin(review, {})
    // No store to decay: the handler falls back to the builtin window and
    // returns without throwing.
    expect(() => { ctx.emit('session/created', {}) }).not.toThrow()
  })
})

describe('per-entry Config — one schema per settings page section', () => {
  it('each entry schema carries only its own slice', () => {
    // The plugins page binds one section per entry to that entry's ConfigForm,
    // so a key living in the wrong schema would surface on the wrong card.
    const memorySchema = JSON.stringify(store.Config)
    expect(memorySchema).toContain('memoryMode')
    expect(memorySchema).toContain('decayDays')
    expect(memorySchema).toContain('maxSearchResults')
    expect(memorySchema).not.toContain('notesEnabled')
    expect(memorySchema).not.toContain('identityEnabled')
    expect(memorySchema).not.toContain('autoRecallEnabled')

    const notesSchema = JSON.stringify(notes.Config)
    expect(notesSchema).toContain('notesEnabled')
    expect(notesSchema).not.toContain('identityEnabled')
    expect(notesSchema).not.toContain('memoryMode')

    const autoRecallSchema = JSON.stringify(context.Config)
    expect(autoRecallSchema).toContain('autoRecallEnabled')
    expect(autoRecallSchema).toContain('hitSignalEnabled')
    expect(autoRecallSchema).not.toContain('memoryMode')
    expect(autoRecallSchema).not.toContain('identityEnabled')

    const identitySchema = JSON.stringify(identity.Config)
    expect(identitySchema).toContain('identityEnabled')
    expect(identitySchema).toContain('soulCharLimit')
    expect(identitySchema).not.toContain('autoRecallEnabled')
  })

  it('a live change to the auto-recall entry arms and disarms the pre-step fence', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.provide('memory', new MiniStore(3))
    const fiber = await ctx.plugin(context, context.Config({}))
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'how do I run the deploy script for staging?' }], source: { kind: 'user' } })]
    const payload = { agent: { session: undefined }, messages, turn: 0, step: 0, signal: new AbortController().signal }
    const innerNext = async (): Promise<{ kind: string; messages: unknown[] }> => ({ kind: 'enter', messages })
    // Factory default ON: the fence appends on the first step.
    const before = await ctx.waterfall('agent/pre-step', payload, innerNext)
    expect((before as { messages: unknown[] }).messages).toHaveLength(2)

    // A card write re-runs this entry's apply; the fence obeys the next step.
    await fiber.dispose()
    const offFiber = await ctx.plugin(context, context.Config({ autoRecallEnabled: false }))
    const off = await ctx.waterfall('agent/pre-step', payload, innerNext)
    expect((off as { messages: unknown[] }).messages).toHaveLength(1)

    // And back on again — live, no restart.
    await offFiber.dispose()
    await ctx.plugin(context, context.Config({ autoRecallEnabled: true }))
    const after = await ctx.waterfall('agent/pre-step', payload, innerNext)
    const appended = (after as { messages: unknown[] }).messages
    expect(appended).toHaveLength(2)
    expect(JSON.stringify(appended[1])).toContain('<recalled-memory>')
  })

  it('identity enablement rides the identity entry live', async () => {
    const ctx = new Context()
    ctx.provide('memory', new MiniStore(0))
    const fiber = await ctx.plugin(identity, identity.Config({}))
    // Disabled by default: the empty snapshot.
    expect(ctx.get('identity')!.snapshotFor()).toEqual({ soul: '', user: '' })

    // The card write re-runs the entry's apply: the next read sees it.
    await fiber.dispose()
    const enabled = await ctx.plugin(identity, identity.Config({ identityEnabled: true }))
    expect(ctx.get('identity')!.snapshotFor().soul.length).toBeGreaterThan(0)

    await enabled.dispose()
    await ctx.plugin(identity, identity.Config({ identityEnabled: false }))
    expect(ctx.get('identity')!.snapshotFor()).toEqual({ soul: '', user: '' })
  })
})
