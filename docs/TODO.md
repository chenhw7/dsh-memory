# TODO & Evolution Plan — `@chenhw7/dsh-memory`

> Companion to [TECH_DESIGN.md](./TECH_DESIGN.md) (English) / [TECH_DESIGN.zh-CN.md](./TECH_DESIGN.zh-CN.md) (Chinese).
> This document tracks the plugin's current scope boundaries and **how it should evolve**: what to
> build next, why, the intended approach, and what "done" looks like for each item.

---

## 1. Current Scope Boundaries

v0.1.x ships a deliberately narrow, verifiable core: one JSON file, six tools, rule + LLM
extraction, and four prompt-injection modes. The areas intentionally left outside the current
scope — and their evolution items — are:

| Area | Current shape | Evolution item |
|---|---|---|
| Retrieval | Structured filters + case-insensitive substring matching | §3.3 Hybrid retrieval |
| Memory health | Write-through store; dedup is advisory (prompt-level) only | §3.4 Dedup & merge |
| Memory lifecycle | Entries live until replaced or removed | §3.5 Memory lifecycle |
| Extraction | Session-routed model; user-message keyword/correction signals | §3.6 Extraction upgrades |
| Observability | Results surface through the tools; no audit events emitted | §3.2 + §3.7 |
| User-facing UI | Settings (behavior configuration) only | §3.8 Memory management UI |
| Storage | Single local JSON file, single process | §3.9 Pluggable backends |
| Content security | 24-pattern regex scanner, fail-closed | §3.10 Scanner hardening |
| Testing | Unit / contract / tool spec layers; runner wiring pending | §3.1 Test infrastructure |

---

## 2. Evolution Goals

North star: a memory subsystem that is

- **Retrievable** — the right memories surface when needed (semantic + structured hybrid);
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
  scanner and parser have corpus-based FP/FN regression checks.

### 3.2 Emit `memory/*` Session Events — P0

- **Why:** `memory/added | updated | removed` are declared on the session `SessionEventMap` but
  not yet emitted by the write paths; audit trails and UI timelines need them.
- **How:** after each successful mutation, append the corresponding log-only event (payloads are
  already specified: id / scope / content / category). Keep them non-surface events so derived
  message history is unaffected.
- **Done when:** every successful add/update/remove produces exactly one event with the declared
  payload; derived history is unchanged.

### 3.3 Hybrid Retrieval — P1

- **Why:** substring matching misses paraphrases; recall depends on keyword overlap.
- **How:** introduce embeddings behind the existing `MemoryStore.search` seam. Decide the
  embedding source first (host embedding service if available; otherwise an in-package LLM
  embedding call with cached vectors). Store vectors in a new `embeddings` table (domain version
  0 → 1, with a migration from the JSON v0 data) or in a sidecar file keyed by entry id. Compose
  the final score from semantic similarity, recency (`updatedAt`), and hit frequency; structured
  filters stay unchanged. Expose the strategy (`substring` | `hybrid`) as a setting, defaulting
  to `hybrid` when embeddings are available.
- **Done when:** golden-query recall beats the substring baseline on a fixed eval set; p95 search
  latency stays bounded by caching; tool schemas are unchanged (no breaking change).

### 3.4 Dedup & Merge Pipeline — P1

- **Why:** the review prompt *asks* the model to omit known memories, but the store is
  write-through, so near-duplicates can accumulate.
- **How:** on the extraction path only, before `add`: (1) cheap prefilter against the current
  snapshot (normalized-token Jaccard; embeddings once §3.3 lands); (2) optional LLM judge with a
  duplicate / update / new verdict; (3) on duplicate → `update` the existing entry (merge
  content, bump `updatedAt`) instead of `add`. Model-initiated `memory_add` stays explicit
  (intent wins); optionally return a "similar entry exists" hint with the existing id in the tool
  result.
- **Done when:** on a synthetic-duplicate dataset, the duplicate rate is below a chosen threshold
  while distinct-fact retention (precision/recall report) stays high.

### 3.5 Memory Lifecycle — P2

- **Why:** memories are removed only manually today; stale entries degrade retrieval and consume
  prompt budget.
- **How:** per-scope decay policy (e.g., project-scoped entries decay after N days without recall
  hits; `user`/`global` persist), `supersedes` links (a new entry invalidates an older one),
  pinning (immune to decay), and a deterministic janitor pass (on `session/created` or a timer)
  that records every action via §3.2 events.
- **Done when:** decay never touches pinned or `global` entries; janitor behavior is logged and
  reviewable from the audit events.

### 3.6 Extraction Upgrades — P1

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
  correct scope/category; every prompt change is gated by the regression suite.

### 3.7 Observability — P2

- **How:** counters (extraction calls, entries stored/rejected, scanner hits by class) surfaced
  through §3.2 events; a settings-page health row (last extraction time, entry counts by scope);
  an optional audit-log file.
- **Done when:** a user can answer "what was learned this session, and why" from the UI alone.

### 3.8 Memory Management UI — P1

- **Why:** data is browsed through the tools and the JSON file today; users want a first-class
  view and editor.
- **How:** the settings page gains a memory data section: browse by scope (cards with id,
  category, timestamps), a search box, edit/replace, delete, and add — calling the existing six
  tools / store backend through the host's frontend RPC. No new backend surface is needed.
- **Done when:** full CRUD round-trip from the UI; changes are reflected in the next session's
  snapshot.

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
- **Done when:** corpus FP rate is below threshold with no regression on known-attack samples.

### 3.11 Cross-Session Consistency — P2 (exploratory)

- **Why:** memory can conflict with the user's current statement or with newer evidence.
- **How:** at context assembly, optionally detect entries that conflict with facts stated in the
  current session (LLM judge on flagged pairs) and render them as `stale` / `conflicting` in the
  snapshot ("memory conflicts with current evidence") instead of silently overwriting.
- **Done when:** conflicts are surfaced to the user and resolution (keep / replace) is explicit.

---

## 4. Prioritization & Sequencing

| Priority | Items | Rationale |
|---|---|---|
| P0 | 3.1, 3.2 | Foundation: test gate + audit events; everything else builds on them |
| P1 | 3.4, 3.6, 3.8, 3.3 | Memory health and usability first: dedup, smarter extraction, user UI, better retrieval |
| P2 | 3.5, 3.7, 3.9, 3.10, 3.11 | Maturity: lifecycle, observability, storage options, security, consistency |

Sequencing notes:

- 3.2 (events) before 3.7 (observability) and 3.5 (janitor logging).
- 3.4 can ship without 3.3: token-based prefilter first, embeddings plug in later.
- 3.3 depends on the embedding-source decision; 3.9 should land after 3.4/3.5 so the provider
  contract stabilizes first.

---

## 5. Cross-Cutting Constraints for All Evolution Work

1. No breaking change to the four-row bundle shape; evolve within the existing export sub-paths.
2. New settings extend the `memory` namespace with safe defaults — existing users are unaffected
   on upgrade.
3. Every new write path goes through `scanContent`.
4. Newly injected content counts against `memoryCharLimit`; the per-session frozen-snapshot
   invariant (KV-cache prefix stability) is preserved.
5. Background work (extraction, embeddings, janitor, migration) is best-effort and never blocks
   the agent loop.
6. The `MemoryStore` contract stays the single seam between consumers and backends.
