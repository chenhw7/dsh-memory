/**
 * Memory management UI — client plugin entry.
 *
 * Contributes four cards into Settings → Plugins → Plugin configuration
 * (`settings.plugin.item`):
 * 1. "Memory" (curated MemoryPluginCard, `memory` namespace) — injection mode,
 *    char budget, search-result cap, decay days.
 * 2. "Project Notes" (spec-driven NamespaceCard, `memory` namespace) — notes
 *    export toggle and its knobs.
 * 3. "Auto Recall" (spec-driven NamespaceCard, `memory` namespace) — the
 *    step-level BM25 recall fence and its knobs.
 * 4. "Automatic Extraction" (spec-driven NamespaceCard, `memory-review`
 *    namespace) — the extraction pipeline: review/flush, model routing,
 *    budget, dedup, pitfall streak, curator pass.
 *
 * All write through the standard `ctx.settingsScope` transport and apply live.
 * There is intentionally NO separate "Memory" navigation section: the user's
 * preference is that memory configuration lives inside the Plugins tab
 * alongside the others.
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
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { MemoryPluginCard } from './MemoryPluginCard.tsx'
import type { MemoryConfig, MemoryPluginCardInjected } from './MemoryPluginCard.tsx'
import { namespaceCard } from './NamespaceCard.tsx'
import type {
  ModelCatalogView, NamespaceCardInjected, NamespaceCardSpec,
} from './NamespaceCard.tsx'
import { modelOptions, providerOptions } from './model-catalog.ts'
import { en, zh } from './locales.ts'

export type { MemoryPluginCardInjected, MemoryPluginCardProps, MemoryConfig } from './MemoryPluginCard.tsx'

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
export const inject = ['slots', 'locale', 'settingsScope']

/** The locale namespace for i18n strings, shared by all three cards. */
const NS = 'settings.memory'

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
 * Mount the memory configuration cards inside Settings → Plugins → Plugin
 * configuration. Each card binds its namespace's settings scope through the
 * standard settings transport. The binder ties the scope's lifetime to this
 * plugin's fiber, so stop/update disposes it; the scope is a HostObservable
 * handed to the card as its hook, and `set`/`unset` pass through verbatim.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Register locale dictionaries for i18n.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory: locale dictionaries')

  // Optional: the connection's llm face powers the extraction-model dropdowns.
  // Absent (headless / older deployment) the selects fall back to free text.
  const loadCatalog = createCatalogLoader(ctx.get('connection') as ConnectionFace | undefined)

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
}
