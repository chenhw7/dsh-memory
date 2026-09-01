---
name: dsh-pre-push-checks
description: Use before pushing to main, tagging a release, publishing to npm, or claiming checks pass in this repository (dsh-memory), to select the smallest build and test evidence that covers the outgoing diff without reflexively running the full suite on every step.
---

# Pre-Push Checks

Run relevant local evidence once before pushing `dsh-memory`. The repository is single-maintainer with direct pushes to `main`; two external gates run on GitHub Actions — `ci.yml` builds and tests every push to `main` and every pull request, and the release workflow (`.github/workflows/publish.yml`) runs `prepublishOnly` (`npm run build && npm run test`) before `npm publish` on a version tag. Local evidence exists to catch a failure before it reaches those runners — not to duplicate them.

## Inspect the outgoing change

1. Confirm the checkout and branch:

```sh
git status --short --branch
git rev-parse --show-toplevel
```

2. Establish the scope against the live base. There is no change-scope script here; use git directly:

```sh
git fetch origin main
git diff --stat origin/main...HEAD       # committed scope ahead of main
git diff --stat                          # staged + unstaged scope
git status --short                       # untracked files
```

After rebasing or merging an advanced `main`, re-run the scope report, reassess which behavior the combined scope can affect, and rerun only checks invalidated by the merge.

## Select relevant evidence

There is no universal local baseline beyond the release run. Every behavior change needs the narrowest available test that would fail for its regression; add broader checks only for surfaces the diff actually reaches. Test-selection rules (which spec owns a surface) are in [docs/testing.md](../../../docs/testing.md).

- **Store, recall, dedup, or context-injection behavior:** run the owning vitest file (`npx vitest run tests/bm25.spec.ts`, `tests/dedup.spec.ts`, `tests/context-refresh.spec.ts`, …). A golden-value change also updates its fixture and the evaluation document that pins it ([testing policy](../../../docs/testing.md#golden-corpora)).
- **Extraction / review-pipeline behavior:** run the owning file (`tests/extract.spec.ts`, `tests/confirm-extraction.spec.ts`, `tests/scanner.spec.ts`); when the prompt, judge rule, or scoring changed, also run the real-API suite with `DEEPSEEK_API_KEY` set — it self-skips without the key, so an unnoticed skip is not evidence.
- **Settings, model catalog, or client UI behavior:** run `tests/model-catalog.spec.ts`, `tests/settings-live.spec.ts`, and the owning `*.spec.tsx`; a client-source change also runs `npm run build` to prove the esbuild bundle compiles.
- **Type surface anywhere under `src/`:** run `npm run build` — tsc is this repository's typecheck lane; there is no separate typecheck script.
- **Documentation, Agent Notes, i18n sidecars, or doc-linked comments:** there is no doc gate; follow [dsh-doc](../dsh-doc/SKILL.md) review criteria by hand — relative links resolve, paired sides updated together with re-recorded sidecars ([i18n contract](../../../docs/i18n/README.md)).
- **Package manifests, exports, `cordis.patch.yml`, or build configuration:** run `npm run build`, and before publishing verify the harness-host compatibility contract ([HOST_CONTRACT.zh.md §9](../../../docs/HOST_CONTRACT.zh.md)) when the harness version moved.
- **Untracked residue:** confirm the diff adds no repository-written artifacts — this plugin writes no files into the repository ([root rule](../../../AGENTS.md)); new files must be source, tests, docs, or `.agents/` content.

Do not repeat a passing check merely because commit or push follows. `npm run test` (the full suite) belongs at release points, when diagnosing a failure, or when the change is genuinely cross-cutting; otherwise the focused files above are the evidence.

## Full local rehearsal

Run `npm run build && npm run test` once, in full, only when: the user explicitly requests it, a release tag is imminent ([runbook](../../../docs/RELEASING.zh.md)), or the change spans so many subsystems that no narrower set is credible. This mirrors what `prepublishOnly` runs; passing it locally is the strongest pre-release evidence.

## Protect history on `main`

Pushes go to `main` directly. Never force-push `main`; if a push is rejected, fetch and reconcile instead of overwriting. A rebase of local work onto advanced `main` re-runs the evidence invalidated by the new base before pushing.

## Handle failures

If a relevant check fails before a push, stop and fix or explain the blocker. Do not push and hope the release run differs. If a failure looks environment-specific, prove it: record the exact command and failing test, confirm the relevant non-platform evidence, and prefer fixing the nondeterminism over retrying.

## Push procedure

1. Run the selected relevant checks once.
2. Commit normally; inspect any files the commit includes with `git status --short`.
3. Push normally: `git push origin main`.
4. Verify the remote ref matches local `HEAD`:

```sh
git rev-parse HEAD origin/main
```

For a release, continue with the [release runbook](../../../docs/RELEASING.zh.md): `npm version <bump>`, `git push origin main --tags`, then watch the publish workflow. Report pending workflow runs as pending; inspect failures before attributing them to the code or the environment.
