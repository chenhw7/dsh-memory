# Cairn — Documentation Index

Index of the `@chenhw7/dsh-memory` documentation. 中文版：[README.zh.md](./README.zh.md).

Docs are split into two groups by lifecycle: **current baseline** at this level, and **historical decision records** in [`archive/`](./archive/).

## Current baseline

Living documents describing how the system works today, plus standing maintenance references. Kept in sync with the code at each release.

| Document | What it is |
|---|---|
| [TECH_DESIGN](./TECH_DESIGN.md) · [zh-CN](./TECH_DESIGN.zh.md) | Full technical design & implementation reference (v0.6.0): architecture, data model, subsystems, configuration, security, testing. |
| [SEQUENCE_DIAGRAMS](./SEQUENCE_DIAGRAMS.md) · [zh-CN](./SEQUENCE_DIAGRAMS.zh.md) | Sequence diagrams for every major flow + module dependency & service call graph. |
| [CLIENT_UI_LESSONS](./CLIENT_UI_LESSONS.zh.md) | Hard-won lessons from building a dsh plugin client UI — useful to any plugin that contributes a settings card or browser UI. (zh-CN only) |
| [HOST_CONTRACT](./HOST_CONTRACT.zh.md) | Host (harness) API contract with source-code evidence per claim; §9 is the check-list to run when the harness is bumped. (zh-CN only) |
| [RELEASING](./RELEASING.zh.md) | npm release runbook: the three-command flow, OIDC trusted-publishing prerequisites, failure triage, and the trust boundary (tag-push = publish right). (zh-CN only) |

## Historical decision records (`archive/`)

Completed planning/analysis documents, kept for the "why": decision rationale, verified findings, and implementation deviations. Their outcomes live in the code and in the baseline docs above.

| Document | What it was |
|---|---|
| [archive/MEMORY_SYSTEM_ANALYSIS.zh.md](./archive/MEMORY_SYSTEM_ANALYSIS.zh.md) | v0.2.x system analysis against five reference designs + P0/P1/P2 roadmap. P0/P1 shipped in v0.3.0; P2 deliberately deferred. Entry-level quotes are anonymized. |
| [archive/MEMORY_SYSTEM_EVALUATION_v0.7.0.zh.md](./archive/MEMORY_SYSTEM_EVALUATION_v0.7.0.zh.md) | v0.7.0 successor deep evaluation (follow-up to the system analysis): verifies the eight prior findings as fixed, assesses retrieval semantics, recall fulfillment, concurrency, and the security asymmetry, with a remediation roadmap. |
| [archive/IMPLEMENTATION_NOTES_v0.3.0.zh.md](./archive/IMPLEMENTATION_NOTES_v0.3.0.zh.md) | v0.3.0 implementation notes (P0×7 + P1×6). |
| [archive/memory-plugins-comparison-zh.md](./archive/memory-plugins-comparison-zh.md) | Comparison against three reference dsh memory plugins + the P0/P1 governance program, all shipped in v0.5.0. |
| [archive/MEMORY_MANAGER_PLAN.zh.md](./archive/MEMORY_MANAGER_PLAN.zh.md) | Memory-management UI implementation plan; phase 1 shipped in v0.4.0, §12 records implementation deviations (e.g. `/api` RPC instead of `$mount`). |
| [archive/PROJECT_NOTES.zh.md](./archive/PROJECT_NOTES.zh.md) | Project-notes subsystem design & ADRs (v0.2–v0.6). The prompt-only projection shipped in v0.6.0; the decision lives in the [Agent Note](../.agents/notes/implemented/architecture/2026-08-31-project-notes-writes-no-repository-files.zh.md). |
| [archive/INDEX_MODE_EVALUATION.zh.md](./archive/INDEX_MODE_EVALUATION.zh.md) | Measured comparison of the three injection modes (policy-only / index / full); reproducible via `tests/recall-golden.spec.ts`. The verdict lives in the [Agent Note](../.agents/notes/implemented/architecture/2026-08-26-index-mode-stays-policy-only.md). |
| [archive/SECURITY_AUDIT.zh.md](./archive/SECURITY_AUDIT.zh.md) | Security audit (2026-08-28, v0.5.0): nine-category manual audit + Mimosa sealed deep scan, findings SEC-01…09 — all resolved (SEC-01 key revoked 2026-08-31). |

## Conventions

- **Language**: the docs index (this pair), the repo `README`, `TECH_DESIGN` and `SEQUENCE_DIAGRAMS` keep English + zh-CN versions (they face external users and the plugin ecosystem); all other docs are zh-CN only, to avoid bilingual upkeep.
- **New planning/analysis docs** are written at the `docs/` top level. When the work they describe is done and absorbed into the code and baseline docs, move the file to `docs/archive/` and add an "archived" status line at the top.
- This plugin writes **no files into the repository** since 0.6 (≤0.5.x generated `docs/agent-memory/` and an `AGENTS.md` pointer block; both are removed and cleaned up automatically). Place hand-written docs elsewhere under `docs/`.
