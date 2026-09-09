/**
 * Compaction-boundary snapshot refresh (§ P1-10): `session/created` freezes
 * the memory section once for KV-cache stability, and the `compaction/end`
 * boundary — the one sanctioned prefix break per session — re-freezes it so
 * memories learned mid-session surface without waiting for a new session.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { Session } from '@deepseek-ai/dsh-session'
import { MemoryStore, validateContent } from '../src/index.ts'
import type { AddMemoryInput, MemoryEntry, MemoryId, MemorySearchQuery } from '../src/types.ts'
import * as context from '../src/context/index.ts'
import * as notes from '../src/notes/index.ts'

/** In-memory store whose entries the test mutates between assemblies. */
class MutableStore extends MemoryStore {
  readonly entries: MemoryEntry[] = []
  private seq = 0

  /** Explicit timestamps override the wall clock, for tests whose result
   * depends on the `updatedAt` order the notes priority sort reads. */
  override async add(input: AddMemoryInput & { readonly createdAt?: number; readonly updatedAt?: number }): Promise<{ entry: MemoryEntry }> {
    validateContent(input.content)
    const now = Date.now()
    const entry: MemoryEntry = {
      id: `mem-${++this.seq}` as MemoryId,
      scope: input.scope,
      content: input.content,
      ...(input.category !== undefined ? { category: input.category } : {}),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    }
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
  memoryDigestCharLimit: 800,
  memoryMaxEntries: 20,
  maxSearchResults: 50,
  decayDays: 30,
  notesEnabled: false,
  notesConventionsCharLimit: 1600,
  notesPitfallsCharLimit: 800,
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

  it('the memory section is byte-identical across turns (frozen prefix)', async () => {
    const { ctx, store, session, sectionText } = await setup()
    await store.add({ scope: 'global', content: 'stable fact one' })
    ctx.emit('session/created', session)
    const first = sectionText()
    // Repeated assemblies with no compaction must return the SAME bytes —
    // this is the KV-cache stability the freeze exists for.
    expect(sectionText()).toBe(first)
    expect(sectionText()).toBe(first)
    // Mid-session store writes do not perturb the frozen text either.
    await store.add({ scope: 'global', content: 'mid-session fact' })
    const afterWrite = sectionText()
    expect(afterWrite).toBe(first)
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
    // The budget is a whole-section cap: it must carry the frame (opening +
    // note + footnote + closing), so a truncating budget sits a few hundred
    // chars above the note alone.
    const { ctx, session, setDocuments, soulText } = await setupIdentity({ soulCharLimit: 400 })
    setDocuments('很长的人格文档，超过四百个字符预算的时候应当被截断并附上注脚说明，同时闭合标签必须完好。'.repeat(4), '画像')
    ctx.emit('session/created', session)
    expect(soulText()).toContain('truncated at 400 characters')
    expect(soulText().endsWith('</soul>')).toBe(true)
    // A budget below the frame drops the section instead of slicing the fence.
    const tiny = await setupIdentity({ soulCharLimit: 60 })
    tiny.setDocuments('人格', '画像')
    tiny.ctx.emit('session/created', tiny.session)
    expect(tiny.soulText()).toBe('')
  })
})

/** An in-memory settings provider so live settings writes reach the plugins. */
class TestSettingsProvider extends SettingsProvider {
  override get writable() { return true }
  private doc: Record<string, unknown> = {}
  protected override async load(): Promise<Record<string, unknown>> { return this.doc }
  protected override async persist(ns: Parameters<SettingsProvider['update']>[0], section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: section }
  }
}

describe('project-notes budget — frozen at snapshot time, not per assembly', () => {
  it('a live notes-budget change lands at the next freeze (compaction), not the next assembly', async () => {
    const ctx = new Context()
    await ctx.plugin(TestSettingsProvider)
    const sections = new Map<string, { order: number; text: (asm: unknown) => string }>()
    ctx.provide('systemPrompt', {
      section: (def: { name: string; order: number; text: (asm: unknown) => string }) => {
        sections.set(def.name, def)
        return () => {}
      },
    })
    const store = new MutableStore()
    ctx.provide('memory', store)
    await ctx.plugin(notes, {})
    await ctx.plugin(context, { ...CONFIG, notesEnabled: true } as never)

    // Two convention entries: only the first survives the tiny budget once it lands.
    await store.add({ scope: 'global', content: 'first convention with a fairly long body text', category: 'convention' } as never)
    await store.add({ scope: 'global', content: 'second convention with a fairly long body text', category: 'convention' } as never)

    const session = { header: { cwd: '' } } as unknown as Session
    const assembleCtx = { agent: { session } }
    const notesText = (): string => sections.get('project-notes')!.text(assembleCtx)

    // Freeze under the default budget: both entries render.
    ctx.emit('session/created', session)
    expect(notesText()).toContain('first convention')
    expect(notesText()).toContain('second convention')

    // Shrink the conventions budget live. Assemblies keep serving the FROZEN
    // snapshot — the change must not apply per assembly.
    await ctx.settings.update('memory-notes', { notesConventionsCharLimit: 230 })
    const frozen = notesText()
    expect(frozen).toContain('second convention')
    expect(notesText()).toBe(frozen)

    // The compaction boundary is where the budget re-applies: the squeezed
    // entry now folds into a count line instead of rendering.
    ctx.emit('session/event', session, { type: 'compaction/end', seq: 101, time: 0, data: { compactionId: 'c-budget' } })
    const refrozen = notesText()
    expect(refrozen).not.toBe(frozen)
    expect(refrozen).toMatch(/\(another \d+ global practices — use memory_search\)/)
  })

  it('the deprecated notesCharLimit derives both budgets end-to-end through the settings document', async () => {
    // README promises the 0.9.x combined key still works. The unit test pins
    // the resolver; this pins the whole path — schemastery's non-strict merge
    // passing the unknown key through the `memory-notes` namespace, the notes
    // service's injected-fiber read, and the 60/40 derivation — so a stored
    // `notesCharLimit` behaves exactly like the two explicit keys it derives.
    async function boot(seed: Record<string, unknown>) {
      const ctx = new Context()
      await ctx.plugin(TestSettingsProvider)
      const sections = new Map<string, { order: number; text: (asm: unknown) => string }>()
      ctx.provide('systemPrompt', {
        section: (def: { name: string; order: number; text: (asm: unknown) => string }) => {
          sections.set(def.name, def)
          return () => {}
        },
      })
      const store = new MutableStore()
      ctx.provide('memory', store)
      await ctx.plugin(notes, {})
      // The composition base must NOT pin the new budget keys, or they would
      // shadow the deprecated-key derivation (absence is the resolver's
      // signal) — exactly the state a pre-migration deployment is in.
      const { notesConventionsCharLimit: _c, notesPitfallsCharLimit: _p, ...base } = CONFIG
      await ctx.plugin(context, { ...base, notesEnabled: true } as never)
      // Enough conventions that a 300- vs 500-char budget renders differently.
      // Fixed timestamps: the render sorts by `updatedAt`, so wall-clock
      // stamps would make this cross-boot byte-compare depend on whether a
      // millisecond ticked mid-seeding.
      const t0 = Date.UTC(2026, 0, 1)
      for (let i = 0; i < 14; i++) {
        await store.add({ scope: 'global', content: `convention ${i}: a body long enough to measure the budget cut precisely`, category: 'convention', createdAt: t0 + i, updatedAt: t0 + i })
      }
      await ctx.settings.update('memory-notes', seed)
      const session = { header: { cwd: '' } } as unknown as Session
      ctx.emit('session/created', session)
      return sections.get('project-notes')!.text({ agent: { session } })
    }

    // Legacy 500 → conventions 300 (60%); explicit 300 must match byte-for-byte.
    const legacy = await boot({ notesCharLimit: 500 })
    const explicit = await boot({ notesConventionsCharLimit: 300 })
    expect(legacy).toBe(explicit)
    // A new key set alongside the legacy one wins its own slot.
    const mixed = await boot({ notesCharLimit: 500, notesConventionsCharLimit: 300 })
    expect(mixed).toBe(explicit)
  })
})
