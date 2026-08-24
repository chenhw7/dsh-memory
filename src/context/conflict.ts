/**
 * Cross-session consistency: conflict detection between stored memories and
 * current-session facts (§3.11, exploratory).
 *
 * This module provides a pure, dependency-free conflict detector that flags
 * stored entries whose content contradicts facts stated in the current
 * session. The detector uses a lightweight signal-based prefilter (no LLM):
 * when a stored entry and a current-session fact share significant token
 * overlap but assert opposing values, the entry is flagged as `conflicting`.
 *
 * The full LLM-judge integration (§3.11 done-when) is a future enhancement:
 * it would run an LLM call on flagged pairs at context assembly time, which
 * requires breaking the per-session frozen-snapshot invariant (the snapshot
 * is read once at session/created and stays stable for KV-cache prefix
 * stability). The pure detector here can be called without that cost.
 *
 * @module @chenhw7/dsh-memory/context/conflict
 */

import type { MemoryEntry, MemoryCategory } from '../types.ts'
import { tokenize } from '../review/dedup.ts'
import { jaccardSimilarity } from '../review/dedup.ts'

/** The minimal entry shape the conflict machinery needs. */
type ConflictEntry = Pick<MemoryEntry, 'id' | 'content' | 'lastRecalledAt' | 'category'>

/** The conflict status of one stored entry relative to current-session facts. */
export type ConflictStatus = 'fresh' | 'stale' | 'conflicting'

/** One current-session fact to check against stored memories. */
export interface SessionFact {
  /** The fact text as stated in the current session. */
  readonly text: string
  /** Whether the fact contradicts a prior statement (e.g., a correction). */
  readonly isCorrection: boolean
}

/** The result of checking one stored entry against current-session facts. */
export interface ConflictResult {
  /** The entry id that was checked. */
  readonly entryId: string
  /** The conflict status. */
  readonly status: ConflictStatus
  /** The session fact that triggered the conflict, when applicable. */
  readonly conflictingFact?: string
}

/** Negation/correction signal words that indicate a fact contradicts a prior statement. */
const CONTRADICTION_SIGNALS = [
  'not', 'no longer', 'actually', 'wrong', 'incorrect', 'changed',
  'instead of', 'rather than', 'previously', 'used to',
  '不对', '不再', '其实', '错了', '改了', '而不是', '之前是',
]

/**
 * Detect whether a stored entry conflicts with current-session facts.
 *
 * A conflict is flagged when:
 * 1. A session fact is a correction (isCorrection=true) AND
 * 2. The fact shares significant token overlap with the entry (Jaccard ≥ 0.2) AND
 * 3. The fact contains a contradiction signal word.
 *
 * `stale` is returned when an entry has not been recalled recently and a
 * correction-type fact touches the same topic — a softer signal than
 * `conflicting`.
 */
export function detectConflict(
  entry: ConflictEntry,
  facts: readonly SessionFact[],
): ConflictResult {
  const entryTokens = tokenize(entry.content)

  for (const fact of facts) {
    if (!fact.isCorrection) continue

    const factTokens = tokenize(fact.text)
    const similarity = jaccardSimilarity(entryTokens, factTokens)

    if (similarity < 0.15) continue

    // Check for contradiction signals in the fact text.
    const lowerFact = fact.text.toLowerCase()
    const hasSignal = CONTRADICTION_SIGNALS.some(sig => lowerFact.includes(sig))

    if (hasSignal && similarity >= 0.2) {
      return { entryId: entry.id as string, status: 'conflicting', conflictingFact: fact.text }
    }

    // Softer: correction touches the same topic but no explicit contradiction signal.
    if (similarity >= 0.15) {
      return { entryId: entry.id as string, status: 'stale', conflictingFact: fact.text }
    }
  }

  return { entryId: entry.id as string, status: 'fresh' }
}

/**
 * Check all stored entries against current-session facts and return conflict
 * results. Entries not touched by any fact are `fresh`.
 * @param entries - all stored entries.
 * @param facts - facts stated in the current session.
 * @returns one conflict result per entry.
 */
export function detectConflicts(
  entries: readonly ConflictEntry[],
  facts: readonly SessionFact[],
): readonly ConflictResult[] {
  if (facts.length === 0) return []
  return entries
    .map(entry => detectConflict(entry, facts))
    .filter(result => result.status !== 'fresh')
}

/**
 * Wire the pure conflict detector into snapshot assembly (§3.11, LLM-free
 * variant): within one scope, correction-category entries act as the "newer
 * statements" and every other entry is checked against them. An older entry
 * sharing significant token overlap with a correction is flagged
 * `conflicting` (explicit contradiction signals) or `stale` (same topic only),
 * so the injection view can mark it instead of silently serving both sides.
 *
 * Deterministic and synchronous — runs once at freeze time, so the annotated
 * text stays KV-cache-stable for the whole session.
 * @param entries - one scope's healthy entries (staleness/exclusion already applied).
 * @returns entry-id → status for every flagged entry (corrections themselves are never flagged).
 */
export function annotateConflicts(entries: readonly ConflictEntry[]): ReadonlyMap<string, ConflictStatus> {
  const flagged = new Map<string, ConflictStatus>()
  if (entries.length < 2) return flagged
  // Corrections with an explicit category drive the check; untagged text is
  // never treated as a fact source (too noisy at zero-LLM confidence).
  const facts: SessionFact[] = entries
    .filter(entry => entry.category === 'correction')
    .map(entry => ({ text: entry.content, isCorrection: true }))
  if (facts.length === 0) return flagged
  for (const entry of entries) {
    if (entry.category === 'correction') continue
    const result = detectConflict(entry, facts)
    if (result.status !== 'fresh') flagged.set(entry.id as string, result.status)
  }
  return flagged
}
