// @vitest-environment jsdom
/**
 * jsdom tests for the Memory settings section (phase 1, read-only): real
 * client sources driven through @testing-library/react over a scripted
 * memoryRemote API face, wired exactly as src/client/index.ts wires it.
 * Covers the plan §7 phase-1 matrix: tab split (Overview dashboard vs Manage
 * list), initial load rendering, scope switching, workspace filtering, BM25
 * search with its 300ms debounce, category chips, lazy loading (remote batch
 * append while browsing, local reveal while filtering), stale markers, and
 * the error/recover path — including CJK content.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { MemorySection } from '../src/client/MemorySection.tsx'
import type { MemorySectionInjected, MemorySectionProps } from '../src/client/MemorySection.tsx'
import { MEMORY_BATCH_SIZE, MemorySectionController } from '../src/client/memory-section-store.ts'
import type { MemoryRemoteApi, MemorySectionState } from '../src/client/memory-section-store.ts'
import { en } from '../src/client/locales.ts'
import type { MemoryEntryJson, MemoryHealthResult } from '../src/typert.remote-client.js'

afterEach(cleanup)

/** RPC ok-wrapper matching the Typert gateway response shape. */
function ok<T>(value: T): { result: { ok: true; value: T } } {
  return { result: { ok: true, value } }
}

/** RPC failure-wrapper. */
function fail(message: string): { result: { ok: false; error: { message: string } } } {
  return { result: { ok: false, error: { message } } }
}

const HEALTH: MemoryHealthResult = {
  totalEntries: 4,
  byScope: { global: 2, project: 1, user: 1 },
  pinned: 1,
  auditRecords: 9,
  stale: 1,
  lastActivityTs: 1_700_000_000_000,
}

const ROWS: MemoryEntryJson[] = [
  {
    id: 'mem-1', scope: 'global', category: 'failure',
    content: 'Always pin the CI runner version before installing.',
    createdAt: 1_700_000_100_000, updatedAt: 1_700_000_200_000,
    pinned: true,
  },
  {
    id: 'mem-2', scope: 'project', projectName: 'web', category: 'convention',
    content: '本仓库的提交信息一律使用中文书写，格式为「模块：变更摘要」。',
    createdAt: 1_700_000_300_000, updatedAt: 1_700_000_400_000,
  },
  {
    id: 'mem-3', scope: 'user', category: 'preference',
    content: 'Prefers concise answers with code first.',
    createdAt: 1_700_000_500_000, updatedAt: 1_700_000_600_000,
    staleSince: 1_700_010_000_000,
  },
]

interface ApiScript {
  /** health() answer; absent → healthy. */
  health?: { ok?: boolean; message?: string }
  projects?: readonly string[]
  /** Backing pool + advertised total for list(); defaults to ROWS. */
  list?: { entries: readonly MemoryEntryJson[]; total?: number }
  /** Full match set returned by every search(); defaults to none. */
  search?: { entries: readonly MemoryEntryJson[]; total?: number }
}

/**
 * A scripted memoryRemote face; every method is a recorded vi.fn. `list`
 * honors limit/offset over its pool exactly like the wire service, so lazy
 * loading can be exercised end to end.
 */
function fakeApi(script: ApiScript = {}): MemoryRemoteApi {
  const unhealthy = script.health?.ok === false
  const pool = script.list?.entries ?? ROWS
  const poolTotal = script.list?.total ?? pool.length
  return {
    health: vi.fn(async () => unhealthy ? fail(script.health?.message ?? 'store unavailable') : ok(HEALTH)),
    projects: vi.fn(async () => ok({ projects: script.projects ?? ['web', 'cli-tools'] })),
    list: vi.fn(async (request: { limit?: number; offset?: number } = {}) => {
      const offset = request.offset ?? 0
      const limit = request.limit ?? 100
      return ok({ entries: pool.slice(offset, offset + limit), total: poolTotal })
    }),
    search: vi.fn(async () => ok({
      entries: script.search?.entries ?? [],
      total: script.search?.total ?? script.search?.entries.length ?? 0,
    })),
  }
}

/**
 * Wire the component to a real controller over the scripted API, binding the
 * store to a selector hook the way the slots renderer would.
 */
function renderSection(script: ApiScript = {}) {
  const api = fakeApi(script)
  const { props } = wire(api)
  render(<MemorySection {...props} />)
  return { api, ...wireHandles(props) }
}

/** Build the full prop bag for one controller over one api face. */
function wire(api: MemoryRemoteApi): {
  props: MemorySectionProps
  controller: MemorySectionController
} {
  const controller = new MemorySectionController(api)
  const store: SnapshotStore<MemorySectionState> = controller.store
  const subscribe = store.subscribe.bind(store)
  const getSnapshot = store.getSnapshot.bind(store)
  // The slots renderer binds each inject hook to a uSES selector hook; a bare
  // useSyncExternalStore + identity select reproduces that contract here.
  const useMemorySection = (): MemorySectionState => useSyncExternalStore(subscribe, getSnapshot)
  const props = {
    useMemorySection,
    load: () => controller.load(),
    setScope: (scope: MemorySectionInjected['setScope'] extends (s: infer S) => void ? S : never) => { controller.setScope(scope) },
    setProject: (name: string | null) => { controller.setProject(name) },
    commitQuery: (query: string) => { controller.commitQuery(query) },
    toggleCategory: (category: string) => { controller.toggleCategory(category) },
    loadMore: () => { void controller.loadMore() },
    t: (key: keyof typeof en) => en[key],
    close: () => {},
  } as unknown as MemorySectionProps
  return { props, controller }
}

function wireHandles(props: MemorySectionProps) {
  return {
    actions: {
      setScope: props.setScope,
      loadMore: props.loadMore,
    },
  }
}

/** Land on the Manage tab and wait for the first rows. */
async function openManage(script: ApiScript = {}, waitText: RegExp = /pin the CI runner/) {
  const handles = renderSection(script)
  fireEvent.click(await screen.findByRole('tab', { name: en.tabManage }))
  await screen.findByText(waitText)
  return handles
}

describe('tabs', () => {
  it('shows only the health dashboard under Overview and only the list under Manage', async () => {
    renderSection()

    expect(await screen.findByText(en.dashTotal)).toBeTruthy()
    expect(screen.getByText(en.tabManage)).toBeTruthy()
    expect(screen.queryByLabelText(en.searchLabel)).toBeNull()
    expect(screen.queryByText(/pin the CI runner/)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: en.tabManage }))

    expect(await screen.findByLabelText(en.searchLabel)).toBeTruthy()
    expect(screen.getByText(/pin the CI runner/)).toBeTruthy()
    expect(screen.queryByText(en.dashTotal)).toBeNull()
  })
})

describe('initial load', () => {
  it('renders dashboard numbers once loaded', async () => {
    renderSection()

    // Dashboard mirrors health(): total and audit counters visible.
    await waitFor(() => expect(screen.getByText('4')).toBeTruthy())
    expect(screen.getByText(en.dashTotal)).toBeTruthy()
    expect(screen.getByText('9')).toBeTruthy()
    expect(screen.getByText(en.dashAudit)).toBeTruthy()
  })

  it('renders badges, pin/dormancy marks, and CJK content rows on the Manage tab', async () => {
    await openManage()

    expect(screen.getByText(/pin the CI runner/)).toBeTruthy()
    expect(screen.getByText(`📌 ${en.pinnedBadge}`)).toBeTruthy()
    expect(screen.getByText(/提交信息一律使用中文书写/)).toBeTruthy()
    // 'web' appears on the entry row AND in the workspace dropdown.
    expect(screen.getAllByText('web').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(`😴 ${en.staleMark}`)).toBeTruthy()
    // Everything fits in the first batch: full count, no Load more button.
    expect(screen.getByText(en.shownCount.replace('{shown}', '3').replace('{total}', '3'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.loadMore })).toBeNull()
  })

  it('shows the empty-state line for a fresh store', async () => {
    renderSection({ list: { entries: [], total: 0 }, projects: [] })

    fireEvent.click(await screen.findByRole('tab', { name: en.tabManage }))
    await waitFor(() => expect(screen.getByText(en.emptyAll)).toBeTruthy())
  })

  it('marks dormant rows grey with an explanatory hint', async () => {
    await openManage()

    const staleBadge = screen.getByText(`😴 ${en.staleMark}`)
    expect(staleBadge.getAttribute('title')).toBe(en.staleHint)
    expect(staleBadge.closest('li')?.className).toContain('dsm-s-row-stale')
    // Healthy rows keep the plain class.
    expect(screen.getByText(/pin the CI runner/).closest('li')?.className).not.toContain('dsm-s-row-stale')
  })
})

describe('filters', () => {
  it('switches scope remotely and disables the workspace selector on global/user', async () => {
    const { api } = await openManage()
    vi.mocked(api.list).mockClear()

    fireEvent.click(screen.getByRole('button', { name: en.scopeGlobal }))

    await waitFor(() => expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'global', limit: MEMORY_BATCH_SIZE, offset: 0 })))
    const select = screen.getByLabelText(en.workspaceLabel) as HTMLSelectElement
    expect(select.disabled).toBe(true)
  })

  it('filters by workspace from the populated dropdown', async () => {
    const { api } = await openManage()
    const select = screen.getByLabelText(en.workspaceLabel) as HTMLSelectElement
    await waitFor(() => expect([...select.options].map(o => o.value)).toContain('cli-tools'))
    vi.mocked(api.list).mockClear()

    fireEvent.change(select, { target: { value: 'web' } })

    await waitFor(() => expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: 'web', limit: MEMORY_BATCH_SIZE, offset: 0 })))
  })

  it('debounces typed searches into ONE remote query and shows its totals', async () => {
    const { api } = await openManage({ search: { entries: [ROWS[0]!], total: 1 } })
    vi.mocked(api.search).mockClear()

    const box = screen.getByLabelText(en.searchLabel) as HTMLInputElement
    // Three keystrokes inside the 300ms window collapse into one commit…
    fireEvent.change(box, { target: { value: 'CI' } })
    fireEvent.change(box, { target: { value: 'CI r' } })
    fireEvent.change(box, { target: { value: 'CI runner' } })

    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(1), { timeout: 2000 })
    expect(api.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'CI runner', limit: 0 }))
    // …and the footer reports the searched total.
    expect(screen.getByText(en.shownCount.replace('{shown}', '1').replace('{total}', '1'))).toBeTruthy()
  })

  it('toggles category chips and unions them locally over one full fetch', async () => {
    const { api } = await openManage()
    vi.mocked(api.search).mockClear()

    const failureChip = screen.getByRole('button', { name: en.catFailure })
    fireEvent.click(failureChip)
    await waitFor(() => expect(failureChip.getAttribute('aria-pressed')).toBe('true'))

    const conventionChip = screen.getByRole('button', { name: en.catConvention })
    fireEvent.click(conventionChip)

    // Each flip re-queries; every query is an uncapped fetch unioned locally
    // (the wire takes a single category, so chips cannot ride it).
    await waitFor(() => expect(api.search.mock.calls.length).toBeGreaterThanOrEqual(2))
    for (const call of api.search.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ limit: 0 }))
      expect(call[0].query).toBeUndefined()
    }
  })
})

describe('lazy loading', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    id: `m${String(i).padStart(3, '0')}`,
    scope: 'global' as const,
    content: `row ${i}`,
    createdAt: i, updatedAt: i,
  }))

  function countLine(shown: number, total: number): string {
    return en.shownCount.replace('{shown}', String(shown)).replace('{total}', String(total))
  }

  it('appends remote batches while browsing until everything is shown', async () => {
    const { api } = await openManage({ list: { entries: many } }, /row 0/)

    // First batch only; later rows are not in the DOM yet.
    expect(screen.queryByText('row 119')).toBeNull()
    expect(screen.getByText(countLine(MEMORY_BATCH_SIZE, 120))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    await waitFor(() => expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ offset: MEMORY_BATCH_SIZE, limit: MEMORY_BATCH_SIZE })))
    await screen.findByText('row 99')
    expect(screen.getByText(countLine(MEMORY_BATCH_SIZE * 2, 120))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    await screen.findByText('row 119')
    expect(screen.getByText(countLine(120, 120))).toBeTruthy()
    // Exhausted: the manual fallback disappears.
    expect(screen.queryByRole('button', { name: en.loadMore })).toBeNull()
  })

  it('reveals further matches locally while filtering without extra searches', async () => {
    const { api } = await openManage(
      { list: { entries: [] }, search: { entries: many, total: many.length } },
      en.emptyAll,
    )

    const box = screen.getByLabelText(en.searchLabel) as HTMLInputElement
    fireEvent.change(box, { target: { value: 'row' } })
    await screen.findByText(countLine(MEMORY_BATCH_SIZE, 120))
    expect(api.search).toHaveBeenCalledTimes(1)

    // Baseline after the filter commit; the reveal itself must ride the
    // cached match set with no new RPC.
    vi.mocked(api.search).mockClear()
    vi.mocked(api.list).mockClear()

    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    await screen.findByText('row 99')
    expect(screen.getByText(countLine(MEMORY_BATCH_SIZE * 2, 120))).toBeTruthy()
    expect(api.search).not.toHaveBeenCalled()
    expect(vi.mocked(api.list)).not.toHaveBeenCalled()
  })
})

describe('failure and recovery', () => {
  it('lands in the error state when the store cannot be reached, and retries out of it', async () => {
    const { api } = renderSection({ health: { ok: false, message: 'boom' } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('boom')

    // Recovering the backend makes retry land back on the ready page.
    vi.mocked(api.health).mockImplementation(async () => ok(HEALTH))
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await screen.findByText(en.dashTotal)
  })

  it('keeps the previous rows visible when a refresh fails mid-browsing', async () => {
    const { api } = await openManage()

    vi.mocked(api.list).mockImplementationOnce(async () => fail('reset mid-flight'))
    fireEvent.click(screen.getByRole('button', { name: en.scopeUser }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('reset mid-flight')
    // Last-known rows stay on screen instead of blanking the page.
    expect(screen.getByText(/pin the CI runner/)).toBeTruthy()
  })
})
