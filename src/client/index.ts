/**
 * Memory management UI — browser half.
 *
 * Two surfaces over one store:
 *
 * 1. **Configuration**: one page on this bundle's card in Settings → Plugins
 *    (`plugins.bundle.config`, keyed by the package name), holding five
 *    sections — injection mode, project notes, auto recall, identity, and
 *    automatic extraction. Each section is bound to the config form of the
 *    profile entry that declares those settings (`memory`, `memory-notes`,
 *    `memory-autorecall`, `memory-identity`, `memory-review`), so a write lands
 *    in the row that owns the field and applies on the Host's re-apply.
 * 2. **Content management** (phase 1): a dedicated "Memory" settings section
 *    (`settings.section`, id `memory`, order 25) browsing the whole web-profile
 *    memory store — an Overview tab with the health dashboard and a Manage tab
 *    with scope/workspace filters, BM25 search, category chips, and a
 *    read-only lazily loaded list with soft-decay markers.
 *    Configuration and content are different dimensions: the cards stay where
 *    they are, the section says so in its intro line.
 * 3. **Identity governance** (the identity layer): a read-only "Identity"
 *    settings section (id `identity`, order 26) rendering the agent's two
 *    self-documents — SOUL.md (its character) and USER.md (its understanding
 *    of the human) — with their retained version history, the revert valve,
 *    and a plain export. The documents are written by the agent through
 *    conversation (`identity_update`); the human holds no editor here, only
 *    governance.
 *
 * The content surface calls the host's `memoryRemote` Typert namespace through
 * the generic `/api` RPC channel (`memoryRemote/<method>`, `{ args }` payload).
 * The host's TypertGateway claims every such endpoint via source-mode
 * discovery — it reflects the `typertRemote` binding of the mounted
 * MemoryRemoteService (cordis.patch.yml row `memory-remote`) and dispatches by
 * method name — so NO client-side contribution mount is involved. That also
 * sidesteps two gateway-client constraints on `$mount`ed contributions that a
 * self-produced namespace cannot satisfy: descriptor method names may not
 * collide with the namespace service's own members (`remove` does), and a
 * fiber cannot declare an inject dependency on a service it mounts itself.
 *
 * This file runs in the host's client build pipeline (TSX + React), not the
 * plugin's tsc build. Consumed via the `exports["./client"]` subpath and
 * declared in `dsh.client`.
 *
 * @module @chenhw7/dsh-memory/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry that hosts this section) and the ctx.configForms Context merge.
// Cross-plugin collaboration goes through the service, never a value import
// (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the plugins settings tab's SlotMap merge (settings.plugins.tab).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: merges `ctx.slots` (SlotRegistry) into the client Context — the
// slot injection/registration surface this module's apply() drives — and the
// `connection/reset` client event this module reloads the section on.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { MemorySection } from './MemorySection.tsx'
import type { MemorySectionInjected } from './MemorySection.tsx'
import { IdentitySection } from './IdentitySection.tsx'
import type { IdentitySectionInjected } from './IdentitySection.tsx'
import { MEMORY_ENTRY_IDS, SettingsPage } from './SettingsPage.tsx'
import type { MemoryEntryId, SettingsPageInjected } from './SettingsPage.tsx'
import type { ModelCatalogView } from './NamespaceCard.tsx'
import { MemorySectionController } from './memory-section-store.ts'
import type { MemoryRemoteApi } from './memory-section-store.ts'
import { IdentitySectionController } from './identity-section-store.ts'
import { en, zh } from './locales.ts'

/**
 * The plugin-owned locale namespace: this bundle registers the dictionary
 * (`ctx.locale.register('settings.memory', …)`) and its cards/section are the
 * only consumers, so the namespace key's union lives here — the same `en`
 * dictionary the `translate` fallback reads.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Memory cards + section copy (dictionaries registered in this module). */
    'settings.memory': keyof typeof en
  }
}

export type { MemoryConfig, MemorySectionProps } from './MemoryPluginCard.tsx'
export type { MemorySectionInjected, MemorySectionProps as MemoryContentSectionProps } from './MemorySection.tsx'
export type { IdentitySectionInjected, IdentitySectionProps } from './IdentitySection.tsx'
export type { SettingsPageInjected, SettingsPageProps, MemoryEntryId } from './SettingsPage.tsx'
export type { NamespaceSectionProps, NamespaceCardSpec } from './NamespaceCard.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'configForms']

/** The locale namespace for i18n strings, shared by the page and the sections. */
const NS = 'settings.memory'

/** This bundle's package name — the key the Plugins page files its configuration under. */
const BUNDLE_NAME = '@chenhw7/dsh-memory'

/** Settings-section nav order — after Plugins (15) and Agent presets (20). */
const SECTION_ORDER = 25

/** The identity section's nav order — right after the Memory section. */
const IDENTITY_SECTION_ORDER = 26

/** Structural face of the pieces of the client connection the loader needs. */
interface ConnectionFace {
  readonly api?: {
    readonly llm?: {
      readonly models: (payload: Record<string, never>) => Promise<{
        result: { ok: true; value: unknown } | { ok: false; error: unknown }
      }>
    }
  }
  /** Generic logical RPC channels (the Typert gateway rides `/api`). */
  readonly rpc?: {
    call(
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }>
  }
}

/**
 * Adapt the connection's generic RPC channel to the controller's
 * `memoryRemote` face. Every call is one `/api` endpoint of the form
 * `memoryRemote/<method>`; the SRC dispatch binds each method PARAMETER NAME
 * to a wire field, so a single-`request` method carries
 * `{ args: { request: {...} } }` and a parameterless method an empty args
 * object — exactly what the gateway's own client projection would emit.
 * @param connection - the optional client connection handle.
 * @returns the face, or undefined when this connection cannot serve RPCs (the
 * section then degrades to its error state instead of breaking settings).
 */
function createMemoryRemoteApi(connection: ConnectionFace | undefined): MemoryRemoteApi | undefined {
  const call = connection?.rpc?.call
  if (typeof call !== 'function') return undefined
  const invoke = async <T>(method: string, request?: unknown): Promise<{
    result: { ok: true; value: T } | { ok: false; error: { message: string } }
  }> => {
    try {
      const response = await call('/api', `memoryRemote/${method}`, {
        args: request === undefined ? {} : { request },
      })
      if (response.ok) return { result: { ok: true, value: response.value as T } }
      return {
        result: {
          ok: false,
          error: { message: response.error?.message ?? `memoryRemote/${method} failed` },
        },
      }
    } catch (error) {
      return {
        result: {
          ok: false,
          error: { message: error instanceof Error ? error.message : String(error) },
        },
      }
    }
  }
  return {
    list: request => invoke('list', request),
    search: request => invoke('search', request),
    getRaw: request => invoke('getRaw', request),
    projects: () => invoke('projects'),
    health: () => invoke('health'),
    update: request => invoke('update', request),
    removeEntry: request => invoke('removeEntry', request),
    pin: request => invoke('pin', request),
    archive: request => invoke('archive', request),
    suggestList: () => invoke('suggestList'),
    suggestAdopt: request => invoke('suggestAdopt', request),
    suggestReject: request => invoke('suggestReject', request),
    identityList: () => invoke('identityList'),
    identityHistory: request => invoke('identityHistory', request),
    identityRevert: request => invoke('identityRevert', request),
  }
}

/**
 * Build the model-catalog loader wired to the connection's host-scoped
 * `llm.models` RPC (the same catalog the Models settings page renders).
 * Returns undefined when this connection cannot serve the llm domain, so
 * select fields degrade to free text instead of breaking.
 * @param connection - the optional client connection handle.
 */
function createCatalogLoader(connection: ConnectionFace | undefined): (() => Promise<ModelCatalogView | undefined>) | undefined {
  const llm = connection?.api?.llm
  if (llm === undefined || typeof llm.models !== 'function') return undefined
  return async () => {
    const response = await llm.models({})
    return response.result.ok ? response.result.value as ModelCatalogView : undefined
  }
}

/**
 * Mount the memory surfaces.
 *
 * The configuration cards keep their Plugin-tab home untouched; the content
 * section registers beside them under its own nav entry.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Register locale dictionaries for i18n.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory: locale dictionaries')

  // Optional: the connection's llm face powers the extraction-model dropdowns.
  // Absent (headless / older deployment) the selects fall back to free text.
  const connection = ctx.get('connection') as ConnectionFace | undefined
  const loadCatalog = createCatalogLoader(connection)

  // The content-management controller rides the generic /api RPC channel to
  // the host's memoryRemote namespace; a deployment without the channel
  // degrades the section to its error state instead of breaking settings.
  const remoteApi = createMemoryRemoteApi(connection)
  const controller = new MemorySectionController(remoteApi)

  // The identity governance controller rides the same channel; it takes the
  // same face (the identity RPCs are optional on it) so one adapter serves
  // both sections and old deployments degrade to the empty state.
  const identityController = new IdentitySectionController(remoteApi)

  ctx.effect(() => {
    return ctx.on('connection/reset', () => {
      void controller.load()
      void identityController.load()
    })
  }, 'dsh-memory: memory section reload on reconnect')

  // The bundle's settings page: one contribution to the Plugins page's
  // `plugins.bundle.config` slot, keyed by this package's name, so the page
  // renders it as the body of the bundle's own detail page. It appears only
  // while the Host serves at least one of the entries it edits — a deployment
  // that composed none of them shows no trace of it.
  const formsFor = (): Record<MemoryEntryId, ConfigForm<Record<string, unknown>>> => {
    const forms = {} as Record<MemoryEntryId, ConfigForm<Record<string, unknown>>>
    for (const entryId of MEMORY_ENTRY_IDS) forms[entryId] = ctx.configForms.get<Record<string, unknown>>(entryId)
    return forms
  }
  ctx.effect(() => ctx.configForms.whileServed([...MEMORY_ENTRY_IDS], () => {
    const injected = (): SettingsPageInjected => ({
      forms: formsFor(),
      ...(loadCatalog === undefined ? {} : { loadCatalog }),
    })
    return ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_NAME,
      locale: NS,
      inject: injected,
    }, SettingsPage))
  }), 'dsh-memory: settings page')

  const sectionInjected = (): MemorySectionInjected => ({
    hooks: { memorySection: controller.store },
    load: () => controller.load(),
    setScope: (scope) => { controller.setScope(scope) },
    setProject: (name) => { controller.setProject(name) },
    commitQuery: (query) => { controller.commitQuery(query) },
    toggleCategory: (category) => { controller.toggleCategory(category) },
    loadMore: () => { void controller.loadMore() },
    saveEntryEdits: (id, edits) => controller.saveEntryEdits(id, edits),
    loadRawContent: (id) => controller.loadRawContent(id),
    deleteEntry: (id) => controller.deleteEntry(id),
    togglePin: (entry) => controller.togglePin(entry),
    toggleArchive: (entry) => controller.toggleArchive(entry),
    adoptSuggestion: (id, edits) => controller.adoptSuggestion(id, edits),
    rejectSuggestion: (id) => controller.rejectSuggestion(id),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: SECTION_ORDER,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: sectionInjected,
  }, MemorySection))

  // The identity governance section: a separate nav entry after Memory —
  // the identity documents are the agent's own surface, not memory entries,
  // and the settings-section contract keeps them addressable apart.
  const identityInjected = (): IdentitySectionInjected => ({
    hooks: { identitySection: identityController.store },
    load: () => identityController.load(),
    revert: (kind, version) => identityController.revert(kind, version),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'identity',
    order: IDENTITY_SECTION_ORDER,
    label: () => ctx.locale.bind(NS)('identityNav'),
    locale: NS,
    inject: identityInjected,
  }, IdentitySection))
}
