/**
 * Generic namespace settings card — the same PluginCard port as
 * MemoryPluginCard, but driven by a declarative field spec, so sibling
 * plugins (`memory-review`, `tool-memory`) get a card without re-curating
 * one. Locale keys follow the `<key>` / `<key>Hint` convention unless the
 * spec overrides them.
 *
 * @module @chenhw7/dsh-memory/client/NamespaceCard
 */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { css } from './card-styles.ts'
import { TextField, NumberField, CheckboxField } from './fields.tsx'

/** One displayed field: its settings key, control kind, and locale keys. */
export interface FieldSpec {
  readonly key: string
  readonly kind: 'checkbox' | 'number' | 'text'
  readonly labelKey?: string
  readonly hintKey?: string
}

/** The full card content: card-chrome locale keys + the fields, in display order. */
export interface NamespaceCardSpec {
  readonly titleKey: string
  readonly descriptionKey: string
  readonly fields: readonly FieldSpec[]
}

/** The registration-side face the card's slot entry injects. */
export interface NamespaceCardInjected {
  hooks: {
    /** The bound settings scope — bound by the renderer as useNs. */
    ns: { getSnapshot(): SettingsScopeSnapshot<Record<string, unknown>>; subscribe(fn: () => void): () => void }
  }
  /** Queue one field write (durable, revision-fenced). */
  set: (field: string, value: unknown) => Promise<void>
  /** Queue one field clear (re-inherits the composition layer). */
  unset: (field: string) => Promise<void>
}

/** Props the renderer binds for a namespace card. */
export interface NamespaceCardProps
  extends PropsLocale<'settings.memory'>, PropsRuntime<'settings.plugin.item'>, InjectFace<NamespaceCardInjected> {
  spec: NamespaceCardSpec
}

/** Bind a spec into a slot-registrable component (keeps entry modules JSX-free). */
export function namespaceCard(spec: NamespaceCardSpec) {
  return function SpecBoundNamespaceCard(props: Omit<NamespaceCardProps, 'spec'>) {
    return <NamespaceCard {...props} spec={spec} />
  }
}

/** A field is overridden when the user layer carries it (presence, not value). */
function isOverridden(snap: SettingsScopeSnapshot<Record<string, unknown>>, field: string): boolean {
  const user = snap.user
  if (user === undefined || user === null || typeof user !== 'object') return false
  return Object.prototype.hasOwnProperty.call(user, field)
}

export function NamespaceCard(props: NamespaceCardProps) {
  const snap = props.useNs(s => s)
  const t = props.t
  const spec = props.spec
  const [open, setOpen] = useState(false)

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
    return !Number.isFinite(n) || n < 0
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
      const ops: Promise<void>[] = []
      for (const field of spec.fields) {
        if (draft[field.key] === committed[field.key]) continue
        const value = draft[field.key]
        ops.push(value === undefined ? props.unset(field.key) : props.set(field.key, value))
      }
      await Promise.all(ops)
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
        <IconChevronDownOutline14 className={`${css.chevron}${open ? ` ${css.chevronOpen}` : ''}`} />
      </button>
      {open ? (
        <div className={css.body}>
          {!snap.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}
          {spec.fields.map(field => {
            const label = t(field.labelKey ?? field.key)
            const hint = t(field.hintKey ?? `${field.key}Hint`)
            const base = {
              key: field.key,
              id: `dsh-settings-${field.key}`,
              label,
              hint,
              overridden: isOverridden(snap, field.key),
              overriddenLabel: t('overridden'),
              resetLabel: t('reset'),
              disabled,
              onReset: () => { void props.unset(field.key); edit(field.key, undefined) },
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
