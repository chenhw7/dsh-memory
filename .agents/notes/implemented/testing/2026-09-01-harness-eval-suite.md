# Agent Note: Harness-run eval suite for memory storage and recall

Status: implemented

English | [中文](2026-09-01-harness-eval-suite.zh.md)

## Problem

The plugin's only standing measurement is the retrieval golden set in `src/benchmark/` (35 entries × 35 query sets, CI-guarded by `tests/recall-golden.spec.ts`) plus an injection-cost table. It proves BM25 ranking quality and per-mode injection cost, and nothing else. Every mechanism change since — review extraction, dedup, conflict annotation, injection modes, the janitor, the index rewrite — lands without a quantitative answer to the question that motivates it: does a session actually behave better under the new build than under the old one?

Three specific gaps:

1. The **write path** is unmeasured: whether a planted fact sediments into `memory.json` at all, with correct scope/category and retrievable wording. Storage quality sits upstream of every other surface, and nothing scores it.
2. The **standing-injection path** is unmeasured: whether a fact stored during session N reaches the opening system prompt of session N+1 (the `memory` and `project-notes` sections), under which mode, with how much noise, at what cost.
3. There is no **A/B instrument**: improvements are argued from mechanism, not from two builds running the same workload side by side.

Unit tests assemble components and never boot the harness; the LLM is always a stub. None of the three gaps can be closed without running the real harness.

## Decision

The suite lives in the top-level `eval/` directory on the `eval/benchmark-suite` worktree branch, outside the published bundle (`files` stays `lib`, `cordis.patch.yml`, `README.md`). The runbook is [docs/EVAL.zh.md](../../../../docs/EVAL.zh.md). The core design holds: **the plugin build is a variable**. `npm run eval -- --build <dir>` takes any built plugin directory — main, a feature branch, a published npm version — materializes a throwaway `$DSH_HOME` per scenario, loads the build as a real profile bundle over the real harness (`dsh --profile sdk`, SDK stdio client), executes the same scenario corpus, and reports per-slice metrics plus an A/B paired diff (`npm run eval:ab`).

The suite ships as one lane with two scenario chains, both measured against the same mechanical and judged metrics:

- **seed** — pre-write the store via the single-source medium writer, open one session, and score the opening system prompt as the standing-injection surface for every question.
- **plant** — session 1 plays a realistic dialogue that plants facts; dispose triggers the flush; quiesce bounds it; the settled medium is the storage measurement; session 2 re-opens on the SAME `$DSH_HOME` with a fresh handle (fresh memory snapshot, KV-cache session contract) and answers the questions.

Every metric has exactly one home: mechanical items (standing hit, noise ratio, injection cost, storage precision) are computed in code (`eval/mechanical.ts`, `eval/report.ts`); judged items are computed by the rubric-anchored LLM judge (`eval/judge.ts`). Reports stamp the build under test, rubric versions, judge identity, and memory mode, so scores are never read without their calibration.

## Scenario corpus

`eval/datasets/core-v0.jsonl` holds 32 hand-authored scenarios carrying 128 scored questions: 16 plant / 16 seed; programming 17, daily-work 10, life 5; 20 zh (62.5%), 5 en, 7 mixed. Question types: 60 single-hop, 60 paraphrase, 3 multi-hop, 5 negative. `eval/datasets/smoke.jsonl` holds the pinned M0 smoke scenario (1 seed scenario, 2 questions). Every scenario carries planted facts, same-topic distractor entries, and paraphrased question variants; negative questions (the fact was never stated) guard against hallucinated recall.

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

The corpus contract is `eval/schema.ts` (zod, strict): one scenario per JSONL line, validated loud at load. The retrieval golden set stays in `src/benchmark/` as the cheap L0 floor; this corpus measures harness behavior, not the tokenizer.

## Scoring rubric

Scoring is anchored by the versioned rubric files `eval/rubric/storage-v1.md` and `eval/rubric/recall-v1.md`. The judge's system prompt is the rubric text verbatim, every report stamps the rubric versions it used (parsed from each file's `Rubric version: <N>` first line), and changing an anchor bumps the version — scores from different rubric versions are never compared. This is what "a fixed scoring standard" means here: the judge is an instrument with a recorded calibration, not a per-run improvisation.

**Storage rubric** — per stored entry, against its planted fact, four dimensions scored 0–2 with written anchors:

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Content fidelity | contradicts or drops the fact, or fabricates detail | core correct, partly lost or noisy | complete and accurate, nothing invented |
| Scope & category | wrong scope | right scope, wrong or missing category | both correct |
| Retrievability | misses paraphrased queries entirely | weak match under rewording | stable hit under rewording |
| Merge behavior | wrong merge overwrites a different fact, or duplicates | merges but loses information | correct merge/update/new verdict |

A wrong scope caps the entry at 1 overall, because a scope error breaks every downstream injection surface. Scenario level adds storage precision: the share of written entries that trace to no planted fact (extraction hallucination).

**Recall rubric** — per question, mechanical and judged parts:

- Standing hit (mechanical): the required fact appears in the opening system prompt of the follow-up session, matched by token or near-match against the planted content and its summary.
- Injection quality (judged, 0–3): 0 — relevant memory absent; 1 — present but misleading, stale, or an unannotated conflict; 2 — correct but with significant noise; 3 — clean, complete, directly usable.
- Noise ratio and injection cost (mechanical): the unrelated share of injected entries; characters and ≈tokens.
- Answer correctness (judged, 0–2, real-model runs only): 0 — wrong or hallucinated; 1 — partially correct; 2 — correct against gold.

Judge protocol: temperature 0; structured output (per-dimension score plus quoted evidence lines); one re-judge on parse failure, then recorded as invalid and counted separately; judged means cover non-null verdicts only, so a skipped judge reads as `null`, never as zero. A/B runs the judged layers as deltas; the deterministic layers diff exactly per scenario.

## Standing-injection chain evaluation

The headline scenario type joins the write path to the standing injection. Session 1 plants facts inside a realistic programming or daily-work conversation; the runner waits for quiescence (review drain or dispose flush completes; `memory.json` and its audit table poll stable); session 2 opens in the same `$DSH_HOME` and the assembled system prompt is captured from the SDK `request/header` event. Each planted fact is then scored as a chain: the storage rubric score for how it was stored, the standing hit for whether it reached session 2's `memory`/`project-notes` sections, and — in real-model runs — answer correctness. A miss is diagnosed as an extraction failure or an injection failure instead of disappearing into an aggregate number.

Both injection modes are measured, because the factory default is index mode: `full` scores the rendered content blocks; `index` scores index-line quality — whether the existence line plus summary is enough to route a `memory_search`. Config knobs that would blur runs (`decayDays`, the curator, `confirmBeforeWrite`, `reviewCandidateThreshold`) are pinned per scenario class through the profile's `cordis.patch.yml`.

## Execution design

```text
eval/
  datasets/*.jsonl          # scenario corpus, one scenario per line (smoke, core-v0)
  rubric/storage-v1.md      # anchored scoring rubric (versioned)
  rubric/recall-v1.md
  harness/profile-template/ # profile package.json + settings + cordis.patch.yml (pinned config)
  harness/…                 # sdk-client, llm-mock launcher, route-table fake LLM, quiesce, seed-media
  boot.ts                   # temp DSH_HOME + link build dir + spawn `dsh --profile sdk`
  runner.ts                 # scenario executor (seed / plant chains)
  mechanical.ts             # mechanical metrics: fences, matching, noise, cost
  judge.ts                  # rubric-driven LLM judge (env-gated)
  report.ts                 # metrics + A/B paired diff, JSON + Markdown
  schema.ts                 # corpus contract (zod) + dataset loader
  cli.ts                    # `npm run eval` / `npm run eval:ab`
  smoke.ts                  # M0 chain smoke (`npm run eval:smoke`)
```

- **Boot**: `DSH_HOME` points at a per-scenario temp directory; the profile template declares `dsh.profile.bundles` with the plugin linked to the build under test (`link:<dir>`), mirroring the live `web` profile wiring. Driving uses the harness TS SDK client over `--profile sdk`; the assembled system prompt, tool calls, and final answers come from SDK session events, the audited `storages/memory.json`, and quiesce-stable medium reads. Nothing is written into the plugin repository (the no-repo-files rule, [Agent Note](../architecture/2026-08-31-project-notes-writes-no-repository-files.md)).
- **Model modes**: `mock` starts the harness `@deepseek-ai/dsh-llm-mock-server` in-process for deterministic L1 runs — measured to NOT route by request content, so answer text is irrelevant and standing-injection runs stay deterministic. Content-aware scripted responses (the plant chain's extraction conversations) use the in-`eval/` route-table fake LLM (`eval/harness/fake-llm.ts`) behind `--mode external --base-url`; its route match receives the escaped raw wire body. `real` passes through to the public endpoint and is env-gated like `tests/judge-real-api.spec.ts`, never run in CI.
- **Judging**: `--judge` activates the rubric judge when the judge environment exists (`EVAL_JUDGE_BASE_URL`/`EVAL_JUDGE_API_KEY`/`EVAL_JUDGE_MODEL`, falling back to `DEEPSEEK_*`); with no judge environment the judged layer is skipped and the deterministic layer still runs.
- **A/B**: `npm run eval:ab -- --baseline <dir> --candidate <dir>` runs the corpus twice and emits a paired per-scenario diff; deterministic layers diff exactly, judged layers aggregate as candidate − baseline deltas.

## Alternatives considered

**Extend only the existing golden set.** The golden set measures ranking over fixed entry-and-query pairs; it cannot see whether extraction stores the right thing, whether the standing injection delivers it, or whether answers improve. It already exists and stays as the cheap CI floor.

**Adopt an external eval framework (promptfoo/ragas/LoCoMo-style).** They carry their own agent-loop assumptions; the requirement is the behavior of the real harness with the plugin composed as a profile layer, which none of them drive. Borrowing public datasets for slices is fine; the loop must be the harness's own.

**Scale up the in-process composition tests (`tests/integration/host.spec.ts` style).** Deterministic and cheap, but they never exercise real boot, profile layering, `settings.yaml`, session persistence, or dispose-time flush timing — exactly the surfaces the eval must judge. They remain unit floors, not the eval.

**Exact-match scoring instead of an LLM judge.** Extraction legitimately paraphrases; exact match systematically undercounts. Mechanical checks (hit, noise, cost) stay exact; judged dimensions get the anchored rubric.

**Per-run ad-hoc judging without a versioned rubric.** Scores drift across runs and judge models, so cross-build comparison degrades into noise. The versioned-rubric requirement exists precisely to prevent this.

## Testing

- `npm run build` exits 0 (the host tsc program covers `src/`; `eval/` is outside it) and `npm run test` passes 744 tests with 6 skipped (the env-gated `tests/judge-real-api.spec.ts`), including the seven `tests/eval-*.spec.ts` files over the eval modules.
- The manual strict-tsc gate over the eval sources and their specs (`tsc --ignoreConfig --noEmit --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --noImplicitOverride …` over `eval/*.ts eval/harness/*.ts tests/eval-*.spec.ts`) reports 0 errors.
- `npm run eval:smoke` passes (exit 0): the seeded facts surface in the `<memory-index>` fence and survive on the medium.
- A full mock pass over `core-v0.jsonl` completes 32/32 scenarios with 0 errors; all 61 measurable seed questions stand at 100%; plant scenarios score low under the content-blind mock (expected — extraction needs content-aware responses); negative questions are not measurable and stay out of the denominators.
- `npm run eval:ab` with the same build directory as both sides reports the deterministic layer EQUAL across all scenarios.
- The plant chain runs end to end through `--mode external` against the fake LLM (SSE framing) with judging active — the full chain the suite measures.
- Every command in [docs/EVAL.zh.md](../../../../docs/EVAL.zh.md) was executed before the runbook landed.

## Consequences

The suite buys a quantitative A/B instrument over real harness behavior and pays for it in accepted limits:

- **Real runs and real judging are env-gated and need credentials.** `--mode real` refuses to boot without a `DEEPSEEK` key (environment or managed `$DSH_HOME/.credentials.yaml`); `--judge` degrades to deterministic-only when no judge environment exists. Neither ever runs in CI — keyless runs stay green, at the cost of L2 evidence requiring a keyed, manual pass.
- **The mock model cannot route by request content** (measured, recorded in `eval/harness/llm-mock.ts`). Deterministic standing-injection runs are unaffected; extraction-quality measurement depends on the in-`eval/` route-table fake LLM or a real model. Plant storage scores under the bare mock measure the routing gap, not extraction.
- **The corpus's slices are unevenly powered.** 128 questions cover standing injection and paraphrase densely, but multi-hop holds only 3 questions — no conclusion can rest on that slice — and the 5 negative questions guard one failure mode (hallucinated assertion) only. v0 deliberately stops at 32 scenarios; scaling the corpus is incremental, not structural.
- **Mechanical matching is a deterministic approximation.** The thresholds — a verbatim fast path, then ≥2 distinctive tokens or ≥1 distinctive ASCII anchor against sibling-fact contrast sets — are implementation choices for rubric v1, recorded as calibration input for rubric v2, not a semantic verdict.
- **Judge variance is mitigated, not eliminated**: anchored rubrics, temperature 0, one re-judge then invalid-and-counted-separately; judged A/B deltas are mean differences of two independent judge passes — the judge never sees both builds side by side — and residual sensitivity to the judge model is accepted and stamped next to the rubric version.
- **Quiescence is bounded, not instant**: dispose flush and review drain poll to stability with timeouts (default 30 s), and the profile patch pins the knobs that would blur runs, so a slow flush fails loudly instead of silently deflating storage scores.
- **Boot wiring follows the [host contract](../../../../docs/HOST_CONTRACT.zh.md) §10 checklist**; harness bumps require re-running the M0 smoke before trusting eval numbers again.
- **`eval/` is type-checked outside every automated gate**: the host tsconfig compiles `src/` only, and vitest/tsx transform without checking, so strict coverage rides a hand-run `tsc --ignoreConfig` flag set rather than a dedicated tsconfig — a hole a maintainer must remember to fill by hand.
