/**
 * Cross-session consistency: conflict detection between stored memories and
 * current-session facts (§3.11, exploratory).
 *
 * This module provides a pure conflict detector that flags stored entries
 * whose content contradicts facts stated in the current session. The detector
 * uses a lightweight signal-based prefilter (no LLM): when a stored entry and
 * a current-session fact share significant weighted token overlap (the shared
 * bm25 tokenizer and IDF weighting) but assert opposing values, the entry is
 * flagged as `conflicting`.
 *
 * The full LLM-judge integration (§3.11 done-when) is a future enhancement:
 * it would run an LLM call on flagged pairs at context assembly time, which
 * requires breaking the per-session frozen-snapshot invariant (the snapshot
 * is read once at session/created and stays stable for KV-cache prefix
 * stability). The pure detector here can be called without that cost.
 *
 * @module @chenhw7/dsh-memory/context/conflict
 */

import type { MemoryEntry } from '../types.ts'
import { buildCorpusStats, uniqueTokens, weightedOverlapSimilarity } from '../store/bm25.ts'

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
 * IDF-weighted overlap at or above which a correction fact counts as touching
 * the entry's topic (`stale` floor). Measured on the two-text corpus the
 * detector builds (tests/conflict.spec.ts pins the pairs): a same-topic
 * rewrite scores 0.21–0.44, the 「上海/海南」-class distractor pairs ~0.06, and
 * a correction naming the replaced value (`npm` for `pnpm`) 0.11–0.13 — the
 * corpus IDF downweights the shared frame, which used to float unrelated
 * template pairs to the same Jaccard band as real rewrites. 0.1 keeps every
 * same-topic pair and every replace-value correction above the line while
 * distractor pairs stay ~2× below it. The old no-IDF Jaccard line was 0.15.
 */
const CONFLICT_STALE_THRESHOLD = 0.1

/**
 * IDF-weighted overlap at or above which an overlap plus an explicit
 * contradiction signal word flags a hard `conflicting`. Set equal to the
 * stale line: on the IDF metric the old 0.2-separation between the two
 * statuses inverted — the strongest old `conflicting` pairs (a correction
 * that REPLACES a value, e.g. `npm`→`pnpm`) now score 0.11–0.13, BELOW the
 * bare-topic `stale` pairs at 0.21–0.44, because the corpus IDF downweights
 * the shared frame those pairs repeat. Requiring a higher overlap for
 * `conflicting` than for `stale` would therefore invert the semantics
 * (value-replacing corrections read as `stale`, bare rewrites as
 * `conflicting`); the signal word is already the discriminating evidence,
 * so the status split rides on it alone. The old no-IDF Jaccard line was 0.2.
 */
const CONFLICT_CONTRADICTION_THRESHOLD = 0.1

/**
 * Detect whether a stored entry conflicts with current-session facts.
 *
 * A conflict is flagged when:
 * 1. A session fact is a correction (isCorrection=true) AND
 * 2. The fact's IDF-weighted token overlap with the entry is at least
 *    {@link CONFLICT_STALE_THRESHOLD} AND
 * 3. The fact contains a contradiction signal word with overlap at least
 *    {@link CONFLICT_CONTRADICTION_THRESHOLD} (hard `conflicting`), or the
 *    overlap alone is enough for the softer same-topic `stale`.
 */
export function detectConflict(
  entry: ConflictEntry,
  facts: readonly SessionFact[],
): ConflictResult {
  const entryTokens = uniqueTokens(entry.content)

  for (const fact of facts) {
    if (!fact.isCorrection) continue

    const factTokens = uniqueTokens(fact.text)
    // The entry + its facts form the corpus: IDF downweights function words
    // shared by every pair, content words carry the similarity.
    const stats = buildCorpusStats([entry.content, ...facts.map(f => f.text)])
    const similarity = weightedOverlapSimilarity(stats, entryTokens, factTokens)

    if (similarity < CONFLICT_STALE_THRESHOLD) continue

    // Check for contradiction signals in the fact text.
    const lowerFact = fact.text.toLowerCase()
    const hasSignal = CONTRADICTION_SIGNALS.some(sig => lowerFact.includes(sig))

    if (hasSignal && similarity >= CONFLICT_CONTRADICTION_THRESHOLD) {
      return { entryId: entry.id as string, status: 'conflicting', conflictingFact: fact.text }
    }

    // Softer: correction touches the same topic but no explicit contradiction signal.
    return { entryId: entry.id as string, status: 'stale', conflictingFact: fact.text }
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
