# Technical Design: `@chenhw7/dsh-memory` — Long-Term Memory for the DeepSeek Harness

| | |
|---|---|
| Package | `@chenhw7/dsh-memory` |
| Version covered | 0.1.1 (as published) |
| Host | [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) — Cordis-based composition |
| Language / runtime | TypeScript (strict, ESM), Node.js 22 |
| License | MIT |
| Status | Implemented, published to npm |
| 中文版 | [TECH_DESIGN.zh-CN.md](./TECH_DESIGN.zh-CN.md) |

---

## 1. Summary

`@chenhw7/dsh-memory` is a self-contained npm package that adds cross-session long-term memory to the DeepSeek Harness. It installs as **one profile layer** via a bundled `cordis.patch.yml` and contributes six composition rows over `dsh-base`:

| Row | Export | Responsibility |
|---|---|---|
| `memory-root` | `@chenhw7/dsh-memory` | No-op root entry for client-module scanner discovery |
| `memory-store` | `@chenhw7/dsh-memory/store` | Durable KV storage; registers the `ctx.memory` service |
| `tool-memory` | `@chenhw7/dsh-memory/tool` | Eight model-facing tools (`memory_search/add/replace/remove/list/get/pin/unpin`) |
| `memory-review` | `@chenhw7/dsh-memory/review` | Automatic learning: rule-based candidate accumulation + LLM extraction + compaction/dispose flush + dedup + janitor |
| `memory-context` | `@chenhw7/dsh-memory/context` | System-prompt memory section (5 injection modes) + frontend settings namespace |
| `memory-remote` | `@chenhw7/dsh-memory/remote-service` | `@Remote` service for memory management UI |

Memories are structured records with three scopes (`global` / `project` / `user`), persisted to a single JSON file under `$DSH_HOME/storages/`. Every write path is security-scanned against secrets, prompt-injection, and exfiltration patterns. All behavior is configurable from the dsh settings UI and applies live.

---

## 2. Background & Motivation

dsh sessions are ephemeral: closing a session discards the context window, and in-session compaction compresses older turns into a summary. This causes recurring pain:

- Users repeatedly re-explain preferences ("always use pnpm here", "I prefer concise answers").
- Corrections are forgotten; the agent repeats the same mistakes across sessions.
- Durable facts (repo conventions, tool quirks, environment facts) must be re-communicated every session.
- After compaction, details shadowed out of the summary are simply lost.

dsh's plugin system — Cordis dependency injection, profile bundles, and `cordis.patch.yml` layers — allows new capabilities to be installed without forking the harness. This design adds a memory layer that:

1. **Persists** facts, preferences, corrections, and lessons durably.
2. **Exposes** them to the model through first-class tools.
3. **Accumulates** them automatically without user effort (rule-based triggering, LLM extraction).
4. **Guards** the store: secrets and injection payloads cannot be written.

---

## 3. Goals

- **G1 — Durable storage.** Facts survive across sessions and process restarts.
- **G2 — Three-layer scoping.** `global` (cross-project), `project` (per repo), `user` (cross-project profile of the user).
- **G3 — First-class model tools.** Eight tools with clean schemas, model-readable error messages, and UI call cards (`memory_search/add/replace/remove/list/get/pin/unpin`).
- **G4 — Automatic learning.** (a) Periodic review extraction when enough candidate signals accumulate; (b) flush extraction when compaction shadows context; (c) flush extraction on session dispose.
- **G5 — Safe writes.** Every write path (model tool, background extraction, store contract) scans content for secrets / injection / exfiltration and rejects on hit.
- **G6 — Frontend-configurable, live.** All settings exposed through the dsh settings UI (`memory` namespace) and applied without restart.
- **G7 — One-command install / uninstall.** `dsh plugin add` / `dsh plugin remove`; uninstall preserves user data.

The evolution of the plugin beyond the current scope — retrieval quality, memory lifecycle, extraction intelligence, observability, and a memory-management UI — is tracked in [TODO.md](./TODO.md).

---

## 4. Design Principles

1. **One installable bundle.** A single npm package; its essence is `cordis.patch.yml` plus six export sub-paths (store, tool, review, context, remote-service, client). No multi-package workspace, no install-time build for npm installs.
2. **Consume, don't re-implement.** All dsh core capabilities (storage, tools, LLM, sessions, system prompt, settings, compaction events, invariants) are consumed as **peer dependencies** through the Cordis service container — the plugin never duplicates host machinery.
3. **Service abstraction.** A `MemoryStore` abstract class is the contract; consumers (tools, review) depend only on `ctx.get('memory')`, never on the backend. The storage-domain-backed provider is swappable.
4. **Defense in depth on writes.** Content is scanned **twice**: at the tool boundary (fast, model-readable rejection) and again inside the store contract (so background paths cannot bypass it).
5. **Never block the agent loop.** Review/flush extraction is best-effort and fire-and-forget at the critical points (compaction end, dispose); a failing or slow LLM call can never stall a step, a compaction, or a dispose.
6. **Fail loud where it matters, fail soft where it doesn't.** Missing services fail loudly at the earliest point a user can see (a tool call), while background extraction silently degrades to a no-op.
7. **Prompt-budget discipline & cache stability.** Injected memory content is capped (`memoryCharLimit`), read **once per session** into a frozen snapshot (stable KV-cache prefix), and re-assembled only when settings change.
8. **Zero-config start, live-tunable.** Sensible defaults ship; every knob is editable from the settings UI and takes effect on the next assembly.

---

## 5. Overall Architecture

### 5.1 Bundle composition

The `dsh.bundle.patch` manifest field points at `cordis.patch.yml`, which inserts six rows over `dsh-base`. Row order carries no load semantics; the grouping is for readability.

| Row | Required (`inject`) | Optional (read via `ctx.get`) | Role |
|---|---|---|---|
| `memory-root` | — | — | No-op root entry for client-module scanner discovery |
| `memory-store` | `storageDomain` | — | Opens the `memory` domain; registers `ctx.memory` |
| `tool-memory` | `tools` | `memory` | Registers the eight model tools |
| `memory-review` | `llm` | `memory`, `sessionProjections` | Accumulator + periodic review + flush + dedup + janitor |
| `memory-context` | `systemPrompt` | `memory` | Settings namespace + system-prompt section |
| `memory-remote` | `memory` | — | `@Remote` service for memory management UI |

```mermaid
flowchart TB
  subgraph host["dsh host · Cordis composition"]
    base["dsh-base + dsh-web-app layers<br/>(session · agent · llm · tools · systemPrompt · settings · compaction · storage-json + storage-domain)"]
    subgraph bundle["@chenhw7/dsh-memory — one layer, six rows"]
      root["memory-root<br/>no-op scanner entry"]
      store["memory-store · /store<br/>ctx.memory provider"]
      tool["tool-memory · /tool<br/>eight model tools"]
      review["memory-review · /review<br/>accumulator + LLM extraction + dedup + janitor"]
      context["memory-context · /context<br/>prompt section + settings namespace"]
      remote["memory-remote · /remote-service<br/>@Remote service for UI"]
    end
  end
  base ==> bundle
  store -- "ctx.get('memory')" --> tool
  store -- "ctx.get('memory')" --> review
  store -- "frozen snapshot per session" --> context
  store -- "ctx.get('memory')" --> remote
  review -- "ctx.llm.stream (session route)" --> llm["LLM provider / model"]
  store -- "serialized writes" --> json["$DSH_HOME/storages/memory.json"]
```

### 5.2 Integration seams (how the plugin attaches to the host)

- **Service registration:** the store provider calls `ctx.provide('memory', new DomainMemoryStore(...))`. Consumers resolve it lazily with `ctx.get('memory')` and throw a model-readable error when absent — the service is *optional* at composition time so memory-less deployments stay loadable.
- **Type-level merging (module augmentation):**
  - `Context.memory: MemoryStore` on `@deepseek-ai/cordis`;
  - `Context.memoryRemote: MemoryRemoteService` on `@deepseek-ai/cordis`;
  - `memory/added | memory/updated | memory/removed` log-only events on `SessionEventMap` of `@deepseek-ai/dsh-session`;
  - `memory-review-candidates` projection key on `SessionProjectionMap` of `@deepseek-ai/dsh-session-projection`.
- **Event hooks:** `agent/pre-step` (drain the accumulator), `session/event` → `compaction/end` (flush), `session/disposed` (flush), `session/created` (freeze the per-session memory snapshot; also run the janitor to decay old project-scoped entries when `decayDays > 0`).
- **Prompt registry:** one `memory` section at order **90**, i.e. before tool guidance (100–199).
- **Settings:** the `memory` namespace is registered with `applies: 'live'`, persisted in `$DSH_HOME/settings.yaml`.

### 5.3 End-to-end data flows

**Write path (model-initiated):**

```mermaid
flowchart LR
  A["memory_add / memory_replace<br/>(tool call)"] --> B{"tool-boundary<br/>scanContent()"}
  B -- "hit" --> E1["model sees error:<br/>content rejected: reasons"]
  B -- "clean" --> C{"scope=project<br/>with projectName?"}
  C -- "no" --> E2["error: project-scoped<br/>memory requires a projectName"]
  C -- "yes" --> D["store.add / store.update<br/>(re-scanned: defense in depth)"]
  D --> E["entries.put()<br/>→ $DSH_HOME/storages/memory.json"]
```

**Read path:** `memory_search` / `memory_list` / `memory_get` read synchronously from the domain's authoritative in-memory state — structured filters, token-based matching (CJK per-character + Latin word tokens, case-folded), sorted by token hit count descending then `updatedAt` descending (search: default limit 50; list: `createdAt` asc, paginated by `limit`/`offset`).

**Automatic-extraction path:**

```mermaid
sequenceDiagram
  participant U as user/message event
  participant ACC as projection accumulator
  participant STEP as agent/pre-step hook
  participant LLM as ctx.llm.stream
  participant SCAN as scanContent
  participant STORE as ctx.memory

  U->>ACC: pure synchronous fold<br/>(keyword / correction / tool-failure signal)
  Note over ACC: candidates accumulate; no LLM here
  STEP->>ACC: snapshot + per-session high-water mark
  alt unprocessed candidates >= threshold (default 10)
    STEP->>LLM: one extraction call<br/>(provider/model routed from session)
    LLM-->>STEP: lines of "scope: content"
    loop each parsed line
      STEP->>SCAN: scanContent(line)
      STEP->>STORE: findDuplicate → judgeDuplicate → merge/update/add<br/>(rejected lines skipped)
    end
    STEP->>ACC: advance high-water mark
  else below threshold
    Note over STEP: no-op
  end
```

Flush paths (`compaction/end`, `session/disposed`) reuse the same LLM-extract-parse-store pipeline on the fragments being shadowed; they are fire-and-forget and never block their event (§7.3.4).

---

## 6. Data Model & Storage

### 6.1 Record

```ts
interface MemoryEntry {
  readonly id: MemoryId          // branded UUID v4 (Branded<'MemoryId'>)
  readonly scope: 'global' | 'project' | 'user'
  readonly category?: 'failure' | 'correction' | 'insight'
                  | 'preference' | 'convention' | 'tool-quirk'
                  | 'procedure'
  readonly content: string       // human-readable memory text
  readonly projectName?: string  // required when scope === 'project'
  readonly pinned?: boolean       // when true, entry is exempt from janitor decay
  readonly createdAt: number     // Unix epoch ms
  readonly updatedAt: number     // Unix epoch ms
  readonly lastRecalledAt?: number // Unix epoch ms, stamped on each search hit
}
```

JSON on the durable medium:

```json
{
  "id": "3f6c1a2e-…",
  "scope": "project",
  "category": "convention",
  "content": "This repo uses pnpm; never commit package-lock.json.",
  "projectName": "dsh-memory",
  "pinned": true,
  "createdAt": 1755500000000,
  "updatedAt": 1755500000000,
  "lastRecalledAt": 1755600000000
}
```

### 6.2 Scopes & categories

| Scope | Meaning | Example |
|---|---|---|
| `global` | Cross-project, environment/tool facts and durable learnings | "The user's network blocks npm proxy X" |
| `project` | Per-repo conventions, architecture, commands (keyed by `projectName`) | "This repo uses pnpm" |
| `user` | Who the user is: preferences, communication style, standing instructions | "The user prefers concise answers in Chinese" |

`category` is an optional lesson-type tag (used e.g. to mark automatic corrections); plain facts may omit it. The seven categories:

| Category | Meaning | Example |
|---|---|---|
| `failure` | A failure the agent hit and should avoid repeating | "Running tsc without -p fails in this monorepo" |
| `correction` | A user correction of the agent's prior behavior | "Don't commit package-lock.json" |
| `insight` | A general insight or learning | "The test suite is slow because of network calls" |
| `preference` | A user preference | "The user prefers concise answers in Chinese" |
| `convention` | A project or code convention | "This repo uses pnpm" |
| `tool-quirk` | A tool or library quirk | "esbuild CJS var hoisting requires defining RULES before inject()" |
| `procedure` | Verified step-by-step process confirmed by tool execution | "Build client: run build-client.cjs → check window.__ModuleLoader__" |

### 6.3 Persistence layout

- The store provider opens a storage-domain named **`memory`** (version 0) with **two tables**:
  - `entries` — a KV table keyed by `MemoryId`. Records are validated against a Zod schema on load.
  - `audit` — a KV table keyed by `AuditId`. The audit table is forward-compatible (domain version
    stays 0).
- The **audit table** records every `add`/`update`/`remove` with an `AuditEntry`:
  - `source`: `'tool'` | `'review'` | `'flush'` | `'ui'` — who triggered the write.
  - `op`: the operation performed (`'add'` | `'update'` | `'remove'` | `'pin'` | `'unpin'` | `'janitor'`).
  - `contentPreview`: first 100 chars of the entry content, redacted (set to `'[scanner rejected]'`)
    when the scanner rejects the content.
  - `ts`: Unix epoch ms.
  - `category?`: the entry's category, if set.
  - `sessionId?`: the session that triggered the write, when available.
  - The audit log is capped at **200 records** (configurable via `auditCap`); when exceeded, the
    oldest entries are evicted.
- **Reads** are synchronous from the domain's authoritative in-memory state; **writes** serialize
  on the domain's write chain and reach the JSON backend before in-memory state updates.
- The host's `storage-json` backend persists the whole domain to
  `$DSH_HOME/storages/memory.json` (Windows: `%USERPROFILE%\.dsh\storages\memory.json`).
- Uninstalling the plugin does **not** delete memories; deleting that one file wipes the data.

### 6.4 Session event vocabulary

`memory/added`, `memory/updated`, `memory/removed` are declared on the session's `SessionEventMap` as **log-only** events (no `surfaceOp`, they contribute nothing to derived history). They are part of the domain's reserved event vocabulary: the current write paths surface results through the tools, and these events keep the seam open for future instrumentation (audit trails, UI timelines) without a breaking change.

---

## 7. Subsystem Design

### 7.1 Memory store — `/store` (`src/store/`)

- **`MemoryStore` (abstract, in `src/index.ts`)** is the public contract:
  `add / get / list / update / remove / search / pin / unpin / janitor / health / exportAuditLog`.
  The contract *requires* implementations to run `scanContent` before persisting and to reject
  failing content — making the store itself safe even if a future consumer bypasses the tool
  boundary.
- **`DomainMemoryStore`** implements it over the storage-domain tables:
  - `add`: validate project scope → scan → mint `MemoryId` → `entries.put` → `appendAudit`.
  - `update`: scan the merged content; missing id → `undefined`.
  - `search`: scope/category/project filters + **token-based matching** (`tokenizeQuery`: CJK
    per-character + Latin word tokens, case-folded); results sorted by **token hit count
    descending**, then `updatedAt` descending; default limit 50; returns `{ entries, total }`.
    A fire-and-forget `markRecalled` stamps `lastRecalledAt` asynchronously on each hit.
  - `list`: optional scope + project filter, ordered by `createdAt` asc.
  - `pin(id)`: sets `pinned: true` on the entry; returns the updated entry or `undefined`.
  - `unpin(id)`: sets `pinned: false` on the entry; returns the updated entry or `undefined`.
  - `janitor(decayDays)`: only decays `project`-scoped entries (never `global` or `user`). Uses
    `lastRecalledAt ?? createdAt` as the last-active timestamp. If
    `now - lastActive >= decayDays * 86400000`, the entry is deleted and an audit record is
    appended. Pinned entries are exempt. Returns the count of decayed entries.
  - `health()`: returns `{ totalEntries, byScope, pinned, auditRecords, lastActivityTs?, lastExtractionTs? }`.
  - `exportAuditLog()`: returns all audit entries sorted by `ts` ascending.
  - `listAudit()`: returns audit entries sorted by `ts` descending.
  - `appendAudit`: best-effort (try/catch, swallows errors), creates an `AuditEntry` with
    `source`/`op`/`contentPreview` (first 100 chars, redacted if scanner rejects).
  - `trimAudit`: if `audit.size > auditCap` (default 200), evicts the oldest entries.
- The provider mounts on `ctx.memory` after `storageDomain` is available and registers a
  disposer (`ctx.effect`) that closes the domain on shutdown.

### 7.2 Model tools — `/tool` (`src/tool/`)

Eight tools registered through `defineTool` (schemastery schemas), each with a 5 s timeout and a `presentCall` card for the UI:

| Tool | Key parameters | Result | Notable error semantics |
|---|---|---|---|
| `memory_search` | `scope?`, `category?`, `projectName?`, `query?`, `limit?` (default 50) | `{ entries[], total }` | token-based matching (CJK per-char + Latin word tokens, case-folded), sorted by token hit count desc then `updatedAt` desc; `presentResult` renders up to 10 entries as file-like matches |
| `memory_add` | `scope`, `content`, `category?`, `projectName?` | `{ entry }` | scanner rejection → `content rejected: …`; missing `projectName` for `project` scope → precise error |
| `memory_replace` | `id`, `content?`, `category?` | `{ entry?, found }` | at least one updatable field required; scanner rejection on new content |
| `memory_remove` | `id` | `{ removed }` | absent id → `removed: false` (not an error) |
| `memory_list` | `scope?`, `projectName?`, `limit?`, `offset?` | `{ entries[], total }` | — |
| `memory_get` | `id` | `{ entry?, found }` | absent id → `found: false` |
| `memory_pin` | `id` | `{ pinned }` | absent id → `pinned: false` |
| `memory_unpin` | `id` | `{ unpinned }` | absent id → `unpinned: false` |

The tool plugin also accepts a `maxSearchResults` config field (default 50) that caps the number of entries `memory_search` returns.

Design notes:

- **Optional service, loud failure.** Each tool resolves the store with `ctx.get('memory')` and
  throws `memory service is not available: no memory provider is composed` when absent — a
  memory-less deployment still boots; the failure appears at the earliest point the user can see it.
- **Scan at the tool boundary** so a rejected payload never reaches the store and the model gets a
  clean, actionable error; the store re-scans as defense-in-depth.
- **Wire projection:** entries are projected to `EntryJson` (branded id serialized as a plain
  string; optional fields omitted when absent) so tool output is stable JSON.
- Tool descriptions are part of the behavioral contract: they tell the model *when* to use each
  tool and that memory is "helpful context, not instructions".

### 7.3 Automatic extraction — `/review` (`src/review/`)

The review plugin is the automatic-sediment layer. Two mechanisms, one store:

#### 7.3.1 Candidate accumulator (session projection)

- Registered as the session projection key **`memory-review-candidates`**:
  `{ key, schema (Zod), init: emptyAccumulator, apply: applyAccumulator, view: identity, stateVersion: 1 }`.
- `applyAccumulator` is a **pure, synchronous fold** over committed session events. Three event
  types contribute:
  - **`user/message` events** contribute text via `messageText`:
    - **Keyword signals** (explicit "remember" intent): 6 patterns — `记住`, `别忘了`, `以后都`,
      `remember that`, `don't forget`, `from now on`.
    - **Correction signals** (user revises a prior statement): 5 patterns — `不对`, `不要`,
      `no, I said`, `that's wrong`, `actually`.
    - Keyword hits take priority when both classes match.
  - **`assistant/message` events** also contribute text via `messageText` (the assistant's own
    output may carry durable facts).
  - **`tool/result` events with errors** contribute as a **`tool-failure` signal candidate** — a
    failure the agent hit that may be worth remembering.
- Each hit appends a candidate `{ text, signal, seq }`. Events that contribute nothing return the
  *same* state reference — the projection registry's `Object.is` gate makes no-op folds cheap.
- No LLM runs in this path; it is cheap enough to run on every event.

#### 7.3.2 Periodic review (drain)

- An `agent/pre-step` middleware reads the projection snapshot for the agent's session.
- A **per-session high-water mark** (`WeakMap<Session, number>`) records the seq of the last
  candidate covered by an extraction. `unprocessed = candidates with seq > mark`.
- When `unprocessed.length >= reviewCandidateThreshold` (default **10**), one
  `runReviewExtraction` runs; on success the mark advances to the max covered seq.
- **Extraction budget:** `extractionBudget` (default **20**, 0 = unlimited) is a per-session budget
  shared across the periodic review and both flush paths. Each LLM call (extraction + judge)
  decrements the budget; when exhausted, all extraction paths stop.
- **Judge toggle:** `judgeEnabled` (default **true**) controls whether the LLM dedup judge runs
  on prefilter hits. When `false`, prefilter hits merge directly (cheaper, but may false-merge).
- The whole drain is wrapped in try/catch: **a review failure must never block the step.**

#### 7.3.3 LLM extraction core (`src/review/extract.ts`)

- **Routing:** provider/model are resolved from the session's request header
  (`session.requestHeader().config).` Extraction therefore reuses the session's own provider
  route — no separate keys or configuration, and extraction quality tracks the session model.
  `resolveTarget` also supports a **model override** via `ExtractionModelOverride` (provider +
  model fields), allowing the review plugin to route extraction to a different model.
- **Project auto-detection:** `inferProjectName(session)` reads `session.header?.cwd` and takes
  the basename as the inferred project name. This is passed to `storeMemories` as
  `inferredProjectName` so project-scoped memories are tagged automatically.
- **Prompt:** two fixed system prompts (`REVIEW_SYSTEM_PROMPT` for periodic review, which includes
  the current memory snapshot via `renderMemorySnapshot` so the model is told to omit already-stored
  memories; `FLUSH_SYSTEM_PROMPT` for flushes). The user message carries numbered, signal-tagged fragments.
- **Procedure prefix convention:** extraction prompts instruct the model to prefix verified
  procedures with `[procedure] `. `storeMemories` strips this prefix and maps the entry to the
  `procedure` category.
- **Output protocol:** one memory per line, `scope: content`, where scope ∈ {`global`, `project`,
  `user`}. `parseExtractedMemories` is pure and strict: blank lines, missing colon, unknown scope
  tag, or empty content are dropped — a sloppy model answer can never corrupt the store.
- **Dedup pipeline:** before storing each parsed line, `findDuplicate` (Jaccard ≥ 0.15, same scope
  only) checks against existing entries. If a hit is found and `judgeEnabled` is `true` and a
  session is available, `judgeDuplicate` runs an LLM judge (one-word verdict: `duplicate`/`update`/`new`):
  - `duplicate` → skip (existing entry kept).
  - `update` → merge content into the existing entry via `mergeContent`.
  - `new` → create a new entry.
  If `judgeEnabled` is `false`, the prefilter hit merges directly via `mergeContent`.
- **Storage:** `storeMemories` scans each line and stores entries independently; a scanner rejection
  or store failure skips that entry only. Batches whose candidates are *all* correction signals
  are tagged `category: 'correction'`. `storeMemories` takes additional params: `inferredProjectName`,
  `session`, `modelOverride`, `judgeEnabled`.
- **Stream handling:** `collectStreamText` assembles the `ctx.llm.stream` chunks; terminal
  finishes of `error` / `aborted` / `max-tokens` map to fail-closed errors and the batch is
  skipped.

#### 7.3.4 Flush paths (compaction & dispose)

- **Budget check:** before any flush, the extraction budget is checked; if exhausted, the flush
  is a no-op.
- **On `compaction/end`** (when `flushOnCompaction`, default true, and the event carries no
  error): the matching `compaction/summary` is located, its `shadowedSeqs` are read back from the
  raw event log as text fragments, and one flush extraction runs — fire-and-forget, so it can
  never block compaction.
- **On `session/disposed`** (when `flushOnDispose`, default true): the session's derived
  messages are rendered to `role: text` fragments and flushed with an
  `AbortSignal.timeout(5000)` bound.
- **Janitor on `session/created`** (when `decayDays > 0`, default 30): runs `memory.janitor(decayDays)`
  once per new session to decay old project-scoped entries that have not been recalled within the
  decay window.
- Both flush paths catch all failures; memory extraction is best-effort by construction.

#### 7.3.5 Alternatives considered

| Option | Verdict |
|---|---|
| LLM call on every user message | Rejected: unbounded cost/latency; most messages carry no durable value |
| Extract only at session end | Rejected: compaction shadows context *within* a session; a long session loses details before dispose |
| Per-message extraction with no accumulation | Rejected: same cost problem, no batching |
| **Threshold accumulator + flush on compaction/dispose (chosen)** | Bounded LLM spend (one call per ≥N candidate signals, one per compaction, one per dispose); captures exactly the moments context is about to leave |

#### 7.3.6 Dedup pipeline (`src/review/dedup.ts`)

A two-stage dedup runs before each `add` to prevent storing near-duplicate memories:

1. **Prefilter (embedding-free):**
   - `tokenize(content)`: normalizes to lowercase, splits on word boundaries for Latin, matches
     CJK per-character. English stop words and CJK stop characters (high-frequency grammatical
     particles) are removed so unrelated sentences don't share too many tokens. Returns a `Set` of
     unique tokens.
   - `jaccardSimilarity(a, b)`: `|A ∩ B| / |A ∪ B|` between two token sets.
   - `findDuplicate(candidateContent, candidateScope, existing, threshold = 0.15)`: compares the
     candidate against all existing entries **in the same scope only** (a project convention and
     a user preference are never duplicates). Returns the best-matching entry id above the
     threshold, or `undefined` for a genuine new memory.

2. **LLM judge (optional, when `judgeEnabled` and session available):**
   - `JUDGE_SYSTEM_PROMPT`: a one-word output protocol — `duplicate` (same fact, different
     wording → keep existing), `update` (correction/more precise → replace), `new` (genuinely
     different fact → keep both).
   - `parseJudgeVerdict(text)`: lowercases, trims, matches against the three valid words.
     Defaults to `duplicate` on anything unrecognized (the safe fallback — merge rather than
     create a spurious duplicate).

- **`mergeContent(oldContent, newContent)`:** if one content contains the other as a substring,
  returns the longer; otherwise concatenates with a space separator so no information is lost.

### 7.4 Context injection & settings — `/context` (`src/context/`)

#### Settings namespace

Registered via `installSettingsSection` under the `memory` namespace with `applies: 'live'`; the composition entry supplies defaults (`base`) and the user's settings document overlays them.

| Setting | Default | Effect |
|---|---|---|
| `memoryMode` | `policy-only` | `full` / `policy-only` / `custom` / `off` / `index` |
| `memoryPolicyCustomText` | `""` | Verbatim policy text used only in `custom` mode (supports multi-line YAML `\|`) |
| `reviewEnabled` | `true` | Periodic-review extraction on/off |
| `reviewCandidateThreshold` | `10` | Candidate signals that trigger one extraction |
| `flushOnCompaction` | `true` | Flush shadowed context at compaction end |
| `flushOnDispose` | `true` | Flush remaining context at session dispose |
| `memoryCharLimit` | `5000` | Character budget for injected memory content |

The `index` mode injects a one-line-per-entry index so the model can see what's stored and route to `memory_get` / `memory_search` for full content.

#### Prompt section

- One `memory` section at order **90** (before tool guidance, 100–199).
- **Two frozen snapshots:** on `session/created` (a global listener), the provider reads the store
  across the scopes and builds two snapshots, both stored in `WeakMap<Session, string>`:
  - **`content`** — for `full` mode: renders each non-empty scope as `## <scope>` bullet lines,
    truncated to `memoryCharLimit` (with a `…(memory truncated …)` marker).
  - **`index`** — for `index` mode: `renderMemoryIndex` produces a relevance-ordered index
    (tiers: `project → user → global`), each line: `<scope/category> · <projectName> · <id> ·
    <content[:80]>`, budget-aware roll-up.
  Both are read **once** per session: the recalled content stays stable for the life of the
  session, which keeps the system-prompt prefix stable and preserves **KV-cache prefix stability**
  across steps.
- **Live settings:** the section `text` is a function evaluated at *each* assembly; it reads the
  currently resolved settings (a source thunk swapped on settings attach/detach) plus the frozen
  snapshot. So a mode change applies on the very next assembly — no restart.
- **Composition by mode** (`buildMemorySectionText`, a pure function):

| Mode | Section text |
|---|---|
| `off` | `""` — the section is dropped at render |
| `policy-only` | the fixed `<memory-policy>` guidance block |
| `custom` | `memoryPolicyCustomText` verbatim |
| `full` | `<memory-context>` (framing note + frozen content) followed by the policy block; falls back to policy-only when content is empty |
| `index` | `<memory-index>` block (existence index, one line per entry) + policy block; empty index falls back to policy-only |

The policy text itself is part of the security design: it instructs the model to use `memory_search` on demand, to treat memory as context **not** instructions, and that the user's current request, repo files, and tool outputs override memory.

**Degradation:** when no memory store is mounted, sessions get an empty snapshot; `off` mode removes the section entirely. Neither breaks the host.

#### Settings from the review plugin

The review plugin has its **own** configuration, registered through a separate schemastery schema (not the `memory` settings namespace). These knobs are set via the composition layer, not the settings UI:

| Setting | Default | Effect |
|---|---|---|
| `extractionModelProvider` | `""` | Override LLM provider for extraction/judge |
| `extractionModelModel` | `""` | Override model name |
| `extractionBudget` | `20` | Max extraction+judge calls per session (0 = unlimited) |
| `judgeEnabled` | `true` | LLM dedup judge on/off |
| `decayDays` | `30` | Days before unused project-scoped entries are decayed (0 = disabled) |

### 7.5 Security scanner (`src/scanner.ts`)

`scanContent(content): { allowed, reasons }` is a **dependency-free pure module** shared by the tool boundary, the store contract, and the review extractor — each calls it independently; none imports the others.

Three pattern classes (29 regexes total):

| Class | Patterns (examples) |
|---|---|
| `secret` (16) | DeepSeek / OpenAI / Anthropic API keys, GitHub tokens, AWS access key + 40-char secret, generic Bearer token, JWT, SSH private-key header, Slack tokens, Google API keys, **Stripe key**, **HuggingFace token**, **Twilio API key**, **URL-embedded token**, **Git credentials URL** |
| `injection` (9) | "ignore previous instructions", "disregard prior …", "you are now a …", "forget everything", "new system prompt", "act as a different …", "do not follow previous …", "override … instructions", `[system]: ignore` |
| `exfiltration` (4) | `curl/wget …` targeting `DSH_/DEEPSEEK_/API_/SECRET_/TOKEN_/KEY_` env vars, `print/echo/cat/export` of the same, `base64/eval --decode` of the same, "send the api key to …" |

A hit fails closed: the write is rejected with the matched pattern names as reasons.

**Allowlist:** the `ScanAllowlist` interface and `setAllowlist` function allow suppressing specific pattern hits when the content contains a known-safe value. When an allowlist entry's `value` substring is present in the scanned content, the matching pattern is skipped. This is useful for storing documentation or test fixtures that contain redacted/sample keys.

### 7.6 Invariant companion (`src/invariant.ts`)

A no-op `InvariantInstaller` that claims the package name `@chenhw7/dsh-memory` in the invariants registry. No runtime invariant is needed today: `memory/*` events are standalone log-only records (no nesting to enforce), tools own no event stream, the review path writes only through the validated store, and the context text is a pure function of live settings + a frozen snapshot. The companion exists so a future relation check can land here without changing the registration surface.

### 7.7 `@Remote` service — `/remote-service` (`src/remote/`)

`MemoryRemoteService extends TypertRemoteService`, registered on `ctx.memoryRemote` by the `memory-remote` composition row. It wraps the `MemoryStore` and exposes store operations as `@Remote` methods callable from the client-side UI via the Typert protocol. Writes stay scanner-gated and write-serialized through the existing store contract; the service delegates to `ctx.memory` — it does not duplicate the store.

Nine `@Remote` methods:

| Method | Wire request | Wire result | Notes |
|---|---|---|---|
| `list` | `MemoryListRequest` (scope?, projectName?, limit?, offset?) | `MemoryListResult` (entries[], total) | paginated |
| `search` | `MemorySearchRequest` (scope?, category?, projectName?, query?, limit?) | `{ entries[], total }` | delegates to `store.search` |
| `get` | `MemoryGetRequest` (id) | `MemoryGetResult` (entry?, found) | — |
| `add` | `MemoryAddRequest` (scope, content, category?, projectName?) | `MemoryAddResult` (entry?, error?) | async; `source: 'ui'` |
| `update` | `MemoryUpdateRequest` (id, content?, category?) | `MemoryUpdateResult` (entry?, found, error?) | async; `source: 'ui'` |
| `remove` | `MemoryRemoveRequest` (id) | `MemoryRemoveResult` (removed) | async |
| `pin` | `MemoryPinRequest` (id, pinned) | `MemoryPinResult` (entry?, found) | async; toggles pin/unpin |
| `health` | — | `MemoryHealthResult` (totalEntries, byScope, pinned, auditRecords, lastActivityTs?, lastExtractionTs?) | synchronous |
| `auditLog` | `MemoryAuditRequest` (limit?) | `MemoryAuditResult` (entries[]) | returns audit entries |

Wire types are defined in `src/remote/index.ts`; client-side types are in the hand-written `src/typert.remote-client.d.ts`. The client UI does **not** currently use this service — it is for the future memory management UI.

### 7.8 Client UI — `/client` (`src/client/`)

The client subpath contributes a settings card into the host's Settings → Plugins → Plugin configuration tab. The host does not export `PluginCard` / `ValueField` / `CardForm` as runtime values, so the plugin must replicate the UI manually.

- **`client/index.ts`:** registers locale dictionaries (`en` + `zh` for the `settings.memory`
  namespace), binds the `memory` settings scope via `ctx.settingsScope.bind`, and injects
  `MemoryPluginCard` into the `settings.plugin.item` slot (keyed `memory`).
- **`MemoryPluginCard.tsx`:** a collapsible card with header + body + save/discard footer. Stages
  drafts locally and writes on Save. Fields:
  - `SelectField` — `memoryMode` (full / policy-only / custom / off / index)
  - `TextareaField` — `custom` policy text
  - `CheckboxField` — `reviewEnabled`, `flushOnCompaction`, `flushOnDispose`
  - `NumberField` — `reviewCandidateThreshold`, `memoryCharLimit`
- **`card-styles.ts`:** CSS injected via a `<style>` tag with `data-dsh-memory` attribute; `dsm-c-*`
  class names; a line-by-line port of the host's `PluginCard.module.css` + `fields.module.css`.
  The `RULES` array must be defined before the `inject()` call (an esbuild CJS var-hoisting lesson:
  esbuild hoists `var` declarations but not their initializers, so calling `inject()` before the
  assignment runs with an empty rules array).
- **`locales.ts`:** `en` + `zh` dictionaries for the `settings.memory` namespace.
- **Build:** `scripts/build-client.cjs` uses esbuild to bundle the client into a
  `window.__ModuleLoader__.load()` format, with externals for all host packages.
  `scripts/fix-imports.cjs` fixes `.ts` → `.js` import specifiers in the tsc output and copies
  Typert remote artifacts.
- **Design constraint:** the host does not export `PluginCard`/`ValueField`/`CardForm` as runtime
  values, so the plugin must replicate the UI manually (card structure, field components, and CSS
  are all re-implemented locally).

---

## 8. Configuration

### Memory namespace

All memory settings live in the `memory` namespace of `$DSH_HOME/settings.yaml` (and the settings UI) and apply live:

```yaml
memory:
  memoryMode: policy-only      # full / policy-only / custom / off / index
  memoryPolicyCustomText: ""
  reviewEnabled: true
  reviewCandidateThreshold: 10
  flushOnCompaction: true
  flushOnDispose: true
  memoryCharLimit: 5000
```

- `memoryMode: index` injects a one-line-per-entry existence index so the model can see what's
  stored and route to `memory_get`/`memory_search` for full content.
- `memoryMode: custom` + `memoryPolicyCustomText: |` injects arbitrary multi-line policy text
  verbatim (the preset policy block in the README is a copy-paste example).
- `reviewCandidateThreshold: 0` disables the periodic review via the context-side default
  materialization (the review plugin itself enforces a minimum of 1 when directly configured).
- `memoryCharLimit: 0` disables content injection while still emitting the policy in `full` mode.

### Review plugin config

The review plugin has its own configuration, registered through a separate schemastery schema (not the `memory` settings namespace). These are set via the composition layer:

| Setting | Default | Effect |
|---|---|---|
| `extractionModelProvider` | `""` | Override LLM provider for extraction/judge |
| `extractionModelModel` | `""` | Override model name |
| `extractionBudget` | `20` | Max extraction+judge calls per session (0 = unlimited) |
| `judgeEnabled` | `true` | LLM dedup judge on/off |
| `decayDays` | `30` | Days before unused project-scoped entries are decayed (0 = disabled) |

---

## 9. Security & Failure-Mode Analysis

### 9.1 Threat model

| Threat | Mitigation |
|---|---|
| Secrets written to durable storage (leak on later reads/backups) | `scanContent` rejects high-confidence secret patterns on **every** write path (tool boundary + store contract + extractor) |
| Stored content becomes a prompt-injection vector when later recalled | Injection patterns rejected at write time; the injected prompt and every tool description instruct the model to treat memory as context, not instructions |
| Exfiltration payload stored and executed on a later session | Exfiltration patterns rejected at write time; tool output rendering does not execute content |
| Indirect injection *through the extractor* (hostile session content steering the LLM) | Extraction output is constrained to the `scope: content` line protocol, parsed strictly, and every line is re-scanned before storage |
| Unbounded store growth / prompt bloat | `memoryCharLimit` budget + truncation marker; `limit`/`offset` pagination on tools; audit log capped at 200 records; janitor decays old project-scoped entries |

### 9.2 Failure matrix

| Scenario | Behavior |
|---|---|
| No `storageDomain` composed (e.g. headless without storage rows) | Composition fails at the `memory-store` row — loud, by design (the store row `inject`s `storageDomain`) |
| Tool called while `ctx.memory` is absent | Tool returns `memory service is not available…` — deployment still boots |
| No provider/model in the session request header | Extraction resolves no route and is a silent no-op |
| LLM stream error / aborted / truncated at max tokens | Batch skipped; step/compaction/dispose unaffected |
| Scanner rejects an extracted line | That line is skipped; the rest of the batch is stored |
| Store write fails for one extracted entry | Entry skipped; others proceed |
| `sessionProjections` not composed (headless assembly) | Accumulator not registered; periodic review no-ops; flush paths still work (they don't depend on projections) |
| Session disposed while a flush is running | `AbortSignal.timeout(5000)` bounds the in-flight extraction |
| `extractionBudget` exhausted | All extraction paths stop (review + both flushes); no further LLM calls until next session |
| `judgeEnabled: false` | Prefilter hits merge directly via `mergeContent` (cheaper, but may false-merge unrelated entries that happen to share tokens) |
| Invalid settings values | Rejected by the schemastery/Zod schemas at composition/settings time |

---

## 10. Deployment, Packaging & Release

### 10.1 Package layout

```
dsh-memory/ ├── cordis.patch.yml        # the profile layer (the package's substance) ├── src/                    # TypeScript sources (20 files, ~3 kLOC) ├── lib/                    # tsc + esbuild build output (published) ├── scripts/                # build-client.cjs (esbuild), fix-imports.cjs ├── tests/                  # vitest specs (14 files) └── package.json            # exports map, dsh.bundle.patch manifest, peer deps
```

`exports` exposes `.`, `./store`, `./tool`, `./review`, `./context`, `./invariant`, `./remote`, `./remote-service`, `./client`, `./cordis.patch.yml`, `./package.json`.

The `dsh.client` manifest field declares `platform: "web"` and `inject: ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-settings-plugins"]`, which tells the host client-module scanner where to mount the settings card.

### 10.2 Install paths

| Path | Build at install? | Notes |
|---|---|---|
| **npm (recommended)** | No | The tarball ships prebuilt; `prepare` (`tsc`) runs only in the publish pipeline / CI, never on the user's machine |
| git URL | Yes (`prepare`) | pnpm blocks the build until the exact `allowBuilds` key (which embeds the resolved commit) is added to the profile's `pnpm-workspace.yaml` — a documented two-step procedure; pin commits for reproducibility |
| tarball | No | `npm pack` from a checkout with `lib/` built |
| local `file:` | No | pnpm skips build scripts for `file:` deps, so the user must `npm run build` first |

dsh peer-dependency ranges track the dsh release line; all dsh services are also mirrored as devDependencies so the package type-checks standalone.

### 10.3 Why the storage rows are NOT in this patch

The patch deliberately inserts **no** `storage-json` / `storage-domain` rows: the `dsh-web-app` bundle already provides them with the correct root path under `$DSH_HOME/storages`. Cordis patches replace whole rows with last-write-wins semantics, so inserting them here would **clobber** the web-app's root configuration. Headless profiles (which ship no storage layer) are instructed to add the two storage rows to *their own* profile `cordis.patch.yml` instead.

### 10.4 Uninstall semantics

`dsh plugin remove --profile <p> @chenhw7/dsh-memory` removes the six rows from the composed config. Saved memories remain in `$DSH_HOME/storages/memory.json` (intentional data-preservation guarantee); users wipe them explicitly by deleting that file.

### 10.5 Release pipeline

GitHub Actions publishes to npm on `v*` tags: it verifies the tag matches the `package.json` version, then runs `npm publish` with a granular `NPM_TOKEN` (Packages read & write for this scope, 2FA bypass enabled).

---

## 11. Testing Strategy

The repo ships 14 vitest spec files (~264 test cases) in four layers:

1. **Pure-function units** — `scanner.spec` (16), `scanner-corpus.spec` (44: corpus-driven
   secret/injection/exfiltration pattern coverage incl. allowlist), `extract.spec` (30: parse/
   build/prompts/storeMemories with a stubbed LLM seam), `accumulator.spec` (27: fold, signals,
   message text extraction, tool-failure, schema), `policy.spec` (16: mode composition incl.
   truncation + index mode), `types.spec` (7), `smoke.spec` (9: module-load sanity),
   `dedup.spec` (25: tokenize, Jaccard similarity, findDuplicate, judge prompts, mergeContent),
   `conflict.spec` (9: cross-session conflict detection, exploratory).
2. **Contract** — `store-contract.spec` (10): an in-memory `TestMemoryStore` exercises the abstract
   `MemoryStore` contract (add/get/list/update/remove/search/pin/unpin/janitor/health/audit,
   scanner rejections, project-scope validation) so any future provider is held to the same contract.
3. **Tool behavior** — `tools.spec` (37): the eight `execute()` paths run against a real
   `ToolRuntime` + `SystemPrompt` composition with the in-memory store, covering success, scanner
   rejection, missing-service, missing-id, and pagination semantics.
4. **Integration** — `integration/composition.spec` (26): full Cordis composition with
   `storage-domain` + JSON backend, exercising the store, tools, and context injection end-to-end.
   `dedup-integration.spec` (2): dedup pipeline against a real store.
   `judge-real-api.spec` (6, skipped without API keys): LLM judge against the real DeepSeek API.

---

## 12. Performance & Prompt-Budget Considerations

- **Search cost:** O(n × tokens) per query — each entry is tokenized and compared against the
  query tokens. Still small n (dozens, not millions); bounded by `limit` (default 50) and
  pagination. No index needed at this scale.
- **Janitor cost:** O(n) scan of project-scoped entries only, runs once per new session (on
  `session/created` when `decayDays > 0`).
- **Audit log:** capped at 200 records; oldest evicted on overflow. `appendAudit` is best-effort
  (try/catch) and never blocks a write.
- **Prompt budget:** `memoryCharLimit` (default 5000 chars ≈ 1.2–1.5 k tokens) caps injected
  content; `full` mode additionally carries the fixed policy block (~0.4 k tokens); `index` mode
  carries a compact one-line-per-entry index.
- **Cache stability:** both snapshots (`content` and `index`) are frozen per session, so the
  system-prompt prefix does not churn mid-session as new memories are written; only mode changes
  alter the prefix.
- **Extraction spend:** bounded and event-driven — at most one LLM call per threshold crossing
  (10 candidate signals), one per compaction, one per dispose (5 s capped), plus one judge call
  per prefilter hit. The `extractionBudget` (default 20) caps total calls per session. Extraction
  reuses the session's provider/model, so no dedicated spend channel is required.
- **I/O:** one JSON file; writes serialize on the domain write chain; reads are in-memory.

---

## 13. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| dsh is in developer preview; API drift | Composition breakage | Peer-dep ranges pinned to the dsh release line; type-level augmentation fails fast at build time; CI publish gate on tagged versions |
| Git-hosted install requires a pnpm build-allowlist entry | One extra step on first-time git install | Documented two-step `allowBuilds` procedure; npm/tarball paths avoid it entirely |
| Injected memory affects prompt quality | Model behavior variance | Policy text frames memory as non-instructional context; scanner blocks instruction-like payloads; `off`/`policy-only` modes available |
| LLM extraction stores garbage | Store pollution | Strict line protocol, per-line re-scan, best-effort semantics, category tagging, dedup pipeline (prefilter + optional LLM judge) |
| Dedup false-merge when `judgeEnabled: false` | Related-but-distinct entries merged into one | Prefilter threshold (0.15) is conservative; `judgeEnabled: true` (default) adds LLM judge as a second gate; `mergeContent` preserves all text on concatenation |
| CSS injection order bug (esbuild CJS var hoisting) | Client card renders without styles | `RULES` array defined before `inject()` call in `card-styles.ts` (mitigates the esbuild var-hoisting pitfall where `var` is hoisted but the initializer is not) |
| Unbounded growth of the JSON file | Prompt bloat / slow loads | Character budget + truncation, pagination, janitor decay of old project-scoped entries, audit log cap (200) |
| Clobbering host storage config | Broken web profile | Storage rows intentionally absent from the patch (§10.3) |

---

## 14. Source Layout

```
src/ ├── index.ts              # package root: re-exports, MemoryStore abstract class, │                         #   validateProjectScope, Context.memory augmentation ├── types.ts              # pure domain types + memory/* SessionEventMap declarations ├── brand.ts              # MemoryId/AuditId branded types + UUID factories ├── scanner.ts            # scanContent: 3 pattern classes, 29 regexes, allowlist ├── invariant.ts          # no-op invariant companion (name claim) ├── store/index.ts        # storage-domain provider → DomainMemoryStore (entries + audit tables) ├── tool/index.ts         # eight model tools (defineTool + schemastery) ├── review/ │   ├── index.ts          # plugin wiring: accumulator, pre-step drain, │   │                     #   compaction/dispose flush, janitor, budget │   ├── accumulator.ts    # pure fold, signal patterns, projection key + schema │   ├── dedup.ts          # tokenize, Jaccard similarity, LLM judge prompts │   └── extract.ts        # prompts, stream collection, line parsing, dedup pipeline, │                         #   store pipeline, project auto-detection ├── context/ │   ├── index.ts          # settings namespace + system-prompt section + frozen snapshots │   ├── policy.ts         # preset policy text + buildMemorySectionText + renderMemoryIndex │   └── conflict.ts       # cross-session conflict detection (exploratory, not wired) ├── remote/ │   ├── index.ts          # @Remote service: 9 methods over Typert │   └── types.ts          # wire type re-exports ├── typert.remote-client.d.ts  # hand-written client-side Typert remote types └── client/
    ├── index.ts          # client plugin entry: locale + settings scope + slot registration
    ├── MemoryPluginCard.tsx  # settings card component (fields + save/discard)
    ├── card-styles.ts    # CSS injection (dsm-c-* classes, <style> tag)
    └── locales.ts        # en + zh dictionaries for settings.memory namespace
```

---

*Companion documents: [README.md](../README.md) (user guide), [README.zh-CN.md](../README.zh-CN.md), [中文版技术方案](./TECH_DESIGN.zh-CN.md), [TODO & Evolution Plan](./TODO.md).*
