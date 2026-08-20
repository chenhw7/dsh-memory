/**
 * Deduplication prefilter for the extraction path. A cheap, embedding-free
 * normalized-token Jaccard similarity check that runs before `add`: when a new
 * candidate is near-duplicate to an existing entry, the caller merges (update)
 * instead of creating a new entry.
 *
 * This module is pure and dependency-free — it operates on strings and
 * returned entry shapes, never touching the store or the LLM.
 *
 * @module @chenhw7/dsh-memory/review/dedup
 */

import type { MemoryEntry } from '../types.ts'

/**
 * Common English stop words excluded from dedup tokenization. These carry
 * little semantic signal and inflate Jaccard similarity between unrelated
 * short sentences (e.g. "The server is unstable" vs "The tunnel is long"
 * share "the" and "is" but are unrelated). Removing them sharpens the
 * comparison toward content-bearing words.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'or',
  'and', 'not', 'no', 'do', 'does', 'did', 'has', 'have', 'had', 'this',
  'that', 'these', 'those', 'it', 'its', 'but', 'so', 'if', 'then',
])

/**
 * Tokenize content for dedup comparison. Normalizes to lowercase, splits on
 * word boundaries for Latin, and matches CJK per-character. Stop words are
 * removed from Latin tokens; CJK characters are always kept (they carry
 * semantic weight per character). Returns a Set of unique tokens.
 */
export function tokenize(content: string): Set<string> {
  const lowered = content.toLowerCase()
  const tokens = new Set<string>()
  const re = /[a-z0-9]+|[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(lowered)) !== null) {
    const token = match[0]
    // Only filter Latin tokens; CJK characters are always content-bearing.
    if (token.length > 1 && STOP_WORDS.has(token)) continue
    if (token.length === 1 && /[a-z0-9]/.test(token)) continue
    tokens.add(token)
  }
  return tokens
}

/**
 * Jaccard similarity between two token sets: |A ∩ B| / |A ∪ B|.
 * Returns 0 when both sets are empty (no meaningful overlap), 1 when identical.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** One existing entry projected to the fields the dedup prefilter needs. */
export interface DedupCandidate {
  readonly id: string
  readonly scope: string
  readonly content: string
}

/**
 * Find the best near-duplicate among existing entries for a new candidate.
 * Returns the matching entry id when similarity exceeds the threshold, or
 * `undefined` when no existing entry is close enough (a genuine new memory).
 *
 * Only entries in the *same scope* are compared — a project convention and a
 * user preference are never duplicates even if they share words.
 *
 * @param candidateContent - the new memory content to check.
 * @param candidateScope - the scope of the new memory.
 * @param existing - all current entries from the store.
 * @param threshold - Jaccard similarity above which two entries are duplicates.
 * @returns the existing entry id to merge into, or `undefined` for a new entry.
 */
export function findDuplicate(
  candidateContent: string,
  candidateScope: string,
  existing: readonly DedupCandidate[],
  threshold: number = 0.15,
): string | undefined {
  const candidateTokens = tokenize(candidateContent)
  if (candidateTokens.size === 0) return undefined

  let bestId: string | undefined
  let bestScore = threshold
  for (const entry of existing) {
    if (entry.scope !== candidateScope) continue
    const score = jaccardSimilarity(candidateTokens, tokenize(entry.content))
    if (score > bestScore) {
      bestScore = score
      bestId = entry.id
    }
  }
  return bestId
}

/**
 * Merge two memory contents into one. When the new content is a strict
 * superset (contains the old text as a substring), the new content wins
 * outright. Otherwise, append the new content as an addendum so no
 * information is lost.
 */
export function mergeContent(oldContent: string, newContent: string): string {
  if (oldContent.includes(newContent) || newContent.includes(oldContent)) {
    return newContent.length >= oldContent.length ? newContent : oldContent
  }
  return `${oldContent} ${newContent}`
}

/**
 * Project a MemoryEntry to the minimal shape findDuplicate needs.
 */
export function toDedupCandidate(entry: MemoryEntry): DedupCandidate {
  return { id: entry.id as string, scope: entry.scope, content: entry.content }
}
