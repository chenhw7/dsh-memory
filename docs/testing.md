# Testing policy

English | [中文](testing.zh.md)

How this repository tests, and the rules that keep a green suite meaningful. Commands live in root [AGENTS.md](../AGENTS.md); linked Agent Notes and docs carry the rationale.

## Tiers

- **Unit** (`npm run test`): vitest over specs under `tests/`, including the integration specs in `tests/integration/` (composition and host-contract smokes). Tests stay beside the code they exercise in scope and naming; the [vitest config](../vitest.config.ts) compiles client sources with the automatic JSX runtime so `tests/*.spec.tsx` can drive the real `src/client` component tree in a `node` environment.
- **Real-API** (`tests/judge-real-api.spec.ts`): the only spec that calls a live model. It self-skips without `DEEPSEEK_API_KEY` (`describe.skipIf`), so keyless local runs and CI stay green. The [testing skill](../.agents/skills/dsh-ci-test-reliability/SKILL.md) treats its retries as valid only at this external boundary.
- **Golden corpora**: `tests/fixtures/` holds checked-in datasets — the dedup dataset, extraction goldens, and the scanner corpus. `tests/recall-golden.spec.ts` pins the injection-mode comparison behind the default-mode decision ([Agent Note](../.agents/notes/implemented/architecture/2026-08-26-index-mode-stays-policy-only.md)); a change that intentionally shifts a golden number updates the fixture and the note's measured tables (regenerable from the same spec) in the same change.
- **Build gate** (`npm run build`): `tsc` over `src/` plus the esbuild client bundle. TypeScript is the typecheck lane; there is no separate coverage, lint, or snapshot lane. CI (`.github/workflows/publish.yml`) runs `npm ci && npm publish --provenance` on a version tag, which executes `prepublishOnly` (`build && test`) before publishing — a failing suite blocks the release, and the tag/version consistency check runs before anything else.

## How specs execute

Vitest runs spec files concurrently in worker threads, and both CI and local runs share one host. Process isolation does not isolate host ports, predictable filesystem paths, environment, or global module state. [dsh-ci-test-reliability](../.agents/skills/dsh-ci-test-reliability/SKILL.md) owns the allocation, restoration, synchronization, timeout-budget, and teardown rules for any spec that acquires resources or mutates globals.

## Prefer the real implementation over a mock

Mock only the expensive or non-deterministic boundary: the LLM adapter behind the review pipeline and the remote storage transport. Everything downstream of those boundaries runs real — the JSON store, BM25 recall, dedup, and the settings schema resolve against the real domain code. The client suite drives the published `@deepseek-ai/dsh-client-store` directly rather than stubbing it. A hand-rolled stand-in proves the bridge moves bytes, not that the shipping code behaves as asserted.

## Verify the world, not the self-report

An assertion re-reads the store file, re-runs the scan, or inspects the rendered section externally; a keyword probe on the component's own log lets a broken pipeline pass. For extraction and review flows, assert the durable store state, not the model's narration. Tests own their resources: create them in the test, dispose in `afterEach` (even on failure), and never share a `tests/fixtures/` entry as writable state between specs.

## Key policy

Real-API tests read `DEEPSEEK_API_KEY` from the environment. Never commit credentials; never print key values in diagnostics. Self-skip keeps keyless contributors unblocked; it is not a cost signal. A no-key run proves plumbing; only a with-key run proves the judge prompt and scoring work against a real model — run it before publishing a change that touches the review pipeline.

## When a behavior change requires evidence

Every behavior change ships with the narrowest test that fails for its regression, selected per [dsh-pre-push-checks](../.agents/skills/dsh-pre-push-checks/SKILL.md): a changed recall ranking updates `tests/bm25.spec.ts` or the recall golden; a changed extraction prompt or judge rule updates `tests/extract.spec.ts` or `tests/confirm-extraction.spec.ts` and earns a with-key run; a changed settings field updates `tests/model-catalog.spec.ts` or `tests/settings-live.spec.ts`; a changed client card renders through a `*.spec.tsx` drive of the real component. The release runbook ([RELEASING.zh.md](RELEASING.zh.md)) owns when the full suite must run.
