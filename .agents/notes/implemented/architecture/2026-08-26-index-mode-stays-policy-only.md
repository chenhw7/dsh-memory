# Agent Note: Injection modes stay on policy-only default

Status: implemented

English | [中文](2026-08-26-index-mode-stays-policy-only.zh.md)

> Superseded 2026-09-01: [The factory default promotes to index mode](2026-09-01-index-default-promotion.md) — the improvement program flipped the evidence burden after the session-capture telemetry stayed unobtainable. The benchmark evidence below remains valid; the default it defended is no longer the shipping one.

## Problem

The memory section supports three standing-injection modes beyond `off`/`custom`: `policy-only` (guidance text only, the model searches on demand), `index` (one existence line per entry), and `full` (full content). Before the golden-set benchmark existed, the default was policy-only by conservatism alone: no one knew how recall quality and injection cost actually traded against each other as the store grows. Promoting `index` to the factory default was a live option from the improvement program ([archive/memory-plugins-comparison-zh.md](../../../../docs/archive/memory-plugins-comparison-zh.md), P1-8), and a default chosen without evidence could not defend itself against the next "index sounds strictly better" proposal.

## Decision

`policy-only` stays the factory default; `index` is documented as the recommended power mode for stores beyond a few dozen entries or when the model demonstrably misses searches; `full` fits small stores with heavy context needs, within its 20-entry fold line. The verdict comes from the measured benchmark (`src/benchmark/index.ts` + `tests/recall-golden.spec.ts`, 2026-08-26):

- **Tool retrieval is already complete.** Over the 24×24 golden fixture, BM25 recall reaches success@5 = 100%, P@1 = 91.7%, MRR = 0.958 (floors pinned in CI: ≥ 85% / 60% / 0.75). A standing index adds existence awareness ("remind the model to search"), not search capability ("can find it").
- **policy-only is the only mode decoupled from store size** — ≈344 tokens flat regardless of inventory. `index` grows ≈26 tokens/entry (reaching the 5000-char budget around 100–140 entries, then rolling up into category-count lines); `full` starts folding entries at just 24 items under default budgets, so its visible coverage falls off before the character budget does.
- **The golden set proves "can find", not "will search".** The switch criterion for a default is behavioral evidence — the model's real-session miss rate on `memory_search` — which requires online recall-trigger statistics that do not exist yet.

## Alternatives considered

- **Promote `index` to the factory default.** Rejected on the evidence above: constant ≈955 tokens of standing cost (≈18% more than `full` at the fixture's 24 entries) buys existence awareness the model does not demonstrably need while tool retrieval already saturates the golden set. This is the recorded reintroduction condition: promote `index` once online recall-trigger statistics show real sessions miss searches that the store could answer.
- **Make `full` the default** (maximum context). Rejected: it is the most expensive standing view and folds its tail at the default 20-entry cap, so larger stores silently lose visibility — the opposite of what a default should do as the store grows.

## Consequences

- The README and the settings UI describe `index` as a recommended upgrade, not the default; the cost table behind that copy is reproducible via `DSH_MEMORY_EVAL_VERBOSE=1 npx vitest run tests/recall-golden.spec.ts`.
- `tests/recall-golden.spec.ts` pins the recall floors, so any tokenizer, weighting, or budget change that degrades retrieval fails CI; the measured tables in the archived evaluation ([archive/INDEX_MODE_EVALUATION.zh.md](../../../../docs/archive/INDEX_MODE_EVALUATION.zh.md)) regenerate from the same run.
- A future promotion of `index` needs the behavioral evidence named above, not a re-run of the lexical benchmark — the benchmark cannot observe whether the model chooses to search.
- Cross-language recall stays out of scope: pure-Chinese queries against pure-English entries have zero lexical overlap, and the golden-set queries are content-anchored to avoid a false miss; a semantic layer would be a different order of work.
