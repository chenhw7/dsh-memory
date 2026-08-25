/**
 * Memory content-management section — Settings → Memory. Phase 1: read-only
 * browsing of the whole web-profile store across every scope and workspace.
 * Two tabs keep the two jobs apart: Overview holds the health dashboard;
 * Manage holds the filters and a lazily loaded entry list (auto-append near
 * the bottom, plus a manual "Load more" fallback) with soft-decay ("dormant")
 * markers.
 *
 * Data flows exclusively through the injected controller store — this file
 * holds no connection and issues no RPCs. Row actions (pin / edit / delete)
 * and the editor drawer arrive in phase 2; until then the Manage tab renders
 * rows without mutation affordances, matching the plan's phased rollout.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { MemoryEntryJson } from '../typert.remote-client.js'
import {
  CATEGORY_LABEL_KEYS,
  MEMORY_CATEGORIES,
  type MemoryScopeFilter,
  type MemorySectionState,
} from './memory-section-store.ts'
import { css } from './section-styles.ts'

/** Registration-side business face for the memory section. */
export interface MemorySectionInjected {
  hooks: {
    /** Page snapshot bound by the renderer as useMemorySection. */
    memorySection: SnapshotStore<MemorySectionState>
  }
  /** Full load (dashboard + workspaces + first batch); called once on open. */
  load: () => Promise<void>
  /** Switch the scope filter. */
  setScope: (scope: MemoryScopeFilter) => void
  /** Pick one workspace, or null/'' for all. */
  setProject: (name: string | null) => void
  /** Commit the debounced search text. */
  commitQuery: (query: string) => void
  /** Flip one category chip. */
  toggleCategory: (category: string) => void
  /** Append the next chunk of rows (lazy loading). */
  loadMore: () => void
}

/** Full component props. */
export type MemorySectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.memory'>
  & InjectFace<MemorySectionInjected>

const SCOPES: readonly { value: MemoryScopeFilter; labelKey: 'scopeAll' | 'scopeGlobal' | 'scopeProject' | 'scopeUser' }[] = [
  { value: 'all', labelKey: 'scopeAll' },
  { value: 'global', labelKey: 'scopeGlobal' },
  { value: 'project', labelKey: 'scopeProject' },
  { value: 'user', labelKey: 'scopeUser' },
]

/** The section's two tabs: glanceable health vs. content management. */
type SectionTab = 'overview' | 'manage'

type LocaleKey = keyof typeof import('./locales.ts').en

/**
 * Render an epoch-ms timestamp in the browser's locale, or a fallback word.
 * @param ts - the timestamp, absent when never.
 * @param fallback - localized "never" text.
 */
function formatTs(ts: number | undefined, fallback: string): string {
  return ts === undefined || ts === null ? fallback : new Date(ts).toLocaleString()
}

/**
 * Which empty-state copy fits the active filters.
 * @param state - the page snapshot.
 * @returns the locale key of the fitting guidance line.
 */
function emptyKeyOf(state: MemorySectionState): 'emptyFiltered' | 'emptyAll' | 'emptyGlobal' | 'emptyUser' | 'emptyProject' {
  if (state.query.trim() !== '' || state.categories.length > 0) return 'emptyFiltered'
  if (state.scope === 'global') return 'emptyGlobal'
  if (state.scope === 'user') return 'emptyUser'
  if (state.scope === 'project') return 'emptyProject'
  return 'emptyAll'
}

/**
 * One list row: badges over expandable content over timestamps.
 */
function EntryRow(props: {
  entry: MemoryEntryJson
  expanded: boolean
  staleLabel: string
  staleHint: string
  pinnedLabel: string
  neverRecalledLabel: string
  scopeLabels: Readonly<Record<'global' | 'project' | 'user', string>>
  translate: (key: LocaleKey) => string
  onToggle: () => void
}): ReactNode {
  const { entry, expanded, staleLabel, staleHint, pinnedLabel, neverRecalledLabel, scopeLabels, translate, onToggle } = props
  // Boolean-guard extraction: read each optional field ONCE into a constant
  // before branching (the double bare access crashed a card once).
  const category = entry.category
  const projectName = entry.projectName
  const isStale = entry.staleSince !== undefined
  const isPinned = entry.pinned === true
  return (
    <li className={isStale ? `${css.row} ${css.rowStale}` : css.row}>
      <div className={css.badges}>
        <span className={css.badge}>{scopeLabels[entry.scope]}</span>
        {category === undefined
          ? null
          : (
            <span className={css.badge}>
              {translate((CATEGORY_LABEL_KEYS[category] ?? category) as LocaleKey)}
            </span>
          )}
        {projectName === undefined ? null : <span className={css.project}>{projectName}</span>}
        {isPinned ? <span className={`${css.badge} ${css.badgePinned}`}>{`📌 ${pinnedLabel}`}</span> : null}
        {isStale ? (
          <span className={`${css.badge} ${css.badgeStale}`} title={staleHint} aria-label={staleHint}>
            {`😴 ${staleLabel}`}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className={expanded ? `${css.content} ${css.contentOpen}` : css.content}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {entry.content}
      </button>
      <p className={css.meta}>
        <span>{`${translate('metaCreated')} ${formatTs(entry.createdAt, '—')}`}</span>
        <span>{`${translate('metaUpdated')} ${formatTs(entry.updatedAt, '—')}`}</span>
        <span>
          {entry.lastRecalledAt === undefined
            ? `${translate('metaRecalled')} ${neverRecalledLabel}`
            : `${translate('metaRecalled')} ${formatTs(entry.lastRecalledAt, neverRecalledLabel)}`}
        </span>
      </p>
    </li>
  )
}

/**
 * Render the Memory section content column.
 * @param props - composed slot props.
 * @returns the section.
 */
export function MemorySection(props: MemorySectionProps): ReactNode {
  const { useMemorySection, t, load } = props
  const state = useMemorySection(snapshot => snapshot)

  useEffect(() => {
    void load()
  }, [load])

  const [tab, setTab] = useState<SectionTab>('overview')

  // Local search text commits through the controller after a 300ms pause.
  // Only the text rides the dependency array: the action closure changes
  // identity per parent render and would reset the timer forever.
  const [searchText, setSearchText] = useState(state.query)
  useEffect(() => {
    const timer = setTimeout(() => { props.commitQuery(searchText) }, 300)
    return () => { clearTimeout(timer) }
  }, [searchText])

  // Rows whose content the user expanded (truncated by default). Held above
  // the tab panels so switching tabs does not forget what was opened.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const toggleExpanded = (id: string): void => {
    setExpandedIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const scopeLabels: Readonly<Record<'global' | 'project' | 'user', string>> = {
    global: t('dashGlobal'),
    project: t('dashProject'),
    user: t('dashUser'),
  }
  const workspaceEnabled = state.scope === 'all' || state.scope === 'project'
  const total = state.total
  const shown = state.entries.length
  const hasMore = shown < total

  // Latest loader behind a stable ref: the scroll observer must not tear down
  // and rebuild on every parent render.
  const loadMoreRef = useRef(props.loadMore)
  loadMoreRef.current = props.loadMore

  // Auto-append when the sentinel scrolls into view. Re-running the effect
  // after each append re-observes, so a still-visible sentinel cascades until
  // the viewport is full or everything is shown. jsdom has no
  // IntersectionObserver — the explicit button covers tests and keyboard use.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const element = sentinelRef.current
    if (element === null || tab !== 'manage') return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) loadMoreRef.current()
      },
      { rootMargin: '240px' },
    )
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [tab, state.status, shown, total])

  if (state.status === 'error') {
    return (
      <div className={css.section}>
        <h2 className={css.title}>{t('nav')}</h2>
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
        <h2 className={css.title}>{t('nav')}</h2>
        <p className={css.intro}>{t('loading' as LocaleKey)}</p>
      </div>
    )
  }

  const health = state.health

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('sectionIntro')}</p>

      {/* Tab bar: health glance vs. content management. */}
      <div className={css.tabs} role="tablist" aria-label={t('nav')}>
        <button
          type="button"
          role="tab"
          className={css.tabBtn}
          aria-selected={tab === 'overview'}
          onClick={() => { setTab('overview') }}
        >
          {t('tabOverview')}
        </button>
        <button
          type="button"
          role="tab"
          className={css.tabBtn}
          aria-selected={tab === 'manage'}
          onClick={() => { setTab('manage') }}
        >
          {t('tabManage')}
        </button>
      </div>

      {tab === 'overview'
        ? (
            health === null
              ? null
              : (
                <div className={css.dash}>
                  <span className={css.stat}>
                    <span className={css.statValue}>{health.totalEntries}</span>
                    <span className={css.statLabel}>{t('dashTotal')}</span>
                  </span>
                  <span className={css.stat}>
                    <span className={css.statValue}>{health.byScope.global}</span>
                    <span className={css.statLabel}>{t('scopeGlobal')}</span>
                  </span>
                  <span className={css.stat}>
                    <span className={css.statValue}>{health.byScope.user}</span>
                    <span className={css.statLabel}>{t('scopeUser')}</span>
                  </span>
                  <span className={css.stat}>
                    <span className={css.statValue}>{health.byScope.project}</span>
                    <span className={css.statLabel}>{t('scopeProject')}</span>
                  </span>
                  <span className={css.stat}>
                    <span className={css.statValue}>{health.pinned}</span>
                    <span className={css.statLabel}>{t('dashPinned')}</span>
                  </span>
                  <span className={`${css.stat} ${css.statStale}`} title={t('dashStaleHint')}>
                    <span className={`${css.statValue}${(health.stale ?? 0) > 0 ? '' : ` ${css.statValueMuted}`}`}>
                      {health.stale ?? 0}
                    </span>
                    <span className={css.statLabel}>{t('dashStale')}</span>
                  </span>
                  <span className={css.stat}>
                    <span className={css.statValue}>{health.auditRecords}</span>
                    <span className={css.statLabel}>{t('dashAudit')}</span>
                  </span>
                  <span className={css.stat}>
                    <span className={`${css.statValue} ${css.statValueMuted}`}>
                      {formatTs(health.lastActivityTs, t('dashLastActivityNever'))}
                    </span>
                    <span className={css.statLabel}>{t('dashLastActivity')}</span>
                  </span>
                  <span className={css.stat}>
                    <span className={`${css.statValue} ${css.statValueMuted}`}>
                      {formatTs(health.lastExtractionTs, t('dashLastActivityNever'))}
                    </span>
                    <span className={css.statLabel}>{t('dashLastExtraction')}</span>
                  </span>
                </div>
              )
          )
        : (
          <>
            {/* Toolbar */}
            <div className={css.toolbar}>
              <div className={css.toolbarRow}>
                <span className={css.toolbarLabel}>{t('searchLabel')}</span>
                <div className={css.seg} role="group" aria-label={t('nav')}>
                  {SCOPES.map(({ value, labelKey }) => (
                    <button
                      key={value}
                      type="button"
                      className={css.segBtn}
                      aria-pressed={state.scope === value}
                      onClick={() => { props.setScope(value) }}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
                <select
                  className={css.select}
                  aria-label={t('workspaceLabel')}
                  disabled={!workspaceEnabled}
                  value={state.projectName ?? ''}
                  onChange={(event) => { props.setProject(event.target.value) }}
                >
                  <option value="">{t('workspaceAll')}</option>
                  {state.projects.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                <input
                  type="search"
                  className={css.input}
                  aria-label={t('searchLabel')}
                  placeholder={t('searchPlaceholder')}
                  value={searchText}
                  onChange={(event) => { setSearchText(event.target.value) }}
                />
              </div>
              <div className={css.toolbarRow}>
                <span className={css.toolbarLabel}>{t('categoryLabel')}</span>
                {MEMORY_CATEGORIES.map(category => (
                  <button
                    key={category}
                    type="button"
                    className={css.chip}
                    aria-pressed={state.categories.includes(category)}
                    onClick={() => { props.toggleCategory(category) }}
                  >
                    {translateCategory(category, t)}
                  </button>
                ))}
              </div>
            </div>

            {/* Inline failure of a background refresh: previous rows stay visible. */}
            {state.error === null ? null : <p className={css.error} role="alert">{state.error}</p>}

            {/* Entry list */}
            {total === 0
              ? <p className={css.empty}>{t(emptyKeyOf(state))}</p>
              : (
                <>
                  <ul className={css.list}>
                    {state.entries.map(entry => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        expanded={expandedIds.has(entry.id)}
                        staleLabel={t('staleMark')}
                        staleHint={t('staleHint')}
                        pinnedLabel={t('pinnedBadge')}
                        neverRecalledLabel={t('neverRecalled')}
                        scopeLabels={scopeLabels}
                        translate={t}
                        onToggle={() => { toggleExpanded(entry.id) }}
                      />
                    ))}
                  </ul>
                  {/* Lazy-load footer: progress line, scroll sentinel, manual fallback. */}
                  <div className={css.more}>
                    <p className={css.count}>
                      {t('shownCount').replace('{shown}', String(shown)).replace('{total}', String(total))}
                    </p>
                    {hasMore
                      ? (
                        <>
                          <div ref={sentinelRef} className={css.sentinel} aria-hidden="true" />
                          <button
                            type="button"
                            className={css.moreBtn}
                            disabled={state.loadingMore}
                            onClick={() => { props.loadMore() }}
                          >
                            {state.loadingMore ? t('loading' as LocaleKey) : t('loadMore')}
                          </button>
                        </>
                      )
                      : null}
                  </div>
                </>
              )}
          </>
        )}
    </div>
  )
}

/** Resolve a chip's label through its locale key, falling back to the raw id. */
function translateCategory(
  category: string,
  t: (key: LocaleKey) => string,
): string {
  const key = CATEGORY_LABEL_KEYS[category]
  return key === undefined ? category : t(key as LocaleKey)
}
