/**
 * `@Remote` service wrapping the `MemoryStore` for the memory management UI (§3.8).
 *
 * This service exposes the store's CRUD operations as `@Remote` methods callable from
 * the client-side UI via `ctx.remote.memory.*`. Writes stay scanner-gated and
 * write-serialized through the existing store contract. The service delegates to
 * `ctx.memory` — it does not duplicate the store.
 *
 * Host integration: the `./remote-service` subpath is mounted as the
 * `memory-remote` composition entry (cordis.patch.yml); the browser half mounts
 * the matching client contribution itself (`src/typert.remote-client.js`).
 *
 * Deployment security (verified against the harness sources, 2026-08): there is
 * NO per-method `PRIVILEGED_METHODS` registry — the trust fence is transport
 * level. Every `/api` request passes `api-request-trust`
 * (`packages/client/connection/src/api-request-trust.ts`), which admits
 * loopback / deployment-derived LAN literals / declared `trustedHosts` hosts
 * and rejects DNS-rebinding and cross-site requests before any RPC runs. So a
 * non-loopback caller cannot reach `add`/`update`/`remove` at all; nothing to
 * pin per method.
 *
 * @module @chenhw7/dsh-memory/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { MemoryId } from '../brand.ts'
import type {
  AddMemoryInput,
  AuditEntry,
  MemoryEntry,
  MemoryHealth,
  MemorySearchQuery,
  SearchMemoryResult,
  UpdateMemoryInput,
} from '../types.ts'

/** Cordis plugin name. */
export const name = 'memory-remote'

/** The memory service is required. */
export const inject = ['memory']

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryRemote: MemoryRemoteService
  }
}

/**
 * Cordis function-plugin apply: instantiate the MemoryRemoteService. The
 * TypertRemoteService constructor calls super(ctx, 'memoryRemote') which
 * registers the service on ctx.memoryRemote via Cordis Service.provide.
 * Called by the cordis.patch.yml fifth row.
 */
export function apply(ctx: Context): void {
  new MemoryRemoteService(ctx)
}

// ─── Wire request/result types ─────────────────────────────────────────────

/** Wire-safe entry projection (branded id as plain string). */
export interface MemoryEntryJson {
  readonly id: string
  readonly scope: 'global' | 'project' | 'user'
  readonly category?: string
  readonly content: string
  readonly projectName?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly pinned?: boolean
  readonly lastRecalledAt?: number
  readonly staleSince?: number
}

function toEntryJson(entry: MemoryEntry): MemoryEntryJson {
  return {
    id: entry.id as string,
    scope: entry.scope,
    content: entry.content,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...entry.category !== undefined ? { category: entry.category } : {},
    ...entry.projectName !== undefined ? { projectName: entry.projectName } : {},
    ...entry.pinned !== undefined ? { pinned: entry.pinned } : {},
    ...entry.lastRecalledAt !== undefined ? { lastRecalledAt: entry.lastRecalledAt } : {},
    ...entry.staleSince !== undefined ? { staleSince: entry.staleSince } : {},
  }
}

export interface MemoryListRequest {
  readonly scope?: 'global' | 'project' | 'user'
  readonly projectName?: string
  readonly limit?: number
  readonly offset?: number
}

export interface MemoryListResult {
  readonly entries: readonly MemoryEntryJson[]
  readonly total: number
}

export interface MemorySearchRequest {
  readonly scope?: 'global' | 'project' | 'user'
  readonly category?: string
  readonly projectName?: string
  readonly query?: string
  readonly limit?: number
}

export interface MemoryGetRequest {
  readonly id: string
}

export interface MemoryGetResult {
  readonly entry?: MemoryEntryJson
  readonly found: boolean
}

export interface MemoryAddRequest {
  readonly scope: 'global' | 'project' | 'user'
  readonly content: string
  readonly category?: string
  readonly projectName?: string
}

export interface MemoryAddResult {
  readonly entry?: MemoryEntryJson
  readonly error?: string
}

export interface MemoryUpdateRequest {
  readonly id: string
  readonly content?: string
  readonly category?: string
}

export interface MemoryUpdateResult {
  readonly entry?: MemoryEntryJson
  readonly found: boolean
  readonly error?: string
}

export interface MemoryRemoveRequest {
  readonly id: string
}

export interface MemoryRemoveResult {
  readonly removed: boolean
}

export interface MemoryPinRequest {
  readonly id: string
  readonly pinned: boolean
}

export interface MemoryPinResult {
  readonly entry?: MemoryEntryJson
  readonly found: boolean
}

export interface MemoryHealthResult {
  totalEntries: number
  byScope: { global: number; project: number; user: number }
  pinned: number
  auditRecords: number
  stale?: number
  lastActivityTs?: number
  lastExtractionTs?: number
}

/** Distinct `projectName` values across all `project`-scoped entries. */
export interface MemoryProjectsResult {
  readonly projects: readonly string[]
}

export interface MemoryAuditRequest {
  readonly limit?: number
}

export interface MemoryAuditResult {
  readonly entries: readonly AuditEntry[]
}

// ─── Service class ──────────────────────────────────────────────────────────

/**
 * Remote service exposing the memory store to the client UI. Extends
 * `TypertRemoteService` so the host Typert generator discovers the `@Remote`
 * methods and generates the `./typert` and `./remote` artifacts.
 */
export class MemoryRemoteService extends TypertRemoteService {
  /** Store the context for internal access (Service.ctx is protected). */
  private readonly _ctx: Context

  constructor(ctx: Context) {
    super(ctx, 'memoryRemote')
    this._ctx = ctx
  }

  private memory() {
    return this._ctx.get('memory')
  }

  @Remote('list')
  list(request: MemoryListRequest): MemoryListResult {
    const store = this.memory()
    if (store === undefined) return { entries: [], total: 0 }
    const scope = request.scope as MemoryEntry['scope'] | undefined
    const projectName = request.projectName
    const all = store.list(scope, projectName)
    const total = all.length
    const offset = request.offset ?? 0
    const limit = request.limit ?? 100
    const paged = limit > 0 ? all.slice(offset, offset + limit) : all.slice(offset)
    return { entries: paged.map(toEntryJson), total }
  }

  @Remote('search')
  search(request: MemorySearchRequest): { entries: readonly MemoryEntryJson[]; total: number } {
    const store = this.memory()
    if (store === undefined) return { entries: [], total: 0 }
    const query = buildSearchQuery(request)
    const result = store.search(query)
    return { entries: result.entries.map(toEntryJson), total: result.total }
  }

  @Remote('get')
  get(request: MemoryGetRequest): MemoryGetResult {
    const store = this.memory()
    if (store === undefined) return { found: false }
    const entry = store.get(request.id as MemoryId)
    if (entry === undefined) return { found: false }
    return { entry: toEntryJson(entry), found: true }
  }

  @Remote('add')
  async add(request: MemoryAddRequest): Promise<MemoryAddResult> {
    const store = this.memory()
    if (store === undefined) return { error: 'memory service not available' }
    try {
      const input: AddMemoryInput = {
        scope: request.scope as MemoryEntry['scope'],
        content: request.content,
        source: 'ui',
        ...request.category !== undefined ? { category: request.category as MemoryEntry['category'] } : {},
        ...request.projectName !== undefined ? { projectName: request.projectName } : {},
      }
      const { entry } = await store.add(input)
      return { entry: toEntryJson(entry) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'add failed' }
    }
  }

  @Remote('update')
  async update(request: MemoryUpdateRequest): Promise<MemoryUpdateResult> {
    const store = this.memory()
    if (store === undefined) return { found: false, error: 'memory service not available' }
    try {
      const input: UpdateMemoryInput = {
        source: 'ui',
        ...request.content !== undefined ? { content: request.content } : {},
        ...request.category !== undefined ? { category: request.category as MemoryEntry['category'] } : {},
      }
      const updated = await store.update(request.id as MemoryId, input)
      if (updated === undefined) return { found: false }
      return { entry: toEntryJson(updated), found: true }
    } catch (e) {
      return { found: false, error: e instanceof Error ? e.message : 'update failed' }
    }
  }

  /**
   * Delete one entry. Named `removeEntry` rather than `remove`: the gateway's
   * client-side namespace service reserves a handful of member names
   * (`remove` among them — its internal uninstall method), and a contribution
   * descriptor carrying one of those names fails validation at mount time.
   */
  @Remote('removeEntry')
  async removeEntry(request: MemoryRemoveRequest): Promise<MemoryRemoveResult> {
    const store = this.memory()
    if (store === undefined) return { removed: false }
    const removed = await store.remove(request.id as MemoryId)
    return { removed }
  }

  @Remote('pin')
  async pin(request: MemoryPinRequest): Promise<MemoryPinResult> {
    const store = this.memory()
    if (store === undefined) return { found: false }
    const entry = request.pinned
      ? await store.pin(request.id as MemoryId)
      : await store.unpin(request.id as MemoryId)
    if (entry === undefined) return { found: false }
    return { entry: toEntryJson(entry), found: true }
  }

  @Remote('health')
  health(): MemoryHealthResult {
    const store = this.memory()
    if (store === undefined) {
      return { totalEntries: 0, byScope: { global: 0, project: 0, user: 0 }, pinned: 0, auditRecords: 0 }
    }
    const h = store.health()
    const result: MemoryHealthResult = {
      totalEntries: h.totalEntries,
      byScope: h.byScope,
      pinned: h.pinned,
      auditRecords: h.auditRecords,
    }
    if (h.stale !== undefined) result.stale = h.stale
    if (h.lastActivityTs !== undefined) result.lastActivityTs = h.lastActivityTs
    if (h.lastExtractionTs !== undefined) result.lastExtractionTs = h.lastExtractionTs
    return result
  }

  /**
   * Distinct project names across all `project`-scoped entries — the data
   * source for the management UI's workspace selector. Aggregated here from
   * `store.list('project')` so the store contract stays untouched.
   */
  @Remote('projects')
  projects(): MemoryProjectsResult {
    const store = this.memory()
    if (store === undefined) return { projects: [] }
    const names = new Set<string>()
    for (const entry of store.list('project')) {
      if (entry.projectName !== undefined) names.add(entry.projectName)
    }
    return { projects: [...names].sort() }
  }

  @Remote('auditLog')
  auditLog(request: MemoryAuditRequest): MemoryAuditResult {
    const store = this.memory()
    if (store === undefined) return { entries: [] }
    const all = store.exportAuditLog()
    const limit = request.limit ?? 100
    const entries = limit > 0 ? all.slice(-limit) : all
    return { entries }
  }
}

export type * from './types.ts'

/** Build a MemorySearchQuery without triggering exactOptionalPropertyTypes. */
function buildSearchQuery(request: MemorySearchRequest): MemorySearchQuery {
  const query: MemorySearchQuery = {}
  if (request.scope !== undefined) (query as { scope: MemoryEntry['scope'] }).scope = request.scope as MemoryEntry['scope']
  if (request.category !== undefined) (query as { category: MemoryEntry['category'] }).category = request.category as MemoryEntry['category']
  if (request.projectName !== undefined) (query as { projectName: string }).projectName = request.projectName
  if (request.query !== undefined) (query as { query: string }).query = request.query
  if (request.limit !== undefined) (query as { limit: number }).limit = request.limit
  return query
}
