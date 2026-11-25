/**
 * Shared plumbing for the settings page: subscribe one entry's configuration
 * form, read override state, and submit a staged draft as one revision-fenced
 * mutation.
 *
 * The host hands a plugin page its entry's form (or, for a bundle page, the
 * `ctx.configForms` service the page resolves each entry from), so every
 * memory settings section works off the same small surface instead of a
 * per-namespace transport of its own.
 *
 * @module @chenhw7/dsh-memory/client/form
 */

import { useSyncExternalStore } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** One entry's wire section: every field optional until the schema resolves it. */
export type FormSection = Record<string, unknown>

/** The config form of one memory entry. */
export type EntryForm = ConfigForm<FormSection>

/** The snapshot of one entry's form. */
export type EntrySnapshot = ConfigFormSnapshot<FormSection>

/**
 * Subscribe one entry form's snapshot. The host keeps the snapshot reference
 * stable until the next change, which is exactly the identity contract
 * `useSyncExternalStore` needs.
 * @param form - the entry's config form.
 * @returns the current snapshot, re-rendering on each replacement.
 */
export function useFormSnapshot(form: EntryForm): EntrySnapshot {
  return useSyncExternalStore(
    listener => form.subscribe(listener),
    () => form.getSnapshot(),
  )
}

/** A field is overridden when the user layer carries it (presence, not value). */
export function isOverridden(snapshot: EntrySnapshot, field: string): boolean {
  const user = snapshot.user
  if (user === undefined || user === null || typeof user !== 'object') return false
  return Object.prototype.hasOwnProperty.call(user, field)
}

/**
 * Submit every changed field of one section as ONE mutation: the page's
 * revision fence, Host validation, and recovery read then apply to the whole
 * edit set instead of one field at a time.
 * @param form - the entry's config form.
 * @param draft - the staged section.
 * @param committed - the section the draft was staged from.
 * @returns whether the Host accepted the write (false for a refusal).
 */
export async function submitSection(form: EntryForm, draft: FormSection, committed: FormSection): Promise<boolean> {
  const ops: SettingsPathOpView[] = []
  for (const key of Object.keys(draft)) {
    if (draft[key] === committed[key]) continue
    const value = draft[key]
    ops.push(value === undefined
      ? { op: 'unset', path: [key] }
      : { op: 'set', path: [key], value } as SettingsPathOpView)
  }
  if (ops.length === 0) return true
  return form.mutate(ops, form.getSnapshot().revision)
}
