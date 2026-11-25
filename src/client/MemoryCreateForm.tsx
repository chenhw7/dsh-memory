/**
 * The Memory panel's Manage-tab create form: one entry, written through the
 * same host `add` path the tools use (scanner gates included, source `'ui'`).
 *
 * It exists for the fact you want recorded now — the tools need a model turn
 * and extraction needs a threshold, while this is a deliberate human write.
 *
 * @module @chenhw7/dsh-memory/client/MemoryCreateForm
 */

import { useState, type ReactNode } from 'react'
import { CATEGORY_LABEL_KEYS, MEMORY_CATEGORIES } from './memory-section-store.ts'
import { css } from './section-styles.ts'

type LocaleKey = keyof typeof import('./locales.ts').en

/** Scope values the form can write; `project` requires a workspace name. */
const CREATE_SCOPES: readonly { readonly value: 'global' | 'project' | 'user'; readonly labelKey: LocaleKey }[] = [
  { value: 'global', labelKey: 'scopeGlobal' },
  { value: 'project', labelKey: 'scopeProject' },
  { value: 'user', labelKey: 'scopeUser' },
]

/**
 * Render the create form.
 * @param props - the workspace roster (for project scope) and the submit action.
 * @returns the form, or nothing while it is collapsed.
 */
export function MemoryCreateForm(props: {
  open: boolean
  projects: readonly string[]
  actionError?: string | null
  translate: (key: LocaleKey) => string
  onToggle: () => void
  onSubmit: (input: {
    scope: 'global' | 'project' | 'user'
    content: string
    category?: string
    summary?: string
    projectName?: string
  }) => Promise<boolean>
}): ReactNode {
  const { open, projects, actionError, translate, onToggle, onSubmit } = props
  const [scope, setScope] = useState<'global' | 'project' | 'user'>('user')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState('')
  const [summary, setSummary] = useState('')
  const [projectName, setProjectName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  if (!open) {
    return (
      <div className={css.createRow}>
        <button type="button" className={css.actionBtn} onClick={onToggle}>
          {translate('createTitle')}
        </button>
      </div>
    )
  }

  const trimmed = content.trim()
  const valid = trimmed.length > 0 && (scope !== 'project' || projectName.trim().length > 0)

  const submit = async (): Promise<void> => {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    const ok = await onSubmit({
      scope,
      content: trimmed,
      ...category.length > 0 ? { category } : {},
      ...summary.trim().length > 0 ? { summary: summary.trim() } : {},
      ...scope === 'project' ? { projectName: projectName.trim() } : {},
    })
    setSaving(false)
    if (!ok) {
      setError(translate('createFailed'))
      return
    }
    // A successful create clears the draft and collapses: the new row is
    // already visible in the list above, so keeping a filled form would only
    // invite a duplicate.
    setContent('')
    setSummary('')
    setCategory('')
    onToggle()
  }

  return (
    <div className={css.createBox}>
      <h3 className={css.metricGroupTitle}>{translate('createTitle')}</h3>
      <p className={css.metricHint}>{translate('createHint')}</p>
      <div className={css.createRow}>
        <span className={css.createLabel}>{translate('createScope')}</span>
        <div className={css.seg} role="group" aria-label={translate('createScope')}>
          {CREATE_SCOPES.map(option => (
            <button
              key={option.value}
              type="button"
              className={css.segBtn}
              aria-pressed={scope === option.value}
              onClick={() => { setScope(option.value) }}
            >
              {translate(option.labelKey)}
            </button>
          ))}
        </div>
        {scope === 'project'
          ? (
            <input
              className={css.input}
              aria-label={translate('createProject')}
              placeholder={translate('createProject')}
              list="dsm-create-projects"
              value={projectName}
              onChange={(event) => { setProjectName(event.target.value) }}
            />
          )
          : null}
        {scope === 'project'
          ? (
            <datalist id="dsm-create-projects">
              {projects.map(name => <option key={name} value={name} />)}
            </datalist>
          )
          : null}
      </div>
      <div className={css.createRow}>
        <span className={css.createLabel}>{translate('createContent')}</span>
        <textarea
          className={css.textarea}
          aria-label={translate('createContent')}
          placeholder={translate('createContentPlaceholder')}
          rows={3}
          value={content}
          onChange={(event) => { setContent(event.target.value) }}
        />
      </div>
      <div className={css.createRow}>
        <span className={css.createLabel}>{translate('createCategory')}</span>
        <select
          className={css.select}
          aria-label={translate('createCategory')}
          value={category}
          onChange={(event) => { setCategory(event.target.value) }}
        >
          <option value="">{translate('noCategory')}</option>
          {MEMORY_CATEGORIES.map(value => (
            <option key={value} value={value}>
              {translate(CATEGORY_LABEL_KEYS[value] as LocaleKey)}
            </option>
          ))}
        </select>
        <span className={css.createLabel}>{translate('createSummary')}</span>
        <input
          className={css.input}
          aria-label={translate('createSummary')}
          placeholder={translate('editSummaryPlaceholder')}
          value={summary}
          onChange={(event) => { setSummary(event.target.value) }}
        />
      </div>
      {error === null ? null : <p className={css.error} role="alert">{actionError ?? error}</p>}
      <div className={css.createRow}>
        <button type="button" className={css.actionBtn} disabled={!valid || saving} onClick={() => { void submit() }}>
          {translate('createSubmit')}
        </button>
        <button type="button" className={css.actionBtn} onClick={onToggle}>
          {translate('createCancel')}
        </button>
      </div>
    </div>
  )
}
