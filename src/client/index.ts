/**
 * Memory management UI — client plugin entry.
 *
 * Contributes ONE card into Settings → Plugins → Plugin configuration
 * (`settings.plugin.item`, keyed `memory`) that edits the `memory` settings
 * namespace the host already serves (memoryMode, review flags, char limit…)
 * through the standard `ctx.settingsScope` transport. There is intentionally
 * NO separate "Memory" navigation section: the user's preference is that
 * memory configuration lives inside the Plugins tab alongside the others.
 *
 * Data access is purely the typed settings scope — no @Remote service and no
 * self-mount of a remote namespace. This file is the browser half; it runs in
 * the host's client build pipeline (TSX + React), not the plugin's tsc build.
 * Consumed via the `exports["./client"]` subpath and declared in `dsh.client`.
 *
 * @module @chenhw7/dsh-memory/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry that hosts the Plugins tab) and the ctx.settingsScope Context merge.
// Cross-plugin collaboration goes through the service, never a value import
// (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the plugins settings tab's SlotMap merge (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { MemoryPluginCard } from './MemoryPluginCard.tsx'
import type { MemoryConfig, MemoryPluginCardInjected } from './MemoryPluginCard.tsx'
import { en, zh } from './locales.ts'

export type { MemoryPluginCardInjected, MemoryPluginCardProps, MemoryConfig } from './MemoryPluginCard.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope']

/** The locale namespace for i18n strings. */
const NS = 'settings.memory'

/** The host settings namespace this card edits. */
const MEMORY_NS = 'memory'

/**
 * Mount the memory plugin configuration card inside Settings → Plugins →
 * Plugin configuration. The card binds the `memory` settings scope through the
 * standard settings transport and edits the namespace the host already serves.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Register locale dictionaries for i18n.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory: locale dictionaries')

  // Bind the `memory` settings namespace. The binder ties the scope's lifetime
  // to this plugin's fiber (ctx.effect), so stop/update disposes it. The scope
  // is a HostObservable (getSnapshot + subscribe) and is handed to the card as
  // the `memory` hook source; its `set`/`unset` actions pass through verbatim.
  const scope = ctx.settingsScope.bind({ namespace: MEMORY_NS }) as
    import('@deepseek-ai/dsh-client-runtime/client').SettingsScope<MemoryConfig>

  const cardInjected = (): MemoryPluginCardInjected => ({
    hooks: { memory: scope },
    set: (field, value) => scope.set(field, value),
    unset: (field) => scope.unset(field),
  })

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'memory',
      locale: NS,
      inject: cardInjected,
    }, MemoryPluginCard)
  })
}
