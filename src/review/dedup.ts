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
 * Common CJK (Chinese) stop characters excluded from dedup tokenization.
 * These are high-frequency grammatical particles and structural words that
 * inflate Jaccard similarity between unrelated Chinese sentences (e.g.
 * "这个项目使用pnpm" vs "这个项目使用vitest" share 这/个/项/目/使/用 = 0.75,
 * but are about different tools). Removing them sharpens comparison toward
 * content-bearing characters.
 */
const CJK_STOP_CHARS = new Set([
  // 结构词：这个、那、些
  '这', '个', '那', '些',
  // 助词
  '的', '了', '着', '过', '地', '得',
  // 判断/系词
  '是', '在', '为',
  // 介词/连词
  '和', '与', '或', '但', '而', '由', '于', '对', '向', '从', '把', '被', '将',
  // 否定/副词
  '不', '没', '也', '都', '就', '还', '只', '才', '已', '再',
  // 动词虚化高频
  '用', '有', '会', '能', '要', '可', '以',
  // 量词/代词高频
  '一', '上', '下', '中',
])

/**
 * Tokenize content for dedup comparison. Normalizes to lowercase, splits on
 * word boundaries for Latin, and matches CJK per-character. English stop words
 * are removed from Latin tokens; CJK stop characters (high-frequency
 * grammatical particles) are removed from CJK tokens so unrelated Chinese
 * sentences don't share too many tokens. Returns a Set of unique tokens.
 */
export function tokenize(content: string): Set<string> {
  const lowered = content.toLowerCase()
  const tokens = new Set<string>()
  const re = /[a-z0-9]+|[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(lowered)) !== null) {
    const token = match[0]
    // Filter English stop words from Latin tokens.
    if (token.length > 1 && STOP_WORDS.has(token)) continue
    if (token.length === 1 && /[a-z0-9]/.test(token)) continue
    // Filter CJK stop characters (high-frequency grammatical particles).
    if (CJK_STOP_CHARS.has(token)) continue
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
