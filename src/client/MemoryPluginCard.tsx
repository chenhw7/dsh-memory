/**
 * The `memory` entry's settings section — one section of the bundle's page in
 * Settings → Plugins. Binds to that entry's `ConfigForm` (`ctx.configForms`)
 * and edits the injection mode and the memory budgets. The project-notes,
 * auto-recall, identity, and review knobs live on their own sections
 * (NamespaceSection), each bound to the form of the entry that declares them.
 *
 * The card is a self-contained port of the deployment's own plugin-card
 * design (PluginCard from ui-settings-plugins): a collapsible header naming
 * the plugin and what its settings govern, disclosing labelled fields; the
 * field components live in ./fields.tsx. Those internals are not exported as
 * values, so an external package must replicate them; the CSS
 * (card-styles.ts) is a line-by-line port of the deployment's
 * PluginCard.module.css / fields.module.css over the same `--dsw-alias-*`
 * tokens. select / checkbox / textarea — which the deployment's cards do not
 * use — are styled to match the `.input` control.
 *
 * The card stages drafts locally and writes only on Save: one preference
 * change is one durable, revision-fenced document mutation.
 *
 * @module @chenhw7/dsh-memory/client/MemoryPluginCard
 */

import { useEffect, useState } from 'react'
import { IconChevronDownOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { css } from './card-styles.ts'
import { SelectField, TextField, NumberField, CheckboxField, TextareaField } from './fields.tsx'
import { isOverridden, submitSection, useFormSnapshot } from './form.ts'
import type { EntryForm } from './form.ts'
import type { SectionTranslator } from './NamespaceCard.tsx'

// ─── Wire types (client-side mirror of the host `memory` settings schema) ───

/** The `memory` settings-namespace shape (all fields optional in the wire section). */
export interface MemoryConfig {
  memoryMode?: 'full' | 'policy-only' | 'custom' | 'off' | 'index' | 'digest'
  memoryPolicyCustomText?: string
  memoryCharLimit?: number
  /** Character budget for the one-time digest inventory message (`digest` mode); 0 = off. */
  memoryDigestCharLimit?: number
  /** Max entries injected into the memory snapshot regardless of character budget (P0-6); 0 = no limit. */
  memoryMaxEntries?: number
  maxSearchResults?: number
  decayDays?: number
}

/** Props of the memory entry's settings section. */
export interface MemorySectionProps {
  /** The `memory` entry's config form. */
  readonly form: EntryForm
  /** The page's translator (one locale namespace for the whole page). */
  readonly t: SectionTranslator
}

// ─── Defaults + helpers ─────────────────────────────────────────────────────

const MODES = ['digest', 'policy-only', 'full', 'index', 'custom', 'off'] as const

/** Default draft when the namespace section has not arrived yet. */
const DEFAULTS: MemoryConfig = {
  memoryMode: 'digest',
  memoryPolicyCustomText: '',
  memoryCharLimit: 5000,
  memoryDigestCharLimit: 800,
  memoryMaxEntries: 20,
  maxSearchResults: 50,
  decayDays: 30,
}

/** Numeric fields validated by {@link numericInvalid}. */
type NumericField = 'memoryCharLimit' | 'memoryDigestCharLimit' | 'memoryMaxEntries' | 'maxSearchResults' | 'decayDays'
const NUMERIC_FIELDS: readonly NumericField[] = ['memoryCharLimit', 'memoryDigestCharLimit', 'memoryMaxEntries', 'maxSearchResults', 'decayDays']

// ─── Card component ─────────────────────────────────────────────────────────

export function MemorySection(props: MemorySectionProps) {
  const snap = useFormSnapshot(props.form)
  const t = props.t
  const [open, setOpen] = useState(false)

  const committed = snap.value ?? {}

  // Local draft staged from the committed section; written only on Save.
  const [draft, setDraft] = useState<MemoryConfig>({ ...DEFAULTS, ...committed })
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  // Re-seed the draft whenever the committed section changes (Host push,
  // recovery reload, or another surface writing the same namespace).
  useEffect(() => {
    setDraft({ ...DEFAULTS, ...committed })
    setFailed(false)
  }, [committed])

  const edit = <K extends keyof MemoryConfig>(field: K, value: MemoryConfig[K]) => {
    setFailed(false)
    setDraft(prev => ({ ...prev, [field]: value }))
  }

  // A numeric draft is invalid when non-empty and not a finite non-negative number.
  const numericInvalid = (field: NumericField) => {
    const v = draft[field]
    if (v === undefined || v === null) return false
    const n = Number(v)
    return !Number.isFinite(n) || n < 0
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify({ ...DEFAULTS, ...committed })
  const invalid = NUMERIC_FIELDS.some(numericInvalid)
  const disabled = !snap.writable
  const blocked = !dirty || invalid || saving

  // A card whose namespace is not ready renders nothing — the same rule the
  // deployment's PluginCard applies (available === false → null).
  if (snap.status !== 'ready') return null

  const save = async () => {
    setSaving(true)
    setFailed(false)
    try {
      const accepted = await submitSection(props.form, draft as Record<string, unknown>, committed as Record<string, unknown>)
      if (!accepted) setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const discard = () => {
    setDraft({ ...DEFAULTS, ...committed })
    setFailed(false)
  }

  return (
    <li className={`${css.card}${open ? ` ${css.cardOpen}` : ''}`}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('cardTitle')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('cardTitle')}</span>
          <span className={css.description}>{t('cardDescription')}</span>
        </span>
        {dirty ? <span className={css.pending}>{t('unsaved')}</span> : null}
        <IconChevronDownOutlineMedium className={`${css.chevron}${open ? ` ${css.chevronOpen}` : ''}`} />
      </button>
      {open ? (
        <div className={css.body}>
          {!snap.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}
          <SelectField
            id="dsh-memory-mode"
            label={t('memoryMode')}
            hint={t('memoryModeHint')}
            overridden={isOverridden(snap, 'memoryMode')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            disabled={disabled}
            value={draft.memoryMode ?? 'digest'}
            options={MODES.map(m => ({ value: m, label: m }))}
            onChange={(v) => edit('memoryMode', v as MemoryConfig['memoryMode'])}
            onReset={() => { void props.form.unset('memoryMode'); edit('memoryMode', undefined) }}
          />
          {draft.memoryMode === 'custom' ? (
            <TextareaField
              id="dsh-memory-custom-policy"
              label={t('customPolicy')}
              hint={t('customPolicyHint')}
              overridden={isOverridden(snap, 'memoryPolicyCustomText')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              disabled={disabled}
              value={draft.memoryPolicyCustomText ?? ''}
              onChange={(v) => edit('memoryPolicyCustomText', v)}
              onReset={() => { void props.form.unset('memoryPolicyCustomText'); edit('memoryPolicyCustomText', undefined) }}
            />
          ) : null}
          <NumberField
            id="dsh-memory-char-limit"
            label={t('charLimit')}
            hint={t('charLimitHint')}
            overridden={isOverridden(snap, 'memoryCharLimit')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalidNumber')}
            invalid={numericInvalid('memoryCharLimit')}
            disabled={disabled}
            value={draft.memoryCharLimit ?? ''}
            onChange={(v) => edit('memoryCharLimit', v === '' ? undefined : Number(v))}
            onReset={() => { void props.form.unset('memoryCharLimit'); edit('memoryCharLimit', undefined) }}
          />
          <NumberField
            id="dsh-memory-digest-char-limit"
            label={t('digestCharLimit')}
            hint={t('digestCharLimitHint')}
            overridden={isOverridden(snap, 'memoryDigestCharLimit')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalidNumber')}
            invalid={numericInvalid('memoryDigestCharLimit')}
            disabled={disabled}
            value={draft.memoryDigestCharLimit ?? ''}
            onChange={(v) => edit('memoryDigestCharLimit', v === '' ? undefined : Number(v))}
            onReset={() => { void props.form.unset('memoryDigestCharLimit'); edit('memoryDigestCharLimit', undefined) }}
          />
          <NumberField
            id="dsh-memory-max-entries"
            label={t('memoryMaxEntries')}
            hint={t('memoryMaxEntriesHint')}
            overridden={isOverridden(snap, 'memoryMaxEntries')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalidNumber')}
            invalid={numericInvalid('memoryMaxEntries')}
            disabled={disabled}
            value={draft.memoryMaxEntries ?? ''}
            onChange={(v) => edit('memoryMaxEntries', v === '' ? undefined : Number(v))}
            onReset={() => { void props.form.unset('memoryMaxEntries'); edit('memoryMaxEntries', undefined) }}
          />
          <NumberField
            id="dsh-memory-max-search"
            label={t('maxSearchResults')}
            hint={t('maxSearchResultsHint')}
            overridden={isOverridden(snap, 'maxSearchResults')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalidNumber')}
            invalid={numericInvalid('maxSearchResults')}
            disabled={disabled}
            value={draft.maxSearchResults ?? ''}
            onChange={(v) => edit('maxSearchResults', v === '' ? undefined : Number(v))}
            onReset={() => { void props.form.unset('maxSearchResults'); edit('maxSearchResults', undefined) }}
          />
          <NumberField
            id="dsh-memory-decay-days"
            label={t('decayDays')}
            hint={t('decayDaysHint')}
            overridden={isOverridden(snap, 'decayDays')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalidNumber')}
            invalid={numericInvalid('decayDays')}
            disabled={disabled}
            value={draft.decayDays ?? ''}
            onChange={(v) => edit('decayDays', v === '' ? undefined : Number(v))}
            onReset={() => { void props.form.unset('decayDays'); edit('decayDays', undefined) }}
          />
          <div className={css.footer}>
            {failed ? <p className={css.failed} role="status">{t('saveFailed')}</p> : null}
            <button type="button" className={css.discard} disabled={!dirty || saving} onClick={discard}>
              {t('discard')}
            </button>
            <button type="button" className={css.save} disabled={blocked} onClick={() => void save()}>
              {t(saving ? 'saving' : 'save')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
