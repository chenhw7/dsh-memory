/**
 * Generic settings section — one entry's knobs driven by a declarative field
 * spec, so the review, notes, identity, and auto-recall entries share one
 * renderer. Locale keys follow the `<key>` / `<key>Hint` convention unless the
 * spec overrides them.
 *
 * The section is presentational: the settings page owns the list and hands
 * each section its entry's config form.
 *
 * @module @chenhw7/dsh-memory/client/NamespaceCard
 */

import { useEffect, useRef, useState } from 'react'
import { IconChevronDownOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { css } from './card-styles.ts'
import { TextField, NumberField, CheckboxField, SelectField } from './fields.tsx'
import type { FieldBaseProps } from './fields.tsx'
import { isOverridden, submitSection, useFormSnapshot } from './form.ts'
import type { EntryForm } from './form.ts'

/** One model entry in a provider's catalog group (structural view of `llm.models`). */
export interface CatalogModelEntry {
  readonly id: string
  readonly name?: string
}

/** One provider and its advertised models in the host-scoped model catalog. */
export interface CatalogProviderGroup {
  readonly id: string
  readonly name?: string
  readonly models?: readonly CatalogModelEntry[]
}

/**
 * Structural view of the host's session-independent model catalog (the
 * `llm.models` wire shape). Declared locally so this plugin stays decoupled
 * from the deployment's apiproxy types.
 */
export interface ModelCatalogView {
  readonly groups?: readonly CatalogProviderGroup[]
}

/** Inputs a select field's option resolver receives. */
export interface SelectOptionsInput {
  /** Last good model catalog; undefined until the first successful load. */
  readonly catalog: ModelCatalogView | undefined
  /** Current draft values — lets one field react to another (provider → models). */
  readonly draft: Readonly<Record<string, unknown>>
}

/**
 * The card-spec locale-key domain: the `en` dictionary union. Kept as a plain
 * string union (not the host's `LocaleKeysOf`) so the specs stay plain data
 * the tsc build can check without pulling the host locale merge.
 */
type SpecLocaleKey = keyof typeof import('./locales.ts').en

/** One displayed field: its settings key, control kind, and locale keys. */
export interface FieldSpec {
  readonly key: string
  readonly kind: 'checkbox' | 'number' | 'text' | 'select'
  readonly labelKey?: SpecLocaleKey
  readonly hintKey?: SpecLocaleKey
  /** Client-side lower bound mirroring the host schema's `.min(n)`; defaults to 0. */
  readonly minValue?: number
  /** For kind `'select'`: derive the options from the loaded model catalog + draft. */
  readonly options?: (input: SelectOptionsInput) => { value: string; label: string }[]
  /** For kind `'select'`: locale key of the sentinel empty-value option rendered first. */
  readonly emptyOptionKey?: SpecLocaleKey
}

/** The full card content: card-chrome locale keys + the fields, in display order. */
export interface NamespaceCardSpec {
  readonly titleKey: SpecLocaleKey
  readonly descriptionKey: SpecLocaleKey
  readonly fields: readonly FieldSpec[]
}

/** The translator the settings page passes down (one locale namespace for the page). */
export type SectionTranslator = PropsLocale<'settings.memory'>['t']

/** Props of one settings section: its spec, its entry form, and the page's translator. */
export interface NamespaceSectionProps {
  readonly spec: NamespaceCardSpec
  readonly form: EntryForm
  readonly t: SectionTranslator
  /**
   * Load the host-scoped model catalog for select fields; undefined when the
   * connection cannot serve it (select fields then degrade to free text).
   */
  readonly loadCatalog?: () => Promise<ModelCatalogView | undefined>
}

/** Lifecycle of the model-catalog load a select-bearing card performs on expand. */
type CatalogStatus = 'idle' | 'loading' | 'ready' | 'failed'

/** Upper bound for the model-catalog load before it degrades to free text. */
const MODEL_CATALOG_TIMEOUT_MS = 15_000

export function NamespaceSection(props: NamespaceSectionProps) {
  const snap = useFormSnapshot(props.form)
  const t = props.t
  const spec = props.spec
  const [open, setOpen] = useState(false)

  const canLoadCatalog = typeof props.loadCatalog === 'function'
  const catalogStartedRef = useRef(false)
  const [catalog, setCatalog] = useState<ModelCatalogView | undefined>(undefined)
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>('idle')

  // Select fields need the host's model catalog; load it lazily on the first
  // expand. The started-ref guards duplicates WITHOUT cancelling the in-flight
  // load when status/open change — a cleanup keyed on status would dead-lock
  // the state at 'loading' (it cancels exactly the request that must resolve).
  // A bounded race degrades to free text if the host is slow to answer.
  useEffect(() => {
    if (!open || !canLoadCatalog || catalogStartedRef.current) return
    catalogStartedRef.current = true
    setCatalogStatus('loading')
    const load = props.loadCatalog as () => Promise<ModelCatalogView | undefined>
    void (async () => {
      try {
        const view = await Promise.race([
          load(),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('model catalog timed out')), MODEL_CATALOG_TIMEOUT_MS)
          }),
        ])
        setCatalog(view)
        setCatalogStatus('ready')
      } catch {
        setCatalogStatus('failed')
      }
    })()
  }, [open, canLoadCatalog])

  // The resolved value carries schema defaults + composition base + user
  // overrides, so the draft needs no local defaults map.
  const committed = (snap.value ?? {}) as Record<string, unknown>

  const [draft, setDraft] = useState<Record<string, unknown>>({ ...committed })
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setDraft({ ...committed })
    setFailed(false)
  }, [committed])

  const edit = (field: string, value: unknown) => {
    setFailed(false)
    setDraft(prev => ({ ...prev, [field]: value }))
  }

  const numericInvalid = (field: FieldSpec): boolean => {
    if (field.kind !== 'number') return false
    const v = draft[field.key]
    if (v === undefined || v === null || v === '') return false
    const n = Number(v)
    return !Number.isFinite(n) || n < (field.minValue ?? 0)
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(committed)
  const invalid = spec.fields.some(numericInvalid)
  const disabled = !snap.writable
  const blocked = !dirty || invalid || saving

  // A card whose namespace is not ready renders nothing — the same rule the
  // deployment's PluginCard applies (available === false → null).
  if (snap.status !== 'ready') return null

  const save = async () => {
    setSaving(true)
    setFailed(false)
    try {
      const accepted = await submitSection(props.form, draft, committed)
      if (!accepted) setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const discard = () => {
    setDraft({ ...committed })
    setFailed(false)
  }

  /** Render one select field: dropdown over the catalog, or free-text fallback. */
  const renderSelectField = (field: FieldSpec & { kind: 'select' }, base: FieldBaseProps) => {
    const rawValue = typeof draft[field.key] === 'string' ? draft[field.key] as string : ''
    // The catalog cannot serve this card at all (no llm face / load failed /
    // zero advertised options) — degrade to a text input so manual ids work.
    if (!canLoadCatalog || catalogStatus === 'failed') {
      return (
        <TextField
          {...base}
          hint={`${base.hint} ${t('modelCatalogUnavailable')}`}
          value={rawValue}
          onChange={(v) => edit(field.key, v === '' ? undefined : v)}
        />
      )
    }
    if (catalogStatus !== 'ready') {
      return (
        <SelectField
          {...base}
          disabled
          value=""
          options={[{ value: '', label: t('modelCatalogLoading') }]}
          onChange={() => { /* loading — nothing to select yet */ }}
        />
      )
    }
    const resolved = field.options?.({ catalog, draft }) ?? []
    if (resolved.length === 0) {
      return (
        <TextField
          {...base}
          hint={`${base.hint} ${t('modelCatalogUnavailable')}`}
          value={rawValue}
          onChange={(v) => edit(field.key, v === '' ? undefined : v)}
        />
      )
    }
    const opts = field.emptyOptionKey === undefined
      ? [...resolved]
      : [{ value: '', label: t(field.emptyOptionKey) }, ...resolved]
    // A committed id the catalog no longer advertises stays visible verbatim
    // instead of rendering as a blank selection.
    if (rawValue !== '' && !opts.some(o => o.value === rawValue)) {
      opts.push({ value: rawValue, label: rawValue })
    }
    return (
      <SelectField
        {...base}
        value={rawValue}
        options={opts}
        onChange={(v) => edit(field.key, v === '' ? undefined : v)}
      />
    )
  }

  return (
    <li className={`${css.card}${open ? ` ${css.cardOpen}` : ''}`}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t(spec.titleKey)}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t(spec.titleKey)}</span>
          <span className={css.description}>{t(spec.descriptionKey)}</span>
        </span>
        {dirty ? <span className={css.pending}>{t('unsaved')}</span> : null}
        <IconChevronDownOutlineMedium className={`${css.chevron}${open ? ` ${css.chevronOpen}` : ''}`} />
      </button>
      {open ? (
        <div className={css.body}>
          {!snap.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}
          {spec.fields.map(field => {
            // A field's settings key doubles as its default label key; every
            // field key exists in the dictionary (checked by the spec types).
            const label = t(field.labelKey ?? (field.key as SpecLocaleKey))
            const hint = t(field.hintKey ?? (`${field.key}Hint` as SpecLocaleKey))
            const base = {
              key: field.key,
              id: `dsh-settings-${field.key}`,
              label,
              hint,
              overridden: isOverridden(snap, field.key),
              overriddenLabel: t('overridden'),
              resetLabel: t('reset'),
              disabled,
              onReset: () => { void props.form.unset(field.key); edit(field.key, undefined) },
            }
            if (field.kind === 'checkbox') {
              return (
                <CheckboxField
                  {...base}
                  checked={Boolean(draft[field.key] ?? false)}
                  onChange={(v) => edit(field.key, v)}
                />
              )
            }
            if (field.kind === 'number') {
              const raw = draft[field.key]
              return (
                <NumberField
                  {...base}
                  invalidLabel={t('invalidNumber')}
                  invalid={numericInvalid(field)}
                  value={typeof raw === 'number' ? raw : typeof raw === 'string' ? raw : ''}
                  onChange={(v) => edit(field.key, v === '' ? undefined : Number(v))}
                />
              )
            }
            if (field.kind === 'select') {
              // Discriminated-union check: select-only props are required here.
              return renderSelectField(field as FieldSpec & { kind: 'select' }, base)
            }
            return (
              <TextField
                {...base}
                value={typeof draft[field.key] === 'string' ? draft[field.key] as string : ''}
                onChange={(v) => edit(field.key, v === '' ? undefined : v)}
              />
            )
          })}
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
