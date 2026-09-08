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

describe('identity sections (soul / user-profile) — freeze, refreeze, gate', () => {
  /** Boot memory-context with a controllable fake identity service (the real service is covered in identity.spec). */
  async function setupIdentity(overrides: Record<string, unknown> = {}) {
    const ctx = new Context()
    const sections = new Map<string, { order: number; text: (asm: unknown) => string }>()
    const fakeSystemPrompt = {
      section: (def: { name: string; order: number; text: (asm: unknown) => string }) => {
        sections.set(def.name, def)
        return () => {}
      },
    }
    ctx.provide('systemPrompt', fakeSystemPrompt)
    let soul = ''
    let user = ''
    ctx.provide('identity', { snapshotFor: () => ({ soul, user }) })
    ctx.provide('memory', new MutableStore())
    await ctx.plugin(context, {
      ...CONFIG,
      identityEnabled: true,
      soulCharLimit: 2000,
      userCharLimit: 3000,
      ...overrides,
    } as never)
    const session = { header: { cwd: '' } } as unknown as Session
    const assembleCtx = { agent: { session } }
    return {
      ctx,
      sections,
      session,
      setDocuments: (nextSoul: string, nextUser: string) => { soul = nextSoul; user = nextUser },
      soulText: (): string => sections.get('soul')!.text(assembleCtx),
      profileText: (): string => sections.get('user-profile')!.text(assembleCtx),
    }
  }

  it('registers soul at order 80 and user-profile at order 81', async () => {
    const { sections } = await setupIdentity()
    expect(sections.get('soul')?.order).toBe(80)
    expect(sections.get('user-profile')?.order).toBe(81)
  })

  it('freezes the identity snapshot at session start; growth waits for the compaction boundary', async () => {
    const { ctx, session, setDocuments, soulText, profileText } = await setupIdentity()
    setDocuments('初版人格', '初版画像')
    ctx.emit('session/created', session)
    expect(soulText()).toContain('初版人格')
    expect(profileText()).toContain('初版画像')
    // Mid-session growth must not perturb the frozen prompt prefix.
    setDocuments('生长后的人格', '生长后的画像')
    expect(soulText()).toContain('初版人格')
    // The compaction boundary re-freezes and surfaces the growth.
    ctx.emit('session/event', session, { type: 'compaction/end', seq: 101, time: 0, data: { compactionId: 'c3' } })
    expect(soulText()).toContain('生长后的人格')
    expect(profileText()).toContain('生长后的画像')
  })

  it('identity disabled: both sections render empty regardless of the snapshot', async () => {
    const { ctx, session, setDocuments, soulText, profileText } = await setupIdentity({ identityEnabled: false })
    setDocuments('人格', '画像')
    ctx.emit('session/created', session)
    expect(soulText()).toBe('')
    expect(profileText()).toBe('')
  })

  it('live budget: the section applies soulCharLimit at assembly with a truncation footer', async () => {
    const { ctx, session, setDocuments, soulText } = await setupIdentity({ soulCharLimit: 60 })
    setDocuments('很长的人格文档，超过六十个字符预算的时候应当被截断并附上注脚说明。'.repeat(4), '画像')
    ctx.emit('session/created', session)
    expect(soulText()).toContain('truncated at 60 characters')
  })
})
