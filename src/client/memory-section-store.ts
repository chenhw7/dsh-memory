/**
 * Memory content-management controller — the state machine behind the
 * Settings → Memory section (phase 1: read-only browsing).
 *
 * The host stays the single fact source. Every filter change re-queries the
 * store through the `memoryRemote` namespace mounted by the client entry, and
 * the page never edits anything in phase 1 — writes arrive via the model
 * tools and extraction, so a plain refresh is always a correct repaint.
 *
 * Paging is remote (`list` limit/offset) for plain browsing. The moment a
 * search query or category chips are active the page fetches the full match
 * set once (`search` with no cap) and paginates locally, because the wire
 * search takes no offset; totals stay exact either way.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  MemoryEntryJson,
  MemoryHealthResult,
  MemoryProjectsResult,
} from '../typert.remote-client.js'

/** Scope filter value; `'all'` means "no scope restriction on the wire". */
export type MemoryScopeFilter = 'all' | 'global' | 'project' | 'user'

/** Page size of the entry list (remote when browsing, local when filtering). */
export const MEMORY_PAGE_SIZE = 100

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
  /** Entries of the current page after the active filters. */
  entries: readonly MemoryEntryJson[]
  /** Total matches across all pages under the active filters. */
  total: number
  /** Active scope filter. */
  scope: MemoryScopeFilter
  /** Active workspace filter; null = every workspace. */
  projectName: string | null
  /** Committed search text (the input debounces before calling commitQuery). */
  query: string
  /** Selected category chips. */
  categories: readonly string[]
  /** Zero-based page index. */
  page: number
}

const INITIAL: MemorySectionState = {
  status: 'idle',
  error: null,
  health: null,
  projects: [],
  entries: [],
  total: 0,
  scope: 'all',
  projectName: null,
  query: '',
  categories: [],
  page: 0,
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

  private requireApi(): MemoryRemoteApi {
    if (this.api === undefined) throw new Error('the memory remote namespace is not mounted on this connection')
    return this.api
  }

  /**
   * Fetch one page of entries under the committed filters. Plain browsing
   * pages remotely; an active query or chip set pulls the whole match set
   * once (search has no offset on the wire) and pages locally.
   */
  private async fetchPage(): Promise<{ entries: readonly MemoryEntryJson[]; total: number }> {
    const snapshot = this.store.getSnapshot()
    const offset = snapshot.page * MEMORY_PAGE_SIZE
    const trimmed = snapshot.query.trim()

    if (trimmed !== '' || snapshot.categories.length > 0) {
      const response = await this.requireApi().search({
        ...this.wireScope() !== undefined ? { scope: this.wireScope() } : {},
        ...snapshot.projectName !== null && snapshot.projectName !== ''
          ? { projectName: snapshot.projectName }
          : {},
        ...trimmed !== '' ? { query: trimmed } : {},
        limit: 0,
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
      const selected = snapshot.categories
      const matches = selected.length === 0
        ? [...response.result.value.entries]
        : response.result.value.entries.filter(
            entry => entry.category !== undefined && selected.includes(entry.category))
      return {
        entries: matches.slice(offset, offset + MEMORY_PAGE_SIZE),
        total: matches.length,
      }
    }

    const response = await this.requireApi().list({
      ...this.wireScope() !== undefined ? { scope: this.wireScope() } : {},
      ...snapshot.projectName !== null && snapshot.projectName !== ''
        ? { projectName: snapshot.projectName }
        : {},
      limit: MEMORY_PAGE_SIZE,
      offset,
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    return { entries: response.result.value.entries, total: response.result.value.total }
  }

  /**
   * Full load: health dashboard, workspace roster, and current page. Used on
   * section open, manual retry, and connection recovery.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const ticket = ++this.seq
    if (this.store.getSnapshot().status === 'idle') this.set({ status: 'loading' })
    try {
      const api = this.requireApi()
      const [health, projects, page] = await Promise.all([
        api.health(),
        api.projects(),
        this.fetchPage(),
      ])
      if (!health.result.ok) throw new Error(health.result.error.message)
      if (!projects.result.ok) throw new Error(projects.result.error.message)
      if (ticket !== this.seq) return // a newer load superseded this one
      this.set({
        status: 'ready',
        error: null,
        health: health.result.value,
        projects: projects.result.value.projects,
        entries: page.entries,
        total: page.total,
      })
    } catch (error) {
      if (ticket !== this.seq) return
      this.set({ status: 'error', error: messageOf(error) })
    }
  }

  /**
   * Re-fetch just the entry page (filters changed). Keeps the dashboard and
   * status untouched; a failure surfaces as page-level error text while the
   * previous rows stay visible.
   */
  async reload(): Promise<void> {
    const ticket = ++this.seq
    try {
      const page = await this.fetchPage()
      if (ticket !== this.seq) return
      this.set({ status: 'ready', error: null, entries: page.entries, total: page.total })
    } catch (error) {
      if (ticket !== this.seq) return
      this.set({ error: messageOf(error) })
    }
  }

  /** Switch the scope filter; the workspace pick cannot outlive its scope. */
  setScope(scope: MemoryScopeFilter): void {
    if (this.store.getSnapshot().scope === scope) return
    this.set({ scope, projectName: null, page: 0 })
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
    this.set({ projectName: next, page: 0 })
    void this.reload()
  }

  /** Commit a search text (already debounced upstream); empty clears it. */
  commitQuery(query: string): void {
    if (this.store.getSnapshot().query === query) return
    this.set({ query, page: 0 })
    void this.reload()
  }

  /** Flip one category chip. */
  toggleCategory(category: string): void {
    const selected = this.store.getSnapshot().categories
    const next = selected.includes(category)
      ? selected.filter(c => c !== category)
      : [...selected, category]
    this.set({ categories: next, page: 0 })
    void this.reload()
  }

  /** Jump to a zero-based page within range. */
  setPage(page: number): void {
    const total = this.store.getSnapshot().total
    const maxPage = Math.max(0, Math.ceil(total / MEMORY_PAGE_SIZE) - 1)
    const clamped = Math.min(Math.max(0, Math.floor(page)), maxPage)
    if (this.store.getSnapshot().page === clamped) return
    this.set({ page: clamped })
    void this.reload()
  }
}

/** Extract a readable message from a thrown transport error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
