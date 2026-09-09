// @vitest-environment jsdom
/**
 * jsdom tests for the Identity settings section (the identity layer's
 * read-only governance surface): real client sources driven through
 * @testing-library/react over a scripted identity API face, wired exactly as
 * src/client/index.ts wires it. Covers: both document panels render the
 * current records and history, the no-editor guarantee, the two-step revert
 * confirm and its refusal path, export through a stubbed object URL, the
 * not-written empty states, the degraded older deployment (no identity RPCs →
 * empty ready state, never an error), and the failed-load error state.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IdentitySection } from '../src/client/IdentitySection.tsx'
import type { IdentitySectionProps } from '../src/client/IdentitySection.tsx'
import { IdentitySectionController } from '../src/client/identity-section-store.ts'
import type { IdentityRemoteApi, IdentitySectionState } from '../src/client/identity-section-store.ts'
import { en } from '../src/client/locales.ts'
import type { IdentityHistoryJson, IdentityRecordJson } from '../src/typert.remote-client.js'

afterEach(() => {
  cleanup()
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

/** RPC ok-wrapper matching the Typert gateway response shape. */
function ok<T>(value: T): { result: { ok: true; value: T } } {
  return { result: { ok: true, value } }
}

/** RPC failure-wrapper. */
function fail(message: string): { result: { ok: false; error: { message: string } } } {
  return { result: { ok: false, error: { message } } }
}

const SOUL: IdentityRecordJson = { kind: 'soul', content: '第二版人格文档', version: 2, updatedAt: 1_700_000_200_000, seedVersion: 1 }
const SOUL_HISTORY: IdentityHistoryJson[] = [
  { kind: 'soul', version: 2, content: '第二版人格文档', ts: 1_700_000_200_000, source: 'tool' },
  { kind: 'soul', version: 1, content: '第一版人格文档', ts: 1_700_000_100_000, source: 'seed' },
]

interface ApiScript {
  /** identityList() answer; defaults to the soul record only. */
  records?: { soul?: IdentityRecordJson; user?: IdentityRecordJson }
  /** identityHistory() answer for both kinds; defaults to SOUL_HISTORY. */
  history?: readonly IdentityHistoryJson[]
  /** identityRevert() behavior; `ok: false` answers the wire-shaped refusal. */
  revert?: { ok?: boolean; message?: string }
  /** No identity RPCs at all — an older deployment. */
  degraded?: boolean
}

/** A scripted identity API face; every method is a recorded vi.fn. */
function fakeApi(script: ApiScript = {}): IdentityRemoteApi {
  if (script.degraded === true) return {}
  return {
    identityList: vi.fn(async () => ok(script.records ?? { soul: SOUL })),
    identityHistory: vi.fn(async () => ok({ history: script.history ?? SOUL_HISTORY })),
    identityRevert: vi.fn(async ({ kind, version }: { kind: 'soul' | 'user'; version: number }) => {
      if (script.revert?.ok === false) {
        return ok({ error: script.revert.message ?? 'identity revert is disabled on this deployment' })
      }
      return ok({ reverted: { kind, content: `restored v${String(version)}`, version: 3, updatedAt: Date.now(), seedVersion: 1 } })
    }),
  }
}

/** Wire the component to a real controller over the scripted API and render. */
function renderSection(script: ApiScript = {}) {
  const api = fakeApi(script)
  const controller = new IdentitySectionController(api)
  const store: SnapshotStore<IdentitySectionState> = controller.store
  const subscribe = store.subscribe.bind(store)
  const getSnapshot = store.getSnapshot.bind(store)
  // The slots renderer binds the inject hook to a uSES selector hook; a bare
  // useSyncExternalStore + identity select reproduces that contract here.
  const useIdentitySection = (): IdentitySectionState => useSyncExternalStore(subscribe, getSnapshot)
  const props = {
    useIdentitySection,
    load: () => controller.load(),
    revert: (kind: 'soul' | 'user', version: number) => controller.revert(kind, version),
    t: (key: keyof typeof en) => en[key],
    close: () => {},
  } as unknown as IdentitySectionProps
  render(<IdentitySection {...props} />)
  return { api, controller }
}

describe('identity section (read-only governance)', () => {
  it('renders both document panels: the written document with history, the absent one with its hint', async () => {
    renderSection()
    expect(await screen.findByText(en.identitySectionIntro)).toBeDefined()
    expect(screen.getByText('第二版人格文档')).toBeDefined()
    expect(screen.getByText(en.identityUserEmpty)).toBeDefined()
    // The document preview carries the wrapping pair — the bare modifier class
    // would leave <pre> non-wrapping and long lines spill past the panel.
    const preview = screen.getByText('第二版人格文档')
    expect(preview.tagName).toBe('PRE')
    expect(preview.className).toContain('dsm-s-content')
    expect(preview.className).toContain('dsm-s-content-open')
    // Both retained versions offer the (first-step) revert button.
    expect(await screen.findAllByRole('button', { name: en.identityRevertBtn })).toHaveLength(2)
  })

  it('holds NO editor anywhere on the surface', async () => {
    renderSection()
    await screen.findByText('第二版人格文档')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('textarea')).toBeNull()
  })

  it('revert is two-step: the first click arms, the second calls the valve and clears', async () => {
    const { api, controller } = renderSection()
    const arm = await screen.findAllByRole('button', { name: en.identityRevertBtn })
    fireEvent.click(arm[0]!)
    const confirm = await screen.findByRole('button', { name: en.identityRevertConfirm })
    fireEvent.click(confirm)
    await waitFor(() => { expect(api.identityRevert).toHaveBeenCalledWith({ kind: 'soul', version: 2 }) })
    await waitFor(() => { expect(controller.store.getSnapshot().actionError).toBeNull() })
  })

  it('a refused revert surfaces the wire refusal inline', async () => {
    renderSection({ revert: { ok: false } })
    const arm = await screen.findAllByRole('button', { name: en.identityRevertBtn })
    fireEvent.click(arm[0]!)
    fireEvent.click(await screen.findByRole('button', { name: en.identityRevertConfirm }))
    await screen.findByText(/identity revert is disabled/)
  })

  it('export downloads the current document through a stubbed object URL', async () => {
    const createObjectURL = vi.fn(() => 'blob:0')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL as never
    URL.revokeObjectURL = revokeObjectURL as never

    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: en.identityExport }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:0')
  })

  it('an older deployment without the identity RPCs renders the empty ready state, never an error', async () => {
    const { controller } = renderSection({ degraded: true })
    await waitFor(() => { expect(controller.store.getSnapshot().status).toBe('ready') })
    expect(screen.getByText(en.identitySoulEmpty)).toBeDefined()
    expect(screen.getByText(en.identityUserEmpty)).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a failed load shows the error state with a retry button', async () => {
    const api: IdentityRemoteApi = {
      identityList: vi.fn(async () => fail('gateway down')),
      identityHistory: vi.fn(async () => fail('gateway down')),
    }
    const controller = new IdentitySectionController(api)
    const store = controller.store
    const useIdentitySection = (): IdentitySectionState => useSyncExternalStore(store.subscribe.bind(store), store.getSnapshot.bind(store))
    const props = {
      useIdentitySection,
      load: () => controller.load(),
      revert: (kind: 'soul' | 'user', version: number) => controller.revert(kind, version),
      t: (key: keyof typeof en) => en[key],
      close: () => {},
    } as unknown as IdentitySectionProps
    render(<IdentitySection {...props} />)
    await screen.findByText(/gateway down/)
    expect(screen.getByRole('button', { name: en.retry })).toBeDefined()
  })
})
