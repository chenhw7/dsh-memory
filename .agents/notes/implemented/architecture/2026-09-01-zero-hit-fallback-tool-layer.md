# Agent Note: memory_search falls back to recent entries only at the tool layer

Status: implemented

English | [中文](2026-09-01-zero-hit-fallback-tool-layer.zh.md)

## Problem

`memory_search` returned an empty result whenever the query shared no lexical token with any entry — and the model could not distinguish "no such memory exists" from "your words do not match". Both readings damage recall: the model either re-searches with different wording (cost) or concludes the memory is absent and proceeds without it (the silent failure the injection surfaces exist to prevent). But a naive "return the most recent entries when empty" would poison the standing injection surfaces: with autoRecall enabled, every agent step would inject unrelated entries, breaking the bounded-cost property and the `<memory-policy>` line that honestly says memory may not be loaded.

## Decision

The fallback lives in the tool layer only, exactly per the improvement program's ruling:

- **Trigger.** A non-empty `query` whose BM25 result is empty (`total === 0`). A filter-only call that returns nothing is "the filters are narrow", not "nothing matches" — it never falls back.
- **Shape.** The most recent entries under the same scope/project/category filters, flagged `fallback: true` in the output schema, the render ("not keyword hits"), and the presentation metadata. The description tells the model to treat flagged results as recency-based context.
- **Read-only.** The fallback path calls `store.list` only — no recall stamp, no `accessCount` bump, no stale revival. A dormant entry surfaced by a fallback stays dormant; the recalled-metadata discipline is untouched.
- **Strictly lexical everywhere else.** The injection surfaces (snapshot, index, auto-recall) and the remote projection keep strict lexical semantics; they never see the fallback.

## Alternatives considered

- **Fallback inside `MemoryStore.search`.** Rejected: the injection surfaces and the management UI consume that method; a store-level fallback would push unrelated entries into the standing prompt and into the UI on every browse.
- **Fallback with recall stamping.** Rejected: surfacing entries the query did not match is not a recall; stamping would reset dormancy for entries the model never actually searched for, corrupting the janitor's staleness signal.
- **Embedding-based fallback.** Out of scope: the semantic plane is deferred behind the host-seam ruling; the lexical fallback is the zero-dependency stopgap.

## Consequences

- The model can now distinguish the two empty cases only via the flag; the render adds a distinct line for the empty-store case ("nothing to fall back to") so an empty store does not masquerade as recency context.
- With `maxSearchResults = 0` (unlimited) a fallback returns the whole store — consistent with the repo's limit-0 convention, but deployments choosing unlimited search should be aware the fallback inherits that boundlessness.
- The fallback respects the same filters as the query; entries hidden by scope/category filters do not re-enter through it.
