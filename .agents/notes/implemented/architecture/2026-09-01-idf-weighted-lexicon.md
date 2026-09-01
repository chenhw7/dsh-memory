# Agent Note: One tokenizer, IDF-weighted overlap, corpus-level df

Status: implemented

English | [中文](2026-09-01-idf-weighted-lexicon.zh.md)

## Problem

The lexical layer used three unrelated mechanisms for the same job. `dedup.ts` scored candidate pairs with unweighted Jaccard over its own per-character CJK tokenization, and papered over the resulting high-frequency-particle noise with a hand-maintained stop-character list that also damaged real words (dropping 的/用/为-类 particles merged 上海/海南 and 中国/美国 upward). `conflict.ts` reused that Jaccard with fixed thresholds. And the BM25 scorer counted document frequency over the filtered candidate set only — with three candidates, a pure function word drew idf ≈ 0.98 and could reorder results. Same vocabulary, three tokenizers, one of them patched by a stop list.

## Decision

One tokenizer, one weighted metric, corpus-level df:

- **`weightedOverlapSimilarity(stats, a, b)`** in `src/store/bm25.ts`: `Σidf(intersection) / Σidf(union)`, idf from `buildCorpusStats` over the compared texts, tokenization from the shared `tokenizeForSearch` (Latin words + CJK unigrams/bigrams). dedup, conflict, and the suggestion-queue re-observation match all call this one function.
- **`CJK_STOP_CHARS`, `STOP_WORDS`, `tokenize`, `jaccardSimilarity` deleted.** The hand-tuned lists were compensating for the missing IDF; with IDF, 「上海/海南」 and 「中国/美国」 measure ≈0.03 (was 0.5) while true rewrites measure 0.14–0.20 — the separation the stop list tried to buy, without the collateral.
- **`df` scope = whole corpus.** `DomainMemoryStore.search` builds `CorpusStats` over all entries and injects it into `Bm25Index`; the candidate set contributes only tf/length. Function words' weights collapse toward zero regardless of candidate-set size.
- **Thresholds recalibrated by measurement, kept as named constants:** `DEDUP_SIMILARITY_THRESHOLD` 0.15 (unchanged number, new semantics — true rewrites 0.14–0.20 vs distractors ≈0.06); `CONFLICT_STALE_THRESHOLD`/`CONFLICT_CONTRADICTION_THRESHOLD` both 0.1 (IDF weighting inverts the old ordering — replace-value corrections score 0.11–0.13, below bare-topic restatements at 0.21–0.44 — so the conflicting/stale split now rides on the signal words, the stronger discriminator); `SUGGESTION_DUP_THRESHOLD` 0.3.

## Alternatives considered

- **Keep Jaccard, grow the stop-char list.** Rejected: every addition trades recall of real words for metric stability; the IDF weight does the same job with no maintenance.
- **df lower bound only (floor the idf).** Rejected: a floor still assigns function words meaningful weight on tiny candidate sets; corpus-level df drives their contribution to zero at the root.
- **Cache the corpus stats across searches.** Rejected: entry writes would stale the cache; the per-search tokenize pass is the same order as the index build already performed per search.

## Consequences

- Re-framed corrections (a rewrite sharing almost no content words — docker-compose→k8s) measure below the conflict line and are no longer flagged stale; the signal-word path still flags them as conflicting when the wording contradicts. This is the recorded cost of switching metrics; the acceptance pairs the program pinned (上海/海南, 中国/美国) drop ≈16× and the golden floors are untouched (100%/91.7%/0.958).
- Any new similarity consumer must use `weightedOverlapSimilarity` with an explicitly chosen corpus, not roll its own Jaccard — one tokenizer, one metric.
- The four thresholds are calibration constants tied to the measured bands recorded in their comments; retuning requires re-measuring the bands, not editing a number in isolation.
