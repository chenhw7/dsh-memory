# Design: Project Notes — File-Based Project Memory (Conventions + Pitfall Log)

| | |
|---|---|
| Package | `@chenhw7/dsh-memory` |
| Status | **Implemented (v0.2.0)** |
| Scope | One new `memory-notes` composition row in the existing bundle; small extensions to `memory-review` and `memory-context` |
| 中文版 | [PROJECT_NOTES.zh-CN.md](./PROJECT_NOTES.zh-CN.md) |

---

## 1. Goals & Scope

dsh is primarily used for coding work. On top of the existing long-term memory, this proposal adds **file-based project memory** inside each repository:

- A dedicated set of files records **coding habits/conventions** and a **pitfall log**, manageable via git, reviewable in PRs, and human-readable.
- At the start of every session, these files are injected into the system prompt.
- Automatic sedimentation:
  - When the same kind of operation **fails ≥2 times consecutively and is finally resolved**, a structured pitfall entry is produced automatically.
  - When the user **explicitly states** ("remember / from now on …") or **repeats** a coding preference, it is folded into the conventions file.
- Non-goals: semantic retrieval, research/thought logs, syncing files outside `~/.dsh` beyond the repo.

---

## 2. Current-State Findings (factual basis)

Findings against the current codebase (v0.1.x):

- **The data model already has the needed categories**: `convention` / `preference` / `failure` / `procedure` all exist (`memoryEntrySchema` in `src/store/index.ts`). This proposal adds no new memory kind — only a new **carrier (files)** and a **new signal (failure→resolution sequences)**.
- **Storage lives outside the repo**: everything lands in `~/.dsh/storages/memory.json` — not committed, not readable, not shareable.
- **The current pitfall signal is noisy and unpaired**: `src/review/accumulator.ts` collects a candidate for **every** `tool/result` error (including fat-fingered bash commands), and extraction cannot tell whether the failure was eventually resolved — so what sediments as "pitfalls" today are low-value failure fragments.
- **dsh core does not auto-inject AGENTS.md**: AGENTS.md only appears via `agent.inject` on subdirectory changes, with no system-prompt-level auto-loading — a plugin-owned injection path will not double up.
- **The project root is resolvable**: `session.header?.cwd` is already used by `inferProjectName` (`src/review/extract.ts`); the same source locates the repo root for writing files.
- **Injection uses frozen snapshots**: `memory-context` freezes a snapshot at `session/created` to keep the KV-cache prefix stable. File injection follows the same pattern.

---

## 3. Decisions (ADR)

### ADR-1: Extend the existing plugin instead of creating a new one ✅

Add a new `src/notes/` module + subpath export `@chenhw7/dsh-memory/notes`, registered as a seventh composition row `memory-notes` in `cordis.patch.yml`.

Rationale:

1. **The data dependency cannot be split**: the files are a rendered view of the KV store (ADR-2), whose source of truth lives in this package. A separate plugin would still peer-depend on it, adding a cross-package API boundary for nothing.
2. **Pipeline reuse**: the streak signal lives in `accumulator`, the pitfall prompt in `extract`, and dedup/audit/decay in the store — splitting the feature out means duplicating the entire review pipeline.
3. **Composition rows exist for exactly this**: install/uninstall remains a single `dsh plugin add/remove`; users who don't want the feature toggle it off.
4. **Half the maintenance**: one peer-dependency range, one version line, one settings namespace.

A separate plugin only pays off if file notes must be distributed independently of the memory pipeline — that premise is ruled out by ADR-2.

### ADR-2: KV is the source of truth; files are a read-only export ✅

- Direction: `KV store → markdown files`, **one-way**. The exporter is the single writer — no concurrency conflicts by construction.
- **Existing dedup, the LLM judge, janitor decay, audit, and the management UI all keep working** — when the janitor removes an entry, the next render shrinks the file automatically. No lifecycle logic is re-implemented at the file layer.
- The notes files are fully managed (a header declares "auto-generated, do not edit by hand"); hand-written conventions belong in `AGENTS.md`, where the plugin maintains only a one-line managed pointer (ADR-3).
- **No `file → KV` reverse sync, ever**: content read from the repository is never written back into the memory store, so a cloned malicious repo cannot inject instructions via AGENTS.md. Files only flow `file → prompt`.

### ADR-3: Layout = a dedicated directory + an AGENTS.md pointer ✅

```
<repo>/
  AGENTS.md                  # only a managed pointer block is ensured (below)
  docs/agent-memory/         # notesDir, configurable
    CONVENTIONS.md           # coding habits/conventions
    PITFALLS.md              # pitfall log
```

Why not write into AGENTS.md itself: it is shared by the user and other tools, so render-overwrite risk is high. A dedicated directory is plugin-owned and fully manageable, and separate files allow separate size caps. AGENTS.md only gets a pointer block so tools that auto-read it (e.g. Kimi Code) can discover the notes:

```markdown
<!-- dsh-memory:begin -->
> Agent-maintained project notes live in `docs/agent-memory/` (auto-generated by dsh-memory — do not edit those files by hand).
<!-- dsh-memory:end -->
```

### ADR-4: Pitfall granularity = structured short entries ✅

Each pitfall record carries: symptom (the error), root cause, and the fix — within two or three lines. No full diffs or logs, to keep files and prompt injection small.

### ADR-5: Habit-extraction posture = conservative ✅

A preference/convention memory is admitted only when the user explicitly demands it ("remember / from now on …" keyword signals) **or** the same preference theme **appears ≥2 times** in the session or stored memory. One-off situational preferences are not persisted.

---

## 4. Data Flow

```
session events
  → accumulator (new streak signal §5)
  → threshold-triggered LLM extraction (dedicated pitfall prompt + habit admission rules §6)
  → scanContent security screening → dedup prefilter → LLM judge → store (KV, source of truth)
  → exporter observes changes, debounces, renders CONVENTIONS.md / PITFALLS.md (atomic write §7)
  → every session's session/created: snapshotFor renders synchronously from KV (firing the async write), freeze, inject the <project-notes> section (§8)
```

Rendering uses an explicit scope×category matrix — **coding habits can be cross-project**, so the files are not a plain partition by scope but an overlay of global/personal layers under the project layer:

| File section | Scope/category filter |
|---|---|
| `CONVENTIONS.md › ## Project conventions` | current project, `project` scope, category ∈ {`convention`, `preference`} |
| `CONVENTIONS.md › ## Global practices` | `global` scope, category ∈ {`convention`, `preference`} |
| `CONVENTIONS.md › ## Personal habits` | `user` scope, category ∈ {`preference`, `convention`} |
| `PITFALLS.md › ## Project pitfalls` | current project, `project` scope, category ∈ {`failure`, `procedure`, `tool-quirk`} |
| `PITFALLS.md › ## Environment & cross-project pitfalls` | `global` scope, category ∈ {`failure`, `procedure`, `tool-quirk`} |

"Current project" is determined by comparing the basename of `session.header.cwd` with the entry's `projectName` (the existing auto-detection rule).

Section order doubles as the precedence hint: **on conflicts, the nearer scope wins (project > global > personal)**, and the injected text says so. Other categories (e.g. `insight`, `correction`) never enter the notes files — they keep flowing through KV memory injection only.

**Lifecycle**: the janitor only decays `project`-scoped entries, so personal/global habits never disappear automatically; important project conventions can be pinned with the existing `memory_pin` / `memory_unpin` tools, and rendering respects that semantics for free.

---

## 5. Signal Layer: Failure-Streak Detection

Modify `src/review/accumulator.ts` to replace "every tool failure is a candidate" with **paired sequences**:

- **Signature bucketing**: `signature = toolName + normalize(args)`.
  - Shell-like tools: the first two command tokens (e.g. `npm test`, `pnpm build`).
  - File tools: the target path.
  - Everything else: the tool name alone.
- **State**: projection state gains `openCalls` (`callId → { name, signature, seq }`, pairing calls with results) and `openStreaks` (`{ [signature]: { count, lastErrorText, firstSeq, lastSeq } }`), both plain JSON. Projection `stateVersion` bumps from 1 to 2.
- **Rules**:
  - A `tool/result` with an error under a signature → `count += 1`, update `lastErrorText` (truncated to ~500 chars).
  - A successful `tool/result` under the same signature:
    - If `count >= pitfallStreakThreshold` (default 2, configurable) → emit one `pitfall-resolved` candidate carrying: tool/signature, failure count, last error text, a summary of the succeeding call (command or file path), and the first/last seqs.
    - If `0 < count < threshold` → just clear the streak, emit nothing.
  - Bucket count is capped (default 8, least-recently-updated evicted) to keep the projection small.
- **One-shot failures no longer enter the periodic-review candidates** — a deliberate noise-reduction trade-off. The safety net: `compaction/end` and `session/disposed` flush extraction still scans full events, so genuinely important one-shot failures can still be captured there.
- Existing `keyword` / `correction` signals are unchanged.

---

## 6. Extraction Layer

### 6.1 Dedicated pitfall prompt

`pitfall-resolved` candidates go through a separate `PITFALL_SYSTEM_PROMPT` producing structured short entries (ADR-4), forced to `scope: project` with a `[pitfall]` prefix:

```
project: [pitfall] 症状：running vitest fails with "Cannot use import statement outside a module"；根因：dependency not transformed as ESM；修复：add it to server.deps.inline in vitest.config.ts.
```

### 6.2 Habit admission rules (conservative)

Additions to `REVIEW_SYSTEM_PROMPT`:

- preference/convention memories are kept only when explicitly demanded or repeated (ADR-5).
- **Hard-code the scope-routing rule** (so the same habit cannot oscillate between user/global/project): coding habits and preferences go to `user` by default (they follow the person across projects); user-agnostic cross-project engineering practices and environment/tool behavior go to `global`; only what holds in the current repo goes to `project`. The same rule is added to the "Memory write targets" block in `MEMORY_POLICY_TEXT` so the model-tooling write path and the automatic extraction path stay consistent.
- Extend the existing `[procedure] ` prefix-stripping mechanism with `[convention] ` / `[preference] ` / `[pitfall] ` tags mapping to the `convention` / `preference` / `failure` categories (a natural extension of the tag→category logic already in `storeMemories`).
- Entries with an explicit category no longer get the batch-wide `correction` inference.

---

## 7. Exporter: the `memory-notes` plugin (new module `src/notes/`)

- **Renderer**: reads `ctx.memory`, filters per §4, renders newest-first by `updatedAt`.
  - `CONVENTIONS.md`: three sections per the §4 matrix — `## Project conventions` / `## Global practices` / `## Personal habits`, bulleted.
  - `PITFALLS.md`: two sections — `## Project pitfalls` / `## Environment & cross-project pitfalls`; entries rendered verbatim (the prompt guarantees the structured wording), dated by `createdAt`.
  - A header marks the file auto-generated; per-file entry cap (default 100, oldest truncated).
- **Writer**: atomic `tmp + rename` writes; creates the directory on demand; ensures the AGENTS.md pointer block (creates a pointer-only AGENTS.md when absent; can be disabled via settings).
- **Mount point** `memory-notes`: the plugin registers the `projectNotes` service (`ctx.projectNotes`); triggers = `memory-context` calls `snapshotFor(cwd)` on `session/created` (the synchronous render doubles as the reconcile) + this plugin's dirty check on `agent/pre-step` based on `memory.health().lastActivityTs`, debounced. No changes inside `memory-review` — fully decoupled.
- **cordis.patch.yml** gains a seventh row:

```yaml
- insert:
    - id: memory-notes
      name: '@chenhw7/dsh-memory/notes'
```

---

## 8. Injection: the `project-notes` system-prompt section

- New section in `memory-context`: `name: 'project-notes'`, `order: 91` (right next to memory's 90).
- The injected content is the **synchronous render result** of `projectNotes.snapshotFor(cwd)`: on `session/created`, memory-context calls the service, which renders from the KV store synchronously and fires the async persistence of the same text; the returned snapshot is frozen into the per-session snapshot and truncated to `notesCharLimit` (default 4000) at injection time. The section text function reads the frozen copy at each assembly (KV-cache prefix stays stable, same semantics as the memory section).
- No files are read for injection — injection and persistence share one render, so prompt content and on-disk files can never drift apart, and there is no write-then-read ordering window. The files are only a human-readable, git-manageable export view.
- Without a cwd (no resolvable current project): the project sections are absent but the personal/global sections still render and inject; nothing is persisted (there is no project root to write into).
- Disabled or missing store injects an empty string (the section disappears).
- **Writes take effect in the next session** — same deliberate trade-off as the existing memory injection.

**Relationship with the existing `memory` section (key: this is not a second memory)**: the notes files and the memory section derive from **one and the same KV store** — the files are just a standing injection view of that single source of truth, so there is no dual-write inconsistency. Handling of the two overlap points:

- **No double injection**: when `notesEnabled` is true, `readMemorySnapshot` / `readMemoryIndex` exclude entries covered by the notes render matrix (the §4 scope×category set), so in `full` / `index` mode the same content never appears twice in the prompt. The default `policy-only` mode injects no memory content at all, so there is no overlap there either.
- **One render feeds both injection and persistence**: injection uses the synchronous return value of `snapshotFor`; persistence is the async atomic write of the same text (skip-if-unchanged) — no "finish writing the file before reading it back" ordering requirement; reconcile and freeze happen in a single call.
- **Routing note**: `MEMORY_POLICY_TEXT` gains one line — habits/conventions/pitfalls are already in the notes section; everything else (corrections, insights, environment facts) goes through `memory_search`.

---

## 9. Configuration

New settings in the `memory` namespace (visible in the settings UI, live-applied):

| Setting | Default | Meaning |
|---|---|---|
| `notesEnabled` | `true` | Enable file export and injection |
| `notesDir` | `docs/agent-memory` | In-repo relative directory |
| `notesCharLimit` | `4000` | Total injection character budget |
| `notesAgentsPointer` | `true` | Maintain the AGENTS.md pointer block |
| `notesMaxEntriesPerFile` | `100` | Per-file entry cap |

New `memory-review` composition config:

| Setting | Default | Meaning |
|---|---|---|
| `pitfallStreakThreshold` | `2` | Consecutive same-signature failures required to count as a pitfall |

---

## 10. Security & Boundaries

- All stored content still passes `scanContent` (secrets / prompt-injection / exfiltration patterns); exporter input is already screened, so no rescanning.
- **No `file → KV` reverse sync** (ADR-2) — cloned-repo prompt injection is ruled out.
- Once committed, the generated files are ordinary user-owned markdown as far as other tools are concerned.
- Headless profiles behave like the rest of the bundle (users supply their own storage rows, as already documented in the README).

## 11. Known Limitations & Future Options

- **Multi-machine/team sharing**: KV is per-machine truth. Committing the generated files means renders on different machines overwrite each other (last render wins). No merging in this phase; mitigations: (a) gitignore `docs/agent-memory/`, or (b) a future "adoption" mechanism — before rendering, adopt file entries missing from the KV back into it through scanContent + dedup (out of scope here).
- No vector retrieval, no file-level history beyond git.
- In-session writes do not refresh the current session's injection (§8).

## 12. Test Plan

- **Streak detection** (extend `tests/accumulator.spec.ts`): signature normalization; fail×2 + success → exactly one `pitfall-resolved` candidate; fail×1 + success → none; distinct signatures never pair; bucket-cap eviction.
- **Extraction** (extend `tests/extract.spec.ts`): new tag stripping ([pitfall]→failure etc.); pitfall prompt output parsing.
- **Exporter** (new `tests/notes.spec.ts`): render-scope filtering (project/global/personal layering + current-project isolation, non-listed categories excluded); cap truncation; idempotent AGENTS.md pointer ensure; atomic write.
- **Injection**: `buildNotesSectionText` (both inputs empty → empty; zero budget → empty; truncation); snapshot/index exclusion filtering; the service's `snapshotFor` — slice rendering + persisted file contents + the no-cwd behavior.

## 13. Compatibility & Release

- No storage schema change (existing scope/category reused); no migration of old data.
- Semver **minor** release; README's "six rows" becomes "seven rows"; config tables gain the §9 settings.
