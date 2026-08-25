/**
 * Scoped CSS for the Memory settings section (content management). Injected
 * once as a single `<style data-dsh-memory="section">` element; class names
 * are prefixed `dsm-s-` to avoid collisions with the plugin-card styles
 * (`dsm-c-` in ./card-styles.ts).
 *
 * The rules ride the same `--dsw-alias-*` design tokens as the deployment's
 * own settings surfaces and the ported card CSS, so the section reads as part
 * of the Settings dialog. Controls mirror the `.input` / `.select` look from
 * card-styles.ts.
 */

const RULES = `
.dsm-s-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dsm-s-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.dsm-s-intro {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}

/* ── Health dashboard bar ─────────────────────────────────────────────────── */
.dsm-s-dash {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 8px;
}
.dsm-s-stat {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 88px;
  padding: 10px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
}
.dsm-s-stat-value {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--dsw-alias-label-primary);
}
.dsm-s-stat-value-muted {
  color: var(--dsw-alias-label-secondary);
}
.dsm-s-stat-label {
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsm-s-stat-stale {
  cursor: help;
}

/* ── Toolbar ──────────────────────────────────────────────────────────────── */
.dsm-s-toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dsm-s-toolbar-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dsm-s-toolbar-label {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
/* Segmented scope switch and section tabs share one visual language. */
.dsm-s-seg,
.dsm-s-tabs {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
}
.dsm-s-seg-btn,
.dsm-s-tab-btn {
  appearance: none;
  border: 0;
  background: none;
  padding: 4px 12px;
  border-radius: 6px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsm-s-seg-btn:hover:not([aria-pressed="true"]),
.dsm-s-tab-btn:hover:not([aria-selected="true"]) {
  color: var(--dsw-alias-label-primary);
}
.dsm-s-seg-btn[aria-pressed="true"],
.dsm-s-tab-btn[aria-selected="true"] {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.dsm-s-tab-btn[aria-selected="true"] {
  cursor: default;
}
.dsm-s-seg-btn:focus-visible,
.dsm-s-tab-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
/* Search box mirrors the shared .input control look. */
.dsm-s-input {
  flex: 1;
  min-width: 200px;
  max-width: 360px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsm-s-input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
/* Workspace selector mirrors the shared .select control look. */
.dsm-s-select {
  max-width: 260px;
  height: 34px;
  padding: 0 28px 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background-color: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14' fill='none'%3E%3Cpath d='M3 5l4 4 4-4' stroke='%237a7a7a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
}
.dsm-s-select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsm-s-select:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
/* Category chips. */
.dsm-s-chip {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
  padding: 3px 12px;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsm-s-chip:hover {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsm-s-chip[aria-pressed="true"] {
  background: var(--dsw-alias-bg-module-platform);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary);
}
.dsm-s-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

/* ── Entry list ───────────────────────────────────────────────────────────── */
.dsm-s-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsm-s-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
}
.dsm-s-row-stale {
  opacity: 0.62;
}
.dsm-s-badges {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.dsm-s-badge {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  font-weight: 500;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsm-s-badge-pinned,
.dsm-s-badge-stale {
  background: none;
  padding-left: 0;
}
.dsm-s-project {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
}
.dsm-s-content {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
  cursor: pointer;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.dsm-s-content-open {
  display: block;
  -webkit-line-clamp: none;
  overflow: visible;
  cursor: text;
}
.dsm-s-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}

/* ── Lazy-load footer / empty / error ─────────────────────────────────────── */
.dsm-s-more {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.dsm-s-count {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsm-s-sentinel {
  width: 100%;
  height: 1px;
}
.dsm-s-more-btn {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  padding: 4px 12px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsm-s-more-btn:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsm-s-more-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsm-s-empty {
  margin: 24px 0;
  text-align: center;
  font-size: 13px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary);
}
.dsm-s-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
`

const cls = {
  section: 'dsm-s-section',
  title: 'dsm-s-title',
  intro: 'dsm-s-intro',
  dash: 'dsm-s-dash',
  stat: 'dsm-s-stat',
  statValue: 'dsm-s-stat-value',
  statValueMuted: 'dsm-s-stat-value-muted',
  statLabel: 'dsm-s-stat-label',
  statStale: 'dsm-s-stat-stale',
  toolbar: 'dsm-s-toolbar',
  toolbarRow: 'dsm-s-toolbar-row',
  toolbarLabel: 'dsm-s-toolbar-label',
  seg: 'dsm-s-seg',
  segBtn: 'dsm-s-seg-btn',
  tabs: 'dsm-s-tabs',
  tabBtn: 'dsm-s-tab-btn',
  input: 'dsm-s-input',
  select: 'dsm-s-select',
  chip: 'dsm-s-chip',
  list: 'dsm-s-list',
  row: 'dsm-s-row',
  rowStale: 'dsm-s-row-stale',
  badges: 'dsm-s-badges',
  badge: 'dsm-s-badge',
  badgePinned: 'dsm-s-badge-pinned',
  badgeStale: 'dsm-s-badge-stale',
  project: 'dsm-s-project',
  content: 'dsm-s-content',
  contentOpen: 'dsm-s-content-open',
  meta: 'dsm-s-meta',
  more: 'dsm-s-more',
  count: 'dsm-s-count',
  sentinel: 'dsm-s-sentinel',
  moreBtn: 'dsm-s-more-btn',
  empty: 'dsm-s-empty',
  error: 'dsm-s-error',
} as const

let injected = false

function inject(): void {
  if (injected || typeof document === 'undefined') return
  const style = document.createElement('style')
  style.setAttribute('data-dsh-memory', 'section')
  style.textContent = RULES
  document.head.appendChild(style)
  injected = true
}

/** Stable class-name map (bare suffix, no dot). Styles inject on first import. */
export const css = (inject(), cls)
