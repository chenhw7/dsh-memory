/**
 * Memory management UI — client plugin entry (§3.8).
 *
 * Registers a `settings.section` slot that renders the memory management
 * page: browse by scope, search, add/edit/remove, pin/unpin, and a memory
 * activity timeline over the audit store. Data access goes through the typed
 * `ctx.remote.memoryRemote` namespace.
 *
 * Mount path: the canonical owner is the host build — dsh-memory is an
 * api-remotes project reference, so the host client build inlines this
 * package's `./remote` TYPERT_REMOTE contribution into the
 * `@deepseek-ai/dsh-api-remotes` client bundle, whose assembly $mounts it at
 * boot (settled before any UI can run). Until that host build ships (a stale
 * api-remotes bundle has no memoryRemote namespace), the section lazily
 * self-mounts the same contribution on first use — one-shot and deferred to
 * user interaction, so it can never race the host's boot-time mount (which
 * would be rejected as a duplicate). In a current host build the namespace is
 * always present by then and the self-mount path is never taken.
 *
 * This file is the browser half; it runs in the host's client build pipeline
 * (TSX + React), not the plugin's tsc build. It is consumed via the
 * `exports["./client"]` subpath and declared in `dsh.client` in package.json.
 *
 * @module @chenhw7/dsh-memory/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge (the api-remotes client assembly that
// $mounts this package's ./remote contribution — the memoryRemote namespace)
// into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the plugins settings tab's SlotMap merge (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import TYPERT_REMOTE from '../typert.remote-client.js'
import { MemorySection } from './MemorySection.tsx'
import type { MemorySectionInjected, MemoryRemote } from './MemorySection.tsx'
import { MemoryPluginCard } from './MemoryPluginCard.tsx'
import type { MemoryPluginCardInjected } from './MemoryPluginCard.tsx'
import { en, zh } from './locales.ts'

export type { MemorySectionInjected, MemorySectionProps } from './MemorySection.tsx'
export type { MemoryPluginCardInjected, MemoryPluginCardProps } from './MemoryPluginCard.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'settingsScope']

/** The locale namespace for i18n strings. */
const NS = 'settings.memory'

/**
 * Mount the memory management UI: a full settings section (the memory
 * management page with CRUD + activity panel) and a plugin configuration
 * card (memory mode + review settings inside the Plugins tab).
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // ── Typed remote namespace access ──
  // The canonical mount owner is the api-remotes client assembly: the host
  // build inlines this package's ./remote TYPERT_REMOTE contribution (via the
  // api-remotes project reference) and $mounts it at boot — settled before any
  // UI can run. ensureMemoryRemote reads that namespace. When the running
  // api-remotes bundle predates the integration (no memoryRemote namespace),
  // it self-mounts the same contribution — lazily, on first use, one-shot.
  // Deferred to user interaction so it can NEVER race the host's boot-time
  // $mount (a duplicate $mount of an installed method throws and would fail
  // boot); in a current host build the namespace is always present by then, so
  // the self-mount path is never taken.
  let pendingMount: Promise<unknown> | undefined
  const ensureMemoryRemote = async (): Promise<MemoryRemote | undefined> => {
    const remoteService = ctx.get('remote') as
      | { memoryRemote?: MemoryRemote, $mount?: (contribution: unknown) => Promise<unknown> }
      | undefined
    if (remoteService === undefined) return undefined
    if (remoteService.memoryRemote !== undefined) return remoteService.memoryRemote
    if (remoteService.$mount === undefined) return undefined
    pendingMount ??= remoteService.$mount(TYPERT_REMOTE)
    await pendingMount
    return (ctx.get('remote') as { memoryRemote?: MemoryRemote } | undefined)?.memoryRemote
  }

  // Register locale dictionaries for i18n.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory: locale dictionaries')

  // ── Plugin configuration card (inside Plugins → Plugin configuration) ──
  const pluginCardInjected = (): MemoryPluginCardInjected => ({
    hooks: {
      settingsScope: ctx.settingsScope.bind({ namespace: 'memory' }),
    },
  })

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'memory',
    label: () => ctx.locale.bind(NS)('pluginConfigTitle'),
    locale: NS,
    inject: pluginCardInjected,
  }, MemoryPluginCard))

  // ── Full settings section (Memory management page) ──
  // The section's business face is a slot-level Hook factory: the slot
  // renderer binds the `memorySection` hooks source as the `useMemorySection`
  // hook (the hooks key IS the hook name — a plain value here would bind as
  // `use<Name>` and leave `useMemorySection` undefined, crashing the render).
  // The hook hands the section a stable `ensure()` that resolves the typed
  // remote namespace (mounting it on first use if the host bundle is stale).
  const sectionInjected = (): MemorySectionInjected => ({
    hooks: {
      memorySection: () => () => ({ ensure: ensureMemoryRemote }),
    },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: 30,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: sectionInjected,
  }, MemorySection))
}
