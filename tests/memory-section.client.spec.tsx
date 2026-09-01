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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { MemorySection } from '../src/client/MemorySection.tsx'
import type { MemorySectionInjected, MemorySectionProps } from '../src/client/MemorySection.tsx'
import { MEMORY_BATCH_SIZE, MemorySectionController } from '../src/client/memory-section-store.ts'
import type { MemoryRemoteApi, MemorySectionState } from '../src/client/memory-section-store.ts'
import { en } from '../src/client/locales.ts'
import type { MemoryEntryJson, MemoryHealthResult, MemorySuggestionJson } from '../src/typert.remote-client.js'

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
  /** Pending proposals served by suggestList(); defaults to none. */
  pending?: readonly MemorySuggestionJson[]
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
    update: vi.fn(async () => ok({ entry: ROWS[0]!, found: true })),
    removeEntry: vi.fn(async () => ok({ removed: true })),
    pin: vi.fn(async () => ok({ entry: ROWS[0]!, found: true })),
    archive: vi.fn(async () => ok({ entry: ROWS[2]!, found: true })),
    suggestList: vi.fn(async () => ok({ suggestions: script.pending ?? [] })),
    suggestAdopt: vi.fn(async () => ok({ entry: ROWS[0]!, found: true })),
    suggestReject: vi.fn(async () => ok({ rejected: true })),
    getRaw: vi.fn(async ({ id }: { id: string }) => {
      const entry = pool.find(e => e.id === id)
      return entry === undefined ? { found: false } : ok({ entry, found: true })
    }),
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
    saveEntryEdits: (id: string, edits: { content?: string; category?: string | null; summary?: string | null }) => controller.saveEntryEdits(id, edits),
    loadRawContent: (id: string) => controller.loadRawContent(id),
    deleteEntry: (id: string) => controller.deleteEntry(id),
    togglePin: (entry: MemoryEntryJson) => controller.togglePin(entry),
    toggleArchive: (entry: MemoryEntryJson) => controller.toggleArchive(entry),
    adoptSuggestion: (id: string, edits?: { content?: string; category?: string }) => controller.adoptSuggestion(id, edits),
    rejectSuggestion: (id: string) => controller.rejectSuggestion(id),
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

// ── Phase 2: review queue + write path ─────────────────────────────────────

const PROPOSALS: MemorySuggestionJson[] = [
  {
    id: 'sg-1',
    scope: 'global',
    category: 'convention',
    content: 'always run the typecheck before pushing',
    hits: 3,
    firstSeenAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_500_000,
    source: 'review',
  },
  {
    id: 'sg-2',
    scope: 'project',
    projectName: 'web',
    content: 'swap the build to vite here',
    hits: 1,
    firstSeenAt: 1_700_000_600_000,
    lastSeenAt: 1_700_000_700_000,
    targetEntryId: 'mem-1',
    source: 'flush',
  },
]

/** Land on the Review tab with a seeded queue. */
async function openReview(script: ApiScript = {}) {
  const handles = renderSection({ ...script, pending: script.pending ?? PROPOSALS })
  fireEvent.click(await screen.findByRole('tab', { name: `${en.tabReview} (2)` }))
  await screen.findByText(/typecheck before pushing/)
  return handles
}

describe('review queue (P1-1)', () => {
  it('shows pending proposals with hits badges and update-proposal marks', async () => {
    await openReview()

    // The tab label carries the live count.
    expect(screen.getByRole('tab', { name: `${en.tabReview} (2)` })).toBeTruthy()
    // Repeated signals surface their frequency.
    expect(screen.getByText(en.hitsBadge.replace('{hits}', '3'))).toBeTruthy()
    // A proposal against an existing entry is marked as an update proposal.
    expect(screen.getByText(en.updateProposalBadge)).toBeTruthy()
    expect(screen.getByText(/swap the build to vite/)).toBeTruthy()
    // The Manage tab stays untouched by queue contents.
    expect(screen.queryByText(/pin the CI runner/)).toBeNull()
  })

  it('an empty queue renders its guidance line without a count in the tab', async () => {
    renderSection()
    fireEvent.click(await screen.findByRole('tab', { name: en.tabReview }))
    expect(await screen.findByText(en.reviewEmpty)).toBeTruthy()
    expect(screen.getByRole('tab', { name: en.tabReview })).toBeTruthy()
  })

  it('adopting calls suggestAdopt with no edits and drops the row from the tab', async () => {
    const { api } = await openReview()

    const adoptButtons = screen.getAllByRole('button', { name: en.adoptAction })
    fireEvent.click(adoptButtons[0]!)

    await waitFor(() => expect(api.suggestAdopt).toHaveBeenCalledTimes(1))
    expect(api.suggestAdopt).toHaveBeenCalledWith(expect.objectContaining({ id: PROPOSALS[0]!.id }))
    await waitFor(() => expect(screen.queryByText(/typecheck before pushing/)).toBeNull())
    // One proposal remains, so the tab still carries its count.
    expect(screen.getByRole('tab', { name: `${en.tabReview} (1)` })).toBeTruthy()
  })

  it('edit-and-adopt applies the edited content instead of the original', async () => {
    const { api } = await openReview()

    fireEvent.click(screen.getAllByRole('button', { name: en.editAndAdopt })[0]!)
    const box = await screen.findByLabelText(en.editProposalContent) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'human-edited convention' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveAdopt }))

    await waitFor(() => expect(api.suggestAdopt).toHaveBeenCalledWith(
      expect.objectContaining({ id: PROPOSALS[0]!.id, content: 'human-edited convention' })))
  })

  it('rejecting removes the proposal without any write', async () => {
    const { api } = await openReview()

    fireEvent.click(screen.getAllByRole('button', { name: en.rejectAction })[1]!)

    await waitFor(() => expect(api.suggestReject).toHaveBeenCalledWith({ id: PROPOSALS[1]!.id }))
    await waitFor(() => expect(screen.queryByText(/swap the build to vite/)).toBeNull())
    expect(vi.mocked(api.update)).not.toHaveBeenCalled()
  })

  it('a failed adoption surfaces inline while keeping the remaining rows', async () => {
    const { api } = await openReview()

    vi.mocked(api.suggestAdopt).mockResolvedValueOnce(fail('store rejected the write'))
    fireEvent.click(screen.getAllByRole('button', { name: en.adoptAction })[0]!)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('store rejected the write')
    // Both rows stay visible for another decision round.
    expect(screen.getByText(/typecheck before pushing/)).toBeTruthy()
    expect(screen.getByText(/swap the build to vite/)).toBeTruthy()
  })
})

describe('entry write actions (P1-7)', () => {
  /** First row's element (the CI-runner entry) for row-scoped queries. */
  async function firstRow(): Promise<HTMLElement> {
    const list = await screen.findByRole('list')
    return within(list).getAllByRole('listitem')[0]!
  }

  it('edits one entry through the inline form and repaints from the host', async () => {
    const { api } = await openManage()
    vi.mocked(api.update).mockClear()
    const row = await firstRow()

    fireEvent.click(within(row).getByRole('button', { name: en.editAction }))
    const box = screen.getByLabelText(en.editContent) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'edited content by hand' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveEdits }))

    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1))
    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({
      id: ROWS[0]!.id,
      content: 'edited content by hand',
      summary: '',
    }))
  })

  it('deletes with a two-step confirm and drops the row after the host agrees', async () => {
    const { api } = await openManage()
    vi.mocked(api.removeEntry).mockClear()
    const row = await firstRow()

    // First click arms the confirm; nothing is sent yet.
    fireEvent.click(within(row).getByRole('button', { name: en.deleteAction }))
    expect(api.removeEntry).not.toHaveBeenCalled()

    fireEvent.click(within(row).getByRole('button', { name: en.confirmDelete }))
    await waitFor(() => expect(api.removeEntry).toHaveBeenCalledWith({ id: ROWS[0]!.id }))
  })

  it('cancel keeps the entry when the delete confirm is dismissed', async () => {
    const { api } = await openManage()
    vi.mocked(api.removeEntry).mockClear()
    const row = await firstRow()

    fireEvent.click(within(row).getByRole('button', { name: en.deleteAction }))
    fireEvent.click(within(row).getByRole('button', { name: en.cancelDelete }))

    expect(api.removeEntry).not.toHaveBeenCalled()
    expect(screen.getByText(/pin the CI runner/)).toBeTruthy()
  })

  it('archive toggles the dormancy stamp through the archive endpoint', async () => {
    const { api } = await openManage()
    vi.mocked(api.archive).mockClear()

    // First row (mem-1) is not dormant → Archive; third row (mem-3) is → Unarchive.
    const rows = screen.getAllByRole('listitem')
    const archiveBtn = within(rows[0]!).getByRole('button', { name: en.archiveAction })
    const unarchiveBtn = within(rows[2]!).getByRole('button', { name: en.unarchiveAction })
    fireEvent.click(archiveBtn)
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith({ id: ROWS[0]!.id, archived: true }))
    fireEvent.click(unarchiveBtn)
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith({ id: ROWS[2]!.id, archived: false }))
  })

  it('a failed row action reports inline without blanking the list', async () => {
    const { api } = await openManage()
    vi.mocked(api.update).mockResolvedValueOnce(fail('write rejected by scanner'))
    const row = await firstRow()

    fireEvent.click(within(row).getByRole('button', { name: en.editAction }))
    const box = screen.getByLabelText(en.editContent) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'bad content' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveEdits }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('write rejected by scanner')
    expect(screen.getByText(/pin the CI runner/)).toBeTruthy()
  })
})
