/**
 * The SQLite local storage backend (write-path rework Step 3.1): a
 * `MemoryStore` provider over `node:sqlite`'s `DatabaseSync`, owning the
 * plugin-named file `$DSH_HOME/storages/memory.db` (WAL mode + busy_timeout).
 *
 * Read path: the full tables load into memory at open (the target scale is
 * tens–hundreds of entries) and all reads serve from that snapshot — the same
 * synchronous in-memory read semantics as {@link DomainMemoryStore}. Write
 * path: one SQL statement per record, entries + audit landing in one
 * transaction — the write-amplification win over the host medium's
 * full-file republish-and-fsync.
 *
 * The `node:sqlite` API surface is deliberately pinned to open/prepare/exec
 * (plus the transaction helper); everything else about the driver hides
 * behind this class (HOST_CONTRACT §11). Schema: `entries` (MemoryEntry
 * fields as columns), `audit` (the audit trail), `suggestions` (the P1-1
 * queue shape), `meta` (schemaVersion + consolidation progress). Zero-
 * migration on read: absent columns/tables only matter at their write
 * boundaries, and every column is nullable.
 *
 * @module @chenhw7/dsh-memory/store/sqlite
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  MemoryStore,
  validateProjectScope,
  validateContent,
} from '../index.ts'
import { scanContent } from '../scanner.ts'
import { buildCorpusStatsFromTokens, Bm25Index, tokenizeForSearch } from './bm25.ts'
import type {
  AddMemoryInput,
  AddMemoryResult,
  AuditEntry,
  MemoryEntry,
  MemoryHealth,
  MemoryId,
  MemorySearchQuery,
  MemorySuggestion,
  SearchMemoryResult,
  UpdateMemoryInput,
  AddSuggestionInput,
} from '../types.ts'

/** The in-memory mutable row the read path serves (JSON-serializable). */
type Row = Record<string, unknown>

/** Cast a row to the MemoryEntry contract (the row carries exactly its fields). */
function asEntry(row: Row): MemoryEntry {
  return row as unknown as MemoryEntry
}

/** The columns the entries table carries (MemoryEntry's persisted fields). */
const ENTRY_COLUMNS = [
  'id', 'scope', 'category', 'content', 'summary', 'projectName',
  'createdAt', 'updatedAt', 'pinned', 'lastRecalledAt', 'staleSince',
  'accessCount', 'importance', 'anchors', 'status', 'supersededBy',
  'hitCount', 'lastHitAt',
] as const

/** The audit table's columns (AuditEntry fields). */
const AUDIT_COLUMNS = [
  'id', 'op', 'entryId', 'scope', 'category', 'source', 'sessionId',
  'ts', 'seq', 'contentPreview',
] as const

/** The suggestions table's columns (MemorySuggestion fields). */
const SUGGESTION_COLUMNS = [
  'id', 'scope', 'category', 'content', 'summary', 'projectName', 'hits',
  'firstSeenAt', 'lastSeenAt', 'targetEntryId', 'source', 'sessionId',
] as const

/**
 * Bind one record's optional fields to a statement: every column gets a
 * positional parameter; `undefined` binds as SQL NULL (the zero-migration
 * read side: absent optional fields read back as NULL → undefined).
 */
function bindRecord(statement: StatementSync, columns: readonly string[], record: Row): void {
  const params = columns.map(column => {
    const value = record[column]
    if (value === undefined || value === null) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'object') return JSON.stringify(value)
    return value as string | number | bigint
  })
  statement.run(...params)
}

/** Read one row back into the record shape (JSON decoded; booleans restored; NULL dropped). */
function rowToRecord(row: Record<string, unknown>): Row {
  const record: Row = {}
  for (const [key, value] of Object.entries(row)) {
    if (value === null) continue
    if (typeof value === 'number' && (key === 'pinned')) {
      record[key] = value === 1
      continue
    }
    if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
      try {
        record[key] = JSON.parse(value) as unknown
        continue
      } catch {
        // Not JSON — a literal string that happens to start with a bracket.
      }
    }
    record[key] = value
  }
  return record
}

/** The composed failure-reporting seam (same shape as DomainMemoryStore's). */
export interface SqliteStoreOptions {
  /** Absolute path of the database file (`$DSH_HOME/storages/memory.db`). */
  readonly dbPath: string
  /** Swallowed-failure warn channel (the host `ctx.logger`). */
  readonly failureLogger?: { warn(message: string): void } | undefined
  /** Audit-trail cap (oldest evicted first); default 200, matching the domain store. */
  readonly auditCap?: number | undefined
  /** Suggestion-queue cap; default 200. */
  readonly suggestionCap?: number | undefined
  /** Entries cap (§ write-path governance); default 500. */
  readonly entriesCap?: number | undefined
}

/**
 * The medium meta-table key recording that this medium's data moved into
 * memory.db (Step 3.2's one-time migration marker). A host-medium boot that
 * reads this marker fails loud — two live stores would diverge.
 */
export const SQLITE_MIGRATION_MARKER = 'medium:migratedToSqlite'

export class SqliteMemoryStore extends MemoryStore {
  private readonly db: DatabaseSync
  private readonly failureLogger: { warn(message: string): void } | undefined
  private readonly auditCap: number
  private readonly suggestionCap: number
  private readonly entriesCap: number
  private readonly failureCounts = new Map<string, number>()
  private auditSeq = 0

  constructor(options: SqliteStoreOptions) {
    super()
    this.failureLogger = options.failureLogger
    this.auditCap = options.auditCap ?? 200
    this.suggestionCap = options.suggestionCap ?? 200
    this.entriesCap = options.entriesCap ?? 500
    mkdirSync(dirname(options.dbPath), { recursive: true })
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
    this.auditSeq = this.maxAuditSeq()
  }

  /** Create the tables when absent (zero-migration: existing databases reopen untouched). */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, ${ENTRY_COLUMNS.filter(column => column !== 'id').map(column => `"${column}"`).join(', ')});
      CREATE TABLE IF NOT EXISTS audit (${AUDIT_COLUMNS.map(column => column).join(', ')});
      CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, ${SUGGESTION_COLUMNS.filter(column => column !== 'id').map(column => column).join(', ')});
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER);
    `)
  }

  override reportFailure(site: string, error?: unknown): void {
    this.failureCounts.set(site, (this.failureCounts.get(site) ?? 0) + 1)
    this.failureLogger?.warn(`dsh-memory: ${site} failed${error === undefined ? '' : `: ${String(error)}`}`)
  }

  /** Close the database connection (the WAL sidecars recover on the next open). */
  close(): void {
    this.db.close()
  }

  private maxAuditSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS max FROM audit').get() as { max: number | null } | undefined
    return row?.max ?? 0
  }

  /** Next monotonic audit sequence number (the medium's MAX(seq) + 1). */
  private nextAuditSeq(): number {
    this.auditSeq += 1
    return this.auditSeq
  }

  // ─── Write path ─────────────────────────────────────────────────────────────

  override async add(input: AddMemoryInput): Promise<AddMemoryResult> {
    validateProjectScope(input)
    validateContent(input.content)
    const scan = scanContent(input.content)
    if (!scan.allowed) {
      throw new Error(`memory content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    const now = Date.now()
    const entry: Row = {
      id: crypto.randomUUID(),
      scope: input.scope,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
      ...(input.anchors !== undefined ? { anchors: input.anchors } : {}),
    }
    this.transaction(() => {
      this.insertEntry(entry)
      this.trimEntries(now)
      this.appendAudit('add', entry.id as string, entry, input.source, input.sessionId, input.content)
    })
    return { entry: asEntry(entry) }
  }

  override get(id: MemoryId): MemoryEntry | undefined {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id as string) as Record<string, unknown> | undefined
    return row === undefined ? undefined : asEntry(rowToRecord(row))
  }

  override list(scope?: MemoryEntry['scope'], projectName?: string): readonly MemoryEntry[] {
    const results: MemoryEntry[] = []
    let statement: StatementSync
    if (scope !== undefined && projectName !== undefined) {
      statement = this.db.prepare('SELECT * FROM entries WHERE scope = ? AND projectName = ?')
      for (const row of statement.all(scope, projectName) as Record<string, unknown>[]) results.push(asEntry(rowToRecord(row)))
    } else if (scope !== undefined) {
      statement = this.db.prepare('SELECT * FROM entries WHERE scope = ?')
      for (const row of statement.all(scope) as Record<string, unknown>[]) results.push(asEntry(rowToRecord(row)))
    } else if (projectName !== undefined) {
      statement = this.db.prepare('SELECT * FROM entries WHERE projectName = ?')
      for (const row of statement.all(projectName) as Record<string, unknown>[]) results.push(asEntry(rowToRecord(row)))
    } else {
      statement = this.db.prepare('SELECT * FROM entries')
      for (const row of statement.all() as Record<string, unknown>[]) results.push(asEntry(rowToRecord(row)))
    }
    return results.sort((a, b) => a.createdAt - b.createdAt)
  }

  override async update(id: MemoryId, input: UpdateMemoryInput): Promise<MemoryEntry | undefined> {
    const existing = this.get(id)
    if (existing === undefined) return undefined
    const newContent = input.content ?? existing.content
    validateContent(newContent)
    const scan = scanContent(newContent)
    if (!scan.allowed) {
      throw new Error(`memory content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    const summary = input.summary ?? existing.summary
    if (summary !== undefined) {
      const summaryScan = scanContent(summary)
      if (!summaryScan.allowed) {
        throw new Error(`memory summary rejected by scanner: ${summaryScan.reasons.join('; ')}`)
      }
    }
    const updated: Row = {
      ...existing,
      content: newContent,
      updatedAt: Date.now(),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    }
    this.transaction(() => {
      this.insertEntry(updated)
      this.appendAudit('update', id as string, updated, input.source, input.sessionId, newContent)
    })
    return asEntry(updated)
  }

  override async remove(id: MemoryId): Promise<boolean> {
    const existing = this.get(id)
    if (existing === undefined) return false
    this.transaction(() => {
      this.db.prepare('DELETE FROM entries WHERE id = ?').run(id as string)
      this.appendAudit('remove', id as string, existing as unknown as Row, undefined, undefined, existing.content)
    })
    return true
  }

  override search(query: MemorySearchQuery): SearchMemoryResult {
    const limit = query.limit ?? 50
    const candidates: MemoryEntry[] = []
    for (const [, entry] of this.allEntries()) {
      if (entry.status === 'superseded') continue
      if (query.scope !== undefined && entry.scope !== query.scope) continue
      if (query.category !== undefined && entry.category !== query.category) continue
      if (query.projectName !== undefined && entry.projectName !== query.projectName) continue
      candidates.push(entry)
    }
    const queryTokens = query.query !== undefined && query.query.length > 0 ? tokenizeForSearch(query.query) : []
    let ranked: { entry: MemoryEntry; score: number }[]
    if (queryTokens.length > 0) {
      // Same full-corpus df discipline as DomainMemoryStore.search (a per-pool
      // df table would inflate function-word weights in small candidate pools).
      const corpus = buildCorpusStatsFromTokens(
        [...this.allEntries().values()].map(entry => entryIndexTokens(entry)),
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
    if (query.recordRecall !== false) void this.stampRecalled(all.map(entry => entry.id))
    return { entries: all, total }
  }

  override async pin(id: MemoryId): Promise<MemoryEntry | undefined> {
    return this.setPinned(id, true)
  }

  override async unpin(id: MemoryId): Promise<MemoryEntry | undefined> {
    return this.setPinned(id, false)
  }

  private async setPinned(id: MemoryId, pinned: boolean): Promise<MemoryEntry | undefined> {
    const existing = this.get(id)
    if (existing === undefined) return undefined
    const updated: Row = { ...existing, pinned }
    this.transaction(() => { this.insertEntry(updated) })
    return asEntry(updated)
  }

  // ─── Recall / hit stamping (the RMW contract on the SQL row) ────────────────

  /**
   * Stamp entries with a recall timestamp (fire-and-forget): one UPDATE per
   * changed entry, reading the row current at write time — a concurrent
   * edit landing first is never rolled back by the stamp. `updatedAt` is
   * intentionally left untouched.
   */
  private async stampRecalled(ids: readonly MemoryId[]): Promise<void> {
    const now = Date.now()
    for (const id of ids) {
      try {
        this.transaction(() => {
          const current = this.get(id)
          if (current === undefined) return
          if (current.lastRecalledAt === now && current.staleSince === undefined) return
          const { staleSince: _cleared, ...rest } = current
          this.insertEntry({ ...rest, lastRecalledAt: now, accessCount: (rest.accessCount ?? 0) + 1 })
        })
      } catch (error) {
        if (error instanceof Error && !error.message.includes('no record')) {
          this.reportFailure('recall-stamp', error)
        }
      }
    }
  }

  override markRecalled(ids: readonly string[]): void {
    if (ids.length === 0) return
    void this.stampRecalled(ids.filter(id => this.get(id as MemoryId) !== undefined) as MemoryId[])
  }

  override async markHits(ids: readonly MemoryId[]): Promise<void> {
    const now = Date.now()
    for (const id of [...new Set(ids)]) {
      try {
        this.transaction(() => {
          const current = this.get(id)
          if (current === undefined) return
          this.insertEntry({ ...current, hitCount: (current.hitCount ?? 0) + 1, lastHitAt: now })
          this.appendAudit('update', id as string, this.get(id) as unknown as Row, 'review', undefined, current.content)
        })
      } catch (error) {
        if (error instanceof Error && !error.message.includes('no record')) {
          this.reportFailure('mark-hits', error)
        }
      }
    }
  }

  override async supersedeEntry(id: MemoryId, supersededBy: MemoryId, annotate?: (entry: MemoryEntry) => string): Promise<MemoryEntry | undefined> {
    const existing = this.get(id)
    if (existing === undefined) return undefined
    if (existing.status === 'superseded') return existing
    const annotated = annotate === undefined ? existing.content : annotate(existing)
    const updated: Row = { ...existing, content: annotated, status: 'superseded', supersededBy }
    this.transaction(() => {
      this.insertEntry(updated)
      this.appendAudit('update', id as string, updated, 'janitor', undefined, annotated)
    })
    return asEntry(updated)
  }

  // ─── Janitor (the two-tier lifecycle policy, same semantics) ────────────────

  override async janitor(decayDays: number, now: number = Date.now()): Promise<number> {
    if (decayDays <= 0) return 0
    const decayMs = decayDays * 24 * 60 * 60 * 1000
    let removed = 0
    for (const entry of this.list()) {
      if (entry.pinned === true) continue
      const lastActive = entry.lastRecalledAt ?? entry.createdAt
      if (now - lastActive < decayMs) continue
      if (entry.scope === 'project') {
        // Hard decay: the pin re-check reads the row current at write time.
        const current = this.get(entry.id)
        if (current === undefined || current.pinned === true) continue
        this.transaction(() => {
          this.db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id as string)
          this.appendAudit('remove', entry.id as string, current as unknown as Row, 'janitor', undefined, current.content)
        })
        removed++
        continue
      }
      // Soft decay only — stamp once, never auto-delete (importance grace, pin
      // exemption, and decay idempotence all re-checked on the current row).
      const current = this.get(entry.id)
      if (current === undefined) continue
      const lastActiveNow = current.lastRecalledAt ?? current.createdAt
      const graceFactor = current.importance !== undefined && current.importance >= 4 ? 1.5 : 1
      if (now - lastActiveNow < decayMs * graceFactor) continue
      if (current.staleSince !== undefined) continue
      this.transaction(() => {
        this.insertEntry({ ...current, staleSince: now })
        this.appendAudit('update', entry.id as string, { ...current, staleSince: now }, 'janitor', undefined, current.content)
      })
    }
    return removed
  }

  // ─── Suggestions (P1-1 queue shape) ─────────────────────────────────────────

  override async observeSuggestion(input: AddSuggestionInput): Promise<MemorySuggestion> {
    const scan = scanContent(input.content)
    if (!scan.allowed) {
      throw new Error(`memory content rejected by scanner: ${scan.reasons.join('; ')}`)
    }
    const now = Date.now()
    const existing = this.listSuggestions().find(suggestion =>
      suggestion.scope === input.scope
      && (input.targetEntryId !== undefined
        ? suggestion.targetEntryId === input.targetEntryId
        : jaccardish(suggestion.content, input.content) > 0.6))
    if (existing !== undefined) {
      const updated: Row = {
        ...existing,
        hits: existing.hits + 1,
        lastSeenAt: now,
        ...(existing.category === undefined && input.category !== undefined ? { category: input.category } : {}),
        ...(input.content.length > existing.content.length ? { content: input.content } : {}),
      }
      this.transaction(() => { this.insertSuggestion(updated) })
      return asEntry(updated) as unknown as MemorySuggestion
    }
    const row: Row = {
      id: crypto.randomUUID(),
      scope: input.scope,
      content: input.content,
      hits: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
      ...(input.targetEntryId !== undefined ? { targetEntryId: input.targetEntryId } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    }
    this.transaction(() => {
      this.insertSuggestion(row)
      this.trimSuggestions()
    })
    return asEntry(row) as unknown as MemorySuggestion
  }

  /** Trim the suggestion queue back to its cap (highest-hits exempt first). */
  private trimSuggestions(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM suggestions').get() as { n: number }).n
    if (count <= this.suggestionCap) return
    this.db.prepare(`DELETE FROM suggestions WHERE id IN (SELECT id FROM suggestions ORDER BY hits ASC, lastSeenAt ASC LIMIT ?)`)
      .run(count - this.suggestionCap)
  }

  override listSuggestions(): readonly MemorySuggestion[] {
    const rows = this.db.prepare('SELECT * FROM suggestions ORDER BY hits DESC, lastSeenAt DESC').all() as Record<string, unknown>[]
    return rows.map(row => asEntry(rowToRecord(row)) as unknown as MemorySuggestion)
  }

  override getSuggestion(id: string): MemorySuggestion | undefined {
    const row = this.db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : asEntry(rowToRecord(row)) as unknown as MemorySuggestion
  }

  // ─── Health / audit / raw / meta ────────────────────────────────────────────

  override health(): MemoryHealth {
    let global = 0, project = 0, user = 0, pinned = 0, stale = 0
    let lastActivity: number | undefined
    for (const entry of this.list()) {
      if (entry.scope === 'global') global++
      else if (entry.scope === 'project') project++
      else user++
      if (entry.pinned === true) pinned++
      if (entry.staleSince !== undefined) stale++
      lastActivity = Math.max(lastActivity ?? 0, entry.updatedAt)
    }
    const auditRecords = (this.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n
    return {
      totalEntries: global + project + user,
      byScope: { global, project, user },
      pinned,
      auditRecords,
      ...(stale > 0 ? { stale } : {}),
      ...(lastActivity !== undefined && auditRecords > 0 ? { lastActivityTs: lastActivity } : {}),
      ...(this.failureCounts.size > 0 ? { backgroundFailures: Object.fromEntries(this.failureCounts) } : {}),
    }
  }

  override exportAuditLog(): readonly AuditEntry[] {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY ts DESC').all() as Record<string, unknown>[]
    return rows.map(row => rowToRecord(row) as unknown as AuditEntry)
  }

  override async getRaw(id: MemoryId): Promise<MemoryEntry | undefined> {
    const entry = this.get(id)
    if (entry !== undefined) {
      try {
        this.appendAudit('readRaw', id as string, entry as unknown as Row, 'ui', undefined, entry.content)
      } catch (error) {
        // A failed raw-read audit never blocks the break-glass read.
        this.reportFailure('audit-append', error)
      }
    }
    return entry
  }

  /** Read one meta record (synchronous; the meta table is tiny). */
  getMeta(key: string): { key: 'consolidation' | 'medium' | 'schema'; value?: string | undefined; updatedAt?: number | undefined } | undefined {
    const row = this.db.prepare('SELECT * FROM meta WHERE key = ?').get(key) as { value: string | null; updatedAt: number | null } | undefined
    if (row === undefined) return undefined
    return { key: keyPrefix(key) as 'consolidation' | 'medium' | 'schema', ...(row.value !== null ? { value: row.value } : {}), ...(row.updatedAt !== null ? { updatedAt: row.updatedAt } : {}) }
  }

  /** Write one meta record (insert or replace; best-effort on failure). */
  async setMeta(key: string, record: { key: 'consolidation' | 'medium' | 'schema'; value?: string | undefined; updatedAt?: number | undefined }): Promise<void> {
    try {
      this.db.prepare('INSERT INTO meta (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt')
        .run(key, record.value ?? null, record.updatedAt ?? Date.now())
    } catch (error) {
      this.reportFailure('meta-write', error)
    }
  }

  /**
   * One-time bulk import from the host medium (Step 3.2's migration): every
   * entry, audit record, and suggestion row lands verbatim in one
   * transaction. Fidelity is row-for-row — ids, timestamps, and optional
   * fields carry over; the caller owns the migration marker on the medium
   * side.
   */
  importFromDomain(entries: readonly MemoryEntry[], audit: readonly AuditEntry[], suggestions: readonly MemorySuggestion[]): void {
    this.transaction(() => {
      for (const entry of entries) this.insertEntry(entry as unknown as Row)
      for (const record of audit) this.insertAudit(record as unknown as Row)
      for (const row of suggestions) this.insertSuggestion(row as unknown as Row)
    })
    this.auditSeq = this.maxAuditSeq()
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /** All entries keyed by id (the read snapshot; fresh per call). */
  private allEntries(): Map<string, MemoryEntry> {
    const map = new Map<string, MemoryEntry>()
    for (const row of this.db.prepare('SELECT * FROM entries').all() as Record<string, unknown>[]) {
      const record = rowToRecord(row)
      map.set(record.id as string, asEntry(record))
    }
    return map
  }

  /** Run `body` inside one transaction (entries + audit land atomically). */
  private transaction(body: () => void): void {
    this.db.exec('BEGIN')
    try {
      body()
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* the transaction already ended; nothing to roll back */ }
      throw error
    }
  }

  /** Insert or replace one entry row (the full-record put contract). */
  private insertEntry(entry: Row): void {
    const columns = [...new Set([...ENTRY_COLUMNS.filter(column => entry[column] !== undefined), 'id', 'scope', 'content', 'createdAt', 'updatedAt'])]
    const sql = `INSERT OR REPLACE INTO entries (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    bindRecord(this.db.prepare(sql), columns, entry)
  }

  /** Insert or replace one suggestion row. */
  private insertSuggestion(row: Row): void {
    const columns = [...new Set([...SUGGESTION_COLUMNS.filter(column => row[column] !== undefined), 'id', 'scope', 'content', 'hits', 'firstSeenAt', 'lastSeenAt'])]
    const sql = `INSERT OR REPLACE INTO suggestions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    bindRecord(this.db.prepare(sql), columns, row)
  }

  /** Append one audit record (fire-and-forget semantics at the caller; best-effort here). */
  private appendAudit(op: 'add' | 'update' | 'remove' | 'readRaw', entryId: string, entry: Row, source: string | undefined, sessionId: string | undefined, content: string): void {
    const record: Row = {
      id: crypto.randomUUID(),
      op,
      entryId,
      scope: entry.scope,
      contentPreview: content.slice(0, 120),
      ts: Date.now(),
      seq: this.nextAuditSeq(),
      ...(entry.category !== undefined ? { category: entry.category } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    }
    this.insertAudit(record)
    // The audit trail caps: oldest records evict first.
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n
    if (count > this.auditCap) {
      this.db.prepare(`DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY ts ASC LIMIT ?)`)
        .run(count - this.auditCap)
    }
  }

  /** Insert one audit record verbatim (the append's core; the import path reuses it). */
  private insertAudit(record: Row): void {
    const sql = `INSERT OR REPLACE INTO audit (${AUDIT_COLUMNS.join(', ')}) VALUES (${AUDIT_COLUMNS.map(() => '?').join(', ')})`
    bindRecord(this.db.prepare(sql), AUDIT_COLUMNS, record)
    // The audit trail caps: oldest records evict first.
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n
    if (count > this.auditCap) {
      this.db.prepare(`DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY ts ASC LIMIT ?)`)
        .run(count - this.auditCap)
    }
  }

  /** Trim the entries table back to the cap (§ write-path governance). */
  private trimEntries(now: number): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n
    if (count <= this.entriesCap) return
    const rows = this.db.prepare('SELECT * FROM entries').all() as Record<string, unknown>[]
    const victims = rows
      .map(row => rowToRecord(row) as unknown as MemoryEntry)
      .filter(entry => entry.pinned !== true)
      .sort((a, b) =>
        (a.accessCount ?? 0) - (b.accessCount ?? 0)
        || (a.lastRecalledAt ?? a.createdAt) - (b.lastRecalledAt ?? b.createdAt))
      .slice(0, count - this.entriesCap)
    for (const victim of victims) {
      this.db.prepare('DELETE FROM entries WHERE id = ?').run(victim.id as string)
      this.appendAudit('remove', victim.id as string, victim as unknown as Row, 'janitor', undefined, victim.content)
    }
  }
}

/** Quick content overlap for the suggestion dedup (same-shape rows). */
function jaccardish(a: string, b: string): number {
  const ta = new Set(tokenizeForSearch(a))
  const tb = new Set(tokenizeForSearch(b))
  if (ta.size === 0 && tb.size === 0) return 1
  let shared = 0
  for (const token of ta) if (tb.has(token)) shared++
  return shared / (ta.size + tb.size - shared)
}

/** The meta key's owning-subsystem prefix (before the first ':'). */
function keyPrefix(key: string): string {
  return key.slice(0, key.indexOf(':') > 0 ? key.indexOf(':') : undefined)
}

/** Merged content+summary token bag per entry (the search index's unit). */
function entryIndexTokens(entry: MemoryEntry): string[] {
  return [...tokenizeForSearch(`${entry.content}\n${entry.summary ?? ''}`)]
}
