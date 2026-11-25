/**
 * Client registration: the management pages live in the sidebar's global
 * panel list, not in Settings. The registration is the only wiring the shell
 * sees, so this pins it: one `main` occupant per panel, one `sidebar.panellist`
 * icon with the same id (the sidebar selects the panel by that id), and the
 * Plugins-page configuration contribution. A `settings.section` registration
 * would put the pages back in Settings — the shell's settings nav must stay
 * empty of this bundle.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

// The settings page's icon set is a host-provided module whose own runtime
// dependencies live in the deployment, not in this package's devDependencies.
// Registration never renders, so a stub keeps the graph loadable.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineMedium: () => null,
}))

const { apply } = await import('../src/client/index.ts')

/** One captured `ctx.slots.register` call. */
interface CapturedRegistration {
  name: string
  options: Record<string, unknown> & { name: string }
  component: unknown
}

/** A connection face that answers both RPC shapes without a host. */
const connection = {
  api: { llm: { models: async () => ({ result: { ok: true as const, value: {} } }) } },
  rpc: { call: async () => ({ ok: true, value: {} }) },
}

/**
 * Run the client apply over a recording slot registry.
 * @returns the captured registrations, in registration order.
 */
function runApply(): CapturedRegistration[] {
  const registrations: CapturedRegistration[] = []
  const fake = {
    effect: (fn: () => unknown) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => () => {},
    get: (name: string) => (name === 'connection' ? connection : undefined),
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
      subscribe: () => () => {},
    },
    configForms: {
      get: () => ({}),
      whileServed: (_ids: readonly string[], callback: (served: ReadonlySet<string>) => () => void) => callback(new Set(_ids)),
    },
    slots: {
      register: (options: Record<string, unknown> & { name: string }, component: unknown) => {
        registrations.push({ name: options.name, options, component })
        return () => {}
      },
      inject: (_key: string, callback: () => () => void) => callback(),
    },
  }
  apply(fake as unknown as ClientContext)
  return registrations
}

describe('client surface registration', () => {
  it('puts both management pages in the sidebar main panel, not in settings', () => {
    const registrations = runApply()
    const mains = registrations.filter(entry => entry.name === 'main')
    const icons = registrations.filter(entry => entry.name === 'sidebar.panellist')
    expect(mains.map(entry => entry.options['key'])).toEqual(['memory', 'identity'])
    expect(icons.map(entry => entry.options['id'])).toEqual(['memory', 'identity'])
    // The sidebar resolves its row label through this thunk.
    const memoryIcon = icons.find(entry => entry.options['id'] === 'memory')!
    expect((memoryIcon.options['label'] as () => string)()).toBe('nav')
    const identityIcon = icons.find(entry => entry.options['id'] === 'identity')!
    expect((identityIcon.options['label'] as () => string)()).toBe('identityNav')
    // Panel order: memory after the context panel (20), identity right after it.
    expect(icons.map(entry => entry.options['order'])).toEqual([30, 31])
    expect(registrations.some(entry => entry.name === 'settings.section')).toBe(false)
  })

  it('selects a registered main panel for every sidebar icon', () => {
    const registrations = runApply()
    const mainKeys = new Set(registrations.filter(entry => entry.name === 'main').map(entry => entry.options['key']))
    for (const icon of registrations.filter(entry => entry.name === 'sidebar.panellist')) {
      // `layout.selectPanel` throws for an id without a `main` occupant.
      expect(mainKeys.has(icon.options['id'])).toBe(true)
    }
  })

  it('keeps the configuration page on the Plugins bundle slot', () => {
    const registrations = runApply()
    const configPage = registrations.find(entry => entry.name === 'plugins.bundle.config')
    expect(configPage?.options['key']).toBe('@chenhw7/dsh-memory')
  })
})
