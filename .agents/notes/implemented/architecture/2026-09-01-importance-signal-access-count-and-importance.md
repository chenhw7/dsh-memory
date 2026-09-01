# Agent Note: Entries carry a use-signal (accessCount) and an optional model-assessed importance

Status: implemented

English | [中文](2026-09-01-importance-signal-access-count-and-importance.zh.md)

## Problem

The entry schema carried no use or importance signal: survival and ranking depended only on `lastRecalledAt ?? createdAt` and the `pinned` flag — a single time signal with no notion of how often an entry actually helped. Every day of operation wrote more entries that could never retroactively gain these signals, so the debt grew with runtime. Adding the fields later would fix the code but not the corpus; the cost curve made this a wave-1 item despite it being neither urgent nor risky.

## Decision

Two signals, one schema change, landed together:

- **`accessCount` (mechanical, automatic).** The store increments it on every recall stamp (`stampRecalled` — the same fire-and-forget path that sets `lastRecalledAt` and clears a decay stamp), so `memory_search` hits, `memory_get`, and `memory_list` pages all count. Absent reads as 0, so pre-existing entries are handled without a migration. It needs no model cooperation and cannot be gamed by an assessment.
- **`importance` (model-assessed, optional).** `memory_add` and `memory_replace` accept an integer self-assessment; the store clamps it into 1–5 on write rather than rejecting out-of-range input — a wrong judgment is not a protocol error. Absent means "not assessed", not "unimportant": ranking reads absent as mid-range so unassessed entries are not penalized.
- **Where each signal acts.** Search ranking breaks BM25-score ties by importance (desc) before recency. The janitor's soft-decay check grants `importance` 4–5 a 1.5× grace window; recall stays the stronger survival signal — `stampRecalled` clears a decay stamp outright regardless of importance.
- **Projection.** Both fields flow through the tool and remote entry projections (`accessCount`, `importance` optional on the wire), so the model and the management UI can see them.

## Alternatives considered

- **Model-assessed confidence as well.** Deferred: `confidence` fits the auto-extraction judge (its verdict is already a per-proposal confidence signal), but wiring it means touching the review pipeline; the field is left un-added until that change lands, so the schema does not carry a permanently-unset column.
- **Importance affects decay outright (skip decay below a threshold).** Rejected: an unassessed entry would then outlive an assessed-mid one, inverting the signal's meaning; a multiplicative grace window keeps the unassessed baseline untouched.
- **accessCount as the ranking signal.** Rejected for now: ranking by use-count favors old high-traffic entries over new relevant ones; it is recorded from day one so a later eviction order can weigh it once `entries-cap` lands.

## Consequences

- The signal debt stops growing: every entry written from now on carries `accessCount` automatically.
- `entries-cap` can now define an eviction order over `pinned` → `accessCount` → `lastRecalledAt`; that decision remains its own note.
- The 1.5× grace factor and the mid-range-when-absent ranking rule are fixed conventions; changing either requires updating this note, the TECH_DESIGN lifecycle section, and the grace-window ranking tests together.
