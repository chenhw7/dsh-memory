# AGENTS.md

Cairn (`@chenhw7/dsh-memory`) is a self-contained single-package plugin bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): persistent cross-session memory (store, tools, auto-extraction review, context injection) shipped as one profile layer. This file holds the standing orders; linked documents own their subjects.

## Layout

```text
src/           Plugin source (ESM TypeScript, compiled to lib/)
  context/       memory-context: injects recalled facts into the prompt
  store/         storage domain + JSON store + BM25 recall
  tool/          memory tool surface (search/save/forget…)
  review/        automatic extraction pipeline (memory-review)
  notes/         project-notes prompt projection
  client/        settings-card UI (own tsconfig gate; esbuild bundle, no tsc emit)
  remote/        remote storage adapter
  benchmark/     benchmark utilities
tests/         vitest specs (unit + integration)
docs/          Documentation index (docs/README.md), TECH_DESIGN, SEQUENCE_DIAGRAMS, standards
  i18n/          Bilingual pairing contract, translation rules, terminology
  archive/       Frozen planning/analysis records
.agents/
  notes/         Agent Notes (decision records) — see .agents/notes/README.md
  skills/        Skills (reusable workflows) — this directory
scripts/       Build and site tooling
```

## Commands

```sh
npm run build    # tsc (host + client gate) + fix-imports + client bundle (prepublishOnly runs build && test)
npm run test     # vitest run (the only test lane)
npm ci           # install (npm, not pnpm/yarn)
```

There is no typecheck/lint/doc-gate runner: `tsc` gates the build, vitest gates behavior, review gates the rest. GitHub Actions runs `build` + `test` on every push to `main` and every PR (`ci.yml`); `publish.yml` publishes on `v*` tags ([release pipeline](docs/TECH_DESIGN.md)).

## Conventions

- **Read `.agents/notes/README.md` before non-trivial changes.** Every non-trivial change includes an Agent Note in the same commit ([when to write one](.agents/notes/README.md#when-to-write-one)).
- **Host contract**: this package consumes host services as peer dependencies and must stay compatible with the installed harness. `docs/HOST_CONTRACT.zh.md` records the contract with source evidence; §9 is the checklist to run when the harness is bumped.
- **Client source is type-checked by its own gate, not the host program**: `src/client` is excluded from the host `tsc` program and compiles through `scripts/build-client.cjs` (esbuild, single-file bundle, no asset pipeline); `npm run build` type-checks it first via `tsc -p tsconfig.client.json`. Client UI copy and field conventions follow the [settings-plugin contract](docs/CLIENT_UI_LESSONS.zh.md); UI copy stays locale-owned.
- **The plugin writes no files into the repository** (since 0.6): user data lives under `$DSH_HOME/storages/memory.json` and notes under a configured `notesDir` with containment checks; never reintroduce repo-file generation.
- **No hardcoded tunables**: deployment-varying choices are validated `Config` fields changeable from `cordis.patch.yml` and the settings UI; protocol constants and security invariants stay fixed.
- **Misconfiguration fails loud** at load; never silently skip a missing referent.
- **An empty `catch` names what it swallows** and why nothing else can reach it; keep the `try` to one statement.
- **Trust TypeScript at typed same-process boundaries.** Validate at parser/config, durable/file, and remote/wire boundaries; do not add runtime validation for values the static interface already requires.
- **Prefer maintained dependencies over hand-rolling** when the swap genuinely deletes owned code and tests; the BM25 kernel and CJK tokenizer are the recorded exceptions (zero-dependency goal, [TECH_DESIGN](docs/TECH_DESIGN.md)).
- **Documentation follows [docs/AGENTS.md](docs/AGENTS.md)**: one home per fact, current-state prose, bilingual pairs update together ([i18n contract](docs/i18n/README.md)). Only these pairs are bilingual: root `README`, `docs/README`, `TECH_DESIGN`, `SEQUENCE_DIAGRAMS`, `docs/AGENTS`; everything else under `docs/` is zh-only by convention.
- **Tests describe behavior, not correctness.** A changed behavior updates its tests in the same change; test reliability rules (isolation, teardown, global state) follow [dsh-ci-test-reliability](.agents/skills/dsh-ci-test-reliability/SKILL.md).
- Files end with exactly one trailing newline.
- **Releases**: tag push via `npm version` + `git push --tags` triggers OIDC trusted publishing; run the [pre-push evidence](.agents/skills/dsh-pre-push-checks/SKILL.md) first. The runbook is [docs/RELEASING.zh.md](docs/RELEASING.zh.md).
- This repository is single-maintainer with direct pushes to `main`: no PR/stack workflow applies; [dsh-merging-stacked-prs](.agents/skills/dsh-merging-stacked-prs/SKILL.md) is carried for host-repo work only.

## Defensive patterns

Read [docs/defensive-patterns.md](docs/defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work.

## Skills

Skills in `.agents/skills/` are adapted from the harness repository and bound to this codebase's rules (this file, [docs/AGENTS.md](docs/AGENTS.md), [Agent Notes](.agents/notes/README.md)); use them for documentation work ([dsh-doc](.agents/skills/dsh-doc/SKILL.md)), prose ([dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md)), code review ([dsh-code-review](.agents/skills/dsh-code-review/SKILL.md)), pre-push evidence ([dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md)), test reliability ([dsh-ci-test-reliability](.agents/skills/dsh-ci-test-reliability/SKILL.md)), simplification surveys ([dsh-find-simplifications](.agents/skills/dsh-find-simplifications/SKILL.md)), and Agent Note curation ([dsh-archive-agent-notes](.agents/skills/dsh-archive-agent-notes/SKILL.md)).
