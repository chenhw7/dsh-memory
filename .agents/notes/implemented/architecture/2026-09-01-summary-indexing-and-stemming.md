# Agent Note: Summaries join the index, Latin inflections stem conservatively, golden set grows to 35

Status: implemented

English | [中文](2026-09-01-summary-indexing-and-stemming.zh.md)

## Problem

The search index tokenized `entry.content` only. A query whose words appeared solely in an entry's `summary` — the human-curated high-signal text written for exactly this purpose — could not find the entry. The tokenizer also had no stemming, so `testing` and `test` were different tokens, and both blind spots shared one root: the golden fixture (24 entries × 24 keyword-style queries) was topically disjoint by construction and could not see either gap. The program's ruling required growing the fixture first so the changes had a measuring stick, and its floors had to survive.

## Decision

Three linked changes:

- **Summary joins the index.** The search index tokenizes content plus summary into one bag (implicit BM25F: summary tokens repeated in content raise tf); corpus statistics and the index share the same bag. The summary is already scanner-gated (`summary-scan`), so no unscanned channel opens.
- **Conservative Latin stemming, length-guarded.** Only long inflections collapse — `testing→test`, `configuring→configur`, `computers→computer` — and only when a ≥5-character stem survives; shorter words wearing suffix letters keep their identity (news, lens, bring, aged, speed, digit runs). CJK unigram/bigram paths are untouched. The first cut stripped to 2-character stems (`bring→br`, `news→new`) and misread digits; the guard plus the boundary tests below came out of that review.
- **The golden set grows 24 → 35** with a synonym slice (queries whose words live only in summaries, including two bilingual mirror entries) and an inflection slice. All four floors hold unchanged (success@5 ≥ 0.85, MRR ≥ 0.75, P@1 ≥ 0.6, zh ≥ 0.8); the measured baseline moved to success@5 100% / P@1 82.9% / MRR 0.902 — the P@1 dilution is same-topic summary entries entering the candidate set together, recorded in the spec with the pre-change numbers (P@1 91.7% / MRR 0.958 over 24).

## Alternatives considered

- **Explicit BM25F field weighting.** Rejected for now: the merged bag gets most of the effect (summary tokens raise tf) with no new scoring parameters to tune; a field-weighted scorer is a larger change to measure separately.
- **Aggressive (Porter-style) stemming.** Rejected: the first cut's mangling (`bring→br`, `news→new`, `movies→movy`) showed how much damage unguarded suffix stripping does to real vocabulary; the length guard trades a little recall among short words for no identity corruption.
- **Separate summary index with two-phase ranking.** Rejected: two indexes double the per-search cost for no measured benefit over the merged bag.

## Consequences

- The dedup/conflict/suggestion similarity shares the tokenizer, so inflected forms are now near-identical there too (`running ≈ runs`) — accepted drift in the "same memory" direction, verified not to trip any existing threshold test.
- The length guard means singular/plural pairs of short words stay distinct tokens (`tests`/`test`); recall for those pairs comes from the synonym slice and summary text rather than the stem.
- The golden set is now the standing regression floor at 35 cases; adding retrieval behavior changes requires re-measuring the baseline bands, not editing floors in isolation.
