# Agent Note: Project-notes projection writes no repository files

Status: implemented

English | [中文](2026-08-31-project-notes-writes-no-repository-files.zh.md)

## Problem

The project-notes subsystem (conventions list + pitfall log) originally exported its render into the user's repository as `docs/agent-memory/{CONVENTIONS,PITFALLS}.md` plus a managed pointer block in `AGENTS.md` (v0.2–v0.5), so tools other than dsh could discover the memory by reading the repo. Real usage turned that contract into its own failure modes: generated files kept surfacing in the user's `git status` (the dominant real-user complaint), multi-machine clones rendered from per-machine stores and fought over the committed files as writers, and the files were neither committable (per-machine truth) nor ignorable (the pointer block exists to be committed) — leaving only git noise and a stale copy of what the store already held.

## Decision

Since 0.6 the `memory-notes` projection is prompt-only: `ProjectNotesService.snapshotFor(cwd)` renders synchronously, purely in memory from the store, into the `project-notes` system-prompt section; the store (`$DSH_HOME/storages/memory.json`) is the single source of truth and the Memory settings UI (view/edit/pin/archive/delete) is the management surface. The plugin never writes into the user's repository.

- **One-way render, no reverse sync.** Facts flow KV store → prompt text only. Nothing read from the repository is ever written back into the store, so a cloned hostile repository cannot inject instructions through files.
- **Anti-double-injection.** While `notesEnabled` is on, the snapshot and index readers exclude every entry matching the render matrix (`isRenderedEntry`), so the same entry never appears in both the `project-notes` section and the `memory` section/index; in `policy-only` mode nothing overlaps by construction.
- **Conservative one-time cleanup.** On `session/created` (once per project root per process, idempotent, best-effort), ≤0.5.x artifacts are removed: only the managed block between the AGENTS.md markers is stripped (everything outside stays; a file left empty by the strip is deleted), only the plugin-generated `CONVENTIONS.md` / `PITFALLS.md` / `*.bak.*` are deleted (foreign files keep the directory), and the user's `.gitignore` is never touched.
- **Render honors store lifecycle.** Janitor decay removes entries from the render automatically (decay applies to `project`-scope entries; personal/global habits never auto-expire), and `memory_pin` semantics carry through the render.

## Alternatives considered

<!-- The two alternatives below are reconstructed from the design record; no committed decision document predates the removal itself. -->

- **Keep the file export but gitignore it.** Rejected: a gitignored export silences the status noise but keeps unrequested files on every machine and still can't be shared — the pointer mechanism only works when the files are committed, and committing per-machine renders is what caused the conflicts.
- **Keep both surfaces (repo files + prompt injection).** Rejected: two homes for the same facts that must be kept in sync by hand, the drift guard needed to police them, and double maintenance for a bridge only some tools used.

## Consequences

- Tools that only read the user's repository can no longer see these memories; the accepted cost — a user who wants that bridge curates their own AGENTS.md from the settings UI.
- `docs/agent-memory/` directories from custom `notesDir` deployments are not recoverable by the cleanup (it only knows the default location) and must be removed by hand.
- Zero repo writes are test-pinned (`tests/notes.spec.ts`: `snapshotFor` leaves no new files), and the cleanup rules (marker stripping, pointer-only deletion, foreign files kept, idempotent re-run) have their own specs.
- The pre-0.6 `notesDir` / `notesAgentsPointer` settings keys no longer exist; stale values are silently ignored by `resolveNotesSettings`.
