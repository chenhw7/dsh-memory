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
