# Agent Note: Audit-cap test seeds the medium

Status: implemented

English | [中文](2026-09-03-audit-cap-test-seeds-medium.zh.md)

## Problem

The §3.2 audit-cap integration test produced its overflow the expensive way: 205 sequential live `store.add` calls. Each add publishes the whole single-unit JSON file through the storage-json atomic write (temp file + fsync + rename + directory fsync), so the test paid ~415 durable full-file publishes to assert what is fundamentally one trim behavior. On the CI lane that cost sat against vitest's inherited 5 s budget with no explicit case timeout: 1706 ms on the 2026-09-02 run, then killed at 5016 ms mid-loop on the 2026-09-03 run — the first observed ci.yml failure of the test since it landed (2026-08-20), with the other 823 tests green. The trigger was load, not code: the same push added four concurrent eval spec files (+56 tests; suite test-time 10.5 s → 19.1 s) and pushed the fsync-heaviest case past the budget on a contended runner. Every future push carried the same ~3× run-to-run variance against the line.

## Decision

`tests/integration/composition.spec.ts` seeds the overflow on the medium instead of producing it. The test disposes the booted composition, writes a version-0 `memory.json` carrying 204 schema-valid audit records (`fact 0`–`fact 203`, seq 1–204) into its private temp root, boots a fresh real composition over the same directory, and lands ONE real add (`fact 204`). The assertions are unchanged from the old form: the audit table holds 200 records, the just-added record is at the head, the oldest survivor is `fact 5`. The seed also drives `nextAuditSeq`'s lazy initialization from the medium — the live add must continue at seq 205 — a path the 205-add form never reached. Durable publishes drop from ~415 to 7 (one entry put, one audit put, five audit deletes).

## Alternatives considered

**Raise the case timeout** (~20 s with a comment naming the awaited work). Legitimate under the test-reliability skill — naming the awaited work and restoring a budget is not flake-masking — and it keeps the incidental sustained-write stress. But it keeps paying ~415 fsync'd publishes on every push and puts a subjective budget literal in the suite. Lost to seeding, which removes the cost instead of budgeting for it.

**Shrink the loop to 201 adds.** Still ~400 publishes; saves ~2%. Pointless.

**Raise the global `testTimeout`.** Widens the lane budget when exactly one case is bound by durable I/O; the case should say so at the case.

**Batch or debounce the JSON publish.** Changes the shipped durability contract — every mutation is crash-durable on return — to serve a test. Rejected outright.

## Consequences

- The suite's heaviest case went from 1240 ms local-isolated / killed at 5016 ms on CI to 52 ms isolated; the whole composition file runs ~1.0–1.5 s where it took 3.0 s (2026-09-02 CI) and 7.9 s (2026-09-03 failing run).
- Given up: the 205-mutation sustained-write mini-stress no longer exists anywhere in the vitest lane. Per-mutation audit appending stays pinned by sibling cases at small N (exactly one record per add/update/remove/readRaw); pressure evidence lives in the eval and pre-push lanes, not in a unit-tier case.
- The seed is a durable-format fixture: it must stay schema-valid under `auditEntrySchema`, and a future change to the audit record shape updates it in the same change, like every other on-disk fixture.

## Testing

- `tests/integration/composition.spec.ts` passes in full (41 tests) including the rewritten case; the full vitest lane passes (41 files + 1 env-gated skip).
- The trim is genuinely exercised: the medium holds 205 audit records after the add, so the length-200 assertion fails if `trimAudit` stops trimming (observed via a temporary negative control), and the head/tail assertions pin which five records were evicted.
