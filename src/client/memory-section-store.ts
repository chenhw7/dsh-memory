/**
 * Memory content-management controller — the state machine behind the
 * Settings → Memory section (phase 1: read-only browsing).
 *
 * The host stays the single fact source. Every filter change re-queries the
 * store through the injected controller store, and the page never edits
 * anything in phase 1 — writes arrive via the model tools and extraction,
 * so a plain refresh is always a correct repaint.
 *
 * The list lazily loads instead of paging. Plain browsing appends remote
 * batches (`list` limit/offset, newest first) as the user scrolls; the
 * moment a search query or category chips are active the controller pulls
 * the full match set once (`search` has no offset on the wire, and the
 * remote service stamps such reads `recordRecall: false` so browsing never
 * rewrites recall metadata) and reveals further chunks locally. Totals stay
 * exact either way.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  MemoryEntryJson,
  MemoryHealthResult,
  MemoryProjectsResult,
  MemorySuggestionJson,
} from '../typert.remote-client.js'

/** Scope filter value; `'all'` means "no scope restriction on the wire". */
export type MemoryScopeFilter = 'all' | 'global' | 'project' | 'user'

/** Rows fetched / revealed per lazy-loading step. */
export const MEMORY_BATCH_SIZE = 50

/** Categories offered as filter chips; mirrors the store's MemoryCategory set. */
export const MEMORY_CATEGORIES = [
  'failure',
  'correction',
  'insight',
  'preference',
  'convention',
  'tool-quirk',
  'procedure',
] as const

/** Locale-key suffix for each chip, resolved by the component as `cat{X}`. */
export const CATEGORY_LABEL_KEYS: Record<string, string> = {
  failure: 'catFailure',
  correction: 'catCorrection',
  insight: 'catInsight',
  preference: 'catPreference',
  convention: 'catConvention',
  'tool-quirk': 'catToolQuirk',
  procedure: 'catProcedure',
}

/** One RPC round-trip's shape over the Typert gateway. */
type Rpc<T> = Promise<{ result: { ok: true; value: T } | { ok: false; error: { message: string } } }>

/** Structural face of the mounted `memoryRemote` namespace the controller needs. */
export interface MemoryRemoteApi {
  list(request: {
    scope?: 'global' | 'project' | 'user'
    projectName?: string
    limit?: number
    offset?: number
  }): Rpc<{ entries: readonly MemoryEntryJson[]; total: number }>
  search(request: {
    scope?: 'global' | 'project' | 'user'
    category?: string
    projectName?: string
    query?: string
    limit?: number
  }): Rpc<{ entries: readonly MemoryEntryJson[]; total: number }>
  projects(): Rpc<MemoryProjectsResult>
  health(): Rpc<MemoryHealthResult>
  update(request: { id: string; content?: string; category?: string; summary?: string }): Rpc<{ entry?: MemoryEntryJson; found: boolean }>
  removeEntry(request: { id: string }): Rpc<{ removed: boolean }>
  pin(request: { id: string; pinned: boolean }): Rpc<{ entry?: MemoryEntryJson; found: boolean }>
  archive(request: { id: string; archived: boolean }): Rpc<{ entry?: MemoryEntryJson; found: boolean }>
  suggestList(): Rpc<{ suggestions: readonly MemorySuggestionJson[] }>
  suggestAdopt(request: { id: string; content?: string; category?: string; summary?: string }): Rpc<{ entry?: MemoryEntryJson; found: boolean }>
  suggestReject(request: { id: string }): Rpc<{ rejected: boolean }>
  getRaw(request: { id: string }): Rpc<{ entry?: MemoryEntryJson; found: boolean }>
}

/** Page snapshot. */
export interface MemorySectionState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; replaces the page until retried. */
  error: string | null
  /** Health dashboard numbers, null until the first successful load. */
  health: MemoryHealthResult | null
  /** Every workspace known to the store (distinct project names). */
  projects: readonly string[]
  /** Entries visible so far under the active filters (grows via loadMore). */
  entries: readonly MemoryEntryJson[]
  /** Total matches across the full result set under the active filters. */
  total: number
  /** True while a remote batch append is in flight. */
  loadingMore: boolean
  /** Active scope filter. */
  scope: MemoryScopeFilter
  /** Active workspace filter; null = every workspace. */
  projectName: string | null
  /** Committed search text (the input debounces before calling commitQuery). */
  query: string
  /** Selected category chips. */
  categories: readonly string[]
  /** Pending proposals awaiting a human decision (P1-1 review queue). */
  pending: readonly MemorySuggestionJson[]
  /**
   * Failure of the last row action (edit/delete/pin/archive/adopt/reject).
   * Surfaces inline above the list; the next successful action clears it.
   */
  actionError: string | null
}

const INITIAL: MemorySectionState = {
  status: 'idle',
  error: null,
  health: null,
  projects: [],
  entries: [],
  total: 0,
  loadingMore: false,
  scope: 'all',
  projectName: null,
  query: '',
  categories: [],
  pending: [],
  actionError: null,
}

/**
 * Whether a workspace selection survives a scope switch: only scopes whose
 * entries can carry a project name honor the selector.
 */
function projectSelectable(scope: MemoryScopeFilter): boolean {
  return scope === 'all' || scope === 'project'
}

/**
 * Drive the Memory section: health dashboard, workspace roster, and the
 * filtered/paged entry list.
 */
export class MemorySectionController {
  /** Page snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<MemorySectionState> = createSnapshotStore(INITIAL)

  /** Guards against overlapping loads painting partial results. */
  private seq = 0

  /**
   * Full match set behind the active query/chips, cached between local
   * reveals; null whenever plain browsing applies. See {@link fetchFirstBatch}.
   */
  private matches: readonly MemoryEntryJson[] | null = null

  /**
   * @param api - the mounted `memoryRemote` namespace face; undefined on a
   * deployment too old to serve it — loads then fail into the page's error
   * state instead of breaking the settings panel.
   */
  constructor(private readonly api: MemoryRemoteApi | undefined) {}

  private set(patch: Partial<MemorySectionState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /** Wire scope for the current filter, or undefined for "all". */
  private wireScope(): 'global' | 'project' | 'user' | undefined {
    const { scope } = this.store.getSnapshot()
    return scope === 'all' ? undefined : scope
  }

  /**
   * Shared wire filter fields (scope + workspace) from the current snapshot.
   */
  private wireFilters(): { scope?: 'global' | 'project' | 'user'; projectName?: string } {
    const snapshot = this.store.getSnapshot()
    const scope = this.wireScope()
    return {
      ...(scope !== undefined ? { scope } : {}),
      ...(snapshot.projectName !== null && snapshot.projectName !== ''
        ? { projectName: snapshot.projectName }
        : {}),
    }
  }

  private requireApi(): MemoryRemoteApi {
    if (this.api === undefined) throw new Error('the memory remote namespace is not mounted on this connection')
    return this.api
  }

  /**
   * Fetch the first batch under the committed filters. Plain browsing pages
   * remotely; an active query or chip set pulls the whole match set once
   * (search has no offset on the wire), caches it for local reveals, and
   * unions multi-chip selections client-side (the wire takes one category).
   */
  private async fetchFirstBatch(): Promise<{ entries: readonly MemoryEntryJson[]; total: number }> {
    const snapshot = this.store.getSnapshot()
    const trimmed = snapshot.query.trim()

    if (trimmed !== '' || snapshot.categories.length > 0) {
      const response = await this.requireApi().search({
        ...this.wireFilters(),
        ...trimmed !== '' ? { query: trimmed } : {},
        limit: 0,
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
      const selected = snapshot.categories
      const matches = selected.length === 0
        ? [...response.result.value.entries]
        : response.result.value.entries.filter(
            entry => entry.category !== undefined && selected.includes(entry.category))
      this.matches = matches
      return { entries: matches.slice(0, MEMORY_BATCH_SIZE), total: matches.length }
    }

    this.matches = null
    const response = await this.requireApi().list({
      ...this.wireFilters(),
      limit: MEMORY_BATCH_SIZE,
      offset: 0,
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    return { entries: response.result.value.entries, total: response.result.value.total }
  }

  /**
   * Full load: health dashboard, workspace roster, current page, and the
   * pending-review queue. Used on section open, manual retry, and connection
   * recovery.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const ticket = ++this.seq
    if (this.store.getSnapshot().status === 'idle') this.set({ status: 'loading' })
    try {
      const api = this.requireApi()
      const [health, projects, batch] = await Promise.all([
        api.health(),
        api.projects(),
        this.fetchFirstBatch(),
      ])
      if (!health.result.ok) throw new Error(health.result.error.message)
      if (!projects.result.ok) throw new Error(projects.result.error.message)
      // A deployment too old to serve the queue (no suggestList on its
      // memoryRemote face) degrades to an empty list instead of failing the
      // whole page.
      const pendingRows = typeof api.suggestList !== 'function'
        ? []
        : await api.suggestList().then(
            response => response.result.ok ? response.result.value.suggestions : [],
            () => [],
          )
      if (ticket !== this.seq) return // a newer load superseded this one
      this.set({
        status: 'ready',
        error: null,
        health: health.result.value,
        projects: projects.result.value.projects,
        entries: batch.entries,
        total: batch.total,
        pending: pendingRows,
      })
    } catch (error) {
      if (ticket !== this.seq) return
      this.set({ status: 'error', error: messageOf(error) })
    }
  }

  /**
   * Re-fetch the first batch (filters changed). Resets the accumulated list;
   * keeps the dashboard and status untouched, and a failure surfaces as
   * page-level error text while the previous rows stay visible.
   */
  async reload(): Promise<void> {
    const ticket = ++this.seq
    try {
      const batch = await this.fetchFirstBatch()
      if (ticket !== this.seq) return
      this.set({ status: 'ready', error: null, entries: batch.entries, total: batch.total, loadingMore: false })
    } catch (error) {
      if (ticket !== this.seq) return
      this.set({ error: messageOf(error), loadingMore: false })
    }
  }

  /** Switch the scope filter; the workspace pick cannot outlive its scope. */
  setScope(scope: MemoryScopeFilter): void {
    if (this.store.getSnapshot().scope === scope) return
    this.set({ scope, projectName: null })
    void this.reload()
  }

  /**
   * Pick one workspace (or null/'' for all). Only honored where it means
   * something — see {@link projectSelectable}.
   */
  setProject(projectName: string | null): void {
    if (!projectSelectable(this.store.getSnapshot().scope)) return
    const next = projectName === '' ? null : projectName
    if (this.store.getSnapshot().projectName === next) return
    this.set({ projectName: next })
    void this.reload()
  }

  /** Commit a search text (already debounced upstream); empty clears it. */
  commitQuery(query: string): void {
    if (this.store.getSnapshot().query === query) return
    this.set({ query })
    void this.reload()
  }

  /** Flip one category chip. */
  toggleCategory(category: string): void {
    const selected = this.store.getSnapshot().categories
    const next = selected.includes(category)
      ? selected.filter(c => c !== category)
      : [...selected, category]
    this.set({ categories: next })
    void this.reload()
  }

  /**
   * Append the next chunk to the visible list. Plain browsing issues one
   * remote batch; an active search reveals more of the cached full match
   * set without touching the network. No-op while everything is already
   * shown or another append is in flight.
   */
  async loadMore(): Promise<void> {
    const snapshot = this.store.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.loadingMore) return
    if (snapshot.entries.length >= snapshot.total) return

    if (snapshot.query.trim() === '' && snapshot.categories.length === 0) {
      const ticket = ++this.seq
      this.set({ loadingMore: true })
      try {
        const response = await this.requireApi().list({
          ...this.wireFilters(),
          limit: MEMORY_BATCH_SIZE,
          offset: snapshot.entries.length,
        })
        if (!response.result.ok) throw new Error(response.result.error.message)
        if (ticket !== this.seq) return
        const current = this.store.getSnapshot()
        // Append defensively by id so a stale batch can never duplicate rows.
        const seen = new Set(current.entries.map(entry => entry.id))
        const appended = response.result.value.entries.filter(entry => !seen.has(entry.id))
        this.set({
          entries: [...current.entries, ...appended],
          total: response.result.value.total,
          loadingMore: false,
        })
      } catch (error) {
        if (ticket !== this.seq) return
        this.set({ error: messageOf(error), loadingMore: false })
      }
      return
    }

    const matches = this.matches
    if (matches === null) {
      await this.reload() // cache lost (should not happen); refetch instead
      return
    }
    this.set({ entries: matches.slice(0, snapshot.entries.length + MEMORY_BATCH_SIZE) })
  }

  // ─── Write path (phase 2): edit / delete / pin / archive / review queue ───

  /**
   * Run one row action against the host, then refresh the affected surfaces.
   * Failures land in `actionError` (inline, previous rows stay visible); a
   * success clears any stale error and repaints from the host's answer.
   */
  private async act(
    run: (api: MemoryRemoteApi) => Promise<{ ok: boolean; message?: string }>,
  ): Promise<boolean> {
    try {
      const outcome = await run(this.requireApi())
      if (!outcome.ok) {
        this.set({ actionError: outcome.message ?? 'action failed' })
        return false
      }
      this.set({ actionError: null })
      return true
    } catch (error) {
      this.set({ actionError: messageOf(error) })
      return false
    }
  }

  /** Save human edits to one entry ("edit lands in KV", store single truth). */
  async saveEntryEdits(id: string, edits: { content?: string; category?: string | null; summary?: string | null }): Promise<boolean> {
    return this.act(async api => {
      const response = await api.update({
        id,
        ...(edits.content !== undefined ? { content: edits.content } : {}),
        ...(edits.category !== undefined ? { category: edits.category ?? '' } : {}),
        ...(edits.summary !== undefined ? { summary: edits.summary ?? '' } : {}),
      })
      if (!response.result.ok) return { ok: false, message: response.result.error.message }
      if (!response.result.value.found) return { ok: false, message: 'entry vanished before it could be saved' }
      await this.refreshAfterMutation()
      return { ok: true }
    })
  }

  /**
   * Fetch one entry's unredacted content through the break-glass `getRaw`
   * RPC (audit-logged server-side). Returns undefined when the entry is gone
   * or the read fails — the editor keeps the redacted draft either way.
   */
  async loadRawContent(id: string): Promise<string | undefined> {
    try {
      const response = await this.requireApi().getRaw({ id })
      if (!response.result.ok) return undefined
      return response.result.value.entry?.content
    } catch {
      return undefined
    }
  }

  /** Delete one entry after the component-level confirmation. */
  async deleteEntry(id: string): Promise<boolean> {
    return this.act(async api => {
      const response = await api.removeEntry({ id })
      if (!response.result.ok) return { ok: false, message: response.result.error.message }
      if (!response.result.value.removed) return { ok: false, message: 'entry was already gone' }
      await this.refreshAfterMutation()
      return { ok: true }
    })
  }

  /** Toggle one entry's pin. */
  async togglePin(entry: MemoryEntryJson): Promise<boolean> {
    return this.act(async api => {
      const response = await api.pin({ id: entry.id, pinned: entry.pinned !== true })
      if (!response.result.ok) return { ok: false, message: response.result.error.message }
      if (!response.result.value.found) return { ok: false, message: 'entry was already gone' }
      await this.refreshAfterMutation()
      return { ok: true }
    })
  }

  /** Toggle one entry's dormancy stamp (P1-7 archive semantics). */
  async toggleArchive(entry: MemoryEntryJson): Promise<boolean> {
    return this.act(async api => {
      const response = await api.archive({ id: entry.id, archived: entry.staleSince === undefined })
      if (!response.result.ok) return { ok: false, message: response.result.error.message }
      if (!response.result.value.found) return { ok: false, message: 'entry was already gone' }
      await this.refreshAfterMutation()
      return { ok: true }
    })
  }

  /** Re-fetch the pending queue plus whatever list surfaces are live. */
  async refreshPending(): Promise<void> {
    try {
      const response = await this.requireApi().suggestList()
      if (response.result.ok) this.set({ pending: response.result.value.suggestions })
    } catch {
      // The queue stays as-is on failure; actionError already reports worse.
    }
  }

  /**
   * Adopt one pending proposal — optionally with "edit before adopt" tweaks.
   * Refreshes the queue AND the entry list (adoption may create or rewrite an
   * entry under the active filters).
   */
  async adoptSuggestion(id: string, edits?: { content?: string; category?: string }): Promise<boolean> {
    const done = await this.act(async api => {
      const response = await api.suggestAdopt({
        id,
        ...(edits?.content !== undefined && edits.content.trim() !== '' ? { content: edits.content } : {}),
        ...(edits?.category !== undefined && edits.category !== '' ? { category: edits.category } : {}),
      })
      if (!response.result.ok) return { ok: false, message: response.result.error.message }
      if (!response.result.value.found) return { ok: false, message: 'proposal was already decided' }
      return { ok: true }
    })
    if (done) {
      this.set({ pending: this.store.getSnapshot().pending.filter(s => s.id !== id), actionError: null })
      await this.reload()
    }
    return done
  }

  /** Reject one pending proposal. */
  async rejectSuggestion(id: string): Promise<boolean> {
    const done = await this.act(async api => {
      const response = await api.suggestReject({ id })
      if (!response.result.ok) return { ok: false, message: response.result.error.message }
      return { ok: response.result.value.rejected, message: response.result.value.rejected ? undefined : 'proposal was already decided' }
    })
    if (done) this.set({ pending: this.store.getSnapshot().pending.filter(s => s.id !== id), actionError: null })
    return done
  }

  /** Post-mutation repaint: health numbers + the visible list + the queue. */
  private async refreshAfterMutation(): Promise<void> {
    void this.refreshPending()
    try {
      const [health] = await Promise.all([this.requireApi().health()])
      if (health.result.ok) this.set({ health: health.result.value })
    } catch {
      // Health is cosmetic here; the reload below carries the real data.
    }
    await this.reload()
  }
}

/** Extract a readable message from a thrown transport error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
