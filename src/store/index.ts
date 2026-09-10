/**
 * storage-domain provider for the long-term memory store. Opens a `memory`
 * domain with six tables (`entries` keyed by `MemoryId`, `audit`, and
 * `suggestions` for the review queue, `meta` for subsystem state rows,
 * `identity` and `identityHistory` for the identity layer's self-documents)
 * and implements the {@link MemoryStore} abstract service against them. Reads are
 * synchronous from
 * the domain's authoritative in-memory state; writes serialize on the domain's
 * write chain and reach the backend before updating memory.
 *
 * The provider is a function plugin that mounts on `ctx.memory` after the
 * `storage-domain` facility is available.
 *
 * @module @chenhw7/dsh-memory/store
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { MemoryStore, MemoryId, AuditId, SuggestionId, scanContent, validateProjectScope, validateContent } from '../index.ts'
import type { RecallSource } from '../types.ts'
import { Bm25Index, tokenizeForSearch, buildCorpusStats, buildCorpusStatsFromTokens, uniqueTokens, weightedOverlapSimilarity } from './bm25.ts'
import { nextIdentityRecord } from './identity-util.js'
import { SqliteMemoryStore, SQLITE_MIGRATION_MARKER } from './sqlite.ts'
import {
  CrossProcessGuard,
  DEFAULT_CROSS_PROCESS_PROBE_MS,
  EMPTY_OWNER,
  currentBootOwner,
  mediumOwnerReader,
  mediumGoodbyeWriter,
  ownerStampSchema,
} from './cross-process.ts'
import type {
  AddMemoryInput,
  AddMemoryResult,
  AddSuggestionInput,
  AdoptSuggestionOverride,
  AuditEntry,
  AuditOp,
  AuditSource,
  IdentityHistoryRecord,
  IdentityKind,
  IdentityRecord,
  MemoryEntry,
  MemoryHealth,
  MemorySearchQuery,
  MemorySuggestion,
  SearchMemoryResult,
  UpdateIdentityInput,
  UpdateMemoryInput,
} from '../types.ts'

/**
 * One record of the domain's fourth table (`meta`): durable state that is not
 * a memory entry, an audit record, or a suggestion — consolidation progress
 * (lastRun/cooldown under the `'consolidation'` key), medium-level migration
 * markers (`'medium'`, e.g. `migratedToSqlite`), and schema-version markers
 * (`'schema'`). The row is keyed by its `key` in the table plus any caller
 * suffix; the carrier fields are permissive-on-read by design (zero
 * migration): unknown keys and unknown fields re-read without error.
 */
export interface MemoryMetaRecord {
  /** Which subsystem owns this row. */
  readonly key: 'consolidation' | 'medium' | 'schema'
  /** Opaque string payload (timestamps, markers, version stamps as text). */
  readonly value?: string | undefined
  /** Unix epoch ms of the last write to this record. */
  readonly updatedAt?: number | undefined
}

/** Zod schema for one memory entry record on the durable medium. */
const memoryEntrySchema = zod.object({
  id: zod.string().min(1),
  scope: zod.enum(['global', 'project', 'user']),
  category: zod.enum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk', 'procedure']).optional(),
  content: zod.string(),
  summary: zod.string().optional(),
  projectName: zod.string().optional(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
  pinned: zod.boolean().optional(),
  lastRecalledAt: zod.number().optional(),
  staleSince: zod.number().optional(),
  accessCount: zod.number().optional(),
  importance: zod.number().optional(),
  anchors: zod.array(zod.string()).optional(),
  status: zod.enum(['active', 'superseded']).optional(),
  supersededBy: zod.string().optional(),
  hitCount: zod.number().optional(),
  lastHitAt: zod.number().optional(),
})

/** Zod schema for one audit-record entry on the durable medium. */
const auditEntrySchema = zod.object({
  id: zod.string().min(1),
  op: zod.enum(['add', 'update', 'remove', 'readRaw']),
  entryId: zod.string().min(1),
  scope: zod.enum(['global', 'project', 'user']),
  category: zod.enum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk', 'procedure']).optional(),
  source: zod.enum(['tool', 'review', 'flush', 'ui', 'janitor']),
  sessionId: zod.string().optional(),
  ts: zod.number(),
  seq: zod.number().optional(),
  contentPreview: zod.string(),
})

/** Zod schema for one pending suggestion in the human-review queue (P1-1). */
const suggestionSchema = zod.object({
  id: zod.string().min(1),
  scope: zod.enum(['global', 'project', 'user']),
  category: zod.enum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk', 'procedure']).optional(),
  content: zod.string(),
  summary: zod.string().optional(),
  projectName: zod.string().optional(),
  identityKind: zod.enum(['soul', 'user']).optional(),
  hits: zod.number(),
  firstSeenAt: zod.number(),
  lastSeenAt: zod.number(),
  targetEntryId: zod.string().optional(),
  source: zod.enum(['tool', 'review', 'flush', 'ui', 'janitor']),
  sessionId: zod.string().optional(),
})

/**
 * Zod schema for one meta record on the durable medium. The record is a
 * deliberately permissive carrier: the `key` discriminates which subsystem
 * owns the row, and every payload field is optional so a future carrier
 * extension reopens on today's readers (zero-migration, the same looseObject
 * rationale as the owner stamp).
 */
const metaRecordSchema = zod.looseObject({
  key: zod.enum(['consolidation', 'medium', 'schema']),
  value: zod.string().optional(),
  updatedAt: zod.number().optional(),
}) as unknown as zod.ZodType<MemoryMetaRecord>

/** Zod schema for the current record of one identity document. */
const identityRecordSchema = zod.object({
  kind: zod.enum(['soul', 'user']),
  content: zod.string(),
  version: zod.number(),
  updatedAt: zod.number(),
  seedVersion: zod.number(),
})

/** Zod schema for one identity-document version snapshot (the identity audit surface). */
const identityHistorySchema = zod.object({
  kind: zod.enum(['soul', 'user']),
  version: zod.number(),
  content: zod.string(),
  ts: zod.number(),
  source: zod.enum(['seed', 'tool', 'ui']),
  sessionId: zod.string().optional(),
})

/**
 * The memory domain spec: `entries` (memory records keyed by id) plus `audit`
 * (mutation audit trail) plus `suggestions` (P1-1 pending-review queue) plus
 * `meta` (subsystem state rows: consolidation progress, migration markers),
 * plus `identity`/`identityHistory` (the identity layer's self-documents and
 * their version snapshots), plus a global singleton carrying the single-writer
 * owner stamp (P3 cross-process detection). Domain version stays at 0 — all
 * later additions are forward-compatible: storage-json reads only declared
 * tables and initializes any absent table as an empty map, and a medium whose
 * global slot was never written reads as `null`, which the domain replaces
 * with the spec's `initial` without materializing it, so existing v0 media
 * reopen without migration.
 *
 * The stamp and meta-record schemas accept extra keys on purpose
 * (`looseObject`): the medium holds both as opaque JSON, and a future
 * extension of their shapes must reopen cleanly on today's readers.
 */
/** The memory domain spec, exported for the SQLite backend's migration path. */
export const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 0,
  global: {
    schema: ownerStampSchema,
    initial: EMPTY_OWNER,
  },
  tables: {
    entries: domainTable<MemoryId, MemoryEntry>(memoryEntrySchema as unknown as zod.ZodType<MemoryEntry>),
    audit: domainTable<AuditId, AuditEntry>(auditEntrySchema as unknown as zod.ZodType<AuditEntry>),
    suggestions: domainTable<SuggestionId, MemorySuggestion>(suggestionSchema as unknown as zod.ZodType<MemorySuggestion>),
    meta: domainTable<string, MemoryMetaRecord>(metaRecordSchema),
    identity: domainTable<IdentityKind, IdentityRecord>(identityRecordSchema as unknown as zod.ZodType<IdentityRecord>),
    identity_history: domainTable<string, IdentityHistoryRecord>(identityHistorySchema as unknown as zod.ZodType<IdentityHistoryRecord>),
  },
})

/** The opened memory domain handle, typed for its tables. */
type MemoryDomain = Domain<typeof memoryDomainSpec>

/** The entries table from the opened domain. */
type EntriesTable = KvTable<MemoryId, MemoryEntry>

/** The audit table from the opened domain. */
type AuditTable = KvTable<AuditId, AuditEntry>

/** The suggestions table from the opened domain (P1-1 review queue). */
type SuggestionsTable = KvTable<SuggestionId, MemorySuggestion>

/** The meta table from the opened domain (subsystem state rows). */
type MetaTable = KvTable<string, MemoryMetaRecord>

/** The identity table from the opened domain (current self-document records, keyed by kind). */
type IdentityTable = KvTable<IdentityKind, IdentityRecord>

/** The identity-history table from the opened domain (version snapshots, keyed `${kind}#${version}`). */
type IdentityHistoryTable = KvTable<string, IdentityHistoryRecord>

/**
 * The identity plumbing handed to {@link DomainMemoryStore}. Optional so a
 * composition (or unit test) can mount the store without the identity layer;
 * identity writes then fail loud instead of silently no-opping.
 */
export interface IdentityTables {
  readonly identity: IdentityTable
  readonly identityHistory: IdentityHistoryTable
}

/**
 * Maximum audit records retained; oldest are trimmed on overflow. Protocol
 * default like {@link DEFAULT_ENTRIES_CAP}: settable per deployment through
 * the `config:` entry on the `memory-store` composition row.
 */
const DEFAULT_AUDIT_CAP = 200

/**
 * Maximum memory entries retained in the `entries` table. Write paths
 * (`add`, and `adoptSuggestion`'s new-entry path which delegates to `add`)
 * trim back to this cap after a successful write, evicting by use signal.
 *
 * Why 500: the durable medium is one JSON file — it tolerates thousands of
 * entries before size/migration pressure becomes real — so the cap only has
 * to bound runaway extraction, not normal growth. 200 (the audit/suggestion
 * cap precedent) would evict healthy, actively-recalled stores; the
 * recall-golden fixture (24 entries) and integration suites sit far below it.
 *
 * Soft cap: entries that survive eviction (pinned, or high `accessCount`)
 * may push the table past the cap; eviction never runs when every remaining
 * candidate is protected. Settable per deployment through the `config:`
 * entry on the `memory-store` composition row.
 */
const DEFAULT_ENTRIES_CAP = 500

/**
 * Maximum pending suggestions retained (P1-1). Overflow evicts the
 * lowest-signal rows first: fewest hits, then oldest `lastSeenAt`.
 */
const DEFAULT_SUGGESTION_CAP = 200

/**
 * Maximum identity-history snapshots retained per document kind. Overflow
 * evicts the oldest versions first; reverts therefore can only restore within
 * this window. Bounded payload: one snapshot is at most the document budget
 * (a few thousand chars), so 20 kinds' worth of history stays a small table.
 */
const IDENTITY_HISTORY_CAP = 20

/**
 * IDF-weighted overlap above which two same-scope proposals count as the
 * same suggestion (re-observation, not a new row). Sits below the entry-dedup
 * prefilter line (DEDUP_SIMILARITY_THRESHOLD, 0.15) so a proposal is never
 * silently dropped on this signal alone, while "the model keeps proposing X"
 * still accumulates `hits` on one row instead of flooding the queue. The
 * metric is the shared {@link ../store/bm25.ts weightedOverlapSimilarity}
 * measured over the live queue as corpus.
 */
const SUGGESTION_DUP_THRESHOLD = 0.3

/**
 * Deterministic audit ordering: newest/oldest by `ts`, ties broken by the
 * monotonic append `seq`, then by id for records written before `seq` existed.
 * Ids are random UUIDs, so without `seq` a burst of writes inside one
 * millisecond would order non-deterministically.
 */
function compareAuditDesc(a: AuditEntry, b: AuditEntry): number {
  return b.ts - a.ts || (b.seq ?? 0) - (a.seq ?? 0) || (a.id < b.id ? -1 : 1)
}

/** Ascending counterpart of {@link compareAuditDesc} (append order). */
function compareAuditAsc(a: AuditEntry, b: AuditEntry): number {
  return a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0) || (a.id < b.id ? -1 : 1)
}

/** Cordis plugin name. */
export const name = 'memory-store-domain'

/**
 * Fraction of {@link StoreConfig.entriesCap} at or beyond which the startup
 * selfcheck warns that the store is approaching the single-JSON-medium
 * migration threshold (scale-trigger-selfcheck): it detects "close to the
 * cap" where the cap's own eviction only acts at "past the cap". File-size
 * and multi-process concerns are deliberately not re-checked here — the file
 * size is derived from the same entry count, and cross-process detection
 * (cross-process-detect) already owns the concurrent-writer warning.
 */
const SCALE_SELFCHECK_FRACTION = 0.8

/** Services required before this provider can mount. */
export const inject = ['storageDomain']

/**
 * Configuration for the memory store provider, settable from a `config:`
 * entry on the `memory-store` composition row.
 */
export interface StoreConfig {
  /**
   * Which storage backend mounts (write-path rework Step 3.2): `host-medium`
   * (default) keeps everything in the host's `memory.json`; `sqlite` moves
   * the store into the plugin-owned `$DSH_HOME/storages/memory.db` (WAL
   * mode) with a one-time import from a non-empty medium. Misconfiguration
   * fails loud. Defaults to `host-medium` this release.
   */
  storage: 'host-medium' | 'sqlite'
  /**
   * Maximum entries retained in the `entries` table; write paths trim back
   * to it (pinned entries exempt, lowest use signal evicted first). Default
   * {@link DEFAULT_ENTRIES_CAP}. Settable from `cordis.patch.yml` under the
   * "no hardcoded tunables" rule.
   */
  entriesCap: number
  /**
   * Interval in milliseconds between medium owner-stamp read-backs for
   * cross-process single-writer detection; `0` disables the periodic probe
   * (the startup check and the dispose goodbye still run). Default
   * {@link DEFAULT_CROSS_PROCESS_PROBE_MS}. Settable from `cordis.patch.yml`
   * under the "no hardcoded tunables" rule.
   */
  crossProcessProbeMs: number
}

/** Schemastery configuration for the `memory-store` composition row. */
export const Config = z.object({
  storage: z.union(['host-medium', 'sqlite'] as const).default('host-medium'),
  entriesCap: z.number().step(1).min(1).default(DEFAULT_ENTRIES_CAP),
  crossProcessProbeMs: z.number().step(1).min(0).default(DEFAULT_CROSS_PROCESS_PROBE_MS),
})

/**
 * Mount the storage-domain memory store provider. Opens the `memory` domain
 * and registers a {@link MemoryStore} subclass on `ctx.memory`. On open, a
 * {@link CrossProcessGuard} claims the medium's owner stamp (the domain's
 * global slot) and starts the configured read-back probe; the dispose path
 * stamps `closedAt` so the next boot does not warn about this one.
 * @param ctx - Cordis context with `storageDomain` injected.
 * @param config - row config; `entriesCap` and `crossProcessProbeMs` are read here.
 */
export async function apply(ctx: Context, config: StoreConfig = { storage: 'host-medium', entriesCap: DEFAULT_ENTRIES_CAP, crossProcessProbeMs: DEFAULT_CROSS_PROCESS_PROBE_MS }): Promise<void> {
  const domain: MemoryDomain = await ctx.storageDomain.open(memoryDomainSpec)
  const entries: EntriesTable = domain.table('entries')
  const audit: AuditTable = domain.table('audit')
  const suggestions: SuggestionsTable = domain.table('suggestions')
  const meta: MetaTable = domain.table('meta')
  const identity: IdentityTable = domain.table('identity')
  const identityHistory: IdentityHistoryTable = domain.table('identity_history')

  // Backend selection (write-path rework Step 3.2): `sqlite` mounts the
  // plugin-owned memory.db instead of the domain store. The medium's
  // migration marker guards both directions — a sqlite boot over a
  // non-empty, never-migrated medium imports it once; a host-medium boot
  // after a migration fails loud (two diverging sources of truth).
  if (config.storage === 'sqlite') {
    const dbPath = resolveSqlitePath(ctx)
    if (dbPath === undefined) {
      throw new Error('dsh-memory: storage: sqlite needs the dshHomePath service to resolve $DSH_HOME/storages/memory.db — the composition does not provide it; fix the row or keep storage: host-medium')
    }
    const sqlite = new SqliteMemoryStore({
      dbPath,
      failureLogger: ctx.logger,
      entriesCap: config.entriesCap,
    })
    // The marker lives in the MEDIUM's meta table (the migrating boot wrote
    // it there); the sqlite database's own meta table is the new store's
    // progress, not the migration record.
    const migrated = meta.get(SQLITE_MIGRATION_MARKER)
    const mediumEntries = [...entries.entries()].map(([, entry]) => entry)
    const mediumIdentity = [...identity.entries()].map(([, record]) => record)
    if (migrated === undefined && (mediumEntries.length > 0 || mediumIdentity.length > 0)) {
      // One-time import: the medium holds data this database has never seen.
      sqlite.importFromDomain(
        mediumEntries,
        [...audit.entries()].map(([, record]) => record),
        [...suggestions.entries()].map(([, row]) => row),
        mediumIdentity,
        [...identityHistory.entries()].map(([, record]) => record),
      )
      // If a crash occurs after importFromDomain completes but before the medium is
      // cleared, the next boot re-imports; this is safe because importFromDomain uses
      // stable primary keys with INSERT OR REPLACE, making re-import idempotent.
      // The imported rows are now memory.db's rows, so the medium's data
      // tables clear before the marker lands. Left in place they would make
      // the next sqlite boot trip the both-sides guard on its own leftovers
      // — the clear-first order keeps every crash window benign: a boot
      // between the two steps sees an empty, unmarked medium (no import to
      // redo, no guard to refuse), while marker-first would strand data the
      // guard must reject.
      for (const key of [...entries.keys()]) await entries.delete(key)
      for (const key of [...audit.keys()]) await audit.delete(key)
      for (const key of [...suggestions.keys()]) await suggestions.delete(key)
      for (const key of [...identity.keys()]) await identity.delete(key)
      for (const key of [...identityHistory.keys()]) await identityHistory.delete(key)
      await meta.put(SQLITE_MIGRATION_MARKER, { key: 'medium', value: new Date().toISOString(), updatedAt: Date.now() })
      ctx.logger.warn(`dsh-memory: imported ${String(mediumEntries.length)} entries from memory.json into ${dbPath} and cleared the medium`)
    } else if (migrated !== undefined && (mediumEntries.length > 0 || mediumIdentity.length > 0)) {
      // Both sides hold data: the medium was written after the migration —
      // a second writer (the migrating boot itself leaves the medium's data
      // tables empty). Failing loud is the only safe answer.
      throw new Error('dsh-memory: storage: sqlite — the host medium holds data but carries a migratedToSqlite marker; a host-medium process wrote memory.json after the migration. Reconcile the two stores by hand and remove the stale writes before restarting.')
    }
    ctx.effect(() => async () => { sqlite.close() })
    ctx.provide('memory', sqlite)
    return
  }

  // Cross-process single-writer detection (host storage-json is
  // last-writer-wins across processes, silently): claim the medium's owner
  // stamp at open, re-read it on a lightweight interval, stamp `closedAt` on
  // dispose. The medium path comes from the harness-home resolver the boot
  // provides to composition `!!js` expressions; when absent (unit tests,
  // exotic hosts) the medium read-back seam is undefined and only the
  // in-memory startup judgment + goodbye stamps run.
  // One boot identity per mount, shared by the claim and the goodbye: a
  // second `currentBootOwner()` would mint a fresh random bootId that the
  // goodbye writer would (correctly) refuse to stamp.
  // Mixed-version guard (Step 3.2): a host-medium boot over a medium whose
  // meta table carries the sqlite migration marker fails loud — the medium
  // is no longer this backend's source of truth, and writing to it anyway
  // would fork the data.
  if (meta.get(SQLITE_MIGRATION_MARKER) !== undefined) {
    throw new Error('dsh-memory: storage: host-medium — the medium carries the migratedToSqlite marker: its data moved into memory.db and a host-medium process must not write memory.json anymore. Start with storage: sqlite, or reconcile the stores by hand and remove the marker.')
  }
  const own = currentBootOwner()
  const mediumReader = resolveMediumReader(ctx)
  const mediumGoodbye = resolveMediumGoodbye(ctx, own.bootId)
  const store = new DomainMemoryStore(entries, audit, suggestions, meta, DEFAULT_AUDIT_CAP, DEFAULT_SUGGESTION_CAP, ctx.logger, config.entriesCap, { identity, identityHistory })
  const guard = new CrossProcessGuard(
    own,
    mediumReader,
    owner => domain.global.set(owner),
    (site, error) => store.reportFailure(site, error),
    undefined,
    mediumGoodbye,
  )
  try {
    // Startup judgment + claim: judge the open-time global (loaded from the
    // medium), then stamp this boot as owner so later starters see us. A
    // failed claim cannot run detection, but the store itself may still be
    // usable — fail loud in the log, keep mounting.
    await guard.startup(domain.global.get())
  } catch (error) {
    // Detection is a background safety net, not the write path: an unwritable
    // global slot degrades to no cross-process visibility, so the mount
    // continues and only this warn marks the gap.
    ctx.logger.warn(`dsh-memory: cross-process owner claim failed: ${String(error)}`)
  }

  ctx.effect(() => {
    // The cordis-plugin-timer mixin is not a dependency of this package, so
    // the probe uses the platform interval directly — registered inside the
    // effect so the disposer below clears it on stop/update/undefine.
    const probeTimer = config.crossProcessProbeMs > 0
      ? setInterval(() => { void guard.probe() }, config.crossProcessProbeMs)
      : undefined
    return async () => {
      if (probeTimer !== undefined) clearInterval(probeTimer)
      await guard.sayGoodbye()
      await domain.close()
    }
  })

  ctx.provide('memory', store)
}

/**
 * Resolve the unit-file read seam for cross-process detection from the
 * harness-home path resolver the boot exposes to `!!js` config expressions.
 * Compositions derive the storage root from the same service, so the
 * resolution agrees with where storage-json actually writes. Returns
 * `undefined` when the service is absent.
 * @param ctx - Cordis context that may carry `dshHomePath`.
 * @returns an async medium reader, or `undefined` when unresolvable.
 */
function resolveMediumReader(ctx: Context): (() => Promise<unknown>) | undefined {
  const homePath = (ctx as unknown as { get(name: string): unknown }).get('dshHomePath')
  if (typeof homePath !== 'function') return undefined
  return mediumOwnerReader(homePath('storages', 'memory.json'))
}

/**
 * Resolve the direct medium-file goodbye writer (same derivation as
 * {@link resolveMediumReader}). The goodbye must not go through the domain's
 * global slot: the storage facility's own unmount closes the domain
 * concurrently with our disposer, so the domain write rejects with `closed`
 * most dispose runs — the medium file is the only teardown-valid seam.
 * @param ctx - Cordis context that may carry `dshHomePath`.
 * @param bootId - This mount's boot identity, matching the claim the guard writes.
 * @returns an async goodbye writer, or `undefined` when unresolvable.
 */
function resolveMediumGoodbye(ctx: Context, bootId: string): (() => Promise<void>) | undefined {
  const homePath = (ctx as unknown as { get(name: string): unknown }).get('dshHomePath')
  if (typeof homePath !== 'function') return undefined
  return mediumGoodbyeWriter(homePath('storages', 'memory.json'), bootId)
}

/**
 * Resolve the plugin-owned SQLite database path from the same harness-home
 * resolver the medium reader uses (`$DSH_HOME/storages/memory.db`). Returns
 * `undefined` when the service is absent — the sqlite backend cannot mount
 * without it (the caller fails loud).
 */
function resolveSqlitePath(ctx: Context): string | undefined {
  const homePath = (ctx as unknown as { get(name: string): unknown }).get('dshHomePath')
  if (typeof homePath !== 'function') return undefined
  return homePath('storages', 'memory.db') as string
}

/**
 * Token bags per entry: content tokens plus — when the entry carries a
 * summary — the summary's tokens. Merging both fields into ONE bag (summary
 * tokens simply repeat into tf) is the deliberately simple stand-in for
 * BM25F: summary is a human-written high-signal distillation, so its terms
 * earning the same tf boost as content terms IS the desired emphasis, and a
 * matched summary keyword pushes an entry above content-only competitors.
 * Explicit BM25F (per-field lengths + b-field + weight w_f) was considered
 * and rejected for now: it adds per-field length bookkeeping and a weight
 * tunable (against the "no hardcoded tunables" rule, another Config field)
 * for a gain this merged bag already captures at fixture scale; revisit if
 * the floors slip with real-corpus summaries. Empty-string summaries count
 * as absent (add() already refuses to store them, but direct table seeds
 * can still carry `summary: ''`).
 */
function entryIndexTokens(entry: MemoryEntry): string[] {
  const contentTokens = tokenizeForSearch(entry.content)
  return entry.summary === undefined || entry.summary === ''
    ? contentTokens
    : [...contentTokens, ...tokenizeForSearch(entry.summary)]
}

/**
 * Filter one anchor list for storage: anchors first became a prompt surface
 * (the digest's topic words), so each one passes the write-time scanner;
 * violating (or empty) anchors drop silently — they are derived tokens, not
 * the entry body, and losing one costs a topic word, never content. The
 * load-time counterpart is `redactBlocked` in the digest builder.
 */
function filterAnchors(anchors: readonly string[]): string[] {
  return anchors.filter(anchor => anchor.length > 0 && scanContent(anchor).allowed)
}

/**
 * MemoryStore implementation backed by a storage-domain KV table. Reads are
 * synchronous from memory; writes serialize on the domain chain. Every
 * successful mutation appends one record to the `audit` table (best-effort:
 * an audit failure never breaks the primary write).
 */
export class DomainMemoryStore extends MemoryStore {
  private readonly entries: EntriesTable
  private readonly audit: AuditTable
  private readonly suggestions: SuggestionsTable
  private readonly meta: MetaTable
  private readonly identity: IdentityTable | undefined
  private readonly identityHistory: IdentityHistoryTable | undefined
  private readonly auditCap: number
  private readonly suggestionCap: number
  private readonly entriesCap: number
  /** Warn channel for swallowed background-path failures; the host `ctx.logger`. */
  private readonly failureLogger: { warn(message: string): void } | undefined
  /** Per-site counts of swallowed failures, surfaced through `health()`. */
  private readonly failureCounts = new Map<string, number>()
  /** Last audit `seq` handed out; lazily initialized from the medium on first append. */
  private auditSeq: number | undefined

  constructor(
    entries: EntriesTable,
    audit: AuditTable,
    suggestions: SuggestionsTable,
    meta: MetaTable,
    auditCap: number = DEFAULT_AUDIT_CAP,
    suggestionCap: number = DEFAULT_SUGGESTION_CAP,
    failureLogger?: { warn(message: string): void },
    entriesCap: number = DEFAULT_ENTRIES_CAP,
    identity?: IdentityTables,
  ) {
    super()
    this.entries = entries
    this.audit = audit
    this.suggestions = suggestions
    this.meta = meta
    this.identity = identity?.identity
    this.identityHistory = identity?.identityHistory
    this.auditCap = auditCap
    this.suggestionCap = suggestionCap
    this.entriesCap = entriesCap
    this.failureLogger = failureLogger
    // Startup selfcheck (scale-trigger-selfcheck): judge the entry count the
    // medium opened with, once per construction. Deployments that reopen an
    // already-large medium see the warning at boot — the point where a
    // migration decision (per-record/SQLite backing) is still cheap — instead
    // of first learning about the size from an eviction storm.
    this.selfcheckScale()
  }

  /**
   * One-time startup scale judgment. Fires a warn when the entry count
   * loaded from the medium already sits at or above
   * {@link SCALE_SELFCHECK_FRACTION} of {@link entriesCap}. The warn carries
   * the concrete numbers and the documented migration threshold, and goes
   * through the same best-effort logger channel as every background-path
   * failure — a missing logger (unit tests, headless constructions) stays
   * silent rather than throwing out of the constructor.
   */
  private selfcheckScale(): void {
    if (this.entries.size < this.entriesCap * SCALE_SELFCHECK_FRACTION) return
    this.failureLogger?.warn(
      `dsh-memory: entries table holds ${this.entries.size} of ${this.entriesCap} `
      + `allowed entries (≥ ${SCALE_SELFCHECK_FRACTION}× cap) — approaching the `
      + 'single-JSON-medium scale ceiling; consider migrating to per-record or '
      + 'SQLite backing (see the improvement program\'s scale-trigger-selfcheck entry)',
    )
  }

  override reportFailure(site: string, error?: unknown): void {
    this.failureCounts.set(site, (this.failureCounts.get(site) ?? 0) + 1)
    this.failureLogger?.warn(`dsh-memory: ${site} failed${error === undefined ? '' : `: ${String(error)}`}`)
  }

  // ─── Meta table (subsystem state rows, § consolidation/migration) ──────────

  /**
   * Read one meta record, synchronously from the domain's in-memory state.
   * @param key - the record's table key (the owning subsystem's `key` plus
   *   any caller suffix, e.g. `'consolidation:lastRun'`).
   * @returns the record, or `undefined` when never written.
   */
  getMeta(key: string): MemoryMetaRecord | undefined {
    return this.meta.get(key)
  }

  /**
   * Write one meta record durably (insert or full replace — the table's `put`
   * contract, no partial merge). Best-effort on failure: a meta write never
   * breaks the caller's primary path, mirroring the audit-append discipline.
   * @param key - the record's table key.
   * @param record - the full new record; `updatedAt` is stamped here when the
   *   caller leaves it off.
   */
  async setMeta(key: string, record: MemoryMetaRecord): Promise<void> {
    try {
      await this.meta.put(key, record.updatedAt !== undefined ? record : { ...record, updatedAt: Date.now() })
    } catch (error) {
      this.reportFailure('meta-write', error)
    }
  }

  /** Next monotonic audit sequence number (survives reopen via the medium). */
  private nextAuditSeq(): number {
    if (this.auditSeq === undefined) {
      let max = 0
      for (const [, record] of this.audit.entries()) max = Math.max(max, record.seq ?? 0)
      this.auditSeq = max
    }
    this.auditSeq += 1
    return this.auditSeq
  }

  override async add(input: AddMemoryInput): Promise<AddMemoryResult> {
    validateProjectScope(input)
    validateContent(input.content)
    const scan = scanContent(input.content)
    if (!scan.allowed) {
      throw new Error(`memory content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    const summaryScan = scanContent(input.summary ?? '')
    if (!summaryScan.allowed) {
      throw new Error(`memory summary rejected by scanner: ${summaryScan.reasons.join('; ')}`)
    }
    const now = Date.now()
    const id = MemoryId()
    const entry: MemoryEntry = {
      id,
      scope: input.scope,
      category: input.category,
      content: input.content,
      ...(input.summary !== undefined && input.summary.length > 0 ? { summary: input.summary } : {}),
      projectName: input.projectName,
      createdAt: now,
      updatedAt: now,
      ...clampImportance(input.importance),
      ...input.anchors !== undefined ? { anchors: filterAnchors(input.anchors) } : {},
    }
    await this.entries.put(id, entry)
    await this.appendAudit('add', id, entry, input.source, input.sessionId)
    // Both new-entry write paths land here (adoptSuggestion's new-entry branch
    // delegates to add), so the cap is enforced at this one chokepoint.
    await this.trimEntries()
    return { entry }
  }

  override get(id: MemoryId): MemoryEntry | undefined {
    return this.entries.get(id)
  }

  override list(scope?: MemoryEntry['scope'], projectName?: string): readonly MemoryEntry[] {
    const results: MemoryEntry[] = []
    for (const [, entry] of this.entries.entries()) {
      if (scope !== undefined && entry.scope !== scope) continue
      if (projectName !== undefined && entry.projectName !== projectName) continue
      results.push(entry)
    }
    return results.sort((a, b) => a.createdAt - b.createdAt)
  }

  override async update(id: MemoryId, input: UpdateMemoryInput): Promise<MemoryEntry | undefined> {
    const existing = this.entries.get(id)
    if (existing === undefined) return undefined
    const newContent = input.content ?? existing.content
    validateContent(newContent)
    const scan = scanContent(newContent)
    if (!scan.allowed) {
      throw new Error(`memory content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    // Scans only what this call writes: an entry stored before summary scanning
    // existed stays updatable, so its summary can still be repaired or cleared.
    const summaryScan = scanContent(input.summary ?? '')
    if (!summaryScan.allowed) {
      throw new Error(`memory summary rejected by scanner: ${summaryScan.reasons.join('; ')}`)
    }
    // summary semantics: `undefined` = keep existing; `''` = explicitly clear;
    // a non-empty string = replace. Build the updated entry accordingly.
    const base: MemoryEntry = {
      ...existing,
      content: newContent,
      category: input.category ?? existing.category,
      updatedAt: Date.now(),
      // Only rewrite the field when the caller supplies one; `undefined`
      // keeps the stored importance (add-time assessment stands).
      ...clampImportance(input.importance),
      // Same absent-means-keep semantics for anchors; supplied anchors are
      // scanner-filtered (they are prompt-surface tokens, like at add time).
      ...(input.anchors !== undefined ? { anchors: filterAnchors(input.anchors) } : {}),
    }
    const updated: MemoryEntry = input.summary === ''
      ? (() => { const { summary: _c, ...rest } = base; return rest as MemoryEntry })()
      : input.summary !== undefined
        ? { ...base, summary: input.summary }
        : base
    await this.entries.put(id, updated)
    await this.appendAudit('update', id, updated, input.source, input.sessionId)
    return updated
  }

  override async remove(id: MemoryId): Promise<boolean> {
    const existing = this.entries.get(id)
    if (existing === undefined) return false
    const removed = await this.entries.delete(id)
    if (removed) {
      await this.appendAudit('remove', id, existing, undefined, undefined)
    }
    return removed
  }

  override search(query: MemorySearchQuery): SearchMemoryResult {
    const limit = query.limit ?? 50
    // Structured filters first; scoring runs over the surviving candidates.
    // Superseded entries are excluded (consolidation conflict verdicts leave
    // them to the navigable-only surfaces: memory_get/memory_list/management UI).
    const candidates: MemoryEntry[] = []
    for (const [, entry] of this.entries.entries()) {
      if (entry.status === 'superseded') continue
      if (query.scope !== undefined && entry.scope !== query.scope) continue
      if (query.category !== undefined && entry.category !== query.category) continue
      if (query.projectName !== undefined && entry.projectName !== query.projectName) continue
      candidates.push(entry)
    }
    const queryTokens = query.query !== undefined && query.query.length > 0 ? tokenizeForSearch(query.query) : []
    let ranked: { entry: MemoryEntry; score: number }[]
    if (queryTokens.length > 0) {
      // BM25 over the filtered set: relevance-weighted (IDF × saturation),
      // CJK bigrams for word-level Chinese precision. OR semantics preserved —
      // any shared term scores above zero and keeps the document in play.
      // The df table is built over the FULL corpus (every entry), not the
      // filtered set: with a 3-entry candidate pool a per-pool df lets a pure
      // function word present in 2 of 3 candidates earn the same IDF as a
      // genuinely distinctive term, and the resulting noise reorders results.
      // Full-corpus stats cost one tokenize pass over all entries per search
      // — the same order as the candidate-set tokenization itself. Both
      // corpus and index see the SAME merged content+summary bag, so df and
      // tf stay consistent.
      const corpus = buildCorpusStatsFromTokens(
        [...this.entries.entries()].map(([, entry]) => entryIndexTokens(entry)),
      )
      const index = new Bm25Index(candidates.map(entry => entryIndexTokens(entry)), corpus)
      const scores = index.scores(queryTokens)
      ranked = []
      candidates.forEach((entry, i) => {
        const score = scores[i] ?? 0
        if (score > 0) ranked.push({ entry, score })
      })
    } else {
      ranked = candidates.map(entry => ({ entry, score: 0 }))
    }
    // Rank by BM25 relevance (desc), then pinned entries (desc), then the
    // model-assessed importance (desc; absent reads as 0, so unassessed
    // entries sort below assessed ones on ties), then by recency (updatedAt
    // desc). Pinned entries surface early even among equal-relevance matches — pin means
    // "the user wants this remembered"; importance is the model's weaker,
    // optional version of the same judgment.
    const pinOf = (entry: MemoryEntry): number => entry.pinned === true ? 1 : 0
    const importanceOf = (entry: MemoryEntry): number => entry.importance ?? 0
    ranked.sort((a, b) =>
      b.score - a.score
      || pinOf(b.entry) - pinOf(a.entry)
      || importanceOf(b.entry) - importanceOf(a.entry)
      || b.entry.updatedAt - a.entry.updatedAt)
    let all = ranked.map(r => r.entry)
    const total = all.length
    all = limit > 0 ? all.slice(0, limit) : all
    // Fire-and-forget: stamp the returned entries with a recall timestamp
    // so the janitor can decay entries that have not been recalled recently.
    // Read-only consumers (management UI) opt out via recordRecall: false —
    // merely viewing entries must not rewrite their recall metadata. The
    // auto-recall fence also opts out and stamps its own lightweight tier.
    if (query.recordRecall !== false) void this.stampRecalled(all.map(entry => entry.id), 'tool')
    return { entries: all, total }
  }

  /**
   * Stamp entries with a recall timestamp (fire-and-forget). Each entry is
   * stamped through the table's atomic read-modify-write, so the transform
   * reads the record current at its write-chain slot — a concurrent
   * `memory_replace` that lands first is never rolled back by the stamp, and
   * the stamp never rolls one back. One stamp pass enqueues one job per
   * changed entry; entries already carrying this pass's timestamp and no
   * decay stamp are skipped without touching the chain. `updatedAt` is
   * intentionally left untouched: recalling is not mutating.
   *
   * The tier follows {@link RecallSource}: `'tool'` bumps `accessCount` (the
   * deliberate-read signal eviction and ranking consume); `'fence'` stamps
   * `lastRecalledAt` only — a BM25 query match is presentation, not use.
   * @param ids - the ids of the entries the caller surfaced to the model.
   * @param source - the recall surface selecting the stamping tier.
   */
  private async stampRecalled(ids: readonly MemoryId[], source: RecallSource): Promise<void> {
    const bumpAccess = source !== 'fence'
    const now = Date.now()
    for (const id of ids) {
      // Cheap pre-check on the synchronous snapshot: a stamp pass that would
      // change nothing skips the queue entirely (the common repeat-search case).
      const snapshot = this.entries.get(id)
      if (snapshot?.lastRecalledAt === now && snapshot.staleSince === undefined) continue
      try {
        // The atomic RMW re-reads at the chain slot, so a content edit that
        // landed between search and stamp survives in the written record.
        await this.entries.update(id, current => {
          if (current.lastRecalledAt === now && current.staleSince === undefined) return current
          const { staleSince: _cleared, ...rest } = current
          return {
            ...rest,
            lastRecalledAt: now,
            ...(bumpAccess ? { accessCount: (rest.accessCount ?? 0) + 1 } : {}),
          }
        })
      } catch (error) {
        // A missing id (entry removed between search and stamp) or a domain
        // going away mid-pass is a normal end-of-life for a stamp, not a
        // failure to report.
        if (error instanceof Error && !error.message.includes('no record')) {
          this.reportFailure('recall-stamp', error)
        }
      }
    }
  }

  /**
   * Record that the caller actually surfaced the given entries to the model
   * (e.g. `memory_get` / `memory_list` tool results). Fire-and-forget; never
   * throws into the caller. The base-class default is a no-op so providers
   * without recall tracking stay contract-conformant.
   * @param ids - the ids of the entries surfaced.
   * @param source - the recall surface selecting the stamping tier (see
   *   {@link stampRecalled}); defaults to the full `'tool'` stamp.
   */
  override markRecalled(ids: readonly string[], source: RecallSource = 'tool'): void {
    if (ids.length === 0) return
    void this.stampRecalled(ids.filter(id => this.entries.get(id as MemoryId) !== undefined) as MemoryId[], source)
  }

  /**
   * Record usage hits on the given entries (write-path rework Step 2):
   * bump `hitCount` and stamp `lastHitAt` through the table's atomic
   * read-modify-write — the same discipline as {@link stampRecalled}, so a
   * concurrent content edit is never rolled back by a hit and vice versa.
   * `updatedAt` is intentionally left untouched: a hit is a reading signal,
   * not a mutation. Idempotent per call batch (one call adds exactly one
   * hit per entry, regardless of duplicates inside `ids`); unknown ids and
   * entries removed mid-pass are skipped like a stale recall stamp.
   * @param ids - the ids of the entries the assistant's answer echoed.
   */
  override async markHits(ids: readonly MemoryId[]): Promise<void> {
    const now = Date.now()
    // One batch = one hit per entry, regardless of duplicates inside `ids`
    // (the caller passes the echoed id set; a set has no multiplicity).
    for (const id of [...new Set(ids)]) {
      const snapshot = this.entries.get(id)
      if (snapshot === undefined) continue
      try {
        await this.entries.update(id, current => ({
          ...current,
          hitCount: (current.hitCount ?? 0) + 1,
          lastHitAt: now,
        }))
        await this.appendAudit('update', id, this.entries.get(id) ?? snapshot, 'review', undefined)
      } catch (error) {
        // A missing id (entry removed between the caller's answer and this
        // write) or a domain going away mid-pass is a normal end-of-life for
        // a hit, not a failure to report.
        if (error instanceof Error && !error.message.includes('no record')) {
          this.reportFailure('mark-hits', error)
        }
      }
    }
  }

  // ─── Suggestion queue (P1-1 optional human-confirm mode) ──────────────────

  /**
   * Record one extraction/model proposal in the pending-review queue.
   *
   * Dedup semantics ("frequency is signal", evolve-style): when a similar
   * proposal already exists in the same scope — or one targeting the same
   * entry — the observation bumps its `hits` and refreshes `lastSeenAt`
   * instead of creating a row; missing metadata (category/summary) is filled
   * from the newer proposal, and strictly more informative content (a
   * superset) replaces the original. Otherwise the proposal joins with
   * `hits: 1`.
   * @param input - the proposal to record.
   * @returns the stored suggestion (existing row updated, or newly created).
   * @throws when the proposed content or summary fails validation or the scanner.
   */
  override async observeSuggestion(input: AddSuggestionInput): Promise<MemorySuggestion> {
    // Identity proposals (confirm-mode identity_update) take their own queue
    // path: dedup by document kind, not by scope/content overlap.
    if (input.identityKind !== undefined) {
      return this.observeIdentitySuggestion(input)
    }
    validateProjectScope({ ...input, projectName: input.projectName ?? (input.targetEntryId !== undefined ? this.entries.get(input.targetEntryId)?.projectName : undefined) })
    validateContent(input.content)
    const scan = scanContent(input.content)
    if (!scan.allowed) {
      throw new Error(`suggestion content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    const summaryScan = scanContent(input.summary ?? '')
    if (!summaryScan.allowed) {
      throw new Error(`suggestion summary rejected by scanner: ${summaryScan.reasons.join('; ')}`)
    }
    const now = Date.now()
    // Match against existing proposals: same target entry wins outright;
    // otherwise nearest-content in the same scope above the dup threshold.
    let matched: MemorySuggestion | undefined
    const inputTokens = uniqueTokens(input.content)
    for (const [, suggestion] of this.suggestions.entries()) {
      if (input.targetEntryId !== undefined) {
        if (suggestion.targetEntryId === input.targetEntryId) { matched = suggestion; break }
        continue
      }
      // Identity rows never match entry proposals: their dedup dimension is
      // the document kind, not scope/content overlap.
      if (suggestion.identityKind !== undefined) continue
      if (suggestion.scope !== input.scope) continue
      // The live queue is the corpus: at queue scale (≤ cap rows) rebuilding
      // the df table per row would be wasteful, but the queue is tiny — and
      // the table only needs building once per observe call, not per row.
      const stats = buildCorpusStats([input.content, suggestion.content])
      const similarity = weightedOverlapSimilarity(stats, inputTokens, uniqueTokens(suggestion.content))
      if (similarity > SUGGESTION_DUP_THRESHOLD) { matched = suggestion; break }
    }
    if (matched !== undefined) {
      const improved = input.content.length > matched.content.length && input.content.includes(matched.content)
      const updated: MemorySuggestion = {
        ...matched,
        content: improved ? input.content : matched.content,
        category: matched.category ?? input.category,
        summary: matched.summary ?? input.summary,
        projectName: matched.projectName ?? input.projectName,
        hits: matched.hits + 1,
        lastSeenAt: now,
      }
      await this.suggestions.put(matched.id, updated)
      return updated
    }
    const suggestion: MemorySuggestion = {
      id: SuggestionId(),
      scope: input.scope,
      content: input.content,
      hits: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      source: input.source,
      ...input.category !== undefined ? { category: input.category } : {},
      ...input.summary !== undefined ? { summary: input.summary } : {},
      ...input.projectName !== undefined ? { projectName: input.projectName } : {},
      ...input.targetEntryId !== undefined ? { targetEntryId: input.targetEntryId } : {},
      ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
    }
    await this.suggestions.put(suggestion.id, suggestion)
    await this.trimSuggestions()
    return suggestion
  }

  /**
   * The identity-proposal queue path (confirm-mode `identity_update`): the
   * same scanner gates, dedup by document kind — one row per identity
   * document, a repeated proposal bumps `hits` — and `scope` fixed at
   * `'global'` (the identity layer is per-user global; the field exists for
   * the durable row shape).
   */
  private async observeIdentitySuggestion(input: AddSuggestionInput): Promise<MemorySuggestion> {
    validateContent(input.content)
    const scan = scanContent(input.content)
    if (!scan.allowed) {
      throw new Error(`suggestion content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    const now = Date.now()
    // Identity proposals dedup by kind alone (not content similarity like entry
    // proposals): each identity kind has exactly one living document, so the
    // latest proposal per kind always supersedes earlier ones.
    for (const [, suggestion] of this.suggestions.entries()) {
      if (suggestion.identityKind !== input.identityKind) continue
      const improved = input.content.length > suggestion.content.length && input.content.includes(suggestion.content)
      const updated: MemorySuggestion = {
        ...suggestion,
        content: improved ? input.content : suggestion.content,
        hits: suggestion.hits + 1,
        lastSeenAt: now,
      }
      await this.suggestions.put(suggestion.id, updated)
      return updated
    }
    const suggestion: MemorySuggestion = {
      id: SuggestionId(),
      scope: 'global',
      content: input.content,
      hits: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      source: input.source,
      identityKind: input.identityKind,
      ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
    }
    await this.suggestions.put(suggestion.id, suggestion)
    await this.trimSuggestions()
    return suggestion
  }

  /**
   * List pending suggestions for the review UI: highest `hits` first (the
   * repeatedly-re-proposed signals float up), then most recently seen.
   */
  override listSuggestions(): readonly MemorySuggestion[] {
    const all: MemorySuggestion[] = []
    for (const [, suggestion] of this.suggestions.entries()) all.push(suggestion)
    return all.sort((a, b) => b.hits - a.hits || b.lastSeenAt - a.lastSeenAt || (a.id < b.id ? -1 : 1))
  }

  override getSuggestion(id: SuggestionId): MemorySuggestion | undefined {
    return this.suggestions.get(id)
  }

  /**
   * Adopt one pending suggestion — the human yes that turns a proposal into
   * memory. With `targetEntryId` set, the (possibly edited) content updates
   * the targeted entry (P1-2: the model's change applies only here);
   * otherwise a new entry is created. The override carries the "edit before
   * adopt" tweaks made in the review UI. The adopted write goes through the
   * full store contract (scanner included) and the audit trail with source
   * `'ui'`; the suggestion row is removed afterwards.
   * @param id - the suggestion id.
   * @param override - optional human edits applied on top of the proposal.
   * @returns the written entry, or `undefined` when the suggestion is gone.
   */
  override async adoptSuggestion(id: SuggestionId, override?: AdoptSuggestionOverride): Promise<MemoryEntry | undefined> {
    const suggestion = this.suggestions.get(id)
    if (suggestion === undefined) return undefined
    const content = override?.content ?? suggestion.content
    validateContent(content)
    const scan = scanContent(content)
    if (!scan.allowed) {
      throw new Error(`adopted content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    const category = override?.category !== undefined
      ? (override.category.length > 0 ? override.category : undefined)
      : suggestion.category
    const summary = override?.summary !== undefined
      ? (override.summary.length > 0 ? override.summary : undefined)
      : suggestion.summary
    // Identity proposal: the human's yes rewrites the document through the
    // identity write path (source 'ui' — the governance adoption). No memory
    // entry is created, so the caller sees `undefined` on success.
    if (suggestion.identityKind !== undefined) {
      await this.updateIdentity(suggestion.identityKind, content, { source: 'ui' })
      await this.suggestions.delete(id)
      return undefined
    }
    let entry: MemoryEntry | undefined
    if (suggestion.targetEntryId !== undefined && this.entries.get(suggestion.targetEntryId) !== undefined) {
      entry = await this.update(suggestion.targetEntryId, {
        content,
        ...(category !== undefined ? { category } : {}),
        ...(summary !== undefined ? { summary } : { summary: '' }),
        source: 'ui',
      })
    } else {
      const result = await this.add({
        scope: suggestion.scope,
        content,
        source: 'ui',
        ...(category !== undefined ? { category } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(suggestion.projectName !== undefined ? { projectName: suggestion.projectName } : {}),
      })
      entry = result.entry
    }
    await this.suggestions.delete(id)
    return entry
  }

  /**
   * Reject one pending suggestion: the row leaves the queue and nothing is
   * written. @returns whether a suggestion was actually removed.
   */
  override async rejectSuggestion(id: SuggestionId): Promise<boolean> {
    return this.suggestions.delete(id)
  }

  /** Trim the suggestion queue to its cap, evicting the lowest-signal rows. */
  private async trimSuggestions(): Promise<void> {
    if (this.suggestions.size <= this.suggestionCap) return
    const all = [...this.suggestions.entries()].map(([, s]) => s)
    all.sort((a, b) => a.hits - b.hits || a.lastSeenAt - b.lastSeenAt)
    const excess = all.length - this.suggestionCap
    for (let i = 0; i < excess; i++) {
      await this.suggestions.delete(all[i]!.id)
    }
  }

  /**
   * Trim the entries table to {@link DEFAULT_ENTRIES_CAP} / the configured
   * `entriesCap` after a successful write. Awaited inline like
   * {@link trimSuggestions} (not failure-shielded like {@link trimAudit}):
   * an eviction failure propagates to the add caller even though the added
   * row landed. Eviction runs in one pass down TO the cap (not one per add),
   * ordered by the use signal — pinned entries are exempt; the rest go by
   * ascending `accessCount` (never-recalled reads as 0), then ascending
   * `lastRecalledAt` ?? `createdAt` (longest-unrecalled first). When every
   * remaining candidate is protected (e.g. all pinned), the table is allowed
   * to exceed the cap — the cap is a soft target, eviction never deletes a
   * protected entry to reach it.
   *
   * Audit trail: the eviction records `op: 'remove'`, `source: 'janitor'`.
   * The janitor source names system-initiated lifecycle writes (decay,
   * dormancy), and `AuditSource` is a fixed schema enum — extending it would
   * change the durable record shape — so the store's own eviction reuses it.
   */
  private async trimEntries(): Promise<void> {
    if (this.entries.size <= this.entriesCap) return
    const all: MemoryEntry[] = []
    for (const [, entry] of this.entries.entries()) all.push(entry)
    // Eviction order (ascending = evicted first): pinned last/never, then
    // fewest recalls, then longest since last recall (never-recalled entries
    // date from creation).
    all.sort((a, b) =>
      (a.pinned === true ? 1 : 0) - (b.pinned === true ? 1 : 0)
      || (a.accessCount ?? 0) - (b.accessCount ?? 0)
      || (a.lastRecalledAt ?? a.createdAt) - (b.lastRecalledAt ?? b.createdAt))
    const excess = all.length - this.entriesCap
    for (let i = 0; i < excess; i++) {
      const victim = all[i]!
      if (victim.pinned === true) break
      const removed = await this.entries.delete(victim.id)
      if (removed) {
        await this.appendAudit('remove', victim.id, victim, 'janitor', undefined)
      }
    }
  }

  override async pin(id: MemoryId): Promise<MemoryEntry | undefined> {
    const existing = this.entries.get(id)
    if (existing === undefined) return undefined
    const updated: MemoryEntry = { ...existing, pinned: true }
    await this.entries.put(id, updated)
    return updated
  }

  override async unpin(id: MemoryId): Promise<MemoryEntry | undefined> {
    const existing = this.entries.get(id)
    if (existing === undefined) return undefined
    const updated: MemoryEntry = { ...existing, pinned: false }
    await this.entries.put(id, updated)
    return updated
  }

  /**
   * Archive one entry manually (P1-7): stamp `staleSince` (idempotent — an
   * already-stale entry is returned unchanged) and record a `'ui'`-sourced
   * audit update. Hidden from injection; still searchable; recall revives.
   */
  override async archiveEntry(id: MemoryId): Promise<MemoryEntry | undefined> {
    const existing = this.entries.get(id)
    if (existing === undefined) return undefined
    if (existing.staleSince !== undefined) return existing
    const updated: MemoryEntry = { ...existing, staleSince: Date.now() }
    await this.entries.put(id, updated)
    await this.appendAudit('update', id, updated, 'ui', undefined)
    return updated
  }

  /** Lift a manual or janitor dormancy stamp without counting it as a recall. */
  override async unarchiveEntry(id: MemoryId): Promise<MemoryEntry | undefined> {
    const existing = this.entries.get(id)
    if (existing === undefined || existing.staleSince === undefined) return existing
    const { staleSince: _cleared, ...rest } = existing
    const updated: MemoryEntry = rest as MemoryEntry
    await this.entries.put(id, updated)
    await this.appendAudit('update', id, updated, 'ui', undefined)
    return updated
  }

  /**
   * Supersede one entry (batch-consolidation seam, Step 1.3): flip `status`
   * to `'superseded'`, stamp `supersededBy`, and append the caller's visible
   * annotation to the content in one atomic write. Idempotent on an already
   * superseded entry (returned unchanged, no audit). The audit trail records
   * source `'janitor'` — the `AuditSource` enum has no consolidation member,
   * and extending the durable enum shape is not this seam's business (the
   * same rationale as {@link trimEntries}'s eviction records).
   * @param id - the entry being superseded.
   * @param supersededBy - the id of the newer, contradicting entry.
   * @param annotate - optional content annotation (receives the pre-stamp
   *   entry, returns the new content); called before the write so the
   *   annotation lands atomically with the status flip.
   * @returns the superseded entry, or `undefined` when the id does not exist.
   */
  override async supersedeEntry(id: MemoryId, supersededBy: MemoryId, annotate?: (entry: MemoryEntry) => string): Promise<MemoryEntry | undefined> {
    const existing = this.entries.get(id)
    if (existing === undefined) return undefined
    if (existing.status === 'superseded') return existing
    const annotated = annotate === undefined ? existing.content : annotate(existing)
    const updated: MemoryEntry = {
      ...existing,
      content: annotated,
      status: 'superseded',
      supersededBy,
    }
    await this.entries.put(id, updated)
    await this.appendAudit('update', id, updated, 'janitor', undefined)
    return updated
  }

  // ─── Identity documents (the identity layer) ────────────────────────────────

  /** The identity tables, or a loud refusal — identity writes never silently no-op. */
  private requireIdentityTables(): IdentityTables {
    if (this.identity === undefined || this.identityHistory === undefined) {
      throw new Error('this store was mounted without identity tables')
    }
    return { identity: this.identity, identityHistory: this.identityHistory }
  }

  override getIdentity(kind: IdentityKind): IdentityRecord | undefined {
    return this.identity?.get(kind)
  }

  override async updateIdentity(kind: IdentityKind, content: string, input: UpdateIdentityInput): Promise<IdentityRecord> {
    return this.writeIdentity(kind, content, input)
  }

  override listIdentityHistory(kind: IdentityKind): readonly IdentityHistoryRecord[] {
    if (this.identityHistory === undefined) return []
    const all: IdentityHistoryRecord[] = []
    for (const [key, record] of this.identityHistory.entries()) {
      if (!key.startsWith(`${kind}#`)) continue
      all.push(record)
    }
    all.sort((a, b) => b.version - a.version)
    return all
  }

  override async revertIdentity(kind: IdentityKind, version: number): Promise<IdentityRecord> {
    const { identityHistory } = this.requireIdentityTables()
    const snapshot = identityHistory.get(`${kind}#${version}`)
    if (snapshot === undefined) {
      throw new Error(`identity history has no version ${String(version)} for '${kind}'`)
    }
    return this.writeIdentity(kind, snapshot.content, { source: 'ui' })
  }

  /**
   * The shared write path behind update/revert: scanner gate, next version
   * through the table's atomic read-modify-write, history snapshot, history
   * trim. Character budgets are NOT enforced here — they are settings, and
   * the identity service (read side) and the tool (write side) own them.
   */
  private async writeIdentity(kind: IdentityKind, content: string, input: UpdateIdentityInput): Promise<IdentityRecord> {
    const { identity, identityHistory } = this.requireIdentityTables()
    validateContent(content)
    const scan = scanContent(content)
    if (!scan.allowed) {
      throw new Error(`identity content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    const now = Date.now()
    let record: IdentityRecord
    try {
      // Atomic read-modify-write: the next version re-reads the record
      // current at this write-chain slot, so two racing rewrites never mint
      // the same version — the later write lands as the next version instead
      // of overwriting the winner.
      record = await identity.update(kind, current => nextIdentityRecord(current, kind, content, input, now))
    } catch (error) {
      // First-ever write: no record to read-modify-write. The seed path is
      // once-per-process guarded by the identity service and the domain's
      // single-writer guard excludes cross-process racers, so the residual
      // window is a same-process race between two simultaneous first writes.
      // Fragile: the fallback to put() relies on error-message text from the host's
      // KvTable.update; if the host changes its wording this branch may stop firing.
      // Ideally the host would expose a typed MissingRecordError; until then, keep
      // the string set narrow and update it when the host is bumped.
      if (!(error instanceof Error) || !(error.message.includes('missing-key') || error.message.includes('no record'))) throw error
      record = nextIdentityRecord(undefined, kind, content, input, now)
      await identity.put(kind, record)
    }
    await identityHistory.put(`${kind}#${record.version}`, {
      kind,
      version: record.version,
      content,
      ts: now,
      source: input.source,
      ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
    })
    await this.trimIdentityHistory(kind)
    return record
  }

  /** Trim one document's history to the cap, deleting the oldest versions. */
  private async trimIdentityHistory(kind: IdentityKind): Promise<void> {
    if (this.identityHistory === undefined) return
    const all = this.listIdentityHistory(kind)
    const excess = all.length - IDENTITY_HISTORY_CAP
    for (let i = 0; i < excess; i++) {
      const oldest = all[all.length - 1 - i]!
      await this.identityHistory.delete(`${kind}#${oldest.version}`)
    }
  }

  /**
   * Run the janitor pass with the lifecycle's two-tier policy:
   * - `project` entries overdue by `decayDays` (pinned exempt) are REMOVED
   *   (hard decay, audited).
   * - `global`/`user` entries overdue (pinned exempt) are soft-decayed: the
   *   first overdue pass stamps `staleSince`, which hides them from injection
   *   surfaces while keeping them searchable; a later recall clears the stamp.
   * The snapshot iteration is only a pre-filter: every delete and stamp
   * re-decides on the record current at its write-chain slot (the same
   * atomic RMW discipline as `stampRecalled`), so a pin landing between the
   * snapshot and the write is honored.
   * @param decayDays - days without recall before the policy applies.
   * @param now - evaluation clock; defaults to wall time (tests inject fixed clocks).
   * @returns the number of project entries removed.
   */
  override async janitor(decayDays: number, now: number = Date.now()): Promise<number> {
    if (decayDays <= 0) return 0
    const decayMs = decayDays * 24 * 60 * 60 * 1000
    let removed = 0
    for (const [, snapshot] of this.entries.entries()) {
      if (snapshot.pinned === true) continue
      // Snapshot pass is a cheap pre-filter only: every decision below is
      // re-made on the record current at its write-chain slot, so a pin that
      // lands between this iteration and the write is still honored.
      const lastActive = snapshot.lastRecalledAt ?? snapshot.createdAt
      if (now - lastActive < decayMs) continue
      if (snapshot.scope === 'project') {
        // Hard decay: KvTable.update cannot express delete, so the pinned
        // re-check runs as a guard update (returning `current` unchanged —
        // one empty write) and only an unpinned result reaches the delete.
        // Residual TOCTOU window: a pin landing AFTER the guard's chain slot
        // but BEFORE the delete is not observed; the single-process write
        // chain serializes these two calls, but nothing narrower than
        // "guard → delete" exists on KvTable to close the gap. Covered by
        // the janitor-pin-toctou contract test.
        let pinnedAtSlot = false
        try {
          await this.entries.update(snapshot.id, current => {
            pinnedAtSlot = current.pinned === true
            return current
          })
        } catch (error) {
          // A missing id means the entry was removed by another caller
          // between the snapshot and this guard — nothing left to decay.
          if (error instanceof Error && !error.message.includes('no record')) {
            this.reportFailure('janitor', error)
          }
        }
        if (pinnedAtSlot) continue
        const didRemove = await this.entries.delete(snapshot.id)
        if (didRemove) {
          removed++
          await this.appendAudit('remove', snapshot.id, snapshot, 'janitor', undefined)
        }
        continue
      }
      // global/user: soft decay only — stamp once, never auto-delete. The
      // whole decision re-runs on the record current at its chain slot, so
      // the stamp is atomic: a pin or a fresh recall that lands between the
      // snapshot and here skips it, and an already-stamped entry is left
      // untouched. A model-assessed importance of 4–5 extends the grace
      // window 1.5×: a "this matters" judgment should survive a longer quiet
      // period, while low or unassessed entries keep the plain clock. Recall
      // (accessCount) stays the stronger signal — it clears decay outright
      // via stampRecalled.
      let didStamp = false
      let stamped: MemoryEntry | undefined
      try {
        stamped = await this.entries.update(snapshot.id, current => {
          const lastActiveNow = current.lastRecalledAt ?? current.createdAt
          if (now - lastActiveNow < decayMs) return current
          const graceFactor = current.importance !== undefined && current.importance >= 4 ? 1.5 : 1
          if (now - lastActiveNow < decayMs * graceFactor) return current
          if (current.pinned === true) return current
          if (current.staleSince !== undefined) return current
          didStamp = true
          return { ...current, staleSince: now }
        })
      } catch (error) {
        // A missing id (entry removed between the snapshot and this slot) or
        // a domain going away mid-pass is a normal end of life for a stamp.
        if (error instanceof Error && !error.message.includes('no record')) {
          this.reportFailure('janitor', error)
        }
      }
      if (didStamp && stamped !== undefined) {
        await this.appendAudit('update', snapshot.id, stamped, 'janitor', undefined)
      }
    }
    return removed
  }

  /**
   * List audit records, newest first. Each audit record captures one mutation.
   * @returns all audit entries ordered by `ts` descending (then `id` for stability).
   */
  listAudit(): readonly AuditEntry[] {
    const all: AuditEntry[] = []
    for (const [, record] of this.audit.entries()) all.push(record)
    all.sort(compareAuditDesc)
    return all
  }

  override health(): MemoryHealth {
    let global = 0, project = 0, user = 0, pinned = 0, stale = 0
    for (const [, entry] of this.entries.entries()) {
      if (entry.scope === 'global') global++
      else if (entry.scope === 'project') project++
      else user++
      if (entry.pinned === true) pinned++
      if (entry.staleSince !== undefined) stale++
    }
    const audit = this.listAudit()
    const lastActivityTs = audit.length > 0 ? audit[0]!.ts : undefined
    const lastExtractionRecord = audit.find(r => r.source === 'review' || r.source === 'flush')
    const lastExtractionTs = lastExtractionRecord?.ts
    return {
      totalEntries: global + project + user,
      byScope: { global, project, user },
      pinned,
      auditRecords: audit.length,
      stale,
      ...lastActivityTs !== undefined ? { lastActivityTs } : {},
      ...lastExtractionTs !== undefined ? { lastExtractionTs } : {},
      ...this.failureCounts.size > 0 ? { backgroundFailures: Object.fromEntries(this.failureCounts) } : {},
    }
  }

  override async getRaw(id: MemoryId): Promise<MemoryEntry | undefined> {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    await this.appendAudit('readRaw', id, entry, 'ui', undefined)
    return entry
  }

  override exportAuditLog(): readonly AuditEntry[] {
    const all: AuditEntry[] = []
    for (const [, record] of this.audit.entries()) all.push(record)
    all.sort(compareAuditAsc)
    return all
  }

  /**
   * Append one audit record after a successful mutation, then trim the table
   * to the cap (keep newest). Best-effort: a failure here is swallowed so it
   * never breaks the primary write path.
   */
  private async appendAudit(
    op: AuditOp,
    entryId: MemoryId,
    entry: Pick<MemoryEntry, 'scope' | 'category' | 'content'>,
    source: AuditSource | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    try {
      const record: AuditEntry = {
        id: AuditId(),
        op,
        entryId,
        scope: entry.scope,
        ...entry.category !== undefined ? { category: entry.category } : {},
        source: source ?? 'tool',
        ...sessionId !== undefined ? { sessionId } : {},
        ts: Date.now(),
        seq: this.nextAuditSeq(),
        contentPreview: preview(entry.content),
      }
      await this.audit.put(record.id, record)
      await this.trimAudit()
    } catch (error) {
      // Best-effort: an audit failure must never propagate to the caller.
      this.reportFailure('audit-append', error)
    }
  }

  /** Trim the audit table to the cap, deleting the oldest records. */
  private async trimAudit(): Promise<void> {
    if (this.audit.size <= this.auditCap) return
    const all: AuditEntry[] = []
    for (const [, record] of this.audit.entries()) all.push(record)
    all.sort(compareAuditAsc)
    const excess = all.length - this.auditCap
    for (let i = 0; i < excess; i++) {
      await this.audit.delete(all[i]!.id)
    }
  }
}

/** Truncate content to a scanner-clean ~100-char preview for the audit trail. */
function preview(content: string): string {
  const p = content.slice(0, 100)
  return scanContent(p).allowed ? p : '[content redacted]'
}

/** Importances land in 1–5 regardless of what the caller passed in. */
const IMPORTANCE_MIN = 1
const IMPORTANCE_MAX = 5

/**
 * Project an optional caller-supplied importance onto the entry-field spread:
 * absent input spreads nothing (stored value stands); out-of-range input is
 * clamped rather than rejected — a wrong assessment is not a protocol error.
 */
function clampImportance(importance: number | undefined): { importance: number } | Record<string, never> {
  if (importance === undefined || Number.isNaN(importance)) return {}
  const clamped = Math.min(IMPORTANCE_MAX, Math.max(IMPORTANCE_MIN, Math.round(importance)))
  return { importance: clamped }
}
