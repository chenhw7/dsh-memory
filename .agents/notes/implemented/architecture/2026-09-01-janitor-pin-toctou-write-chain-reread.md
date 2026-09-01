# Agent Note: Janitor decides decay at the write-chain slot, not over the iteration snapshot

Status: implemented

English | [中文](2026-09-01-janitor-pin-toctou-write-chain-reread.zh.md)

## Problem

`janitor`'s pin exemption was a check-then-act over the live iteration: the loop read `entry.pinned === false` from its snapshot, then an `await` (the durable put/audit) separated that check from the write. A pin landing in that window — the user pinning an entry while the janitor pass was in flight — was ignored: the entry was hard-decayed (project scope, deleted) or soft-decayed (global/user, stamped out of injection surfaces) despite the pin. The same window also made the decay stamp itself non-idempotent under concurrency: two decisions raced on the same snapshot.

## Decision

The snapshot iteration only pre-filters candidates (overdue, not already decayed); every write decision moved to the write-chain slot via the table's atomic read-modify-write (`KvTable.update`) — the same discipline the recall stamp already follows:

- **Soft decay (global/user) is one atomic RMW per entry.** The transform re-reads the current record and decides there: still within the decay window (including the `importance` 4–5 1.5× grace, computed from the re-read record) → unchanged; `pinned` → unchanged; already decayed → unchanged; otherwise stamp. The pin check and the stamp can no longer interleave.
- **Hard decay (project) runs a guard first.** `KvTable.update` cannot express a delete, so the guard update re-reads `pinned` at its slot and returns unchanged when pinned — the delete then runs only when the guard observed an unpinned record. The window between the guard's slot and the delete's slot remains; no host primitive (`put`/`update`/`delete`) is narrower than "guard → delete", so the code documents that residual honestly instead of claiming a closed race.
- Failures report through the existing `janitor` site; a record that vanished between snapshot and slot (someone removed it mid-pass) is normal end-of-life and skips silently.

## Alternatives considered

- **Re-check pinned after the await (post-write verification).** Rejected: detecting the pin after the delete has already landed would need rollback machinery the table does not offer, and the soft-decay stamp would still be a lost-update race.
- **Hold a plugin-side lock across the janitor pass.** Rejected: single-process write ordering is the domain write chain's job; a second locking mechanism would duplicate it and still not bind the remote `pin` path.
- **Snapshot the whole janitor decision set and apply it without awaits.** Rejected: the audit append and the durable write are inherently async; removing the awaits would buffer unbounded audit work in memory.

## Consequences

- A pin racing the janitor pass is respected whenever it lands at or before the decision slot; the only residual exposure is the hard-decay guard→delete gap, documented in code and bounded by the host's primitive set.
- The janitor's per-entry work is now one write (or one guard + one delete for project), ordered on the same write chain as every other mutation — no new synchronization surfaces.
- The TOCTOU contract tests pin through an intercepting stub that lands the pin inside the janitor's own write-chain slot, so they genuinely distinguish slot re-reads from snapshot checks (mutation-verified).
