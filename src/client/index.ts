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
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { MemorySection } from './MemorySection.tsx'
import type { MemorySectionInjected } from './MemorySection.tsx'

export type { MemorySectionInjected, MemorySectionProps } from './MemorySection.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote']

/** The locale namespace for i18n strings. */
const NS = 'settings.memory'

/**
 * Mount the memory management settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  /** The injected face: hooks + handlers the MemorySection component receives. */
  const sectionInjected = (): MemorySectionInjected => ({
    hooks: {
      // The remote namespace is available as ctx.remote.memory after the
      // contribution is mounted in dsh-api-remotes.
      remote: ctx.remote.memory,
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
