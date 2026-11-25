/**
 * The Memory panel's Audit tab: the store's mutation trail, filtered by
 * operation and source.
 *
 * The trail is the diagnostic surface behind "why is this entry gone?" — every
 * `add`/`update`/`remove` the store applied, plus the break-glass `readRaw`
 * reads that asked for scanner-blocked content. Usage hits are counters rather
 * than mutations, so they live on the Overview tab instead of here.
 *
 * @module @chenhw7/dsh-memory/client/MemoryAuditTab
 */

import type { ReactNode } from 'react'
import type { AuditEntryJson, MemorySuggestionJson } from '../typert.remote-client.js'
import { AUDIT_PAGE_SIZE, type MemorySectionState } from './memory-section-store.ts'
import { css } from './section-styles.ts'

type LocaleKey = keyof typeof import('./locales.ts').en

/** The audit `op` values the filter bar offers (mirrors the store's enum). */
const AUDIT_OPS: readonly string[] = ['add', 'update', 'remove', 'readRaw']

/** The audit `source` values the filter bar offers (mirrors the store's enum). */
const AUDIT_SOURCES: readonly string[] = ['tool', 'review', 'flush', 'janitor', 'ui']

/**
 * Render the audit trail with its filter bar.
 * @param props - the page snapshot plus the filter/refresh actions.
 * @returns the tab body.
 */
export function MemoryAuditTab(props: {
  state: MemorySectionState
  translate: (key: LocaleKey) => string
  onLoad: () => void
  onToggleFilter: (dimension: 'ops' | 'sources', value: string) => void
}): ReactNode {
  const { state, translate, onLoad, onToggleFilter } = props
  return (
    <>
      <p className={css.reviewHead}>{translate('auditIntro')}</p>
      <div className={css.auditBar}>
        <span className={css.toolbarLabel}>{translate('auditFilterOp')}</span>
        {AUDIT_OPS.map(op => (
          <button
            key={op}
            type="button"
            className={css.chip}
            aria-pressed={state.auditOps.includes(op)}
            onClick={() => { onToggleFilter('ops', op) }}
          >
            {op}
          </button>
        ))}
        <span className={css.toolbarLabel}>{translate('auditFilterSource')}</span>
        {AUDIT_SOURCES.map(source => (
          <button
            key={source}
            type="button"
            className={css.chip}
            aria-pressed={state.auditSources.includes(source)}
            onClick={() => { onToggleFilter('sources', source) }}
          >
            {source}
          </button>
        ))}
        <button type="button" className={css.actionBtn} onClick={onLoad}>
          {translate('auditRefresh')}
        </button>
      </div>
      {state.auditStatus === 'error'
        ? <p className={css.error} role="alert">{state.auditError ?? translate('auditFailed')}</p>
        : null}
      {state.auditStatus === 'loading' && state.audit.length === 0
        ? <p className={css.empty}>{translate('searchLabel')}…</p>
        : null}
      {state.audit.length === 0
        ? (state.auditStatus === 'ready'
            ? (
              <p className={css.empty}>
                {translate(state.auditOps.length === 0 && state.auditSources.length === 0 ? 'auditEmptyAll' : 'auditEmpty')}
              </p>
            )
            : null)
        : (
          <>
            <p className={css.metricHint}>
              {translate('auditShowing')
                .replace('{count}', String(state.audit.length))
                .replace('{limit}', String(AUDIT_PAGE_SIZE))}
            </p>
            <div className={css.auditHead}>
              <span>{translate('auditColTime')}</span>
              <span>{translate('auditColOp')}</span>
              <span>{translate('auditColSource')}</span>
              <span>{translate('auditColScope')}</span>
              <span>{translate('auditColPreview')}</span>
            </div>
            <ul className={css.auditTable}>
              {[...state.audit].reverse().map(record => (
                <AuditRow key={record.id} record={record} />
              ))}
            </ul>
          </>
        )}
    </>
  )
}

/**
 * One audit record row, newest first.
 * @param props - the record to render.
 * @returns the row.
 */
function AuditRow(props: { record: AuditEntryJson }): ReactNode {
  const { record } = props
  return (
    <li className={css.auditRow}>
      <span className={`${css.auditCell} ${css.auditTs}`}>{new Date(record.ts).toLocaleString()}</span>
      <span className={css.auditCell}>{record.op}</span>
      <span className={css.auditCell}>{record.source}</span>
      <span className={css.auditCell}>{record.scope}</span>
      <span className={css.auditPreview} title={`${record.entryId}: ${record.contentPreview}`}>
        {record.contentPreview}
      </span>
    </li>
  )
}

/** Re-export so the section module can name the wired proposal type. */
export type { MemorySuggestionJson }
