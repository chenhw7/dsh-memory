/**
 * Memory management UI — client plugin entry (§3.8).
 *
 * Registers a `settings.section` slot that renders the memory management
 * page: browse by scope, search, add/edit/remove, pin/unpin, and a memory
 * activity timeline over the audit store. Data access goes through
 * `ctx.remote.memory.*` (the MemoryRemoteService @Remote methods).
 *
 * This file is the browser half; it runs in the host's client build pipeline
 * (TSX + React), not the plugin's tsc build. It is consumed via the
 * `exports["./client"]` subpath and declared in `dsh.client` in package.json.
 *
 * Host integration: the `./remote` subpath must be mounted in
 * `dsh-api-remotes` (see TODO §3.8 verification notes).
 *
 * @module @chenhw7/dsh-memory/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the settings shell's SlotMap
// merge (the 'settings.section' entry) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the plugins settings tab's SlotMap merge (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { MemorySection } from './MemorySection.tsx'
import type { MemorySectionInjected, MemoryRemote } from './MemorySection.tsx'
import { MemoryPluginCard } from './MemoryPluginCard.tsx'
import type { MemoryPluginCardInjected } from './MemoryPluginCard.tsx'
import { en, zh } from './locales.ts'

export type { MemorySectionInjected, MemorySectionProps } from './MemorySection.tsx'
export type { MemoryPluginCardInjected, MemoryPluginCardProps } from './MemoryPluginCard.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/** The locale namespace for i18n strings. */
const NS = 'settings.memory'

/**
 * Mount the memory management UI: a full settings section (the memory
 * management page with CRUD + activity panel) and a plugin configuration
 * card (memory mode + review settings inside the Plugins tab).
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
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
  const sectionInjected = (): MemorySectionInjected => ({
    hooks: {
      // Lazy getter: ctx.remote.memoryRemote is created by $mount at runtime,
      // not available at fiber activation time. Access it lazily on each render.
      getRemote: () => (ctx.remote as any).memoryRemote as MemoryRemote | undefined,
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
