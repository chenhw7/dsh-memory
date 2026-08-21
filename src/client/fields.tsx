/**
 * Shared field components for the memory settings cards — a port of the
 * deployment's `fields.tsx` ValueField structure (label over control over
 * hint, with an override badge + reset), used by both the curated
 * MemoryPluginCard and the spec-driven NamespaceCard.
 *
 * @module @chenhw7/dsh-memory/client/fields
 */

import { css } from './card-styles.ts'

export interface FieldBaseProps {
  id: string
  label: string
  hint: string
  overridden: boolean
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  onReset: () => void
}

export function FieldHead(props: FieldBaseProps) {
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

export interface SelectFieldProps extends FieldBaseProps {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}

export function SelectField(props: SelectFieldProps) {
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

export interface TextFieldProps extends FieldBaseProps {
  value: string
  placeholder?: string
  onChange: (v: string) => void
}

/** Single-line text input styled like the `.input` control. */
export function TextField(props: TextFieldProps) {
  return (
    <div className={css.field}>
      <FieldHead {...props} />
      <input
        id={props.id}
        className={css.input}
        type="text"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}

export interface NumberFieldProps extends FieldBaseProps {
  value: number | string
  invalid: boolean
  invalidLabel: string
  onChange: (v: string) => void
}

export function NumberField(props: NumberFieldProps) {
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

export interface CheckboxFieldProps extends FieldBaseProps {
  checked: boolean
  onChange: (v: boolean) => void
}

export function CheckboxField(props: CheckboxFieldProps) {
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

export interface TextareaFieldProps extends FieldBaseProps {
  value: string
  onChange: (v: string) => void
}

export function TextareaField(props: TextareaFieldProps) {
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
