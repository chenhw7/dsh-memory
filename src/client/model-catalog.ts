/**
 * Option resolvers for the extraction-model dropdowns, derived from the
 * host-scoped model catalog plus the card's current draft. Pure data-in /
 * data-out so the undefined-provider regression stays unit-testable.
 *
 * @module @chenhw7/dsh-memory/client/model-catalog
 */

import type { ModelCatalogView, SelectOptionsInput } from './NamespaceCard.tsx'

/** Settings key of the provider field — the model dropdown reacts to its draft. */
export const PROVIDER_FIELD = 'extractionModelProvider'

/** Display label for one catalog entry: "Name (id)" when they differ, else the id. */
export function catalogLabel(name: string | undefined, id: string): string {
  return typeof name === 'string' && name.length > 0 && name !== id ? `${name} (${id})` : id
}

/** Provider dropdown: every group the host's model catalog advertises. */
export function providerOptions({ catalog }: SelectOptionsInput): { value: string; label: string }[] {
  return (catalog?.groups ?? [])
    .filter(g => typeof g?.id === 'string' && g.id.length > 0)
    .map(g => ({ value: g.id, label: catalogLabel(g.name, g.id) }))
}

/**
 * Model dropdown: the drafted provider's models when one is chosen, else every
 * provider's models labeled `provider · model` (the stored value stays a bare
 * model id either way). Duplicate ids across providers keep their first entry.
 * The draft value is `undefined` whenever the field follows the session route,
 * so the guard is computed once and reused for BOTH the scope filter and the
 * label form — reading `providerId.length` unguarded crashes the render.
 */
export function modelOptions({ catalog, draft }: SelectOptionsInput): { value: string; label: string }[] {
  const groups = catalog?.groups ?? []
  const providerId = draft[PROVIDER_FIELD]
  const hasProvider = typeof providerId === 'string' && providerId.length > 0
  const scoped = hasProvider ? groups.filter(g => g.id === providerId) : groups
  const seen = new Set<string>()
  const options: { value: string; label: string }[] = []
  for (const g of scoped) {
    for (const m of g.models ?? []) {
      if (typeof m?.id !== 'string' || m.id.length === 0 || seen.has(m.id)) continue
      seen.add(m.id)
      const label = hasProvider
        ? catalogLabel(m.name, m.id)
        : `${g.id} · ${catalogLabel(m.name, m.id)}`
      options.push({ value: m.id, label })
    }
  }
  return options
}

/** Re-export so consumers name one module for the catalog contract. */
export type { CatalogModelEntry, CatalogProviderGroup, ModelCatalogView } from './NamespaceCard.tsx'
