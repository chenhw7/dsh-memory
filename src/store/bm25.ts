/**
 * Dependency-free BM25 ranking for the memory store's lexical search plane,
 * with CJK-aware tokenization: Latin runs become lowercase word tokens, and
 * each CJK run contributes BOTH per-character unigrams and adjacent-character
 * bigrams — bigrams give Chinese queries word-level precision (记忆 stops
 * matching every entry that merely contains 记) while unigrams keep recall
 * for single-character lookups.
 *
 * The scorer is the classic Okapi BM25 with the non-negative Robertson/Sparck-
 * Jones IDF variant, so a term present in every document still scores ≥ 0 and
 * an all-common-term query cannot go negative.
 *
 * Pure module: strings in, numbers out — no store, host, or LLM imports.
 *
 * @module @chenhw7/dsh-memory/store/bm25
 */

/** BM25 term-frequency saturation parameter. */
const K1 = 1.2

/** BM25 length-normalization parameter (0 = none, 1 = full pivot). */
const B = 0.75

/**
 * Tokenize text for retrieval scoring. Same script split as the legacy
 * tokenizer (Latin runs / CJK runs), upgraded so CJK runs emit unigrams plus
 * adjacent bigrams instead of unigrams alone.
 * @param text - the raw document or query text.
 * @returns the token bag (with duplicates; frequency matters to BM25).
 */
export function tokenizeForSearch(text: string): string[] {
  const lowered = text.toLowerCase()
  const tokens: string[] = []
  // Latin word runs OR CJK runs (Hiragana/Katakana/CJK/Hangul).
  const re = /[a-z0-9]+|[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af]+/g
  let match: RegExpExecArray | null
  while ((match = re.exec(lowered)) !== null) {
    const run = match[0]
    if (!/[\u3040-\u30ff\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af]/.test(run)) {
      // Pure Latin/alphanumeric run → one word token.
      tokens.push(run)
      continue
    }
    // CJK run → unigrams + adjacent bigrams.
    const chars = Array.from(run)
    for (const ch of chars) tokens.push(ch)
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i]! + chars[i + 1]!)
  }
  return tokens
}

/** One indexed document: its token bag and length. */
interface Bm25Doc {
  /** Token bag WITH duplicates (term frequency source). */
  readonly tf: Map<string, number>
  /** Total token count (= Σ tf values). */
  readonly length: number
}

/**
 * A prebuilt BM25 index over a fixed document set. Build once per search call;
 * at the store's target scale (tens–hundreds of short entries) construction is
 * negligible next to the O(n·q) scoring it enables.
 */
export class Bm25Index {
  private readonly docs: readonly Bm25Doc[]
  private readonly avgLength: number

  /**
   * Build the index from one token array per document, in document order.
   * @param docsTokens - token bags (with duplicates) per document.
   */
  constructor(docsTokens: readonly (readonly string[])[]) {
    this.docs = docsTokens.map(tokens => {
      const tf = new Map<string, number>()
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
      return { tf, length: tokens.length }
    })
    const total = this.docs.reduce((sum, d) => sum + d.length, 0)
    this.avgLength = this.docs.length === 0 ? 0 : total / this.docs.length
  }

  /**
   * Score every document against the query tokens.
   * @param queryTokens - tokenized query (duplicates allowed).
   * @returns one BM25 score per document, aligned to constructor order;
   *   0 when neither the query nor the document shares any term.
   */
  scores(queryTokens: readonly string[]): number[] {
    if (queryTokens.length === 0 || this.docs.length === 0) {
      return this.docs.map(() => 0)
    }
    // Document frequency per distinct query term.
    const df = new Map<string, number>()
    for (const term of new Set(queryTokens)) {
      let count = 0
      for (const doc of this.docs) {
        if (doc.tf.has(term)) count++
      }
      df.set(term, count)
    }
    const n = this.docs.length
    const avg = this.avgLength
    return this.docs.map(doc => {
      let score = 0
      for (const term of new Set(queryTokens)) {
        const freq = doc.tf.get(term)
        if (freq === undefined) continue
        const occurrences = df.get(term) ?? 0
        // Non-negative IDF: a term in every document contributes ~0, never < 0.
        const idf = Math.log(1 + (n - occurrences + 0.5) / (occurrences + 0.5))
        const norm = freq * (K1 + 1) / (freq + K1 * (1 - B + B * (avg === 0 ? 0 : doc.length / avg)))
        score += idf * norm
      }
      return score
    })
  }
}

/** Convenience: tokenize then score in one step over raw texts. */
export function rankTexts(query: string, texts: readonly string[]): number[] {
  const index = new Bm25Index(texts.map(text => tokenizeForSearch(text)))
  return index.scores(tokenizeForSearch(query))
}
