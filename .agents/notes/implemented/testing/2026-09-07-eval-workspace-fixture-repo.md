# Agent Note: eval workspace fixture — repo-addressing dialogues get a materialized repository

Status: implemented

English | [中文](2026-09-07-eval-workspace-fixture-repo.zh.md)

## Problem

The 2026-09-07 real judged slice surfaced two corpus findings with one shared root: the eval child's cwd was the throwaway home root — an empty directory — so planting dialogues that address "这个仓库" had no in-workspace referent, and the child is not filesystem-sandboxed; the model resolved the phrase to the real host disk. prog101's question session quoted the actual repository's files verbatim (AGENTS.md's `npm ci` line, package-lock.json, ci.yml) and let that evidence falsify the scenario's counterfactual planted premise — its answer-0s are corpus-validity failures, not memory-chain failures. prog104's planting turn escaped into a real harness checkout on the host and never converged: 65>64 and 97>96 budget breaches at exactly budget+1, a non-terminating loop. Both scenarios were declared unrunnable under the real model until the corpus stopped sending the model looking for a repository the workspace does not contain ([the findings](../architecture/2026-09-04-write-path-rework-implementation-plan.md), "Eval lane results (2026-09-07)").

## Decision

A workspace-fixture axis on the corpus, a materializer, and a cwd move — the empty-home root stops being the model's "this repository":

- `scenarioSchema` gained `workspace: 'demo-app' | 'monorepo'` (`eval/schema.ts`); absent means the child keeps the home root as cwd (memory-recall scenarios — the seed rows' questions address other projects and user preferences, never the current repo).
- `materializeWorkspace` (`eval/harness/workspace.ts`) copies the pinned template from `eval/harness/workspace-templates/`, runs `git init` plus one initial commit under the pinned identity (`dsh-eval <dsh-eval@localhost>` — the same pair the fake child home writes, so the eval process's own global git config never leaks into the fixture's history), then writes exactly one untracked file (`docs/next-steps.md`) so a dialogue's "commit this change" has a referent and `git status` shows exactly one entry. Idempotent per home on the `.git` guard: the plant chain's second handle reuses the first session's tree, first-session edits included.
- `StartHarnessOptions.cwd` (`eval/boot.ts`, default the throwaway home) is now plumbed to both the child process and the `initialize` handshake; the runner passes the materialized path for both of a workspace scenario's handles. The credentials project-`.env` isolation is preserved (the workspace lives inside the throwaway home), and the current-project name the memory plugin infers from the session header's cwd basename becomes the stable `demo-app`/`monorepo` instead of the random `dsh-eval-run-XXXX`.
- Eight core-v0 plant rows pin a template — the corpus's repo-work dialogues: `demo-app` for prog101/104/106/107/112/116/117, `monorepo` for prog111 (its dialogue is premise-bound to packages/web, packages/core, turbo.json, and the core-before-web build order; a single-package fixture would have become the new premise falsifier).

## The templates

Both are pnpm-only (README + package.json + lock file state the toolchain, confirming prog101's planted premise; nothing in either template contradicts any planted fact) and zero-dependency — `pnpm install` resolves offline and no scenario-time network fetch can burn turn budget nondeterministically.

- `demo-app` — a single-package TypeScript service. `src/cache.ts` is a write-through `DetailCache` (prog116's write-path invalidation premise, build-stamped edge keys); `lib/util.ts` carries a default export that `lib/index.ts` re-exports (prog112's no-default-export rule has a concrete, completable fix target in `lib/`); `tests/integration/flaky.spec.mjs` documents the intermittent-timeout history in-file (prog104's flaky premise); `.github/workflows/ci.yml` runs the typecheck gate before test (prog104's red-CI premise); `pnpm test` is `node --test` over the two explicit test files — green with zero dependencies (the spec pins this), because `node --test <directory>` executes the directory as a module (MODULE_NOT_FOUND) and only the no-argument form discovers files.
- `monorepo` — a pnpm workspace with `packages/core` and `packages/web`, each building through `tsc -p tsconfig.json` (prog111's single-package typecheck discipline, restated in `packages/web/src/app.ts`); the root `build` script runs core then web (the build-order premise); `turbo.json` declares `"dependsOn": ["^build"]` and no remote-cache key (the "turborepo 远程缓存没开" state).

## Testing

`tests/eval-workspace.spec.ts` (12 cases) pins the materializer over both templates: template fidelity plus the pending file, the one-commit history under the pinned identity, exactly one pending change with deterministic content, idempotency across the two-handle plant chain, fail-loud on an unknown template, the demo-app suite's own green run (the anti-loop property), and the schema axis (acceptance, rejection, and the corpus lint: a workspace row is a plant row). The full lane: **961 passed | 6 skipped (967)**. End-to-end, the workspace-materialized full core-v0 mock run (`/tmp/ab4-host-workspace-core.json`) diffs **deterministic EQUAL, zero scenario errors** against the pre-workspace host baseline (`/tmp/ab2-host-core.json`) — the fixture is behavior-neutral on the deterministic layer while booting both sessions of all eight scenarios over the materialized repos.

## Alternatives considered

- **Sandboxing the child process.** Rejected for this round: a filesystem fence needs container/seccomp machinery the eval process does not own, and a fence alone does not give "这个仓库" a referent — the model would still be addressing a repository that does not exist. The materialized workspace removes the motive for the escape; the sandbox stays the recorded complementary hardening if a real-model run still escapes with a referent present.
- **Inline per-scenario workspace files in the JSONL rows.** Rejected: multi-kilobyte escaped strings per row, the same base files repeated across eight rows, and corpus-line diff noise on every template tweak. A versioned template tree (the profile template's discipline) with a thin per-row pin keeps the corpus readable.
- **Keeping cwd at the home root and naming a subdirectory in dialogue text.** Rejected: eight-row corpus text edits, the harness's own files (settings.yaml, storages/) still in the model's root view, and a shape that diverges from the deployment — the real harness runs with cwd at the project root, and the memory plugin reads `session.header.cwd`.
- **A dependency-complete fixture (vendored tsc, installed node_modules).** Rejected: network installs inside a scenario are nondeterministic and burn turn budget; zero-dependency keeps materialization offline-deterministic. `pnpm build` failing on a missing global tsc is a bounded, reportable outcome — the planted premises are rules to remember, not builds to verify.

## Consequences

- The two blocked scenarios get their recorded corpus fix: the counterfactual premise is now consistent in-repo and the repo-work dialogues have a bounded target. Their rerun — and the 25/32 of the judged baseline still pending — now runs against a workspace-resolved corpus.
- The current-project identity inside planted sessions becomes deterministic (the cwd basename), so the injection ordering and any project-scope behavior stop keying on the random temp name.
- Residuals, recorded rather than closed: prog112's dialogue names `ui-kit`, a sibling project the fixture does not materialize — the model can report its absence but cannot loop on it; prog106's "几个改动我分开提交" finds one pending file, not several. The fixtures are premise-consistent, not premise-exhaustive: a future scenario whose dialogue binds to a shape no template matches gets its own template, not an overlay on an existing one.
- The mock A/B equality covers the workspace-materialized corpus (EQUAL against the pre-change baseline), so the deterministic lane stays comparable across this change; the noisy lane declares no workspace and is untouched.
