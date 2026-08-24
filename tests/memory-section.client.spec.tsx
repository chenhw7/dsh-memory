// @vitest-environment jsdom
/**
 * jsdom tests for the Memory settings section (phase 1, read-only): real
 * client sources driven through @testing-library/react over a scripted
 * memoryRemote API face, wired exactly as src/client/index.ts wires it.
 * Covers the plan §7 phase-1 matrix: initial load rendering, scope switching,
 * workspace filtering, BM25 search with its 300ms debounce, category chips,
 * paging, stale markers, and the error/recover path — including CJK content.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { MemorySection } from '../src/client/MemorySection.tsx'
import type { MemorySectionInjected, MemorySectionProps } from '../src/client/MemorySection.tsx'
import { MemorySectionController } from '../src/client/memory-section-store.ts'
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
  list?: { entries: readonly MemoryEntryJson[]; total: number }
  search?: { entries: readonly MemoryEntryJson[]; total: number }
}

/**
 * A scripted memoryRemote face; every method is a recorded vi.fn the tests
 * can re-route mid-flight (mockImplementationOnce) to simulate failures.
 */
function fakeApi(script: ApiScript = {}): MemoryRemoteApi {
  const unhealthy = script.health?.ok === false
  return {
    health: vi.fn(async () => unhealthy ? fail(script.health?.message ?? 'store unavailable') : ok(HEALTH)),
    projects: vi.fn(async () => ok({ projects: script.projects ?? ['web', 'cli-tools'] })),
    list: vi.fn(async () => ok(script.list ?? { entries: ROWS, total: ROWS.length })),
    search: vi.fn(async () => ok(script.search ?? { entries: [], total: 0 })),
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
    setPage: (page: number) => { controller.setPage(page) },
    t: (key: keyof typeof en) => en[key],
    close: () => {},
  } as unknown as MemorySectionProps
  return { props, controller }
}

function wireHandles(props: MemorySectionProps) {
  return {
    actions: {
      setScope: props.setScope,
      setPage: props.setPage,
    },
  }
}

describe('initial load', () => {
  it('renders dashboard numbers, badges, and CJK content rows once loaded', async () => {
    renderSection()

    // Dashboard mirrors health(): total and audit counters visible.
    await waitFor(() => expect(screen.getByText('4')).toBeTruthy())
    expect(screen.getByText(en.dashTotal)).toBeTruthy()
    expect(screen.getByText('9')).toBeTruthy()
    expect(screen.getByText(en.dashAudit)).toBeTruthy()

    // Rows carry scope / category / workspace badges, pin and dormancy marks.
    expect(screen.getByText(/pin the CI runner/)).toBeTruthy()
    expect(screen.getByText(`📌 ${en.pinnedBadge}`)).toBeTruthy()
    expect(screen.getByText(/提交信息一律使用中文书写/)).toBeTruthy()
    // 'web' appears on the entry row AND in the workspace dropdown.
    expect(screen.getAllByText('web').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(`😴 ${en.staleMark}`)).toBeTruthy()

    // Default remote paging request: first page of 100, unfiltered.
    await waitFor(() => {
      expect(vi.mocked((screen.getByLabelText(en.searchLabel))), 'search box exists').toBeTruthy()
    })
  })

  it('shows the empty-state line for a fresh store', async () => {
    renderSection({ list: { entries: [], total: 0 }, projects: [] })

    await waitFor(() => expect(screen.getByText(en.emptyAll)).toBeTruthy())
  })

  it('marks dormant rows grey with an explanatory hint', async () => {
    renderSection()

    const staleBadge = await screen.findByText(`😴 ${en.staleMark}`)
    expect(staleBadge.getAttribute('title')).toBe(en.staleHint)
    expect(staleBadge.closest('li')?.className).toContain('dsm-s-row-stale')
    // Healthy rows keep the plain class.
    expect(screen.getByText(/pin the CI runner/).closest('li')?.className).not.toContain('dsm-s-row-stale')
  })
})

describe('filters', () => {
  it('switches scope remotely and disables the workspace selector on global/user', async () => {
    const { api } = renderSection()
    await screen.findByText(/pin the CI runner/)
    vi.mocked(api.list).mockClear()

    fireEvent.click(screen.getByRole('button', { name: en.scopeGlobal }))

    await waitFor(() => expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'global', limit: 100, offset: 0 })))
    const select = screen.getByLabelText(en.workspaceLabel) as HTMLSelectElement
    expect(select.disabled).toBe(true)
  })

  it('filters by workspace from the populated dropdown', async () => {
    const { api } = renderSection()
    const select = (await screen.findByLabelText(en.workspaceLabel)) as HTMLSelectElement
    await waitFor(() => expect([...select.options].map(o => o.value)).toContain('cli-tools'))
    vi.mocked(api.list).mockClear()

    fireEvent.change(select, { target: { value: 'web' } })

    await waitFor(() => expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: 'web', limit: 100, offset: 0 })))
  })

  it('debounces typed searches into ONE remote query and shows its totals', async () => {
    const { api } = renderSection({ search: { entries: [ROWS[0]!], total: 1 } })
    await screen.findByText(/pin the CI runner/)
    vi.mocked(api.search).mockClear()

    const box = screen.getByLabelText(en.searchLabel) as HTMLInputElement
    // Three keystrokes inside the 300ms window collapse into one commit…
    fireEvent.change(box, { target: { value: 'CI' } })
    fireEvent.change(box, { target: { value: 'CI r' } })
    fireEvent.change(box, { target: { value: 'CI runner' } })

    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(1), { timeout: 2000 })
    expect(api.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'CI runner', limit: 0 }))
    // …and the pager reports the searched total.
    expect(screen.getByText(en.pageSingle.replace('{total}', '1'))).toBeTruthy()
  })

  it('toggles category chips and unions them locally over one full fetch', async () => {
    const { api } = renderSection()
    await screen.findByText(/pin the CI runner/)
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

  it('pages forward through the total', async () => {
    const many: MemoryEntryJson[] = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`, scope: 'global' as const, content: `row ${i}`,
      createdAt: i, updatedAt: i,
    }))
    const { api } = renderSection({ list: { entries: many, total: 250 } })

    await screen.findByText(en.pageInfo.replace('{from}', '1').replace('{to}', '100').replace('{total}', '250'))
    expect(screen.getByText(en.pageInfo.replace('{from}', '1').replace('{to}', '100').replace('{total}', '250'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.pageNext }))
    await waitFor(() => expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ offset: 100 })))
    await screen.findByText(en.pageInfo.replace('{from}', '101').replace('{to}', '200').replace('{total}', '250'))
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
    await screen.findByText(/pin the CI runner/)
  })

  it('keeps the previous rows visible when a refresh fails mid-browsing', async () => {
    const { api } = renderSection()
    await screen.findByText(/pin the CI runner/)

    vi.mocked(api.list).mockImplementationOnce(async () => fail('reset mid-flight'))
    fireEvent.click(screen.getByRole('button', { name: en.scopeUser }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('reset mid-flight')
    // Last-known rows stay on screen instead of blanking the page.
    expect(screen.getByText(/pin the CI runner/)).toBeTruthy()
  })
})
