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
 * Document frequencies over a fixed corpus, shared by {@link Bm25Index} and
 * the dedup/conflict weighted-overlap similarity. Built from the FULL corpus
 * (e.g. every entry in the store) rather than the handful of documents one
 * call happens to score: when the df base is the per-call candidate set, a
 * candidate pool of 3 entries lets a pure function word that appears in one
 * of them earn the same IDF as a genuinely distinctive term, and the ranking
 * noise dominates real signal at small pool sizes. Pure data — no caching,
 * no cross-call state; callers rebuild it per search at the store's target
 * scale (tens–hundreds of short entries), which is the same order as the
 * tokenization the index build already does.
 */
export class CorpusStats {
  /** Number of documents the frequencies were measured over. */
  readonly documentCount: number
  private readonly df: Map<string, number>

  /**
   * Build the frequency table from one token array per document.
   * @param docsTokens - token bags (with duplicates) per document; a term
   *   counts once per document regardless of its frequency inside it.
   */
  constructor(docsTokens: readonly (readonly string[])[]) {
    this.documentCount = docsTokens.length
    this.df = new Map()
    for (const tokens of docsTokens) {
      for (const term of new Set(tokens)) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1)
      }
    }
  }

  /** Documents (0–{@link documentCount}) containing the term. */
  documentFrequency(term: string): number {
    return this.df.get(term) ?? 0
  }
}

/** Convenience: build {@link CorpusStats} directly from raw texts. */
export function buildCorpusStats(texts: readonly string[]): CorpusStats {
  return new CorpusStats(texts.map(text => tokenizeForSearch(text)))
}

/**
 * The non-negative Robertson/Sparck-Jones IDF over a df table. A term present
 * in every measured document still contributes a small positive weight, never
 * a negative one — the same guarantee the index scorer relies on.
 * @param stats - the df table to measure against.
 * @param term - the term to weight.
 */
export function idfOf(stats: CorpusStats, term: string): number {
  const df = stats.documentFrequency(term)
  return Math.log(1 + (stats.documentCount - df + 0.5) / (df + 0.5))
}

/**
 * Unique-token set for pairwise similarity: the shared {@link tokenizeForSearch}
 * vocabulary (Latin words; CJK unigrams + bigrams) with duplicates collapsed —
 * overlap similarity is a set notion; only BM25 term-frequency scoring wants
 * the bag.
 */
export function uniqueTokens(text: string): Set<string> {
  return new Set(tokenizeForSearch(text))
}

/**
 * IDF-weighted overlap similarity between two token sets: Σ idf over shared
 * tokens ÷ Σ idf over the union. The IDF weighting (measured on the caller's
 * {@link CorpusStats}) is what keeps unrelated pairs apart WITHOUT a stop-word
 * table: a function word shared by the pair but common across the corpus
 * weighs ~0, while a content bigram shared only by the pair weighs full.
 * Returns 0 when both sets are empty, and approaches 1 as the sets coincide.
 */
export function weightedOverlapSimilarity(
  stats: CorpusStats,
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  let union = 0
  for (const token of a) {
    const w = idfOf(stats, token)
    union += w
    if (b.has(token)) intersection += w
  }
  for (const token of b) {
    if (!a.has(token)) union += idfOf(stats, token)
  }
  return union === 0 ? 0 : intersection / union
}

/**
 * A prebuilt BM25 index over a fixed document set. Build once per search call;
 * at the store's target scale (tens–hundreds of short entries) construction is
 * negligible next to the O(n·q) scoring it enables.
 */
export class Bm25Index {
  private readonly docs: readonly Bm25Doc[]
  private readonly avgLength: number
  private readonly stats: CorpusStats

  /**
   * Build the index from one token array per document, in document order.
   * @param docsTokens - token bags (with duplicates) per document.
   * @param corpusStats - optional df table measured over the FULL corpus; when
   *   omitted the df is measured over exactly these documents (correct for
   *   ad-hoc scoring, but see {@link CorpusStats} for why store search passes
   *   a full-corpus table instead).
   */
  constructor(docsTokens: readonly (readonly string[])[], corpusStats?: CorpusStats) {
    this.docs = docsTokens.map(tokens => {
      const tf = new Map<string, number>()
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
      return { tf, length: tokens.length }
    })
    const total = this.docs.reduce((sum, d) => sum + d.length, 0)
    this.avgLength = this.docs.length === 0 ? 0 : total / this.docs.length
    this.stats = corpusStats ?? new CorpusStats(docsTokens)
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
    const n = this.docs.length
    const avg = this.avgLength
    return this.docs.map(doc => {
      let score = 0
      for (const term of new Set(queryTokens)) {
        const freq = doc.tf.get(term)
        if (freq === undefined) continue
        const idf = idfOf(this.stats, term)
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
