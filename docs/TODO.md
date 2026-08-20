# TODO & Evolution Plan — `@chenhw7/dsh-memory`

> Companion to [TECH_DESIGN.md](./TECH_DESIGN.md) (English) / [TECH_DESIGN.zh-CN.md](./TECH_DESIGN.zh-CN.md) (Chinese).
> This document tracks the plugin's current scope boundaries and **how it should evolve**: what to
> build next, why, the intended approach, and what "done" looks like for each item.
> 中文版：[TODO.zh-CN.md](./TODO.zh-CN.md)

---

## 1. Current Scope Boundaries

v0.1.x ships a deliberately narrow, verifiable core: one JSON file, six tools, rule + LLM
extraction, and four prompt-injection modes. The areas intentionally left outside the current
scope — and their evolution items — are:

| Area | Current shape | Evolution item |
|---|---|---|
| Retrieval | Structured filters + case-insensitive substring matching | §3.3 Lexical retrieval upgrade |
| Context injection | Four modes; default `policy-only` exposes no stored content | §3.12 Bounded existence index |
| Memory in trajectory | Tool cards via `presentCall` only; result cards unshaped | §3.14 Memory activity in trajectory |
| Memory health | Write-through store; dedup is advisory (prompt-level) only | §3.4 Dedup & merge |
| Memory lifecycle | Entries live until replaced or removed | §3.5 Memory lifecycle |
| Extraction | Session-routed model; user-message keyword/correction signals | §3.6 Extraction upgrades |
| Observability | Results surface through the tools; no audit events emitted | §3.2 (audit store) + §3.7 |
| User-facing UI | Settings (behavior configuration) only | §3.8 Memory management UI (client bundle + gateway) |
| Storage | Single local JSON file, single process | §3.9 Pluggable backends |
| Content security | 24-pattern regex scanner, fail-closed | §3.10 Scanner hardening |
| Testing | Unit / contract / tool spec layers; runner wiring pending | §3.1 Test infrastructure |

---

## 2. Evolution Goals

North star: a memory subsystem that is

- **Retrievable** — the right memories surface when needed: the model can see what exists,
  and lexical search finds it;
- **Healthy** — no duplication, no rot (dedup, lifecycle, quality scoring);
- **Intelligent** — extraction keeps improving on cheap compute (dedicated model, richer signals);
- **Operable** — observable, user-manageable, storage-swappable.

Every item below keeps the four-row bundle shape, extends the `memory` settings namespace with
safe defaults, routes new write paths through `scanContent`, and keeps background work
non-blocking for the agent loop.

---

## 3. Roadmap Items

### 3.1 Test Infrastructure Completion — P0

- **Why:** the spec suite (8 files, ~120 cases) exists, but vitest is not yet wired into
  `package.json` (`test` is a placeholder), and host-level integration coverage is missing.
- **How:** add vitest to devDependencies; `test` → `vitest run`; a CI job that runs `build` +
  `test` on push/PR; an integration spec that boots a real Cordis composition
  (`storage-domain` + `storage-json` over a temp `$DSH_HOME`) and exercises the four-row bundle
  end-to-end (add → search → update → remove, plus a compaction flush); golden datasets for
  `parseExtractedMemories` and `scanContent`.
- **Done when:** `npm test` passes in CI; the integration spec covers the full composition;
  scanner and parser have corpus-based FP/FN regression checks; a log-hygiene case proves the
  plugin never adds unknown event types to the session log (full memory activity → flush the
  log → reload the session → assert a clean resume; guard for the no-host-change policy, §6)
  passes against the pinned dsh release line.

### 3.2 Plugin-Owned Audit Store — P0

- **Why:** audit trails and the UI need to answer "what was learned, from where, and why" — but
  writing that into the *session log* is off the table under the no-host-change policy (§5,
  §6.1): the host's persistence read path refuses to reload a stored log containing any event
  type outside its in-repo-only `KNOWN_SESSION_EVENT_TYPES` whitelist (the `ignorable` marker is
  the only escape, and it is a reader-side field — `Session.append` never sets it, so a
  plugin-appended event is always required), there is no runtime seam to register
  plugin-declared types in the installed dependencies, and `Session.append` offers no
  writer-side `ignorable`. The audit trail therefore lives in the plugin's own storage, never
  in the session log.
- **How:** add a second table to the plugin-owned `memory` domain (`audit`), declaring it
  alongside `entries` in the existing domain spec. **Keep the domain at version 0** — do *not*
  bump: the storage-json `parse` path rejects any medium whose stamped version differs from the
  spec (`version-mismatch`), and `DomainFacility.open` exposes no migration step, so a 0 → 1 bump
  would refuse to load every existing user's `memory.json` with no recovery path. The table set is
  not version-gated: on `open`, storage-json reads only the tables the descriptor declares,
  initializing any declared table absent from the file as an empty map and ignoring any extra
  table on disk — so adding `audit` to a v0 spec is a zero-migration, forward-compatible change.
  After each successful mutation — tool `memory_add` / `memory_replace` / `memory_remove` and
  review/flush extraction writes — append one record: `{ op, entryId, scope, category?, source:
  'tool'|'review'|'flush'|'ui', sessionId?, ts, contentPreview (~100 chars, still through
  `scanContent') }`. Records are trimmed deterministically on append (keep the newest N, default
  200), so the audit table cannot grow unbounded. The `memory/*` `SessionEventMap`
  declarations stay in place as inert, reserved types — emitted by nothing in v0.x.
- **Done when:** every write path (tool, extraction, UI) appends exactly one audit record;
  the audit table never exceeds its cap; the §3.1 log-hygiene case passes (sessions resume
  cleanly after heavy memory activity).

### 3.3 Lexical Retrieval Upgrade — P1

- **Why:** matching the raw query string as one substring fails whenever the query and the entry
  share words but not a verbatim phrase; multi-word queries collapse if any single token is out
  of place. Recall at this entry count is a lexical-organization problem, not a semantic one.
- **How:** keep `MemoryStore.search` as an O(n) scan of the in-memory entries — no index, no
  vectors: (1) tokenize the query (case-fold; split on word boundaries, with per-character
  matching for CJK); (2) match an entry when *any* token matches (OR semantics) instead of
  requiring the full substring; (3) rank by token-hit count, then recency (`updatedAt`).
  Structured filters and the tool schemas stay unchanged; no new table or migration.
- **Done when:** golden-query recall beats the substring baseline on the fixed eval set from
  §3.1; latency is unchanged at the entry counts we target (tens–hundreds).

### 3.4 Dedup & Merge Pipeline — P1

- **Why:** the review prompt *asks* the model to omit known memories, but the store is
  write-through, so near-duplicates can accumulate.
- **How:** on the extraction path only, before `add`: (1) cheap prefilter against the current
  snapshot (normalized-token Jaccard — no embeddings, see §5); (2) optional LLM judge with a
  duplicate / update / new verdict (the judge prompt takes the compact index rendering from
  §3.12 instead of full entry contents, keeping its cost bounded); (3) on duplicate →
  `update` the existing entry (merge content, bump `updatedAt`) instead of `add`.
  Model-initiated `memory_add` stays explicit
  (intent wins); optionally return a "similar entry exists" hint with the existing id in the tool
  result.
- **Done when:** on a synthetic-duplicate dataset (≥ 50 seed facts each rewritten 3× with
  near-duplicate phrasing, plus ≥ 50 genuinely distinct facts as controls — checked into
  `tests/fixtures/dedup/`), the post-pipeline duplicate rate is **≤ 5%** while distinct-fact
  retention (precision/recall report against the seed set) is **≥ 95%**. The dataset and the
  threshold are the gate; both are defined here so the §3.1 harness can exercise it on landing.

### 3.5 Memory Lifecycle — P2

- **Why:** memories are removed only manually today; stale entries degrade retrieval and consume
  prompt budget.
- **How:** per-scope decay policy (e.g., project-scoped entries decay after N days without recall
  hits; `user`/`global` persist), `supersedes` links (a new entry invalidates an older one),
  pinning (immune to decay), and a deterministic janitor pass (on `session/created` or a timer)
  that records every action in the §3.2 audit store.
- **Done when:** decay never touches pinned or `global` entries; janitor behavior is logged and
  reviewable from the audit store.

### 3.6 Extraction Upgrades — P1

- **Admission rules:** what may persist *at all* (exclusion list, execution-verified procedures,
  new `procedure` category) is defined in §3.13; the prompts tuned here are where it is enforced.
- **Dedicated model option:** an `extractionModel` setting (provider/model override; default =
  session route) so review/flush can run on a cheap, fast model.
- **Project auto-detection:** infer `projectName` for candidates that imply project scope (from
  the session's workspace context), so extracted project memories are filterable instead of
  falling into `global`.
- **Richer signals:** accumulate candidates from tool-call failures, repeated errors, and
  confirmed corrections — not only user-message keywords.
- **Prompt tuning & i18n:** extraction prompts in the session's language; a regression harness
  (golden sets) gates prompt changes.
- **Cost guardrails:** per-session extraction budget (max calls) and backoff after repeated
  failures.
- **Done when:** settings expose the model override; a scripted failure session extracts the
  correct scope/category; every prompt change is gated by the §3.1 regression suite (this item
  is blocked by §3.1's golden-set extraction harness — see the §4 dependency edge).

### 3.7 Observability — P2

- **How:** counters (extraction calls, entries stored/rejected, scanner hits by class,
  zero-result search count — feeds the §5 decision gate) collected in-process and persisted in
  the §3.2 audit store, surfaced through the §3.8 UI (`ctx.remote.memory.*`) plus a
  settings-page health row (last extraction time, entry counts by scope); an optional
  audit-log file export.
- **Done when:** a user can answer "what was learned this session, and why" from the UI alone.

### 3.8 Memory Management UI — P1

- **Why:** data is browsed through the tools and the JSON file today; users want a first-class
  view and editor. A plain settings section cannot do this: `installSettingsSection` registers a
  JSON settings namespace (form fields only) and the `settings.*` RPC is loopback-only.
- **How:** a first-class data view is a **client plugin**, shipped inside the same package
  (zero host changes): declare `dsh.client` (`platform: 'web'`) in `package.json` with
  `exports["./client"]` — the host's client-module registry serves it at
  `/plugins/<id>/client.js` (host docs: `docs/subsystems/client-modules.md`). The bundle
  registers a `settings.section` (or `settings.plugins.tab`) slot whose component is arbitrary
  React: browse by scope (cards with id, category, timestamps), a search box, add / edit /
  replace / delete, i18n via the locale seat. Data access goes through the **Typert API
  Gateway**: expose `MemoryStore` reads/writes as `@Remote` methods on a small
  `TypertRemoteService` wrapper that delegates to `ctx.memory` (writes stay scanner-gated and
  write-serialized through the store contract), called from the UI as `ctx.remote.memory.*`
  (host docs: `docs/api-gateway.md`). Precedent: `ui-agent-preset`'s `AgentPresetSection`
  (roster cards, delete, read-only viewer, all over RPC). The same section renders a **memory
  activity panel** — a timeline over the §3.2 audit store (source, scope, preview, ts), the
  user-visible answer for extraction-triggered writes that never pass through a tool card.
- **Verification caveat (open before implementation):** the client-module manifest field
  (`dsh.client`), the `/plugins/<id>/client.js` serving path, and the two cited host docs are
  consumed as-documented but are **not verifiable from this package's installed npm dependencies**
  — no published `@deepseek-ai/*` package carries a `dsh.client` manifest today, and the two
  docs are not shipped inside any dependency (the `@Remote` gateway itself is real: it resolves
  in `@deepseek-ai/dsh-typert-protocol` and is exercised by `dsh-user-approval`). Before any
  §3.8 code lands, pin both docs to a concrete dsh release line in the project's pinned host
  checkout (not the npm tarball) and confirm the manifest/serving convention matches; if the
  convention has drifted, re-scope this item against the actual seam first. This is the one
  P1 item whose host surface is asserted from host documentation rather than from a dependency
  this package can import.
- **Done when:** full CRUD round-trip from the UI through `ctx.remote.memory.*`; changes are
  reflected in the next session's snapshot; the activity panel shows extraction-triggered
  writes; remote (non-loopback) browser access is explicitly out of scope (would need a
  `memory.*` apiproxy domain, §6).

### 3.9 Pluggable Storage Backends — P2

- **Why:** a single local JSON file is single-process and local-only.
- **How:** keep the `MemoryStore` seam as the provider contract; add a SQLite provider (single
  file, cross-process safe) and an optional server/REST provider for team-shared memory; a
  JSON → SQLite migration tool; document the contract (scanner enforcement, write
  serialization) for third-party providers.
- **Done when:** two or more providers pass the shared contract suite
  (`tests/store-contract.spec.ts` as the gate).

### 3.10 Scanner Hardening — P2

- **Why:** regex detection has false positives (legit text mentioning tokens) and false
  negatives (novel injection phrasings).
- **How:** expand the pattern corpus (more provider key shapes, URL-embedded tokens); an
  allowlist mechanism (the user marks expected patterns, e.g., redacted sample keys in docs);
  periodic FP/FN review against the corpus; an optional small-LLM second pass for "suspicious
  but no pattern hit" content.
- **Done when:** corpus FP rate is **≤ 2%** on the legit-content corpus with **0** regressions
  on the known-attack corpus (both checked into `tests/fixtures/scanner/`, extended from the
  §3.1 golden set); the allowlist covers every user-marked expected pattern.

### 3.11 Cross-Session Consistency — P2 (exploratory)

- **Why:** memory can conflict with the user's current statement or with newer evidence.
- **How:** at context assembly, optionally detect entries that conflict with facts stated in the
  current session (LLM judge on flagged pairs) and render them as `stale` / `conflicting` in the
  snapshot ("memory conflicts with current evidence") instead of silently overwriting.
- **Done when:** conflicts are surfaced to the user and resolution (keep / replace) is explicit.

### 3.12 Bounded Existence Index (L1-lite) — P1

- **Why:** the default `policy-only` mode tells the model the tools exist but not *what is
  stored*; the model must guess keywords for `memory_search`, and a missed keyword means a
  missed memory. Visibility is the first-order recall problem; matching is second-order.
- **How:** add a fifth `memoryMode` value, `index` (settings-namespace extension; the default
  stays `policy-only`, so the lightweight default is unchanged). In `index` mode the per-session
  frozen snapshot renders one existence line per entry —
  `<scope>/<category> · <projectName?> · <id> · <content truncated to ~80 chars>` — ordered by
  relevance (current-project `project` scope first, then `user`, then `global`; within a tier by
  `updatedAt` descending). When the budget (`memoryCharLimit`) is exhausted, the tail collapses
  into category-level roll-up lines (`project/convention ×12`), so the index size grows with the
  number of *categories*, not entries — the L1-boundedness invariant. The model then routes
  index → `memory_get(id)` / `memory_search`: the LLM is the decoder. Rendering is a pure
  function in `context/` over the existing `WeakMap` frozen snapshot — KV-cache prefix
  stability is unchanged — and the same renderer feeds the §3.4 judge prompt compactly.
- **Done when:** `index` mode renders deterministically under `memoryCharLimit`; the
  frozen-snapshot invariant and prefix stability hold; a scripted session in which the model
  finds a stored fact *by reading the index and calling `memory_get`* passes.

### 3.13 Admission Discipline: "No Execution, No Memory" — P1

- **Why:** keyword signals + threshold extraction admit whatever the LLM finds "interesting";
  garbage in is caught only post-hoc by §3.4. The quality gate belongs at write time.
- **How:** the extraction/flush prompts adopt an exclusion list and an execution rule:
  transient states, one-time events, and unverified hypotheses are never persisted; procedural
  memories ("how to do X", including failure workarounds and tool quirks) are admitted only when
  the action was verified by tool execution within the session. A new optional `procedure`
  category value (additive enum change, backward compatible) marks procedural memories so §3.3
  and §3.12 can order/roll them up differently. Prompt changes are gated by the §3.1 regression
  harness.
- **Done when:** a scripted session containing transient chatter plus one execution-verified
  procedure extracts only the procedure, with correct scope/category; the golden sets reject
  unverified-hypothesis lines; pre-existing entries remain valid under the extended enum.

### 3.14 Memory Activity in the Trajectory — P1

- **Why:** users should see the memory read/write process on demand in the session trajectory —
  which memories a search matched, what was written — without expanding raw tool JSON.
- **How (tool cards, plugin-side, independent):** add `presentResult` +
  `output.presentationMeta` to the six tools so structured data survives replay:
  `memory_search` gets a `kind:'search'` call card (title = query) and a `card:'search'`
  result (entries as match groups, capped, with total — the fs-`grep` pattern);
  `memory_add` / `memory_replace` get a call card previewing the content (first ~80 chars) and a
  result card with scope/category/id; `memory_remove` / `memory_get` stay compact generic.
  This covers every model-initiated read/write in the trajectory and needs no host change:
  tool calls render in the chat trajectory by default, and presenters are part of the
  `defineTool` API.
- **Deferred (would need host changes — §6.1/§6.2):** memory rows inside the *chat flow*
  (a `ConversationNodeDefinition` for `memory/*` session events) and a dedicated
  trajectory-table row (closed `TrajectoryCellKind` in `ui-trajectory`). Both are blocked by
  the session-event emission blocker (§5). The §3.8 activity panel covers the
  extraction-write visibility gap outside the chat flow.
- **Out of scope:** bespoke per-entry chips (closed `ToolResultView` union); a custom
  `tool.call.toolview` React row via the §3.8 client bundle is a possible plugin-side
  follow-up.
- **Done when:** refresh/replay shows identical cards from persisted `presentationMeta`; a
  session that matched 3 entries in one search shows the query + the 3 ids in the trajectory;
  an add/replace card shows the stored content preview and the resulting id.

---

## 4. Prioritization & Sequencing

| Priority | Items | Rationale |
|---|---|---|
| P0 | 3.1, 3.2 | Foundation: test gate + audit store; everything else builds on them |
| P1 | 3.12, 3.13, 3.4, 3.3, 3.6, 3.8, 3.14 | Visibility and write-time quality first (index, admission), then memory health and usability (dedup, lexical retrieval, extraction upgrades, UI, trajectory activity) |
| P2 | 3.5, 3.7, 3.9, 3.10, 3.11 | Maturity: lifecycle, observability, storage options, security, consistency |

Sequencing notes:

- 3.1 before any item whose "done when" is gated by the golden-set / regression harness:
  **3.6** (prompt-change regression) and **3.13** (golden-set rejection of unverified
  hypotheses) both depend on 3.1's extraction corpus to be checkable; 3.4 and 3.10 likewise
  consume the §3.1 fixtures (`tests/fixtures/dedup/`, `tests/fixtures/scanner/`).
- 3.2 (audit store) before 3.7 (observability) and 3.5 (janitor logging).
- 3.12 and 3.13 are prompt/settings-only changes with no new backend surface; they can land
  ahead of everything else in P1 (3.13's *done-when check* still waits on 3.1, but the
  `procedure` category + prompt edits themselves are unblocked).
- 3.14's tool-card part is independent; its chat-flow node is deferred under the no-host-
  change policy (§5/§6), with the §3.2 audit store + §3.8 activity panel as the substitute.
- 3.8 needs a host-doc verification spike (see its "Verification caveat") before
  implementation; it is the only P1 item with a pre-implementation gate.
- 3.4 ships without 3.3 (token-based prefilter); neither uses embeddings.
- 3.9 is independent of the retrieval approach; it should still land after 3.4/3.5 so the
  provider contract stabilizes first.
- Any future semantic-retrieval proposal must pass the §5 decision gate.

---

## 5. Rejected Directions & Decision Gate

Considered and rejected for the v0.x line. Revisit only through the decision gate below.

| Direction | Rejected because |
|---|---|
| **`memory/*` session-event emission** (was §3.2) | The no-host-change policy. The host's persistence read path refuses to reload logs containing event types outside its in-repo-only `KNOWN_SESSION_EVENT_TYPES` whitelist (the `known-event-types` module documents this refuse-to-interpret rule; the `SessionEvent.ignorable` marker is the only escape hatch, and it is a *reader-side* field — `Session.append` constructs the envelope from `sourceEventSeqs`/`surfaceOp` only and never sets `ignorable`, so any event a plugin appends is a required event); no runtime registration seam for plugin-declared types exists in the installed dependencies. Emitting would make affected sessions **fail to resume**. Replaced by the plugin-owned audit store (§3.2) + activity panel (§3.8); the type declarations stay reserved; reopen only if an upstream seam lands (§6.1). (Earlier drafts cited `assertEventsSupported` and `PersistenceCoordinatorOptions` by name; those symbols do not resolve in the published `@deepseek-ai/*` deps — likely they live in the unpublished `dsh-web-app` layer or carry different names on the pinned release line. The refusal mechanism itself is real and documented; re-pin the exact symbol when wiring the §3.1 log-hygiene case.) |
| **Embedding / vector hybrid retrieval** (former §3.3) | Contradicts the design doc's own scale argument (n = tens–hundreds; an O(n) scan is fine, no index needed). At this scale it buys marginal recall for a new `embeddings` table + domain migration, vector caching, and an embedding-source decision that either couples provider routing into the `MemoryStore` seam or adds a host dependency. Well-organized non-embedding retrieval has demonstrably beaten embedding-based systems (Mem0, A-MEM) at comparable scale. |
| **In-plugin archive layer** (GA L4) | The host's session logs are the archive; the flush paths already mine them at compaction/dispose. A second copy violates "consume, don't reinvent". |
| **Per-turn working-memory anchor** (GA) | In-session context management is the host's compaction/projection job; per-turn injection would break the per-session frozen-snapshot / KV-cache prefix-stability invariant. |
| **File-based L2/L3 physical layering** (GA) | `storage-domain` + the six tools are the right physical substrate. The fact/procedure distinction is adopted *logically* (`procedure` category + admission rules, §3.13), not by re-architecting the store. |

**Strengths that are not tradable.** Any future redesign must preserve: fail-closed scanning on
every write path; the per-session frozen snapshot (KV-cache prefix stability); bounded,
event-driven extraction that reuses the session's provider routing (no extra keys or billing
channel); the `MemoryStore` contract as the single seam between consumers and backends.

**Decision gate for semantic retrieval.** §3.7 telemetry records zero-result searches
(query, active filters, count). Semantic retrieval may be re-proposed only if, after §3.3 +
§3.12 ship, sustained real-world miss rates prove that lexical + index recall has plateaued —
and even then it must be an opt-in, host-provided embedding service. Vectors are never
embedded in-package. The same no-host-change policy gates all session-log writes: any future
proposal to write plugin data into the session event log must first name the host seam that
makes it safe (§6.1) and a §3.1 log-hygiene case proving it.

---

## 6. Host Constraints (No-Host-Changes Policy)

**Policy: v0.x never modifies the host codebase.** All plugin-side seams mentioned in
§3.8/§3.14 (client module table, `@Remote` gateway, conversation-node assembly,
`presentResult`/`presentationMeta`) are existing host features consumed as documented — zero
host changes. The table below lists capabilities that *would* require host changes; each has a
plugin-side substitute or is explicitly out of scope. No row in this table is a v0.x
dependency.

| # | Blocked capability | Why it needs a host change | Plugin-side substitute / status |
|---|---|---|---|
| 6.1 | Emitting `memory/*` events into the session log | The persistence read path refuses logs containing types outside the in-repo-only `KNOWN_SESSION_EVENT_TYPES` whitelist; `Session.append` builds the envelope from `sourceEventSeqs`/`surfaceOp` only and never sets the reader-side `ignorable` marker, so a plugin-appended event is always required; no runtime registration seam in the installed deps. (Earlier drafts named `assertEventsSupported`/`PersistenceCoordinatorOptions`; those symbols do not resolve in the published deps — re-pin to the real symbol on the pinned dsh release line when adding the §3.1 guard.) | Plugin-owned audit store (§3.2) + activity panel (§3.8). Type declarations stay reserved; reopen only if upstream ships a seam — optional, never a dependency. |
| 6.2 | Memory rows in the chat flow / trajectory table | Needs 6.1 (chat node) or an addition to `ui-trajectory`'s closed `TrajectoryCellKind`. | Tool cards (§3.14) show model-initiated reads/writes in the trajectory; the §3.8 activity panel covers extraction writes. |
| 6.3 | `memory.*` domain in the apiproxy `RpcMethodMap` | `RpcMethodMap` is a closed registry in the host's apiproxy. | Loopback (local web app) access works today through the `@Remote` gateway; remote/headless browsers are out of scope for v0.x. |

Versioning rule: every consumed host seam is pinned to the dsh release line that provides it
(the package already follows the dsh release line via peer ranges); a capability in this table
is reopened only against a release line that actually ships the required seam, verified by a
§3.1 integration case.

---

## 7. Cross-Cutting Constraints for All Evolution Work

1. No breaking change to the four-row bundle shape; evolve within the existing export sub-paths.
2. New settings extend the `memory` namespace with safe defaults — existing users are unaffected
   on upgrade.
3. Every new write path goes through `scanContent`.
4. Newly injected content counts against `memoryCharLimit`; the per-session frozen-snapshot
   invariant (KV-cache prefix stability) is preserved.
5. Background work (extraction, dedup judging, janitor, migration) is best-effort and never
   blocks the agent loop.
6. The `MemoryStore` contract stays the single seam between consumers and backends.
7. No embedding models, vector indexes, or in-package semantic retrieval: search stays lexical
   over structured entries. Semantic retrieval, if ever approved through the §5 decision gate,
   is an opt-in host-side service.
8. No host changes: v0.x neither makes nor assumes host-code changes; capabilities blocked by
   the host (§6) are replaced with plugin-side substitutes or explicitly deferred, and the
   plugin never writes plugin data into the session event log (the §3.1 log-hygiene case is the
   guard).
