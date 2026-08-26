/** Branded id factory for memory entries. @module @chenhw7/dsh-memory/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'
import { randomUUID } from 'node:crypto'

/** Identifies one memory entry across its revisions. */
export type MemoryId = Branded<'MemoryId'>

/**
 * Mint a new unique memory id.
 * @returns a fresh branded id.
 */
export function MemoryId(id: string = randomUUID()): MemoryId {
  return id as MemoryId
}

/** Identifies one audit-record entry in the audit table. */
export type AuditId = Branded<'AuditId'>

/**
 * Mint a new unique audit id.
 * @returns a fresh branded id.
 */
export function AuditId(id: string = randomUUID()): AuditId {
  return id as AuditId
}

/**
 * Identifies one pending memory suggestion in the review queue (P1-1 optional
 * human-confirm mode). Separate from {@link MemoryId}: a suggestion is a
 * proposal, not yet a memory.
 */
export type SuggestionId = Branded<'SuggestionId'>

/**
 * Mint a new unique suggestion id.
 * @returns a fresh branded id.
 */
export function SuggestionId(id: string = randomUUID()): SuggestionId {
  return id as SuggestionId
}
