/**
 * Usage-hit signal (write-path rework Step 2): the pure hit computation
 * (`computeHits` — IDF-weighted overlap over content+summary+anchor tokens,
 * the two opposing fixtures: an injected-but-ignored entry scores no hit, an
 * echoing answer scores one), the store's `markHits` idempotence per batch,
 * and the plugin wiring — the standing ledger recorded at freeze time, the
 * auto-recall fence replacing it for its round, the `assistant/message`
 * listener booking echoes, `hitSignalEnabled=false` fully silent, and the
 * sweep's selection reading `hitCount` first.
 *
 * Fake-LLM discipline: no LLM seam is involved anywhere on this path.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DomainMemoryStore } from '../src/store/index.ts'
import { MemoryStore } from '../src/index.ts'
import type { MemoryEntry, MemoryId, MemorySearchQuery } from '../src/types.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { computeHits, type LedgerEntry } from '../src/context/index.ts'
import { tokenizeForSearch } from '../src/store/bm25.ts'
import { rankForSweep } from '../src/review/sweep.ts'
import * as context from '../src/context/index.ts'

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

function makeRealStore(): DomainMemoryStore {
  return new DomainMemoryStore(memTable(), memTable(), memTable(), memTable())
}

/** Seed a MemoryEntry-shaped fixture (no store round trip). */
function entry(id: string, scope: MemoryEntry['scope'], content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id: id as never, scope, content, createdAt: 0, updatedAt: 0, ...extra }
}

/** Ledger item from the entry's token sources (the shape the wiring builds). */
function led(id: string, text: string, anchors: readonly string[] = []): LedgerEntry {
  return { id: id as never, tokens: new Set([...tokenizeForSearch(text), ...anchors]) }
}

// The calibration fixtures' entry: a project convention with hard tokens.
const LEDGER_ITEM = led('e1', '这个仓库一律用 pnpm 安装依赖，不要用 npm install', ['pnpm'])
const LEDGER_NEIGHBORS = [led('e2', '用户偏好 vim 键位'), led('e3', '部署脚本在 scripts/deploy.sh')]

describe('computeHits — the two opposing fixtures', () => {
  it('an answer restating the fact scores a hit (作答回声 → hit)', () => {
    // The echo restates the convention's substance: pnpm, install, npm.
    const hits = computeHits([LEDGER_ITEM, ...LEDGER_NEIGHBORS], '好的，这个仓库装依赖一律用 pnpm，不用 npm install', 0.25)
    expect(hits).toEqual(['e1'])
  })

  it('an answer that ignores the injected entry scores NO hit (注入被无视不得分)', () => {
    const hits = computeHits([LEDGER_ITEM, ...LEDGER_NEIGHBORS], '今天天气不错去爬山吧明天再去湖边散步', 0.25)
    expect(hits).toEqual([])
  })

  it('a mere mention of one token (an aside about the tool) stays below the threshold', () => {
    // "I installed pnpm globally" shares the anchor but restates nothing.
    const hits = computeHits([LEDGER_ITEM, ...LEDGER_NEIGHBORS], 'pnpm 我个人机器上装过，全局小工具', 0.25)
    expect(hits).toEqual([])
  })

  it('an English genuine restatement crosses; an unrelated English answer does not', () => {
    const enItem = led('e1', 'this repo uses pnpm as the package manager, never npm install', ['pnpm'])
    const enNeighbors = [led('e2', 'prefers vim keybindings'), led('e3', 'deploy script in scripts/deploy.sh')]
    expect(computeHits([enItem, ...enNeighbors], 'Sure — dependency install in this repo always uses pnpm, never npm install', 0.25)).toEqual(['e1'])
    expect(computeHits([enItem, ...enNeighbors], 'nice weather today, let us go hiking', 0.25)).toEqual([])
  })

  it('empty ledger or empty answer yields no hits', () => {
    expect(computeHits([], 'anything', 0.25)).toEqual([])
    expect(computeHits([led('e1', 'some fact content')], '', 0.25)).toEqual([])
  })
})

describe('markHits — store behavior backing the signal', () => {
  it('two answer rounds accumulate (echo → +1 each round)', async () => {
    const store = makeRealStore()
    const { entry } = await store.add({ scope: 'global', content: 'pnpm convention' })
    const first = store.get(entry.id)!.lastHitAt
    await store.markHits([entry.id])
    await new Promise(resolve => setTimeout(resolve, 3))
    await store.markHits([entry.id])
    const after = store.get(entry.id)!
    expect(after.hitCount).toBe(2)
    expect(after.lastHitAt).toBeGreaterThanOrEqual(first ?? 0)
  })
})

describe('rankForSweep reads hitCount first (Step 2.3 consumption)', () => {
  it('a hit entry outranks a merely-surfaced entry; the later tie-breaks stay accessCount then last-use', () => {
    const ranked = rankForSweep([
      entry('surfaced', 'global', 'surfaced often, never echoed', { accessCount: 5, lastRecalledAt: 900 }),
      entry('echoed', 'global', 'echoed by answers', { accessCount: 5, hitCount: 3 }),
      entry('surfaced-old', 'global', 'surfaced often, older', { accessCount: 5, lastRecalledAt: 100 }),
    ], 10)
    // hitCount first, then accessCount (equal here), then last-use.
    expect(ranked.map(e => e.id)).toEqual(['echoed', 'surfaced', 'surfaced-old'])
  })

  it('decayDays remains the only deleter: the ranking reads hits, the filter does not', () => {
    // A zero-hit entry is still eligible for selection (and for the sweep's
    // judgement); nothing in the ranking path removes it.
    const ranked = rankForSweep([entry('no-hits', 'global', 'quiet entry')], 10)
    expect(ranked).toHaveLength(1)
  })
})

// ─── plugin wiring: the ledger and the assistant/message listener ───────────

/** In-memory store recording hits (the contract no-op default overridden). */
class HitStore extends MemoryStore {
  readonly hitIds: MemoryId[][] = []
  private readonly entries: MemoryEntry[] = []
  constructor(count: number) {
    super()
    for (let i = 0; i < count; i++) {
      this.entries.push({ id: `mem-${i}` as MemoryId, scope: 'global', content: `entry ${i}`, createdAt: i, updatedAt: i })
    }
  }
  override async add(): Promise<{ entry: MemoryEntry }> { throw new Error('unused') }
  override get(id: string): MemoryEntry | undefined { return this.entries.find(e => e.id === id as MemoryId) }
  override list(): readonly MemoryEntry[] { return this.entries }
  override async update(): Promise<MemoryEntry | undefined> { return undefined }
  override async remove(id: string): Promise<boolean> { return this.get(id) !== undefined }
  override search(query: MemorySearchQuery): { entries: readonly MemoryEntry[]; total: number } {
    const limit = query.limit ?? 50
    return { entries: limit > 0 ? this.entries.slice(0, limit) : this.entries, total: this.entries.length }
  }
  override async janitor(): Promise<number> { return 0 }
  override async markHits(ids: readonly MemoryId[]): Promise<void> { this.hitIds.push([...ids]) }
  override markRecalled(): void { /* no-op */ }
}

describe('memory-context hit wiring (live listeners)', () => {
  /** A session fixture the WeakMaps key on (same shape as context-refresh's). */
  const session = { header: { cwd: '' } } as never

  it('an echoing assistant message books one hit on the standing-ledger entry', async () => {
    const ctx = new Context()
    ctx.provide('llm', {})
    ctx.provide('systemPrompt', { section: () => () => {} })
    const store = new HitStore(2)
    ctx.provide('memory', store)
    // `full` mode: the standing prefix injects entry content, so the standing
    // ledger is seeded (the digest default injects no entry data — covered
    // by its own test below).
    await ctx.plugin(context, { memoryMode: 'full', hitSignalEnabled: true, hitSignalThreshold: 0.25 } as never)
    // Freeze the standing ledger (session/created fires the freeze).
    ctx.emit('session/created', session)
    // A restating answer books the hit for the standing entry.
    ctx.emit('session/event', session, { type: 'assistant/message', seq: 2, time: 0, data: { message: { content: [{ type: 'text', text: 'entry 0 的约定已确认，后续照办' }] } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.hitIds).toHaveLength(1)
    expect(store.hitIds[0]).toEqual(['mem-0'])
  })

  it('digest mode books no standing hit: a data-less prefix has no ledger to echo', async () => {
    const ctx = new Context()
    ctx.provide('llm', {})
    ctx.provide('systemPrompt', { section: () => () => {} })
    const store = new HitStore(2)
    ctx.provide('memory', store)
    // The factory default (`digest`) injects only counts/topics into the
    // prefix, never entry content, so an answer must not "hit" an entry it was
    // never shown; the per-step recall fence is the only ledger source (B2).
    await ctx.plugin(context, { memoryMode: 'digest', autoRecallEnabled: false, hitSignalEnabled: true, hitSignalThreshold: 0.25 } as never)
    ctx.emit('session/created', session)
    ctx.emit('session/event', session, { type: 'assistant/message', seq: 2, time: 0, data: { message: { content: [{ type: 'text', text: 'entry 0 的约定已确认，后续照办' }] } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.hitIds).toEqual([])
  })

  it('an answer that ignores the injected entries books no hit', async () => {
    const ctx = new Context()
    ctx.provide('llm', {})
    ctx.provide('systemPrompt', { section: () => () => {} })
    const store = new HitStore(2)
    ctx.provide('memory', store)
    await ctx.plugin(context, { memoryMode: 'full', hitSignalEnabled: true, hitSignalThreshold: 0.25 } as never)
    ctx.emit('session/created', session)
    ctx.emit('session/event', session, { type: 'assistant/message', seq: 1, time: 0, data: { message: { content: [{ type: 'text', text: '今天天气不错去爬山吧' }] } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.hitIds).toEqual([])
  })

  it('hitSignalEnabled=false keeps every path silent (no ledger, no hits)', async () => {
    const ctx = new Context()
    ctx.provide('llm', {})
    ctx.provide('systemPrompt', { section: () => () => {} })
    const store = new HitStore(2)
    ctx.provide('memory', store)
    await ctx.plugin(context, { hitSignalEnabled: false } as never)
    ctx.emit('session/created', session)
    ctx.emit('session/event', session, { type: 'assistant/message', seq: 1, time: 0, data: { message: { content: [{ type: 'text', text: 'entry 0 的约定已确认，后续照办' }] } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.hitIds).toEqual([])
  })

  it('one answer consumes the ledger: a second echo does not double-count the same round', async () => {
    const ctx = new Context()
    ctx.provide('llm', {})
    ctx.provide('systemPrompt', { section: () => () => {} })
    const store = new HitStore(1)
    ctx.provide('memory', store)
    await ctx.plugin(context, { memoryMode: 'full', hitSignalEnabled: true, hitSignalThreshold: 0.25 } as never)
    ctx.emit('session/created', session)
    const answer = { type: 'assistant/message', seq: 1, time: 0, data: { message: { content: [{ type: 'text', text: 'entry 0 的约定已确认，后续照办' }] } } }
    ctx.emit('session/event', session, answer)
    await new Promise(resolve => setTimeout(resolve, 10))
    ctx.emit('session/event', session, answer)
    await new Promise(resolve => setTimeout(resolve, 10))
    // One booked hit total — the ledger was consumed by the first answer.
    expect(store.hitIds).toHaveLength(1)
  })
})
