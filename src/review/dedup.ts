/**
 * Deduplication prefilter for the extraction path. A cheap, embedding-free
 * IDF-weighted token-overlap check that runs before `add`: when a new
 * candidate is near-duplicate to an existing entry, the caller merges (update)
 * instead of creating a new entry.
 *
 * The comparison shares the retrieval plane's tokenizer
 * ({@link tokenizeForSearch}: Latin words; CJK unigrams + adjacent bigrams)
 * and weights shared tokens by corpus IDF — high-frequency function words
 * weigh ~0 and content words weigh full, so unrelated pairs that share only
 * sentence structure stay apart without any hand-maintained stop-word table.
 *
 * This module is pure and dependency-free — it operates on strings and
 * returned entry shapes, never touching the store or the LLM.
 *
 * @module @chenhw7/dsh-memory/review/dedup
 */

import type { MemoryEntry } from '../types.ts'
import { buildCorpusStats, uniqueTokens, weightedOverlapSimilarity } from '../store/bm25.ts'

/**
 * Overlap similarity above which two same-scope entries count as
 * near-duplicates. Calibrated on the IDF-weighted metric with the candidate
 * list itself as corpus (tests/dedup.spec.ts pins the pairs): true rewrites
 * of one fact score 0.14–0.20, while the 「上海/海南」-class distractor pairs
 * stay at ~0.06 and same-template-unrelated pairs ≤ ~0.09 — an order of
 * magnitude below the true-duplicate band, because corpus IDF downweights the
 * shared function characters that used to inflate the no-IDF Jaccard. 0.15
 * keeps the whole true-duplicate band above the line with ~2× margin over
 * the distractor band. The old no-IDF Jaccard also used 0.15, but with far
 * less separation — the two bands overlapped there.
 */
export const DEDUP_SIMILARITY_THRESHOLD = 0.15

/** One existing entry projected to the fields the dedup prefilter needs. */
export interface DedupCandidate {
  readonly id: string
  readonly scope: string
  readonly content: string
}

/**
 * Find the best near-duplicate among existing entries for a new candidate.
 * Returns the matching entry id when the IDF-weighted overlap exceeds the
 * threshold, or `undefined` when no existing entry is close enough (a
 * genuine new memory).
 *
 * Only entries in the *same scope* are compared — a project convention and a
 * user preference are never duplicates even if they share words.
 *
 * @param candidateContent - the new memory content to check.
 * @param candidateScope - the scope of the new memory.
 * @param existing - all current entries from the store.
 * @param threshold - weighted-overlap similarity above which two entries are
 *   duplicates (defaults to {@link DEDUP_SIMILARITY_THRESHOLD}).
 * @returns the existing entry id to merge into, or `undefined` for a new entry.
 */
export function findDuplicate(
  candidateContent: string,
  candidateScope: string,
  existing: readonly DedupCandidate[],
  threshold: number = DEDUP_SIMILARITY_THRESHOLD,
): string | undefined {
  if (existing.length === 0) return undefined
  // The candidate list IS the corpus the IDF is measured over — at the
  // prefilter's call sites it is the store's current entries, so per-token
  // weights reflect what actually repeats in memory, and rebuilding the table
  // per call stays O(corpus tokens), the same order as the comparisons below.
  const stats = buildCorpusStats([candidateContent, ...existing.map(entry => entry.content)])
  const candidateTokens = uniqueTokens(candidateContent)
  if (candidateTokens.size === 0) return undefined

  let bestId: string | undefined
  let bestScore = threshold
  for (const entry of existing) {
    if (entry.scope !== candidateScope) continue
    const score = weightedOverlapSimilarity(stats, candidateTokens, uniqueTokens(entry.content))
    if (score > bestScore) {
      bestScore = score
      bestId = entry.id
    }
  }
  return bestId
}

/**
 * Upper bound on merged content produced by {@link mergeContent}. Past this
 * cap the merge falls back to keeping the longer side instead of appending,
 * so repeated near-duplicate merges can never grow an entry without bound.
 * True re-summarization of oversized entries belongs to the curator pass.
 */
export const MERGE_CHAR_LIMIT = 600

/**
 * Merge two memory contents into one. When the new content is a strict
 * superset (contains the old text as a substring), the longer content wins
 * outright. Otherwise, append the new content as an addendum so no
 * information is lost — unless the concatenation would exceed `maxChars`,
 * in which case the longer side wins instead, bounding entry growth while
 * staying deterministic and LLM-free.
 *
 * @param oldContent - the stored content.
 * @param newContent - the incoming candidate content.
 * @param maxChars - upper bound for the concatenated form (default {@link MERGE_CHAR_LIMIT}).
 */
export function mergeContent(oldContent: string, newContent: string, maxChars: number = MERGE_CHAR_LIMIT): string {
  if (oldContent.includes(newContent) || newContent.includes(oldContent)) {
    return newContent.length >= oldContent.length ? newContent : oldContent
  }
  const merged = `${oldContent} ${newContent}`
  if (merged.length <= maxChars) return merged
  // Over the cap: prefer the more informative side rather than growing forever.
  return newContent.length >= oldContent.length ? newContent : oldContent
}

/**
 * Project a MemoryEntry to the minimal shape findDuplicate needs.
 */
export function toDedupCandidate(entry: MemoryEntry): DedupCandidate {
  return { id: entry.id as string, scope: entry.scope, content: entry.content }
}

// ─── LLM Judge (§3.4 enhancement) ──────────────────────────────────────────

/** The LLM judge's verdict for a prefilter-flagged pair. */
export type JudgeVerdict = 'duplicate' | 'update' | 'new'

/** System prompt for the dedup judge — minimal, one-word output protocol. */
export const JUDGE_SYSTEM_PROMPT =
  'You are a memory dedup judge. Given an existing memory entry and a new candidate, decide:'
  + '\n- "duplicate": the new candidate restates the same fact as the existing entry (different wording, same meaning). The existing entry should be kept.'
  + '\n- "update": the new candidate is a correction or more precise version of the existing entry. The new content should replace the old.'
  + '\n- "new": the new candidate is a genuinely different fact that happens to share words with the existing entry. Both should be kept as separate entries.'
  + '\n\nOutput exactly one word: duplicate, update, or new. Output nothing else.'

/**
 * Build the user message for the dedup judge: present the existing entry
 * content and the new candidate content side by side.
 * @param existingContent - the current stored entry's content.
 * @param newContent - the new candidate content flagged by the prefilter.
 * @returns the model-facing user message text.
 */
export function buildJudgePrompt(existingContent: string, newContent: string): string {
  return `Existing memory:\n${existingContent}\n\nNew candidate:\n${newContent}`
}

/**
 * Parse the judge's one-line output into a verdict. Strict: lowercases, trims,
 * and matches against the three valid words. Defaults to `duplicate` on
 * anything unrecognized (the safe fallback — merge rather than create a
 * spurious duplicate).
 * @param text - the raw model output.
 * @returns the verdict.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const word = text.trim().toLowerCase()
  if (word === 'update') return 'update'
  if (word === 'new') return 'new'
  return 'duplicate'
}
