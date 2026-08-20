import { describe, it, expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AddMemoryInput, MemoryEntry, MemoryStore } from '../src/types.ts'
import {
  REVIEW_SYSTEM_PROMPT,
  FLUSH_SYSTEM_PROMPT,
  parseExtractedMemories,
  renderMemorySnapshot,
  buildReviewMessages,
  buildFlushMessages,
  extractMemories,
  storeMemories,
  runReviewExtraction,
  runFlushExtraction,
} from '../src/review/extract.ts'
import type { ParsedMemory } from '../src/review/extract.ts'

/** Build an async iterable that streams one text block then a stop finish. */
function makeTextStream(text: string, finish: StreamChunk & { type: 'finish' } = { type: 'finish', reason: { kind: 'stop' } }): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield finish
  })()
}

/** Minimal fake session with a routed provider/model. */
function fakeSession(opts: { events?: unknown[]; messages?: { role: string; content: { type: string; text: string }[] }[] } = {}): Session {
  return {
    id: 'sess-1' as never,
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat' } }),
    events: opts.events ?? [],
    deriveMessages: () => opts.messages ?? [],
  } as unknown as Session
}

/** Build a fake context with a scripted llm.stream and optional memory store. */
function fakeCtx(streamFn: (opts: unknown) => AsyncIterable<StreamChunk>, memory?: MemoryStore): Context {
  return {
    llm: { stream: streamFn },
    get: (name: string) => (name === 'memory' ? memory : undefined),
  } as unknown as Context
}

/** A recording memory store mock. */
function recordingStore(entries: MemoryEntry[] = []): { store: MemoryStore; added: AddMemoryInput[] } {
  const added: AddMemoryInput[] = []
  const store = {
    add: async (input: AddMemoryInput) => { added.push(input); return { entry: { id: 'x' as never, createdAt: 0, updatedAt: 0, ...input } as MemoryEntry } },
    list: () => entries,
    get: () => undefined,
    update: async () => undefined,
    remove: async () => true,
    search: () => ({ entries: [], total: 0 }),
  } as unknown as MemoryStore
  return { store, added }
}

describe('parseExtractedMemories', () => {
  it('parses valid scope-tagged lines', () => {
    const text = 'user: prefers concise answers\nglobal: use pnpm\nproject: avoid any'
    const parsed = parseExtractedMemories(text)
    expect(parsed).toEqual([
      { scope: 'user', content: 'prefers concise answers' },
      { scope: 'global', content: 'use pnpm' },
      { scope: 'project', content: 'avoid any' },
    ])
  })

  it('is case-insensitive on the scope tag', () => {
    const parsed = parseExtractedMemories('USER: likes dark mode')
    expect(parsed[0]!.scope).toBe('user')
  })

  it('skips blank lines and lines without a colon', () => {
    const parsed = parseExtractedMemories('\nuser: ok\nno colon here\n  \n')
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.content).toBe('ok')
  })

  it('skips lines with an unrecognized scope', () => {
    const parsed = parseExtractedMemories('foo: not a scope\nuser: valid')
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.scope).toBe('user')
  })

  it('skips lines with empty content', () => {
    const parsed = parseExtractedMemories('user:   \nglobal: has content')
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.content).toBe('has content')
  })

  it('returns empty for empty input', () => {
    expect(parseExtractedMemories('')).toEqual([])
  })
})

describe('renderMemorySnapshot', () => {
  it('returns empty string when no store', () => {
    expect(renderMemorySnapshot(undefined)).toBe('')
  })
  it('returns empty string when store has no entries', () => {
    expect(renderMemorySnapshot(recordingStore().store)).toBe('')
  })
  it('renders entries with scope and content', () => {
    const entries: MemoryEntry[] = [
      { id: 'a' as never, scope: 'user', content: 'likes tea', createdAt: 0, updatedAt: 0 },
      { id: 'b' as never, scope: 'project', content: 'use vitest', projectName: 'dsh', category: 'convention', createdAt: 0, updatedAt: 0 },
    ]
    const text = renderMemorySnapshot(recordingStore(entries).store)
    expect(text).toContain('[user] likes tea')
    expect(text).toContain('[project/convention] (dsh) use vitest')
  })
})

describe('buildReviewMessages', () => {
  it('includes the memory snapshot when present', () => {
    const messages = buildReviewMessages('Current memory snapshot:\n- [user] x', [
      { text: 'remember that', signal: 'keyword', seq: 1 },
    ])
    expect(messages).toHaveLength(1)
    const block = messages[0]!.content[0]!
    expect(block.type).toBe('text')
    expect((block as { text: string }).text).toContain('Current memory snapshot')
    expect((block as { text: string }).text).toContain('remember that')
  })
  it('includes fragments only when snapshot is empty', () => {
    const messages = buildReviewMessages('', [
      { text: '不对', signal: 'correction', seq: 2 },
    ])
    const text = (messages[0]!.content[0] as { text: string }).text
    expect(text).toContain('(correction)')
    expect(text).toContain('不对')
    expect(text).not.toContain('Current memory snapshot')
  })
})

describe('buildFlushMessages', () => {
  it('lists the fragments', () => {
    const messages = buildFlushMessages(['user: hi', 'assistant: hello'])
    const text = (messages[0]!.content[0] as { text: string }).text
    expect(text).toContain('user: hi')
    expect(text).toContain('hello')
  })
  it('handles empty fragments', () => {
    const messages = buildFlushMessages([])
    const text = (messages[0]!.content[0] as { text: string }).text
    expect(text).toContain('no fragments available')
  })
})

describe('extractMemories', () => {
  it('returns parsed entries from a successful stream', async () => {
    const session = fakeSession()
    const ctx = fakeCtx(() => makeTextStream('user: prefers dark mode\nglobal: be concise'))
    const parsed = await extractMemories(ctx, session, REVIEW_SYSTEM_PROMPT, buildFlushMessages(['x']))
    expect(parsed).toEqual([
      { scope: 'user', content: 'prefers dark mode' },
      { scope: 'global', content: 'be concise' },
    ])
  })

  it('returns empty when no provider/model is routed', async () => {
    const session = { id: 's' as never, requestHeader: () => undefined, events: [], deriveMessages: () => [] } as unknown as Session
    const ctx = fakeCtx(() => makeTextStream('user: x'))
    const parsed = await extractMemories(ctx, session, REVIEW_SYSTEM_PROMPT, buildFlushMessages(['x']))
    expect(parsed).toEqual([])
  })

  it('returns empty on a stream error finish', async () => {
    const session = fakeSession()
    const ctx = fakeCtx(() => makeTextStream('user: x', { type: 'finish', reason: { kind: 'error', failure: { code: 'BOOM', message: 'fail' } } }))
    const parsed = await extractMemories(ctx, session, REVIEW_SYSTEM_PROMPT, buildFlushMessages(['x']))
    expect(parsed).toEqual([])
  })
})

describe('storeMemories', () => {
  it('stores allowed entries through the memory store', async () => {
    const { store, added } = recordingStore()
    const ctx = fakeCtx(() => makeTextStream(''), store)
    const parsed: ParsedMemory[] = [
      { scope: 'user', content: 'likes tea' },
      { scope: 'global', content: 'be concise' },
    ]
    await storeMemories(ctx, parsed)
    expect(added).toHaveLength(2)
    expect(added[0]!.scope).toBe('user')
  })

  it('skips entries the scanner rejects (secrets)', async () => {
    const { store, added } = recordingStore()
    const ctx = fakeCtx(() => makeTextStream(''), store)
    const parsed: ParsedMemory[] = [
      { scope: 'user', content: 'my key is sk-' + 'a'.repeat(48) },
      { scope: 'global', content: 'clean' },
    ]
    await storeMemories(ctx, parsed)
    expect(added).toHaveLength(1)
    expect(added[0]!.content).toBe('clean')
  })

  it('attaches the supplied category', async () => {
    const { store, added } = recordingStore()
    const ctx = fakeCtx(() => makeTextStream(''), store)
    await storeMemories(ctx, [{ scope: 'user', content: 'x' }], 'correction')
    expect(added[0]!.category).toBe('correction')
  })

  it('is a no-op when no memory store is mounted', async () => {
    const ctx = fakeCtx(() => makeTextStream(''))
    await expect(storeMemories(ctx, [{ scope: 'user', content: 'x' }])).resolves.toBeUndefined()
  })

  it('continues past a store add failure', async () => {
    const store = {
      add: vi.fn().mockRejectedValue(new Error('boom')),
      list: () => [],
    } as unknown as MemoryStore
    const ctx = fakeCtx(() => makeTextStream(''), store)
    await expect(storeMemories(ctx, [{ scope: 'user', content: 'a' }, { scope: 'global', content: 'b' }])).resolves.toBeUndefined()
    expect(store.add).toHaveBeenCalledTimes(2)
  })
})

describe('runReviewExtraction', () => {
  it('builds the prompt from the snapshot and candidates, then stores', async () => {
    const entries: MemoryEntry[] = [{ id: 'e' as never, scope: 'user', content: 'old', createdAt: 0, updatedAt: 0 }]
    const { store, added } = recordingStore(entries)
    const ctx = fakeCtx(() => makeTextStream('user: prefers dark mode'), store)
    const agent = { session: fakeSession() } as unknown as Agent
    const n = await runReviewExtraction(ctx, agent, [{ text: 'remember that', signal: 'keyword', seq: 1 }])
    expect(n).toBe(1)
    expect(added).toHaveLength(1)
    expect(added[0]!.content).toBe('prefers dark mode')
  })

  it('tags correction-only candidates with the correction category', async () => {
    const { store, added } = recordingStore()
    const ctx = fakeCtx(() => makeTextStream('user: use pnpm'), store)
    const agent = { session: fakeSession() } as unknown as Agent
    await runReviewExtraction(ctx, agent, [{ text: '不对', signal: 'correction', seq: 1 }])
    expect(added[0]!.category).toBe('correction')
  })
})

describe('runFlushExtraction', () => {
  it('extracts and stores from shadowed fragments', async () => {
    const { store, added } = recordingStore()
    const ctx = fakeCtx(() => makeTextStream('global: be concise'), store)
    const session = fakeSession()
    const n = await runFlushExtraction(ctx, session, ['user: hi', 'assistant: hello'])
    expect(n).toBe(1)
    expect(added[0]!.scope).toBe('global')
  })

  it('uses the flush system prompt route', async () => {
    let capturedSystem: string | undefined
    const ctx = fakeCtx((opts: unknown) => {
      capturedSystem = (opts as { system?: string }).system
      return makeTextStream('user: x')
    })
    await runFlushExtraction(ctx, fakeSession(), ['fragment'])
    expect(capturedSystem).toBe(FLUSH_SYSTEM_PROMPT)
  })
})

describe('LLM dedup judge (§3.4)', () => {
  /** A store mock with one existing entry that the prefilter will flag. */
  function storeWithExisting(existingContent: string): { store: MemoryStore; updated: { id: string; content: string }[]; added: AddMemoryInput[] } {
    const updated: { id: string; content: string }[] = []
    const added: AddMemoryInput[] = []
    const entries: MemoryEntry[] = [{ id: 'e1' as never, scope: 'global', content: existingContent, createdAt: 0, updatedAt: 0 }]
    const store = {
      add: async (input: AddMemoryInput) => {
        added.push(input)
        return { entry: { id: 'e2' as never, ...input, createdAt: 0, updatedAt: 0 } as MemoryEntry }
      },
      list: () => entries,
      get: () => entries[0],
      update: async (id: string, input: { content: string }) => {
        updated.push({ id, content: input.content })
        return { id: id as never, scope: 'global', content: input.content, createdAt: 0, updatedAt: 0 } as MemoryEntry
      },
      remove: async () => true,
      search: () => ({ entries: [], total: 0 }),
    } as unknown as MemoryStore
    return { store, updated, added }
  }

  it('judge verdict "duplicate" merges the content', async () => {
    const { store, updated, added } = storeWithExisting('user prefers concise answers')
    // The LLM stream returns "duplicate" for the judge call.
    const ctx = fakeCtx(() => makeTextStream('duplicate'), store)
    const session = fakeSession()
    // A near-duplicate that the prefilter will flag.
    await storeMemories(ctx, [{ scope: 'global', content: 'user likes concise responses' }], undefined, 'review', session.id, undefined, session, undefined, true)
    expect(updated).toHaveLength(1)
    expect(added).toHaveLength(0)
    // Merged content contains both the old and new text.
    expect(updated[0]!.content).toContain('concise')
  })

  it('judge verdict "update" replaces with the new content', async () => {
    const { store, updated, added } = storeWithExisting('use pnpm here')
    const ctx = fakeCtx(() => makeTextStream('update'), store)
    const session = fakeSession()
    await storeMemories(ctx, [{ scope: 'global', content: 'use pnpm v9 here' }], undefined, 'review', session.id, undefined, session, undefined, true)
    expect(updated).toHaveLength(1)
    expect(added).toHaveLength(0)
    // The new content replaces the old entirely.
    expect(updated[0]!.content).toBe('use pnpm v9 here')
  })

  it('judge verdict "new" creates a separate entry', async () => {
    const { store, updated, added } = storeWithExisting('这个项目使用pnpm')
    const ctx = fakeCtx(() => makeTextStream('new'), store)
    const session = fakeSession()
    // The prefilter flags this as a near-duplicate (shared 项/目), but the
    // judge correctly says "new" — they're about different tools.
    await storeMemories(ctx, [{ scope: 'global', content: '这个项目使用vitest' }], undefined, 'review', session.id, undefined, session, undefined, true)
    expect(added).toHaveLength(1)
    expect(updated).toHaveLength(0)
    expect(added[0]!.content).toBe('这个项目使用vitest')
  })

  it('falls back to "duplicate" (merge) when judge is disabled', async () => {
    const { store, updated, added } = storeWithExisting('user prefers concise answers')
    const ctx = fakeCtx(() => makeTextStream('new'), store)
    const session = fakeSession()
    // judgeEnabled = false → prefilter hit merges directly, no LLM call.
    await storeMemories(ctx, [{ scope: 'global', content: 'user likes concise responses' }], undefined, 'review', session.id, undefined, session, undefined, false)
    expect(updated).toHaveLength(1)
    expect(added).toHaveLength(0)
  })

  it('falls back to "duplicate" when the LLM stream fails', async () => {
    const { store, updated, added } = storeWithExisting('user prefers concise answers')
    // Stream that errors on finish.
    const ctx = fakeCtx(() => makeTextStream('garbage', { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'ERR' } } }), store)
    const session = fakeSession()
    await storeMemories(ctx, [{ scope: 'global', content: 'user likes concise responses' }], undefined, 'review', session.id, undefined, session, undefined, true)
    // Safe fallback: merge.
    expect(updated).toHaveLength(1)
    expect(added).toHaveLength(0)
  })
})
