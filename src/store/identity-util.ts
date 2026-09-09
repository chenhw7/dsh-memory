/**
 * Pure identity-record transition shared by all storage backends.
 *
 * @module @chenhw7/dsh-memory/store/identity-util
 */

import type { IdentityKind, IdentityRecord, UpdateIdentityInput } from '../types.js'

/**
 * Compute the next identity record: version = current + 1 (or 1 on the first
 * write), with `seedVersion` remaining sticky after creation.
 */
export function nextIdentityRecord(
  current: IdentityRecord | undefined,
  kind: IdentityKind,
  content: string,
  input: UpdateIdentityInput,
  now: number,
): IdentityRecord {
  return {
    kind,
    content,
    version: (current?.version ?? 0) + 1,
    updatedAt: now,
    seedVersion: current?.seedVersion ?? input.seedVersion ?? 1,
  }
}
