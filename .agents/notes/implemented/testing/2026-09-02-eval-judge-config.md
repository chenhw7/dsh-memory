# Agent Note: Eval instrument config — the deployment home's eval.yaml and reasoning-effort passthrough

Status: implemented

English | [中文](2026-09-02-eval-judge-config.zh.md)

## Problem

The rubric judge was env-only (`EVAL_JUDGE_*`), which read as friction: the operator's credentials already live in the deployment home, and pasting three variables per L2 run invited copy-paste drift. Separately, neither model side carried a thinking strength: the tested model ignored the deployment's declared `agent-default-model.reasoningEffort` (so the scored run behaved differently from a real session), and the judge request had no way to enable thinking at a chosen strength.

## Decision

1. **`eval.yaml` is the eval's instrument config**, resolved per run as the project root's `eval.yaml` (the repo the CLI runs from — the pasted-credential copy, gitignored and 0600), then the deployment home's `$DSH_HOME/eval.yaml` (else `~/.dsh/eval.yaml`); `$DSH_EVAL_CONFIG` pins one explicit file (tests/CI) (`eval/eval-config.ts`) — judge only, deliberately: the judge must never default to the model under test (same-source self-grading bias), so the deployment's settings.yaml stays the tested-model source and this file never overrides it. `judge:` carries `baseURL` + `apiKey` (pasted) or `apiKeyEnv` (resolved from the eval process environment) + `model`, optional `reasoningEffort`. A present-but-incomplete section (half-pasted key, unknown fields, both credential forms) fails loud — a half-pasted instrument must not silently degrade to skipped judging.
2. **Precedence: `EVAL_JUDGE_*` env triple → eval.yaml `judge:` → `DEEPSEEK_*` fallback → skipped.** The yaml beats the generic DEEPSEEK fallback because it is the more specific instrument declaration; the env triple beats the yaml because explicit per-run env is the deliberate override.
3. **Reasoning effort flows end to end.** The tested model: `agent-default-model.reasoningEffort` rides the route resolution and the SDK initialize handshake (`boot.ts`), validated harness-side against the provider profile's declared efforts (`UNSUPPORTED_REASONING_EFFORT` otherwise) — the scored run thinks at the strength a real session thinks. The judge: `judge.reasoningEffort` is passed through as the wire `reasoning_effort` body param (the parameter `openai-completions` endpoints accept; pi-ai dispatches the same wire value from its profile mapping).
4. **The report stamp carries the effort.** `EvalReport.model` gains `reasoningEffort` (`null` for mock/undeclared) — answers differ by effort, so scores never leave it behind.

## Alternatives considered

**Auto-default the judge to the deployment's agent-default-model.** Zero-config, but it makes judge == tested model the silent default — precisely the bias the separate instrument exists to avoid. Rejected.

**Let eval.yaml also override the tested model.** It would duplicate `agent-default-model` and re-introduce the drift the settings mirror just removed; `--model` already covers per-run overrides. Rejected.

**Resolve the judge key from the managed credentials document.** The judge is a direct fetch from the eval process, so the value would have to be parsed in-process — breaking the probe-never-parse stance the credential plane just adopted. The `apiKeyEnv` reference (environment-provided) is the honest middle: the operator names a reference; the eval reads the environment, not the credentials document.

## Consequences

- The paste path for the judge is now a file next to the deployment's own config: paste `apiKey` once (0600), then every L2 run is `npm run eval -- --mode real --judge` with no env at all. `apiKeyEnv` remains for CI-style setups.
- `EvalReport.model` gains a required `reasoningEffort` field; report-shape consumers must carry it.
- The tested model's thinking strength now matches the deployment's declaration — a change to `agent-default-model.reasoningEffort` silently changes eval behavior, which is the point (mirror the deployment) and is why the stamp prints it.
