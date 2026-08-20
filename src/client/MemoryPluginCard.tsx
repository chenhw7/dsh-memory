/**
 * Memory plugin configuration card — shown inside Settings → Plugins →
 * Plugin configuration. Binds to the `memory` settings namespace through the
 * standard `ctx.settingsScope` transport and edits memoryMode, the review
 * flags, and the character budget.
 *
 * The card is a self-contained port of the deployment's own plugin-card
 * design (PluginCard + ValueField from ui-settings-plugins): a collapsible
 * header naming the plugin and what its settings govern, disclosing labelled
 * fields (label over control over hint, with an override badge + reset) and a
 * discard/save footer. Those internals are not exported as values, so an
 * external package must replicate them; the CSS (card-styles.ts) is a
 * line-by-line port of the deployment's PluginCard.module.css / fields.module.css
 * over the same `--dsw-alias-*` tokens. select / checkbox / textarea — which the
 * deployment's cards do not use — are styled to match the `.input` control.
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

// ─── Wire types (client-side mirror of the host `memory` settings schema) ───

/** The `memory` settings-namespace shape (all fields optional in the wire section). */
export interface MemoryConfig {
  memoryMode?: 'full' | 'policy-only' | 'custom' | 'off' | 'index'
  memoryPolicyCustomText?: string
  reviewEnabled?: boolean
  reviewCandidateThreshold?: number
  flushOnCompaction?: boolean
  flushOnDispose?: boolean
  memoryCharLimit?: number
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
  reviewEnabled: true,
  reviewCandidateThreshold: 10,
  flushOnCompaction: true,
  flushOnDispose: true,
  memoryCharLimit: 5000,
  memoryPolicyCustomText: '',
}

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
  const numericInvalid = (field: 'reviewCandidateThreshold' | 'memoryCharLimit') => {
    const v = draft[field]
    if (v === undefined || v === null || v === '') return false
    const n = Number(v)
    return !Number.isFinite(n) || n < 0
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify({ ...DEFAULTS, ...committed })
  const invalid = numericInvalid('reviewCandidateThreshold') || numericInvalid('memoryCharLimit')
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
          <CheckboxField
            id="dsh-memory-review-enabled"
            label={t('reviewEnabled')}
            hint={t('reviewEnabledHint')}
            overridden={isOverridden(snap, 'reviewEnabled')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            disabled={disabled}
            checked={Boolean(draft.reviewEnabled ?? true)}
            onChange={(v) => edit('reviewEnabled', v)}
            onReset={() => { void props.unset('reviewEnabled'); edit('reviewEnabled', undefined) }}
          />
          <NumberField
            id="dsh-memory-review-threshold"
            label={t('reviewThreshold')}
            hint={t('reviewThresholdHint')}
            overridden={isOverridden(snap, 'reviewCandidateThreshold')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalidNumber')}
            invalid={numericInvalid('reviewCandidateThreshold')}
            disabled={disabled}
            value={draft.reviewCandidateThreshold ?? ''}
            onChange={(v) => edit('reviewCandidateThreshold', v === '' ? undefined : Number(v))}
            onReset={() => { void props.unset('reviewCandidateThreshold'); edit('reviewCandidateThreshold', undefined) }}
          />
          <CheckboxField
            id="dsh-memory-flush-compaction"
            label={t('flushOnCompaction')}
            hint={t('flushOnCompactionHint')}
            overridden={isOverridden(snap, 'flushOnCompaction')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            disabled={disabled}
            checked={Boolean(draft.flushOnCompaction ?? true)}
            onChange={(v) => edit('flushOnCompaction', v)}
            onReset={() => { void props.unset('flushOnCompaction'); edit('flushOnCompaction', undefined) }}
          />
          <CheckboxField
            id="dsh-memory-flush-dispose"
            label={t('flushOnDispose')}
            hint={t('flushOnDisposeHint')}
            overridden={isOverridden(snap, 'flushOnDispose')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            disabled={disabled}
            checked={Boolean(draft.flushOnDispose ?? true)}
            onChange={(v) => edit('flushOnDispose', v)}
            onReset={() => { void props.unset('flushOnDispose'); edit('flushOnDispose', undefined) }}
          />
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

// ─── Field components (port of fields.tsx ValueField structure) ────────────

interface FieldBaseProps {
  id: string
  label: string
  hint: string
  overridden: boolean
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  onReset: () => void
}

function FieldHead(props: FieldBaseProps) {
  return (
    <div className={css.head}>
      <label className={css.label} htmlFor={props.id}>{props.label}</label>
      {props.overridden ? (
        <span className={css.badges}>
          <span className={css.badge}>{props.overriddenLabel}</span>
          <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>
            {props.resetLabel}
          </button>
        </span>
      ) : null}
    </div>
  )
}

interface SelectFieldProps extends FieldBaseProps {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}

function SelectField(props: SelectFieldProps) {
  return (
    <div className={css.field}>
      <FieldHead {...props} />
      <select
        id={props.id}
        className={css.select}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}

interface NumberFieldProps extends FieldBaseProps {
  value: number | string
  invalid: boolean
  invalidLabel: string
  onChange: (v: string) => void
}

function NumberField(props: NumberFieldProps) {
  return (
    <div className={css.field}>
      <FieldHead {...props} />
      <input
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        type="text"
        inputMode="numeric"
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={String(props.value)}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

interface CheckboxFieldProps extends FieldBaseProps {
  checked: boolean
  onChange: (v: boolean) => void
}

function CheckboxField(props: CheckboxFieldProps) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <span className={css.checkRow}>
          <input
            id={props.id}
            type="checkbox"
            className={css.checkbox}
            checked={props.checked}
            disabled={props.disabled}
            onChange={(e) => props.onChange(e.target.checked)}
          />
          <label className={css.checkLabel} htmlFor={props.id}>{props.label}</label>
        </span>
        {props.overridden ? (
          <span className={css.badges}>
            <span className={css.badge}>{props.overriddenLabel}</span>
            <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>
              {props.resetLabel}
            </button>
          </span>
        ) : null}
      </div>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}

interface TextareaFieldProps extends FieldBaseProps {
  value: string
  onChange: (v: string) => void
}

function TextareaField(props: TextareaFieldProps) {
  return (
    <div className={css.field}>
      <FieldHead {...props} />
      <textarea
        id={props.id}
        className={css.textarea}
        value={props.value}
        disabled={props.disabled}
        rows={4}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
