# Agent Note: Recall stamps go through the table's atomic read-modify-write

Status: implemented

English | [中文](2026-09-01-recall-stamp-batching-atomic-rmw.zh.md)

## Problem

`stampRecalled` wrote each stamped hit with `KvTable.put`, holding the `MemoryEntry` reference captured at search time. Two defects followed from that one choice: in the storage backend's `single` layout every `put` republishes the whole unit file, so a 50-hit search fanned out into 50 full-file rewrites (write amplification growing with hit count), and a `memory_replace` landing between the search and the stamp was silently rolled back — the stamp overwrote the freshly edited record with the stale snapshot it held. The skip condition (`lastRecalledAt === now`) could not catch either case: it compares timestamps, not content.

## Decision

The stamp pass writes through the table's atomic read-modify-write (`KvTable.update`) instead of `put`. The host guarantees that `update`'s transform runs at its write-chain slot reading the record current there, so:

- **No lost updates.** A `memory_replace` landing before the stamp's chain slot is read by the transform and survives in the stamped record — verified in both interleaving directions (edit-then-stamp and stamp-then-edit) by contract tests.
- **One durable write per changed entry per stamp pass.** Entries already carrying the pass's timestamp with no decay stamp return unchanged from the transform and skip at a snapshot pre-check without touching the write chain; the fan-out beyond one write per entry is gone.
- **Failures stay observable.** A stamp whose id vanished mid-pass (normal end-of-life, no report) or whose medium rejects (reported as the `recall-stamp` site through `reportFailure`) never breaks the fire-and-forget contract.

This is a behavior-preserving change to the write mechanism, not the write semantics: the same fields change on the same conditions; only the write primitive and the read-it-before-writing discipline are new. It clears the prerequisite for the `index-default` supersession proposal.

## Alternatives considered

- **Add a batch/multi-record primitive to the storage backend.** Rejected: that is host-side API surface (`KvUnit.putRecord` is the only record primitive); the plugin cannot add it, and the atomic RMW already bounds the damage per entry.
- **Defer/coalesce stamps on a plugin-side timer.** Rejected: it would delay the durability the janitor and ranking read, add a timer to dispose, and still write whole records — the RMW achieves correctness without new machinery.
- **Stamp only the top-k hits.** Rejected: it changes recall metadata semantics (which entries count as recalled), not just the write path — out of scope for this item.

## Consequences

- The stamp's write count is now exactly one per changed entry per pass; the remaining amplification (a 50-hit search writes 50 times in `single` layout) is bounded by the backend, not the plugin — the recorded migration lever for large stores is the `per-record`/SQLite backend choice (`scale-trigger-selfcheck`'s territory).
- `KvTable.update` rejects on a missing key; the stamp treats that as normal end-of-life and reports any other failure through `recall-stamp`.
- The six in-repo `memTable` test stubs implement `update`; a new provider stub must too, or recall stamping reports failures instead of stamping.
