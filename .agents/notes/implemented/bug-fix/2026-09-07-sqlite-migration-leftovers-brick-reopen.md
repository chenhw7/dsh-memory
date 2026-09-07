# Agent Note: sqlite migration leftovers bricked the second boot over a migrated home

Status: implemented

English | [中文](2026-09-07-sqlite-migration-leftovers-brick-reopen.zh.md)

## Problem

The Step 3.2 migration imported the host medium into `memory.db` verbatim and stamped the `medium:migratedToSqlite` marker, but left the medium's `entries`/`audit`/`suggestions` tables populated. The both-sides guard — data AND marker together fail loud, on the theory that "a host-medium process wrote memory.json after the migration" — could not distinguish that case from the medium's own pre-migration leftovers on an innocent reopen. Every subsequent sqlite boot over a migrated home therefore threw at plugin start: in a real deployment, a populated store switched to `storage: 'sqlite'` bricks on its **second** session, with an error telling the user to reconcile two stores nobody diverged. No vitest lane could catch it: `tests/migration.spec.ts` asserted the marker and disposed (no second sqlite boot anywhere), the contract suite opens a fresh database per case, and unit tests do not compose. Only a composition that re-opens the same home twice meets the state.

The first host-medium-vs-sqlite mock A/B ([write-path rework](../architecture/2026-09-04-write-path-rework-implementation-plan.md) Step 3.3's mechanical acceptance) is exactly that composition — the plant chain opens session 1 (dialogue), disposes, and re-opens session 2 on the same `$DSH_HOME` for the standing questions. The first sqlite-side run failed 4 of 32 core scenarios at session-2 boot with `JSON-RPC -32603: cannot create effect on inactive context`: the boot throw destroyed the plugin's cordis context and the runner's next RPC surfaced the corpse. The four — prog101-build-toolchain, prog112-lint-rules, prog116-cache-invalidation, work208-1on1 — are exactly the corpus's four plant scenarios that carry seed entries: the only rows where a populated medium meets the two-session re-open. The noise corpus (plant, no seeds) never migrates and was already per-scenario equal.

## Decision

The migrating boot clears the medium's three data tables after the verbatim import and before writing the marker (`src/store/index.ts`, the `storage === 'sqlite'` branch). The both-sides state is now reachable only by a genuine post-migration writer, so the guard's error text means what it says. The clear-before-marker order makes every crash window benign: a crash between import and clear leaves the medium unmarked and populated, so the next boot re-imports idempotently (`INSERT OR REPLACE`); a crash between clear and marker leaves it empty and unmarked, and the next boot skips the import with the data already in `memory.db`. Marker-first would have re-created the brick window between two publishes.

The eval side moved with it: `readStoredEntries` (`eval/harness/seed-media.ts`) reads `memory.db` when that file exists — the file's existence is the backend signal, since a host-medium run never creates it and the noisy lane (no seeds, no migration) keeps its data only in the database — and reads `memory.json` otherwise. Reading the cleared medium would have turned the A/B's medium-diff layer into spurious 0-vs-N diffs.

## Testing

`tests/migration.spec.ts` test 1 now asserts the medium's data tables are cleared with the marker kept, then re-opens the sqlite composition over the same home — the eval's session-2 flow — asserting the store still serves both imported entries; the other two transition states (host-medium over a marked medium, both sides populated) are unchanged, the latter now reachable only by hand or a real second writer. Red on the unfixed tree (the reopen case fails — the boot throws), green after; full suite **949 passed | 6 skipped (955)**. The re-run A/B over the fixed build: core-v0 (32 scenarios) and noise-v0 (6) both **per-scenario deterministic EQUAL, zero errors** (`diffReports`, host-medium vs the sqlite pin via the profile-template measurement seam).

## Alternatives considered

- **Marker-first, clear-after.** Rejected: the window between the two publishes is the same brick, stranded mid-migration.
- **Reopen-time reconciliation (medium ⊆ database ⇒ treat as leftovers, clean and proceed; divergence ⇒ throw).** Rejected: subset semantics blur the conflict detector (a partial stale write would pass as "leftovers"), every crash path leaves the medium holding stale duplicates, and the guard becomes a comparison instead of an invariant. Clear-at-migration keeps one reachable state per fact.
- **Keep the data, document "remove memory.json's rows by hand after migrating".** Rejected: the migration audience bricks on the very next session and no automated path ever cleans the file; the import is one verified transaction, so clearing it is not data loss.
- **A bulk table clear.** Not available: the domain `KvTable` offers `delete(key)` per key only; the clear is a loop of per-key publishes.

## Consequences

- A populated store switching to sqlite survives restarts — the P1 closes. `docs/HOST_CONTRACT.zh.md` §11's boundary sentence ("`memory.json` 只留迁移标记") was written for this end state; `TECH_DESIGN` (bilingual) now states the clear explicitly.
- The clear costs one publish per key on storage-json — up to ~900 whole-file publishes for a capped store (500 entries + 200 audit + 200 suggestions), a one-time migration cost in the same currency the [write-amp re-baseline](../architecture/2026-09-04-write-path-rework-implementation-plan.md) measures; the host-medium migration path is the one flow where the old medium's write amplification still applies.
- The clear-then-marker crash window (between two awaited publishes) leaves an empty, unmarked medium: the host-medium mixed-version guard stays unarmed until a later migration re-arms it. Millisecond-scale, best-effort, recorded here rather than closed.
- The mock A/B equality now covers both backends over the full corpus, including the four plant+seed rows; the mechanical-lane results and the remaining judged baseline are recorded in the [write-path rework note](../architecture/2026-09-04-write-path-rework-implementation-plan.md).
