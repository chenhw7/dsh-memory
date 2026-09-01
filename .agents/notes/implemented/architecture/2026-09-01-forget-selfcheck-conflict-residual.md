# Agent Note: Topic-forget with safety rails, a scale selfcheck, and the conflict-detection residual on the record

Status: implemented

English | [中文](2026-09-01-wave4-forget-selfcheck-conflict-residual.zh.md)

## Problem

Three gaps closed the program's final wave. Forgetting a topic required deleting entries one id at a time — the model had to enumerate ids it may not know. The store's scale migration trigger (entries near the cap) existed only as documentation. And the conflict detector only annotated overlaps: a heavily re-worded correction could not be detected at all, and the program's acceptance signal ("a heavily paraphrased correction produces a pending proposal") was unreachable on a zero-LLM lexical plane.

## Decision

- **`memory_forget`** — a model tool that batch-forgets every entry lexically related to a topic (same BM25 semantics as `memory_search`, stale entries included). Safety rails: a strict boolean `confirm` gate (absent or false refuses before any search), **pinned entries are exempt** and reported via `pinnedSkipped` (pin means "never forget" everywhere else), and a **runaway guard** refusing batches above half the configured search ceiling — one broad token must not delete half a store. Each removal keeps its individual remove audit; the description mandates previewing with `memory_search` first.
- **`scale-trigger-selfcheck`** — the store warns once at construction when the medium opened with entries at or above 80% of `entriesCap` (the cap truncates at the limit; the selfcheck warns approaching it — the recorded division of labor; the multi-process alarm belongs to `cross-process-detect`). Warns through the host logger channel once per process; a missing logger stays silent.
- **`conflict-resolution` closes as partial, on the record.** The confirm-mode `memory_replace` path already queues proposals (P1-2, existing behavior) — the "resolution via the suggestion queue" half was satisfied. The paraphrase half is unachievable on a zero-LLM lexical plane: a genuinely re-worded correction measures ≈0.02 IDF-weighted overlap against the 0.1 stale line, and lowering the threshold there would push the 上海/海南-class distractor pairs (≈0.06) over it. A test pins the residue with an explicit comment that it documents a cost, not a behavior to preserve — updating it when the semantic plane lands must be a conscious act.

## Alternatives considered

- **memory_forget with no ceiling.** Rejected: one broad token on a large store would irreversibly delete half the entries; the ceiling converts the worst case from silent data loss into a refusal that asks for narrower filters.
- **Silently skipping pinned entries.** Considered and rejected in favor of explicit reporting: silent behavior hides what happened; `pinnedSkipped` tells the model to unpin and re-run if the intent is real.
- **Lowering the conflict threshold to catch paraphrases.** Rejected: distractor pairs (上海/海南 ≈0.06) would cross the line — more false conflicts than caught corrections, the exact trade the `dedup-idf-weighting` note recorded.

## Consequences

- Topic forgetting is auditable end to end (per-entry remove records), bounded, and pin-respecting; the audit log's own cap means very large batches should be split to preserve their trail.
- The scale selfcheck judges only the medium's opening state — growth past the line during runtime surfaces at the next restart. That is a startup advisory, not a live monitor.
- The conflict residual is now a documented test: the paraphrase gap closes only when a semantic plane lands (deferred by the host-seam ruling), and the pinning test forces that update to be deliberate.
