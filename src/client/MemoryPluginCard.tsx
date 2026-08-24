/**
 * Memory plugin configuration card — shown inside Settings → Plugins →
 * Plugin configuration. Binds to the `memory` settings namespace through the
 * standard `ctx.settingsScope` transport and edits the injection mode, the
 * character budget, and the project-notes export. The review and tool knobs
 * live on their own namespace cards (NamespaceCard).
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
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { css } from './card-styles.ts'
import { SelectField, TextField, NumberField, CheckboxField, TextareaField } from './fields.tsx'

// ─── Wire types (client-side mirror of the host `memory` settings schema) ───

/** The `memory` settings-namespace shape (all fields optional in the wire section). */
export interface MemoryConfig {
  memoryMode?: 'full' | 'policy-only' | 'custom' | 'off' | 'index'
  memoryPolicyCustomText?: string
  memoryCharLimit?: number
  maxSearchResults?: number
  decayDays?: number
  notesEnabled?: boolean
  notesDir?: string
  notesCharLimit?: number
  notesAgentsPointer?: boolean
  notesMaxEntriesPerFile?: number
  /** Step-level auto recall toggle; rendered on the dedicated Auto Recall card. */
  autoRecallEnabled?: boolean
  /** Max entries in one auto-recall fence; rendered on the Auto Recall card. */
  autoRecallLimit?: number
  /** Skip recall below this user-text length; rendered on the Auto Recall card. */
  autoRecallMinChars?: number
}

/** The registration-side face the card's slot entry injects. */
export interface MemoryPluginCardInjected {
  hooks: {
    /** The bound `memory` settings scope — bound by the renderer as useMemory. */
    memory: { getSnapshot(): SettingsScopeSnapshot<MemoryConfig>; subscribe(fn: () => void): () => void }
  }
  /** Queue one field write (durable, revision-fenced). */
  set: (field: string, value: unknown) => Promise<void>
  /** Queue one field clear (re-inherits the composition layer). */
  unset: (field: string) => Promise<void>
}

/** Props the renderer binds for the memory card. */
export interface MemoryPluginCardProps
  extends PropsLocale<'settings.memory'>, PropsRuntime<'settings.plugin.item'>, InjectFace<MemoryPluginCardInjected> {}

// ─── Defaults + helpers ─────────────────────────────────────────────────────

const MODES = ['policy-only', 'full', 'index', 'custom', 'off'] as const

/** Default draft when the namespace section has not arrived yet. */
const DEFAULTS: MemoryConfig = {
  memoryMode: 'policy-only',
  memoryPolicyCustomText: '',
  memoryCharLimit: 5000,
  maxSearchResults: 50,
  decayDays: 30,
  notesEnabled: true,
  notesDir: 'docs/agent-memory',
  notesCharLimit: 4000,
  notesAgentsPointer: true,
  notesMaxEntriesPerFile: 100,
}

/** Numeric fields validated by {@link numericInvalid}. */
type NumericField = 'memoryCharLimit' | 'maxSearchResults' | 'decayDays' | 'notesCharLimit' | 'notesMaxEntriesPerFile'
const NUMERIC_FIELDS: readonly NumericField[] = ['memoryCharLimit', 'maxSearchResults', 'decayDays', 'notesCharLimit', 'notesMaxEntriesPerFile']

/** A field is overridden when the user layer carries it (presence, not value). */
function isOverridden(snap: SettingsScopeSnapshot<MemoryConfig>, field: keyof MemoryConfig): boolean {
  const user = snap.user
  if (user === undefined || user === null || typeof user !== 'object') return false
  return Object.prototype.hasOwnProperty.call(user, field)
}

// ─── Card component ─────────────────────────────────────────────────────────

export function MemoryPluginCard(props: MemoryPluginCardProps) {
  const snap = props.useMemory(s => s)
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
      const ops: Promise<void>[] = []
      for (const key of Object.keys(DEFAULTS) as (keyof MemoryConfig)[]) {
        if (draft[key] === committed[key]) continue
        const value = draft[key]
        ops.push(value === undefined ? props.unset(key) : props.set(key, value))
      }
      await Promise.all(ops)
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
        <IconChevronDownOutline14 className={`${css.chevron}${open ? ` ${css.chevronOpen}` : ''}`} />
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
            value={draft.memoryMode ?? 'policy-only'}
            options={MODES.map(m => ({ value: m, label: m }))}
            onChange={(v) => edit('memoryMode', v as MemoryConfig['memoryMode'])}
            onReset={() => { void props.unset('memoryMode'); edit('memoryMode', undefined) }}
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
              onReset={() => { void props.unset('memoryPolicyCustomText'); edit('memoryPolicyCustomText', undefined) }}
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
            onReset={() => { void props.unset('memoryCharLimit'); edit('memoryCharLimit', undefined) }}
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
            onReset={() => { void props.unset('maxSearchResults'); edit('maxSearchResults', undefined) }}
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
            onReset={() => { void props.unset('decayDays'); edit('decayDays', undefined) }}
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
