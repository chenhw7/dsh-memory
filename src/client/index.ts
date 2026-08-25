/**
 * Memory management UI — browser half.
 *
 * Two surfaces over one store:
 *
 * 1. **Configuration** (unchanged since v0.3.0): four cards inside Settings →
 *    Plugins → Plugin configuration (`settings.plugin.item`) — injection mode,
 *    project notes, auto recall, automatic extraction. All write through the
 *    standard `ctx.settingsScope` transport and apply live.
 * 2. **Content management** (phase 1): a dedicated "Memory" settings section
 *    (`settings.section`, id `memory`, order 25) browsing the whole web-profile
 *    memory store — an Overview tab with the health dashboard and a Manage tab
 *    with scope/workspace filters, BM25 search, category chips, and a
 *    read-only lazily loaded list with soft-decay markers.
 *    Configuration and content are different dimensions: the cards stay where
 *    they are, the section says so in its intro line.
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
// entry that hosts this section) and the ctx.settingsScope Context merge.
// Cross-plugin collaboration goes through the service, never a value import
// (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the plugins settings tab's SlotMap merge (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { MemoryPluginCard } from './MemoryPluginCard.tsx'
import type { MemoryConfig, MemoryPluginCardInjected } from './MemoryPluginCard.tsx'
import { MemorySection } from './MemorySection.tsx'
import type { MemorySectionInjected } from './MemorySection.tsx'
import { namespaceCard } from './NamespaceCard.tsx'
import type {
  ModelCatalogView, NamespaceCardInjected, NamespaceCardSpec,
} from './NamespaceCard.tsx'
import { MemorySectionController } from './memory-section-store.ts'
import type { MemoryRemoteApi } from './memory-section-store.ts'
import { modelOptions, providerOptions } from './model-catalog.ts'
import { en, zh } from './locales.ts'

export type { MemoryPluginCardInjected, MemoryPluginCardProps, MemoryConfig } from './MemoryPluginCard.tsx'
export type { MemorySectionInjected, MemorySectionProps } from './MemorySection.tsx'

/** The project-notes card: `notesEnabled` + its knobs, from the `memory` namespace. */
const NOTES_SPEC: NamespaceCardSpec = {
  titleKey: 'notesCardTitle',
  descriptionKey: 'notesCardDescription',
  fields: [
    { key: 'notesEnabled', kind: 'checkbox' },
    { key: 'notesDir', kind: 'text' },
    { key: 'notesCharLimit', kind: 'number' },
    { key: 'notesAgentsPointer', kind: 'checkbox' },
    { key: 'notesMaxEntriesPerFile', kind: 'number' },
  ],
}

/** The auto-recall card: the step-level recall fence, from the `memory` namespace. */
const AUTORECALL_SPEC: NamespaceCardSpec = {
  titleKey: 'autoRecallCardTitle',
  descriptionKey: 'autoRecallCardDescription',
  fields: [
    { key: 'autoRecallEnabled', kind: 'checkbox' },
    { key: 'autoRecallLimit', kind: 'number', minValue: 1 },
    { key: 'autoRecallMinChars', kind: 'number', minValue: 1 },
  ],
}

/** Settings key of the provider field — lives with its resolvers in model-catalog. */
const PROVIDER_FIELD = 'extractionModelProvider'

/** The automatic-extraction card: the full `memory-review` namespace, live. */
const REVIEW_SPEC: NamespaceCardSpec = {
  titleKey: 'reviewCardTitle',
  descriptionKey: 'reviewCardDescription',
  fields: [
    { key: 'reviewEnabled', kind: 'checkbox' },
    { key: 'reviewCandidateThreshold', kind: 'number', labelKey: 'reviewThreshold', hintKey: 'reviewThresholdHint', minValue: 1 },
    { key: 'flushOnCompaction', kind: 'checkbox' },
    { key: 'flushOnDispose', kind: 'checkbox' },
    {
      key: PROVIDER_FIELD,
      kind: 'select',
      options: providerOptions,
      emptyOptionKey: 'followSessionRoute',
    },
    {
      key: 'extractionModelModel',
      kind: 'select',
      options: modelOptions,
      emptyOptionKey: 'followSessionRoute',
    },
    { key: 'extractionBudget', kind: 'number' },
    { key: 'judgeEnabled', kind: 'checkbox' },
    { key: 'pitfallStreakThreshold', kind: 'number', minValue: 1 },
    { key: 'curatorEnabled', kind: 'checkbox' },
    { key: 'curatorEveryNSessions', kind: 'number', minValue: 1 },
    { key: 'curatorMaxEntries', kind: 'number', minValue: 1 },
    { key: 'curatorMinChars', kind: 'number', minValue: 1 },
  ],
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'settingsScope']

/** The locale namespace for i18n strings, shared by the cards and the section. */
const NS = 'settings.memory'

/** Settings-section nav order — after Plugins (15) and Agent presets (20). */
const SECTION_ORDER = 25

/**
 * One `settings.plugin.item` registration. `namespace` is the settings
 * scope to bind (defaults to `key`); it differs when two cards share a
 * namespace (Memory + Project Notes both bind `memory`).
 */
interface CardEntry {
  /** Slot key — unique per card. */
  readonly key: string
  /** Settings namespace to bind; defaults to `key`. */
  readonly namespace?: string
  /** Spec for NamespaceCard; absent → curated MemoryPluginCard. */
  readonly spec?: NamespaceCardSpec
}

const CARDS: readonly CardEntry[] = [
  { key: 'memory' },
  { key: 'memory-notes', namespace: 'memory', spec: NOTES_SPEC },
  { key: 'memory-autorecall', namespace: 'memory', spec: AUTORECALL_SPEC },
  { key: 'memory-review', spec: REVIEW_SPEC },
]

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
    projects: () => invoke('projects'),
    health: () => invoke('health'),
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
  const controller = new MemorySectionController(createMemoryRemoteApi(connection))

  ctx.effect(() => {
    return ctx.on('connection/reset', () => {
      void controller.load()
    })
  }, 'dsh-memory: memory section reload on reconnect')

  ctx.slots.inject('settings.plugin.item', function* () {
    for (const card of CARDS) {
      const ns = card.namespace ?? card.key
      const scope = ctx.settingsScope.bind({ namespace: ns })
      if (card.spec === undefined) {
        const typed = scope as SettingsScope<MemoryConfig>
        const injected = (): MemoryPluginCardInjected => ({
          hooks: { memory: typed },
          set: (field, value) => typed.set(field, value),
          unset: (field) => typed.unset(field),
        })
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          key: card.key,
          locale: NS,
          inject: injected,
        }, MemoryPluginCard)
      } else {
        const spec = card.spec
        const typed = scope as SettingsScope<Record<string, unknown>>
        const withCatalog = loadCatalog !== undefined && spec.fields.some(f => f.kind === 'select')
        const injected = (): NamespaceCardInjected => ({
          hooks: { ns: typed },
          set: (field, value) => typed.set(field, value),
          unset: (field) => typed.unset(field),
          ...(withCatalog ? { loadCatalog } : {}),
        })
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          key: card.key,
          locale: NS,
          inject: injected,
        }, namespaceCard(spec))
      }
    }
  })

  const sectionInjected = (): MemorySectionInjected => ({
    hooks: { memorySection: controller.store },
    load: () => controller.load(),
    setScope: (scope) => { controller.setScope(scope) },
    setProject: (name) => { controller.setProject(name) },
    commitQuery: (query) => { controller.commitQuery(query) },
    toggleCategory: (category) => { controller.toggleCategory(category) },
    loadMore: () => { void controller.loadMore() },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: SECTION_ORDER,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: sectionInjected,
  }, MemorySection))
}
