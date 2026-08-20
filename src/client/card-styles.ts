/**
 * Scoped CSS for the memory plugin card. Injected once as a single
 * `<style>` element; class names are prefixed `dsm-c-` to avoid collisions.
 *
 * The rules are a line-by-line port of the deployment's own plugin-card CSS
 * (PluginCard.module.css + fields.module.css from ui-settings-plugins) and
 * reuse the same `--dsw-alias-*` design tokens, so the card is visually
 * indistinguishable from the Shell / Agent loop / Web search cards. select,
 * checkbox, and textarea — which the deployment's cards do not use — are
 * styled to match the `.input` control so every field shares one look.
 */

const RULES = `
/* ── Card shell (port of PluginCard.module.css) ─────────────────────────── */
.dsm-c-card {
  list-style: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.dsm-c-card:hover {
  border-color: var(--dsw-alias-label-dimmed);
}
.dsm-c-card-open {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsm-c-header {
  width: 100%;
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
}
.dsm-c-header:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dsm-c-head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsm-c-name {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.dsm-c-description {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsm-c-pending {
  flex: none;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsm-c-chevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform .16s;
}
.dsm-c-chevron-open {
  transform: rotate(180deg);
}
.dsm-c-body {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding-bottom: 8px;
}
.dsm-c-read-only {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsm-c-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsm-c-failed {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
.dsm-c-discard,
.dsm-c-save {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
.dsm-c-discard {
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.dsm-c-discard:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsm-c-save {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.dsm-c-discard:disabled,
.dsm-c-save:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsm-c-discard:focus-visible,
.dsm-c-save:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

/* ── Fields (port of fields.module.css) ─────────────────────────────────── */
.dsm-c-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.dsm-c-field + .dsm-c-field {
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsm-c-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsm-c-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsm-c-badges {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.dsm-c-badge {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  font-weight: 500;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsm-c-badge-muted {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
}
.dsm-c-reset {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsm-c-reset:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
.dsm-c-reset:disabled {
  cursor: default;
}

/* Shared input control look (fields.module.css .input). */
.dsm-c-input {
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
.dsm-c-input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsm-c-input:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
/* inputInvalid mirrors .input with an error border (composes: input in host). */
.dsm-c-input-invalid {
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-label-error);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsm-c-input-invalid:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-label-error);
}
.dsm-c-input-invalid:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}

/* select mirrors .input; native arrow kept via appearance. */
.dsm-c-select {
  height: 34px;
  padding: 0 28px 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
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
.dsm-c-select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsm-c-select:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}

/* textarea mirrors .input borders, multi-line sizing. */
.dsm-c-textarea {
  min-height: 80px;
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  resize: vertical;
}
.dsm-c-textarea:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsm-c-textarea:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}

/* A checkbox row: the box and its label sit on the head line so the override
   badge + reset stay right-aligned exactly as the text fields do. */
.dsm-c-check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.dsm-c-checkbox {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.dsm-c-checkbox:disabled {
  cursor: default;
}
.dsm-c-check-label {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.dsm-c-check-label:disabled,
.dsm-c-checkbox:disabled + .dsm-c-check-label {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}

.dsm-c-invalid {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
.dsm-c-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
`

let injected = false

function inject(): void {
  if (injected || typeof document === 'undefined') return
  const style = document.createElement('style')
  style.setAttribute('data-dsh-memory', 'plugin-card')
  style.textContent = RULES
  document.head.appendChild(style)
  injected = true
}

/** Stable class-name map (bare suffix, no dot). */
const cls = {
  // Card shell (PluginCard.module.css).
  card: 'dsm-c-card',
  cardOpen: 'dsm-c-card-open',
  header: 'dsm-c-header',
  headText: 'dsm-c-head-text',
  name: 'dsm-c-name',
  description: 'dsm-c-description',
  pending: 'dsm-c-pending',
  chevron: 'dsm-c-chevron',
  chevronOpen: 'dsm-c-chevron-open',
  body: 'dsm-c-body',
  readOnly: 'dsm-c-read-only',
  footer: 'dsm-c-footer',
  failed: 'dsm-c-failed',
  discard: 'dsm-c-discard',
  save: 'dsm-c-save',
  // Fields (fields.module.css).
  field: 'dsm-c-field',
  head: 'dsm-c-head',
  label: 'dsm-c-label',
  badges: 'dsm-c-badges',
  badge: 'dsm-c-badge',
  reset: 'dsm-c-reset',
  input: 'dsm-c-input',
  inputInvalid: 'dsm-c-input-invalid',
  badgeMuted: 'dsm-c-badge-muted',
  select: 'dsm-c-select',
  textarea: 'dsm-c-textarea',
  checkRow: 'dsm-c-check-row',
  checkbox: 'dsm-c-checkbox',
  checkLabel: 'dsm-c-check-label',
  invalid: 'dsm-c-invalid',
  hint: 'dsm-c-hint',
} as const

export const css = (inject(), cls)

