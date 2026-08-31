/**
 * Compaction-boundary snapshot refresh (§ P1-10): `session/created` freezes
 * the memory section once for KV-cache stability, and the `compaction/end`
 * boundary — the one sanctioned prefix break per session — re-freezes it so
 * memories learned mid-session surface without waiting for a new session.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { MemoryStore, validateContent } from '../src/index.ts'
import type { AddMemoryInput, MemoryEntry, MemoryId, MemorySearchQuery } from '../src/types.ts'
import * as context from '../src/context/index.ts'

/** In-memory store whose entries the test mutates between assemblies. */
class MutableStore extends MemoryStore {
  readonly entries: MemoryEntry[] = []
  private seq = 0

  override async add(input: AddMemoryInput): Promise<{ entry: MemoryEntry }> {
    validateContent(input.content)
    const now = Date.now()
    const entry: MemoryEntry = { id: `mem-${++this.seq}` as MemoryId, scope: input.scope, content: input.content, createdAt: now, updatedAt: now }
    this.entries.push(entry)
    return { entry }
  }

  override get(id: string): MemoryEntry | undefined {
    return this.entries.find(entry => entry.id === id)
  }

  override list(scope?: MemoryEntry['scope']): readonly MemoryEntry[] {
    return scope === undefined ? this.entries : this.entries.filter(entry => entry.scope === scope)
  }

  override async update(): Promise<MemoryEntry | undefined> { return undefined }
  override async remove(id: string): Promise<boolean> {
    const index = this.entries.findIndex(entry => entry.id === id)
    if (index < 0) return false
    this.entries.splice(index, 1)
    return true
  }

  override search(query: MemorySearchQuery): { entries: readonly MemoryEntry[]; total: number } {
    const limit = query.limit ?? 50
    return { entries: limit > 0 ? this.entries.slice(0, limit) : this.entries, total: this.entries.length }
  }

  override async janitor(): Promise<number> { return 0 }
}

const CONFIG = {
  memoryMode: 'full',
  memoryPolicyCustomText: '',
  memoryCharLimit: 5000,
  maxSearchResults: 50,
  decayDays: 30,
  notesEnabled: false,
  notesCharLimit: 4000,
  notesMaxEntriesPerFile: 100,
} as const

describe('compaction-boundary snapshot refresh', () => {
  async function setup() {
    const ctx = new Context()
    // Capture the registered section text providers instead of assembling.
    const sections = new Map<string, (asm: unknown) => string>()
    const fakeSystemPrompt = {
      section: (def: { name: string; order: number; text: (asm: unknown) => string }) => {
        sections.set(def.name, def.text)
        return () => {}
      },
    }
    ctx.provide('systemPrompt', fakeSystemPrompt)
    const store = new MutableStore()
    ctx.provide('memory', store)
    await ctx.plugin(context, CONFIG as never)
    const session = { header: { cwd: '' } } as unknown as Session
    const assembleCtx = { agent: { session } }
    const sectionText = (): string => sections.get('memory')!(assembleCtx)
    return { ctx, store, session, sectionText }
  }

  it('freezes at creation; compaction/end re-freezes to surface mid-session memories', async () => {
    const { ctx, store, session, sectionText } = await setup()

    await store.add({ scope: 'global', content: 'before compaction fact' })
    ctx.emit('session/created', session)

    expect(sectionText()).toContain('before compaction fact')

    // A memory learned mid-session (e.g. via review extraction) must NOT
    // perturb the frozen prompt prefix.
    await store.add({ scope: 'global', content: 'learned mid-session fact' })
    expect(sectionText()).not.toContain('learned mid-session fact')

    // The compaction boundary is the sanctioned prefix break: re-freeze.
    ctx.emit('session/event', session, { type: 'compaction/end', seq: 99, time: 0, data: { compactionId: 'c1' } })
    const refreshed = sectionText()
    expect(refreshed).toContain('before compaction fact')
    expect(refreshed).toContain('learned mid-session fact')
  })

  it('a failed compaction keeps serving the previous snapshot', async () => {
    const { ctx, store, session, sectionText } = await setup()

    await store.add({ scope: 'global', content: 'stable fact' })
    ctx.emit('session/created', session)

    await store.add({ scope: 'global', content: 'post-failure fact' })
    ctx.emit('session/event', session, { type: 'compaction/end', seq: 100, time: 0, data: { compactionId: 'c2', error: new Error('boom') } })

    expect(sectionText()).toContain('stable fact')
    expect(sectionText()).not.toContain('post-failure fact')
  })
})
