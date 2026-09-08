/**
 * Identity governance section — Settings → Identity. READ-ONLY by design:
 * the two self-documents are written by the assistant itself in conversation
 * (the `identity_update` tool); this surface renders the current documents,
 * their retained version history, and exactly one write power — reverting to
 * a retained version — plus a plain markdown export. No editor exists here:
 * the documents are the agent's, the governance is the human's.
 *
 * Data flows exclusively through the injected controller store — this file
 * holds no connection and issues no RPCs.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { IdentityHistoryJson, IdentityRecordJson } from '../typert.remote-client.js'
import type { IdentitySectionState } from './identity-section-store.ts'
import { css } from './section-styles.ts'

/** Registration-side business face for the identity section. */
export interface IdentitySectionInjected {
  hooks: {
    /** Page snapshot bound by the renderer as useIdentitySection. */
    identitySection: SnapshotStore<IdentitySectionState>
  }
  /** Full load (both documents + histories); called once on open. */
  load: () => Promise<void>
  /** Restore one retained version as the newest (the governance valve). */
  revert: (kind: 'soul' | 'user', version: number) => Promise<boolean>
}

/** Full component props. */
export type IdentitySectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.memory'>
  & InjectFace<IdentitySectionInjected>

type LocaleKey = keyof typeof import('./locales.ts').en

/** The two panels, in display order, with their display names. */
const KINDS: readonly {
  kind: 'soul' | 'user'
  titleKey: LocaleKey
  emptyKey: LocaleKey
  file: string
}[] = [
  { kind: 'soul', titleKey: 'identitySoulTitle', emptyKey: 'identitySoulEmpty', file: 'SOUL.md' },
  { kind: 'user', titleKey: 'identityUserTitle', emptyKey: 'identityUserEmpty', file: 'USER.md' },
]

/** Render an epoch-ms timestamp in the browser's locale. */
function formatTs(ts: number): string {
  return new Date(ts).toLocaleString()
}

/** Localized label for one history snapshot's provenance source. */
function sourceLabel(source: IdentityHistoryJson['source'], translate: (key: LocaleKey) => string): string {
  if (source === 'seed') return translate('identitySourceSeed')
  if (source === 'ui') return translate('identitySourceUi')
  return translate('identitySourceTool')
}

/**
 * Download one document's current content as a markdown file. Browser-only:
 * jsdom lacks `URL.createObjectURL`, so the guard no-ops there (the test stubs
 * it when it wants to assert the payload).
 */
function exportDocument(file: string, content: string): void {
  if (typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * One document panel: the read-only current text, the version history with
 * the two-step revert confirm, and the export button. The confirming state
 * holds the version pending its second click — the EntryRow confirm pattern.
 */
function DocumentPanel(props: {
  kind: 'soul' | 'user'
  file: string
  title: string
  emptyHint: string
  record: IdentityRecordJson | null
  history: readonly IdentityHistoryJson[]
  translate: (key: LocaleKey) => string
  onRevert: (kind: 'soul' | 'user', version: number) => Promise<boolean>
}): ReactNode {
  const { kind, file, title, emptyHint, record, history, translate, onRevert } = props
  const [confirmingVersion, setConfirmingVersion] = useState<number | null>(null)

  return (
    <div className={css.row} data-testid={`identity-panel-${kind}`}>
      <div className={css.reviewHead}>
        <span className={css.title}>{title}</span>
        <span className={css.badges}>
          {record !== null
            ? (
              <>
                <span className={css.badge}>
                  {translate('identityCurrentVersion').replace('{version}', String(record.version))}
                </span>
                <button
                  type="button"
                  className={css.moreBtn}
                  onClick={() => { exportDocument(file, record.content) }}
                >
                  {translate('identityExport')}
                </button>
              </>
            )
            : null}
        </span>
      </div>

      {record === null
        ? <p className={css.empty}>{emptyHint}</p>
        : (
          <>
            <pre className={css.contentOpen}>{record.content}</pre>
            <div className={css.list}>
              <div className={css.meta}>{translate('identityHistoryTitle')}</div>
              {history.length === 0
                ? <p className={css.empty}>{translate('identityEmptyHistory')}</p>
                : history.map(snapshot => (
                    <div key={`${kind}-${snapshot.version}`} className={css.row}>
                      <span className={css.content}>
                        {`v${snapshot.version} · ${formatTs(snapshot.ts)} · ${sourceLabel(snapshot.source, translate)}`}
                      </span>
                      <span className={css.actions}>
                        {confirmingVersion === snapshot.version
                          ? (
                              <button
                                type="button"
                                className={css.actionBtnDanger}
                                onClick={() => {
                                  setConfirmingVersion(null)
                                  void onRevert(kind, snapshot.version)
                                }}
                              >
                                {translate('identityRevertConfirm')}
                              </button>
                            )
                          : (
                              <button
                                type="button"
                                className={css.actionBtn}
                                onClick={() => { setConfirmingVersion(snapshot.version) }}
                              >
                                {translate('identityRevertBtn')}
                              </button>
                            )}
                      </span>
                    </div>
                  ))}
            </div>
          </>
        )}
    </div>
  )
}

/** Render the Identity section content column. */
export function IdentitySection(props: IdentitySectionProps): ReactNode {
  const { useIdentitySection, t, load } = props
  const state = useIdentitySection(snapshot => snapshot)

  useEffect(() => {
    void load()
  }, [load])

  if (state.status === 'error') {
    return (
      <div className={css.section}>
        <h2 className={css.title}>{t('identityNav')}</h2>
        <p className={css.error} role="alert">{`${t('loadFailed')} ${state.error ?? ''}`}</p>
        <button type="button" className={css.moreBtn} onClick={() => { void load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div className={css.section}>
        <h2 className={css.title}>{t('identityNav')}</h2>
        <p className={css.intro}>{t('loading')}</p>
      </div>
    )
  }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('identityNav')}</h2>
      <p className={css.intro}>{t('identitySectionIntro')}</p>

      {state.actionError !== null
        ? <p className={css.error} role="alert">{state.actionError}</p>
        : null}

      {KINDS.map(({ kind, titleKey, emptyKey, file }) => (
        <DocumentPanel
          key={kind}
          kind={kind}
          file={file}
          title={t(titleKey)}
          emptyHint={t(emptyKey)}
          record={kind === 'soul' ? state.soul : state.user}
          history={state.history[kind]}
          translate={t}
          onRevert={(revertKind, version) => props.revert(revertKind, version)}
        />
      ))}
    </div>
  )
}
