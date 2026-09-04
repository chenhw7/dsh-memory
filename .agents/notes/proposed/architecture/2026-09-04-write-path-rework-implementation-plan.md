# Agent Note: Write-path rework implementation plan

Status: proposed

## Problem

[sqlite-backend-and-batch-consolidation](./2026-09-04-sqlite-backend-and-batch-consolidation.md) (the parent proposal below) has decided why the write path changes, what it changes into, and which alternatives lost; but "which file and symbol each change lands in, in what commit order, verified by which mechanical check" has no home at the execution layer. Folding it into the parent note would bloat the decision record as construction proceeds; omitting it forces each implementer (human or agent) to re-derive the insertion points from scratch. This note is the parent proposal's execution-layer companion, addressed to whoever lands the code: it slices each phase into commits, lists every insertion point (with line anchors as of 2026-09-04 main — when line numbers drift, search by symbol), where each test goes, and which documents each step syncs. When implementation deviates from the plan, update this note in the same commit as the code.

## Proposal

### Standing discipline

- Each phase is independently shippable and revertible as its own commit sequence; a phase's acceptance = the parent proposal's criteria for that phase + this plan's per-step tests all green.
- Test discipline: all new logic is vitest on fake-LLM — unit tests use the `fakeCtx` hand-written `llm.stream` pattern from `tests/confirm-extraction.spec.ts:36-57`; protocol routing uses the content-routed fake service of `tests/eval-fakellm.spec.ts` / `eval/harness/fake-llm.ts`; the real model runs only behind env gating (`--mode real`, `eval/boot.ts:305-308`).
- Zero-migration discipline: new `MemoryEntry` fields are always optional plus a zod mirror (HOST_CONTRACT §1 validates only at the durable read boundary); new domain tables ride the "absent tables initialize as empty maps" semantics (`src/store/index.ts:96-120`); every schema evolution ships with bidirectional tests (an old file opens under new code; a new file survives a read-then-write through the old schema path without losing tables).
- Documentation discipline: user-visible behavior changes update the TECH_DESIGN bilingual pair in the same commit (§6.1 record table, §6.3 persistence layout, §7.1 store, §8 configuration) and re-record its sidecar; HOST_CONTRACT (zh-only) is touched only in phases that touch the host contract surface; settings-card copy goes through the two `src/client/locales.ts` dictionaries.

### Phase 1: anchors + two-tier batch consolidation (the dedup/conflict fix)

Step 1.1 Entry model and meta table (data plane only, standalone commit)

- `src/types.ts:35-83` `MemoryEntry` gains `anchors?: readonly string[]`, `status?: 'active' | 'superseded'`, `supersededBy?: MemoryId`, with JSDoc stating the defaults (active, no anchors); `AddMemoryInput`/`UpdateMemoryInput` gain the corresponding write faces.
- `src/store/index.ts:47-61` `memoryEntrySchema` mirrors the three optional fields; `:108-120` `memoryDomainSpec` gains a fourth table `meta: domainTable<string, MemoryMetaRecord>` (`{ key: 'consolidation' | 'medium' | 'schema', ...payload }`); `DomainMemoryStore`'s constructor accepts the fourth table and grows internal `getMeta/setMeta`.
- Tests: `tests/store-contract.spec.ts` round-trips the new fields; `tests/integration/composition.spec.ts` mirrors the `:562-605` pre-audit case with two reopen cases — an old file without the new fields/meta table opens zero-migration; a new file carrying the new fields and an unknown table survives a read-then-write through the current code path without losing the table.
- TECH_DESIGN §6.1/§6.3 (fourth table + new fields) and its zh mirror change together.

Step 1.2 Extraction schema and prompt (extraction plane)

- `src/review/extract.ts:174-183` `ParsedMemory` gains `anchors: string[]` and `projectName?: string`.
- Extraction protocol: following the tag precedent (`SCOPE_TAGS` :79, `SUMMARY_TAG_RE` :90), add trailing tags `[anchors: a, b, c]` and `[project: name]`; `parseExtractedMemories` (:192-220) extends parsing, stripping tags before the `scanContent` gate (same order as the summary tag).
- `REVIEW_SYSTEM_PROMPT` (:33-52) and `FLUSH_SYSTEM_PROMPT` (:66-76) gain rules: hard tokens (numbers, identifiers, tool names, repo names/paths) go into anchors; when a repo name/path appears in conversation it must enter anchors and fill project; the NO-OP gate stays.
- `storeMemories` (:511-607) project attribution: parsed.projectName first, `inferredProjectName` (cwd, :567,599) as fallback.
- Tests: `tests/extract.spec.ts` gains parsing fixtures (including tag-less old-format compatibility); `tests/fixtures/extract-golden.ts` gains goldens.

Step 1.3 Per-round consolidation tier (the write-path change)

- New module `src/review/consolidate.ts`:
  - `selectConsolidationCandidates(parsed, existing)`: over the `src/store/bm25.ts` primitives (`buildCorpusStats`/`weightedOverlapSimilarity`); candidates = lexical weighted overlap above threshold ∨ shared low-frequency anchor (df ≤ 2, df counted over existing entries' anchors); bucketed same-scope / cross-scope. **Unchanged:** `dedup.ts`'s `findDuplicate` contract (same-scope, single threshold) — it stays for the legacy path and the calibration tests.
  - `CONSOLIDATE_SYSTEM_PROMPT` + assembly: one call per round, candidates fed by bucket (new entries vs existing entries full text, with scope/category/anchors); the prompt carries anti-over-merge rules (environment observation ≠ convention; different scopes do not merge by default, routing to conflict/scope repair).
  - Output protocol: one line per candidate `<candidateId> <action> [targetEntryId] [content]`, action ∈ `merge | update | conflict | new`; `parseConsolidateVerdicts` follows the discipline of `parseCuratedLines` (`extract.ts:699-714`); unparseable/dirty lines fail closed to `new` (rationale: a false duplicate swallows a fact, a false new leaves redundancy the periodic tier can salvage — the opposite of the judge's fail-closed-duplicate; the docstring records this choice).
  - `applyConsolidation(ctx, session, parsed, existing, opts)`: `merge`/`update` → existing `mergeContent` semantics + `memory.update`; `conflict` → old entry `status='superseded'` + `supersededBy` + visible deprecation annotation (format fixed in the docstring during implementation; the new fact is `add`ed); `new` → `add`. All failures accounted via `memory.reportFailure`.
- `extract.ts:546-599` rework: run the selector per batch; only with candidates does the batch make its one consolidation call; `src/review/index.ts:67-117` Config gains `consolidation: z.enum(['two-tier','legacy-judge']).default('two-tier')` as the kill switch, with `resolveConfig` (:140-160) in step; legacy-judge keeps the `judgeDuplicate` path for one release.
- Retrieval surfaces filter `status='superseded'`: auto-recall (`src/context/index.ts:387-412`, same pattern as the stale filter), standing-section assembly (:417-425), `search`; the tool surface (memory_list/memory_get) does not hide them and renders the annotation.
- Settings card: one select row for consolidation in `REVIEW_SPEC` (`src/client/index.ts:107-141`) + the two locale keys.
- Tests: new `tests/consolidate.spec.ts` (fakeCtx pattern): selector (lexical hit / anchors-only hit / cross-scope bucketing / df>2 anchor non-hit), protocol parsing (dirty line fails closed to new), all four actions applied, plain-add pass-through when the consolidation call makes no match; `tests/dedup.spec.ts` untouched and green; fake-LLM replays of prog101 (a prog101-style fixture: pnpm convention stored → an npm contradiction written → old entry superseded + annotated, new entry stored) and prog112 (repo name in conversation → anchors/projectName in place).

Step 1.4 Periodic full-corpus tier

- Scheduling: reuse the curator's per-N-sessions gating shape (its own counter in `src/review/index.ts`), once on startup + every N sessions; selection = accessCount DESC, `COALESCE(lastRecalledAt, updatedAt)` DESC, decay-window filter, top-N cap; `lastRunAt`/cooldown persist via Step 1.1's meta table. SHIPPED (`src/review/sweep.ts`): the pairing is existing-vs-existing over the ranked set — the per-round selector's parsed-vs-stored shape does not transfer, so `selectSweepPairs` re-proposes pairs on the shared 0.2 lexical signal alone (anchors add nothing on an already-usage-ranked set); verdicts ride the `p<N>` namespace (`SWEEP_SYSTEM_PROMPT`), distinct from the per-round `c<N>`; a dropped verdict fail-closes to INACTION (nothing new exists to land — the opposite of the per-round `new`). Cooldown = meta-table `consolidation:lastRun` + a 1-hour minimum between passes. Defaults: `sweepEnabled` **false** (opt-in this release), `sweepEveryNSessions` 20, `sweepTopN` 20. The extraction budget deliberately does not bound the sweep (store maintenance, not an extraction drain).
- Config: `sweepEnabled`, `sweepEveryNSessions`, `sweepTopN` enter the memory-review namespace + the settings card (the no-hardcoded-tunables convention).
- Tests: a fixture proves this tier merges a reworded-duplicate pair sharing **zero** anchors (the fake-LLM answers by bucket content); cooldown does not re-fire; `sweepEnabled=false` is fully silent; meta-table lastRun survives a reopen. SHIPPED as `tests/sweep.spec.ts` (25 cases); the en rate-limit pair (measured overlap 0.24, zero anchors) is the zero-shared-anchor fixture.
- Eval acceptance (mechanical layer): the full harness replay stays the eval CLI's job (`npm run eval -- --filter prog101,prog112,work201,life303`); the deterministic half of the acceptance is pinned in vitest as `tests/write-path-rework-acceptance.spec.ts` (prog101 contradiction → superseded + annotated; prog112 projectName + anchor pairing; the audited 9/2 duplicate-pair multiplicities — the counter reads 11 over every extra verdict, the report's "10 pairs" prose counted the tracked fact set; the consolidated shape reads 0; the corpus contract lint). `duplicatePairCount` was added to `eval/mechanical.ts` and surfaces as `storage.duplicatePairs` in `eval/report.ts` slices (summed across scenarios, not averaged). The v2 judged A/B (env-gated real model) remains the behavioral gate.

### Phase 2: usage feedback (hitCount)

Step 2.1 Fields and write-back

- `src/types.ts` + the zod mirror gain `hitCount?: number` and `lastHitAt?: number` (optional, zero-migration); the store gains `markHits(ids)`, accounted the same way as `stampRecalled` (atomic RMW, audited, `updatedAt` untouched). SHIPPED; one batch adds exactly one hit per entry (duplicate ids collapse) — a set has no multiplicity.
- Bidirectional compatibility tests per the Step 1.1 discipline. SHIPPED in `tests/store-contract.spec.ts` (3 cases) + `tests/hit-signal.spec.ts`.

Step 2.2 Intersection computation (memory-context)

- The auto-recall pre-step's injected id set for the round and the standing snapshot (`freezeFor`) are recorded into a session-side ledger (a WeakMap beside `sessionMemory`). SHIPPED; the metric is the IDF-weighted share of the ENTRY's tokens the answer restates (`computeHits`, coverage over the entry bag — not a symmetric overlap), with content+summary+anchor tokens. CALIBRATION (written back per plan): genuine restatement 0.5–0.7, incidental mention 0.05–0.12, unrelated ≈0 → default `hitSignalThreshold` **0.25**; Config `hitSignalEnabled` (default false) + `hitSignalThreshold` (default 0.25) in the `memory` namespace + the auto-recall settings card. The ledger is consumed by one answer — a hit belongs to the answer that echoed it.
- The `ctx.on('session/event')` listener on `assistant/message` reuses the `messageText` convention; failures book as `mark-hits`/`hit-compute`. SHIPPED.
- `accessCount`/`lastRecalledAt` semantics and every existing consumer change zero. Verified.

Step 2.3 Consumption

- The periodic sweep's selection orders by `hitCount` DESC first, then `accessCount` DESC, then last-use; **no `maxUnusedDays`** — `decayDays` remains the only deleter. SHIPPED (`rankForSweep`).
- Tests: the two opposing fixtures (restating answer hits; ignored injection and mere mention do not) in `tests/hit-signal.spec.ts` (12 cases incl. the consumed-ledger and disabled-signal wiring); markHits idempotence and audit in `tests/store-contract.spec.ts`; the eval mechanical layer's hitCount readout and the same-build A/B EQUAL check belong to the eval lane and are not vitest-pinned (the judged A/B gate stays env-gated per the parent proposal).

### Phase 3: SQLite backend

Step 3.0 Documentation gate (before code)

- HOST_CONTRACT (zh-only): a new local-medium section (`memory.db` is plugin-owned, the WAL sidecars, the boundary with the host-owned memory.json), an 11th item in the §10 checklist (node:sqlite availability and the warning); record the host engines floor (`^22.19.0 || >=24.0.0`; node:sqlite flag-free since 22.13) — this premise underwrites the whole phase, document it before work starts. Whether this repo's package.json gains an `engines` field is decided at the same time (leaning: no — the host contract document carries it). SHIPPED: HOST_CONTRACT §11 (ownership/WAL/experimental-warning/alpha-API-pinning/concurrency) + §10 item 10; the engines floor verified against the harness checkout's package.json; this repo's package.json stays without `engines`.
- TECH_DESIGN §6.3/§8 updates (memory.db + sidecars + uninstall semantics + the store-row patch example) land together with Steps 3.1–3.2. DONE.

Step 3.1 The backend

- Side-effect-free extraction from `src/store/index.ts` (standalone commit): pull the read-side BM25 retrieval, ranking, filtering, and janitor/trim logic out of `DomainMemoryStore` private methods into backend-neutral kernel functions; behavioral equivalence is proven by the existing specs staying green. REVISED IN PLACE: `SqliteMemoryStore` reads rows per call (synchronous, in-memory semantics) and re-uses the same bm25 primitives (`Bm25Index`/`tokenizeForSearch`) — the extraction turned out unnecessary for behavior equivalence, because the domain store's read logic was already instance-private with no shared-state coupling; the bm25 module IS the backend-neutral kernel the plan wanted. The equivalence proof stays the same: the contract suite green over both backends.
- New file `src/store/sqlite.ts`: SHIPPED — `SqliteMemoryStore extends MemoryStore`; `node:sqlite` `DatabaseSync` pinned to open/prepare/exec; WAL + busy_timeout 5 s; `$DSH_HOME/storages/memory.db` via the same `dshHomePath` service. Tables: `entries` (MemoryEntry columns, `id` PRIMARY KEY), `audit`, `suggestions`, `meta` (keyed `key`); booleans bind as 0/1, objects/arrays as JSON strings, NULL = absent (the zero-migration read side). Writes: one statement per record, entries + audit in one transaction; the read side of search re-uses the full-corpus df discipline. A `close()` seam releases the connection (the WAL sidecars recover on the next open).
- Tests: SHIPPED — `runStoreContractSuite('SqliteMemoryStore', …)` runs the full 24-case contract body over a fresh mkdtemp database per case (73 contract tests green across the three backends); the composition-level reopen/migration cases live in `tests/migration.spec.ts`. WAL sidecar existence and busy_timeout concurrency are pinned by the contract suite's reopen flows (the plan's dedicated composition cases fold into migration.spec).

Step 3.2 Configuration and migration

- Config: SHIPPED — the `storage` field lives on the `memory-store` row's `StoreConfig` (`src/store/index.ts`, default `host-medium`), not the `MemoryConfig` namespace: the backend is a store-provider concern, and the composition row is the only place a provider swap makes sense. No settings-card select (the provider row is composition-owned; the settings cards cover the live knobs) — the cordis.patch.yml path is the documented switch.
- Composition: SHIPPED — the store plugin's `apply` selects the backend by config; `remote/` rides the service abstraction with zero change (its `TypertRemoteService` base does not extend `MemoryStore`, and no wire surface changed).
- One-time migration: SHIPPED — sqlite opens with an empty DB and a non-empty medium → import entries + audit + suggestions verbatim + write `medium:migratedToSqlite` into the medium's meta table; medium holding data AND the marker → fail loud; a host-medium boot reading the marker → fail loud (marker read via the domain's meta table handle — the same `document.tables.meta` the plan names, through the storage-domain seam).
- Tests: SHIPPED as `tests/migration.spec.ts` (3 cases over the real composition): empty → import + marker; both non-empty → fail loud; host-medium sees marker → fail loud; import fidelity asserts entries (id/content/scope/projectName/anchors/createdAt), audit count, and the marker's presence in `tables.meta`.

Step 3.3 Acceptance alignment

- The write-amplification case drops the seeding trick and re-baselines under SQLite (205 adds no longer produce 415 whole-file fsyncs); same-build "host-medium vs sqlite" eval A/B with per-scenario EQUAL on the deterministic layer; the `ExperimentalWarning` does not break host stderr/baseCaptured assertions (the `tests/integration/host.spec.ts` channel); every HOST_CONTRACT §10 checklist item walked through. DEFERRED to the eval lane: the A/B re-baseline needs the harness subprocess route (`npm run eval:ab`), which does not run in vitest; the vitest-visible half (SQLite reopen, marker persistence, contract equivalence) is pinned above.

### Phase 4 (scoped only)

Curated index view: after Phases 1–3 are stable and a v2 A/B baseline is on record, a separate proposed note scopes it; this plan does not expand.

## Alternatives considered

- **Folding the execution detail back into the parent proposal** — no. The parent note is a decision record and should stay stable around "what was decided"; execution detail churns as construction proceeds (line numbers drift, calibration results get back-filled). A separate document lets the parent note change only when a decision changes. The two notes cross-link, so either reader is one hop away.
- **Single-release big-bang** — no. The parent proposal's four phases are independently shippable and revertible; this plan slices commits by Step precisely to preserve that property — when a Step goes wrong, the rollback boundary is a commit, not a release.
- **JSON-schema structured output for consolidation instead of a line protocol** — no. Every LLM protocol in the repo is a line protocol (the judge's one word, the curator's `<id>:` lines), and the host LLM channel has no structured-output mechanism — all output returns as text via `collectStreamText` (`extract.ts:317-323`); introducing a second protocol means a second parser and failure vector, while the line protocol's fail-closed discipline is already covered by the dedup/extract specs.
- **Extending `findDuplicate` itself for cross-scope/anchors** — no. `findDuplicate`'s contract (same-scope near-duplicate detection, single threshold) is pinned by the calibration pairs in `tests/dedup.spec.ts`; adding dimensions to it re-couples "prefilter" and "completeness" into one function. The selector is new code over the bm25 primitives; dedup.ts retires only when the legacy kill-switch is deleted.

## Acceptance criteria

- Per phase: the parent proposal's criteria for that phase all pass + every test named in this plan's Steps is green + `npm run build && npm run test` green + documentation mirrors (the TECH_DESIGN bilingual pair) synced with sidecars re-recorded.
- No "must be back-filled before the next step starts" holes between phases: every Step's commit carries its tests and (where needed) docs; the kill switches (legacy-judge, `sweepEnabled`, `storage`) are test-verified inside their own phases.
- Once all phases land: the parent proposal and this note move to implemented/ with the final phase and are rewritten per that format, both sidecars re-recorded.

## Risks

- Plan/code drift (stale line anchors, calibration parameters not back-filled) → each phase's landing commit updates this note's fact layer; line numbers are a 2026-09-04 snapshot anchor, symbol names are the stable index.
- The line protocol truncated by max-tokens or unparseable on long buckets → fail closed to `new` + a configurable bucket-size cap; the direction is fixed at "never mis-merge".
- The distribution of fail-closed-`new` vs today's fail-closed-duplicate on real corpus is unknown → the kill switch (legacy-judge) stays one release; watch stored-entry counts, duplicate-pair counts, and the A/B mechanical layer before deleting it.
- Phase 3's dual-backend parameterization exposing DomainMemoryStore's private couplings → absorbed by Step 3.1's standalone extraction commit first; the extraction itself is zero-behavior-change, guarded by the existing specs.
