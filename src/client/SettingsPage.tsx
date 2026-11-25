/**
 * The memory bundle's settings page, registered into the Plugins page's
 * `plugins.bundle.config` slot under this package's name.
 *
 * One page, five sections — the five profile entries whose configuration the
 * user can edit (`memory`, `memory-review`, `memory-identity`, `memory-notes`,
 * `memory-autorecall`). The bundle page renders this contribution as the
 * body of the bundle's own page; each section is bound to the config form of
 * the entry that declares it, so a write lands in exactly the row that owns
 * the field.
 *
 * The page owns the form subscription of every entry: `ctx.configForms` gives
 * one form per entry id, and the page only renders while the Host serves at
 * least one of them (the registration side gates on that).
 *
 * @module @chenhw7/dsh-memory/client/SettingsPage
 */

// Type-only: merges the Plugins page's `plugins.bundle.config` slot into the
// client SlotMap (the page this contribution renders inside).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { css } from './card-styles.ts'
import { MemorySection } from './MemoryPluginCard.tsx'
import { NamespaceSection } from './NamespaceCard.tsx'
import type { NamespaceCardSpec, ModelCatalogView } from './NamespaceCard.tsx'
import type { EntryForm } from './form.ts'
import { PROVIDER_FIELD, consolidationOptions, modelOptions, providerOptions } from './model-catalog.ts'

/** The profile entry ids this page edits — each is also its settings namespace. */
export const MEMORY_ENTRY_IDS = ['memory', 'memory-review', 'memory-identity', 'memory-notes', 'memory-autorecall'] as const

/** One of the page's editable entries. */
export type MemoryEntryId = typeof MEMORY_ENTRY_IDS[number]

/** The registration-side face the page's slot entry injects. */
export interface SettingsPageInjected {
  /** One config form per editable entry, resolved from `ctx.configForms`. */
  readonly forms: Record<MemoryEntryId, EntryForm>
  /**
   * Load the host-scoped model catalog for select fields; undefined when the
   * connection cannot serve it (select fields then degrade to free text).
   */
  readonly loadCatalog?: () => Promise<ModelCatalogView | undefined>
}

/** Props the Plugins page binds for a bundle configuration entry. */
export interface SettingsPageProps
  extends PropsLocale<'settings.memory'>, PropsRuntime<'plugins.bundle.config'>, InjectFace<SettingsPageInjected> {}

/** The project-notes section: `notesEnabled` + its budgets. */
const NOTES_SPEC: NamespaceCardSpec = {
  titleKey: 'notesCardTitle',
  descriptionKey: 'notesCardDescription',
  fields: [
    { key: 'notesEnabled', kind: 'checkbox' },
    { key: 'notesConventionsCharLimit', kind: 'number', minValue: 0 },
    { key: 'notesPitfallsCharLimit', kind: 'number', minValue: 0 },
    { key: 'notesMaxEntriesPerFile', kind: 'number', minValue: 0 },
  ],
}

/** The auto-recall section: the step-level recall fence and the hit signal. */
const AUTORECALL_SPEC: NamespaceCardSpec = {
  titleKey: 'autoRecallCardTitle',
  descriptionKey: 'autoRecallCardDescription',
  fields: [
    { key: 'autoRecallEnabled', kind: 'checkbox' },
    { key: 'autoRecallLimit', kind: 'number', minValue: 1 },
    { key: 'autoRecallMinChars', kind: 'number', minValue: 1 },
    { key: 'hitSignalEnabled', kind: 'checkbox', labelKey: 'hitSignalEnabled', hintKey: 'hitSignalEnabledHint' },
    { key: 'hitSignalThreshold', kind: 'number', minValue: 0, labelKey: 'hitSignalThreshold', hintKey: 'hitSignalThresholdHint' },
  ],
}

/**
 * The identity section: the identity layer's live knobs. `identitySeedDir` is
 * a mount-time field (it restarts the entry), so the host's settings wire does
 * not project it and it stays in the composition layer.
 */
const IDENTITY_SPEC: NamespaceCardSpec = {
  titleKey: 'identityCardTitle',
  descriptionKey: 'identityCardDescription',
  fields: [
    { key: 'identityEnabled', kind: 'checkbox' },
    { key: 'soulCharLimit', kind: 'number', minValue: 0 },
    { key: 'userCharLimit', kind: 'number', minValue: 0 },
  ],
}

/** The automatic-extraction section: the full `memory-review` entry, live. */
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
      options: input => providerOptions(input),
      emptyOptionKey: 'followSessionRoute',
    },
    {
      key: 'extractionModelModel',
      kind: 'select',
      options: input => modelOptions(input),
      emptyOptionKey: 'followSessionRoute',
    },
    { key: 'extractionBudget', kind: 'number' },
    { key: 'judgeEnabled', kind: 'checkbox' },
    { key: 'consolidation', kind: 'select', options: () => consolidationOptions(), labelKey: 'consolidation', hintKey: 'consolidationHint' },
    { key: 'pitfallStreakThreshold', kind: 'number', minValue: 1 },
    {
      key: 'confirmBeforeWrite',
      kind: 'checkbox',
      labelKey: 'confirmBeforeWrite',
      hintKey: 'confirmBeforeWriteHint',
    },
    { key: 'curatorEnabled', kind: 'checkbox' },
    { key: 'curatorEveryNSessions', kind: 'number', minValue: 1 },
    { key: 'curatorMaxEntries', kind: 'number', minValue: 1 },
    { key: 'curatorMinChars', kind: 'number', minValue: 1 },
    { key: 'sweepEnabled', kind: 'checkbox', labelKey: 'sweepEnabled', hintKey: 'sweepEnabledHint' },
    { key: 'sweepEveryNSessions', kind: 'number', minValue: 1, labelKey: 'sweepEveryNSessions', hintKey: 'sweepEveryNSessionsHint' },
    { key: 'sweepTopN', kind: 'number', minValue: 2, labelKey: 'sweepTopN', hintKey: 'sweepTopNHint' },
  ],
}

/** Render the bundle's settings page: one collapsible section per entry. */
export function SettingsPage(props: SettingsPageProps) {
  // `summary` is the official-plugin card one-liner; a bundle page always asks
  // for `page`, so anything else renders nothing.
  if (props.view !== 'page') return null
  const t = props.t
  const { forms, loadCatalog } = props
  return (
    <ul className={css.pageList}>
      <MemorySection form={forms.memory} t={t} />
      <NamespaceSection spec={NOTES_SPEC} form={forms['memory-notes']} t={t} />
      <NamespaceSection spec={AUTORECALL_SPEC} form={forms['memory-autorecall']} t={t} />
      <NamespaceSection spec={IDENTITY_SPEC} form={forms['memory-identity']} t={t} />
      <NamespaceSection spec={REVIEW_SPEC} form={forms['memory-review']} t={t} {...loadCatalog === undefined ? {} : { loadCatalog }} />
    </ul>
  )
}
