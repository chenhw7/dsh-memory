# Agent Note: Harness-run eval suite for memory storage and recall

Status: proposed

English | [中文](2026-09-01-harness-eval-suite.zh.md)

## Problem

The plugin's only standing measurement is the retrieval golden set in `src/benchmark/` (35 entries × 35 query sets, CI-guarded by `tests/recall-golden.spec.ts`) plus an injection-cost table. It proves BM25 ranking quality and per-mode injection cost, and nothing else. Every mechanism change since — review extraction, dedup, conflict annotation, injection modes, the janitor, the index rewrite — lands without a quantitative answer to the question that motivates it: does a session actually behave better under the new build than under the old one?

Three specific gaps:

1. The **write path** is unmeasured: whether a planted fact sediments into `memory.json` at all, with correct scope/category and retrievable wording. Storage quality sits upstream of every other surface, and nothing scores it.
2. The **standing-injection path** is unmeasured: whether a fact stored during session N reaches the opening system prompt of session N+1 (the `memory` and `project-notes` sections), under which mode, with how much noise, at what cost.
3. There is no **A/B instrument**: improvements are argued from mechanism, not from two builds running the same workload side by side.

Unit tests assemble components and never boot the harness; the LLM is always a stub. None of the three gaps can be closed without running the real harness.

## Proposal

Build the eval suite in the dedicated worktree (branch `eval/benchmark-suite`, top-level directory `eval/`, outside the published bundle). The core design: **the plugin build is a variable**. The runner takes any built plugin directory — main, a feature branch, a published npm version — materializes a throwaway `$DSH_HOME` per build, loads the plugin as a real profile bundle over the real harness, executes the same scenario corpus, and reports per-slice metrics plus an A/B diff.

Delivery is phased so the risky part lands first:

- **M0 — smoke**: profile template and boot path; one scenario proves the chain end to end (temp `$DSH_HOME` → `dsh --profile sdk` multi-turn → assembled system prompt captured → `memory.json` written).
- **M1 — standing-injection suite**: seeded stores plus realistic follow-up sessions under a mock model; deterministic, CI-optional.
- **M2 — storage suite**: realistic planting conversations; stored entries scored against their planted facts with the storage rubric.
- **M3 — end-to-end + A/B**: real-model answer scoring with the recall rubric, a memory-off control, and `eval:ab`.
- **M4 — docs and lifecycle**: runbook under `docs/`; this note moves to `implemented/`.

## Scenario corpus

The conversations must be realistic. Domains are programming (primary), daily work, and life, at roughly 55 / 30 / 15 percent; zh carries about two thirds of scenarios, the rest en or mixed. Scenarios are hand-authored, synthetic but realistic (no verbatim personal data), each a 5–15 turn session where facts surface the way they do in real use: explicit remember-intents, mid-flow corrections, and failure streaks built from realistic tool call sequences. Every scenario carries planted facts, distractor entries (same topic, different fact), and paraphrased question variants; a slice of negative questions (the fact was never stated) guards against hallucinated recall.

```json
{
  "id": "prog-build-toolchain-01",
  "domain": "programming",
  "language": "zh",
  "turns": [
    { "user": "……", "planted": ["build-pnpm-only"], "signals": ["keyword", "correction"] }
  ],
  "questions": [
    { "q": "这个仓库构建用 npm 还是 pnpm？", "requires": ["build-pnpm-only"],
      "gold": "pnpm；不要用 npm install", "type": "single-hop", "variantOf": null }
  ]
}
```

Sizing: v0 targets at least 30 scenarios (programming ≥ 16, daily work ≥ 9, life ≥ 5) and 60–100 scored questions. The retrieval golden set stays in `src/benchmark/` as the cheap L0 floor; this corpus measures harness behavior, not the tokenizer.

## Scoring rubric

Scoring is anchored by versioned rubric files under `eval/rubric/` (storage, recall). The judge's system prompt is generated from the rubric text, every report stamps the rubric versions it used, and changing an anchor bumps the version — scores from different rubric versions are never compared. This is what "a fixed scoring standard" means here: the judge is an instrument with a recorded calibration, not a per-run improvisation.

**Storage rubric** — per stored entry, against its planted fact, four dimensions scored 0–2 with written anchors:

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Content fidelity | contradicts or drops the fact, or fabricates detail | core correct, partly lost or noisy | complete and accurate, nothing invented |
| Scope & category | wrong scope | right scope, wrong or missing category | both correct |
| Retrievability | misses paraphrased queries entirely | weak match under rewording | stable hit under rewording |
| Merge behavior | wrong merge overwrites a different fact, or duplicates | merges but loses information | correct merge/update/new verdict |

A wrong scope caps the entry at 1 overall, because a scope error breaks every downstream injection surface. Scenario level adds storage precision: the share of stored entries that trace to no planted fact (extraction hallucination).

**Recall rubric** — per question, mechanical and judged parts:

- Standing hit (mechanical): the required fact appears in the opening system prompt of the follow-up session, matched by token or near-match against the planted content and its summary.
- Injection quality (judged, 0–3): 0 — relevant memory absent; 1 — present but misleading, stale, or an unannotated conflict; 2 — correct but with significant noise; 3 — clean, complete, directly usable.
- Noise ratio and injection cost (mechanical): the unrelated share of injected entries; characters and ≈tokens.
- Answer correctness (judged, 0–2, real-model runs only): 0 — wrong or hallucinated; 1 — partially correct; 2 — correct against gold.

Judge protocol: temperature 0; structured output (per-dimension score plus quoted evidence lines); one re-judge on parse failure, then recorded as invalid and counted separately; real-model runs repeat N=3 and report means. A/B runs the judge blind-pairwise: both builds' injections or answers under shuffled labels, verdict plus tie.

## Standing-injection chain evaluation

The headline scenario type joins the write path to the standing injection. Session 1 plants facts inside a realistic programming or daily-work conversation; the runner waits for quiescence (review drain or dispose flush completes; `memory.json` and its audit table poll stable); session 2 opens in the same `$DSH_HOME` and the assembled system prompt is captured from the SDK `request/header` event. Each planted fact is then scored as a chain: the storage rubric score for how it was stored, the standing hit for whether it reached session 2's `memory`/`project-notes` sections, and — in real-model runs — answer correctness. A miss is diagnosed as an extraction failure or an injection failure instead of disappearing into an aggregate number.

Both injection modes are measured, because the factory default is index mode: `full` scores the rendered content blocks; `index` scores index-line quality — whether the existence line plus summary is enough to route a `memory_search`. Config knobs that would blur runs (`decayDays`, the curator, `confirmBeforeWrite`, `reviewCandidateThreshold`) are pinned per scenario class through the profile's `cordis.patch.yml`.

## Execution design

```text
eval/
  datasets/*.jsonl          # scenario corpus, one scenario per line
  rubric/storage-v1.md      # anchored scoring rubric (versioned)
  rubric/recall-v1.md
  harness/profile-template/ # profile package.json + cordis.patch.yml (pinned config)
  boot.ts                   # temp DSH_HOME + link build dir + spawn `dsh --profile sdk`
  runner.ts                 # scenario executor (plant / seed / ask)
  judge.ts                  # rubric-driven LLM judge (env-gated real model)
  report.ts                 # metrics + A/B paired diff, JSON + Markdown
  cli.ts                    # `npm run eval` / `npm run eval:ab`
```

- **Boot**: `DSH_HOME` points at a temp directory; the profile template declares `dsh.profile.bundles` with the plugin linked to the build under test (`link:<dir>`), mirroring the live `web` profile wiring. Driving uses the harness TS SDK client (`packages/sdk/client/src/api.ts`) over `--profile sdk`; the JSON-RPC surface is small enough that a fallback stdio client inside `eval/` is acceptable if the client package cannot be linked. M0 verifies the whole chain before anything depends on it.
- **Assertion sources**: SDK events (`request/header` for the assembled prompt, `tool/call` for tool behavior, `assistant/message` for answers), `storages/memory.json` with its audit table, and the session transcript under `sessions/`.
- **Model modes**: `mock` routes `DEEPSEEK_BASE_URL` at `@deepseek-ai/dsh-llm-mock-server` for deterministic L1 runs; if the mock server cannot route responses by request content — an ability the extraction scenarios need — a small route-table fake server lives in `eval/` instead. `real` runs are env-gated (the same pattern as `tests/judge-real-api.spec.ts`) and never run in CI.
- **A/B**: `npm run eval:ab -- --baseline <dir> --candidate <dir>` runs the corpus twice and emits a paired per-scenario diff; deterministic layers diff exactly, judged layers aggregate repeats.

## Alternatives considered

**Extend only the existing golden set.** The golden set measures ranking over fixed entry-and-query pairs; it cannot see whether extraction stores the right thing, whether the standing injection delivers it, or whether answers improve. It already exists and stays as the cheap CI floor.

**Adopt an external eval framework (promptfoo/ragas/LoCoMo-style).** They carry their own agent-loop assumptions; the requirement is the behavior of the real harness with the plugin composed as a profile layer, which none of them drive. Borrowing public datasets for slices is fine; the loop must be the harness's own.

**Scale up the in-process composition tests (`tests/integration/host.spec.ts` style).** Deterministic and cheap, but they never exercise real boot, profile layering, `settings.yaml`, session persistence, or dispose-time flush timing — exactly the surfaces the eval must judge. They remain unit floors, not the eval.

**Exact-match scoring instead of an LLM judge.** Extraction legitimately paraphrases; exact match systematically undercounts. Mechanical checks (hit, noise, cost) stay exact; judged dimensions get the anchored rubric.

**Per-run ad-hoc judging without a versioned rubric.** Scores drift across runs and judge models, so cross-build comparison degrades into noise. The versioned-rubric requirement exists precisely to prevent this.

## Acceptance criteria

- `npm run eval` boots a real harness subprocess with the plugin mounted as a profile bundle in a throwaway `$DSH_HOME` and produces a report without manual steps.
- The corpus holds at least 30 realistic scenarios across programming, daily work, and life with the stated zh/en mix, plus distractor facts, paraphrase variants, and negative questions.
- Reports stamp rubric versions and state, per slice: standing-hit rate, storage rubric scores, injection quality/noise/cost, and — for real-model runs — answer lift over the memory-off control.
- `npm run eval:ab` produces a paired per-scenario diff between two build directories; deterministic layers reproduce identical scores across reruns under the mock model.
- Eval runtime writes nothing into the plugin repository — all state lives in the temp `$DSH_HOME` (the no-repo-files rule, [Agent Note](../../implemented/architecture/2026-08-31-project-notes-writes-no-repository-files.md)).

## Risks

- **Judge variance** — mitigated by anchored rubrics, temperature 0, N=3 repeats, and blind-pairwise A/B; residual sensitivity to the judge model is accepted and recorded (the judge model identity is stamped next to the rubric version).
- **Mock-model capability** — extraction scenarios need content-aware scripted responses; M0 verifies the harness mock server's routing ability before M2 depends on it, with the in-`eval/` fallback named above.
- **Real-model cost and nondeterminism** — real runs stay env-gated, N=3 by default, never in CI; corpus sizing keeps a full pass bounded.
- **Async quiescence flakiness** — the dispose flush carries a 5 s cap and the drain is threshold-gated; the runner polls the audit table to stability with a timeout, and scenario classes pin thresholds via the profile patch, so a slow flush fails loudly instead of silently deflating storage scores.
- **Harness version drift** — boot wiring follows the [host contract](../../../../docs/HOST_CONTRACT.zh.md) §10 checklist; harness bumps require re-running the M0 verification.
