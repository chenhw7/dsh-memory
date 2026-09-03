# Agent Note: Eval per-turn work budget

Status: implemented

English | [中文](2026-09-03-eval-turn-budget.zh.md)

## Problem

One runaway agent turn can dwarf the whole suite. In the 2026-09-02 core-v0 real run, two turns burned unboundedly in two distinct shapes: a single LLM call that streamed silently for 939–1151 s until the 384K `max-tokens` cap produced no visible text (two scenarios died on it), and a tool-call marathon — 347 tool calls, 33+ minutes, est. 15–25M tokens for one scenario, killed manually. The existing 120 s guard is an **idle** timeout: streaming chunks reset it, so continuous generation is unbounded, and tool loops never idle at all. The eval had no bound on either shape; the mock's deterministic success path never trips it, so nothing failed until a keyed real-model run paid for it.

## Decision

`eval/boot.ts` enforces a per-turn work budget inside the prompt collector: one turn (a `session/prompt` through its idle) breaches when its wall clock exceeds `wallSeconds` or its tool-call count exceeds `toolCalls`. A breach throws `eval boot: turn budget exceeded (…)`, which flows through the existing scenario-error path — fail loud, kept home, completed questions preserved — and the caller's teardown reaps the still-running turn (the SDK server exposes only `initialize`/`session/prompt`/`shutdown`; there is no interrupt, so disposal is the abort).

Resolution is per dimension, three layers: an explicit CLI flag (`--turn-wall-seconds`, `--turn-tool-calls`, `0` = that cap off) wins, then the `turnBudget:` section of the eval instrument config (`eval.yaml`, validated loud: both fields required, non-negative integers, unknown fields rejected), then the built-in defaults (180 s / 32 calls — anchored at ≥2× the worst legitimate turn observed and ~⅕ of the measured pathological streams). The effective values are stamped into every report (`turnBudget` field plus a markdown header line) and printed on the startup line, so a scored population always carries its calibration. The pure verdict lives in `turnBudgetBreach` (vitest seam); `startHarness` gained a `mockSequence` passthrough so the harness mock's `tool_call_success` behavior can drive unbounded tool rounds end to end.

## Alternatives considered

**Lower the initialize handshake's `maxTokens`** (e.g. 384K → 32K). Harness-native and free, and it caps the single-stream shape — but it changes a real operating point of the model under test (must be stamped, and gateway treatment of reasoning tokens inside `max_tokens` is unverified), and it does nothing about tool marathons. Deferred as a possible second layer, per the maintainer's call.

**Scenario-level wall clock.** Coarser: six 5-minute turns burn 30 minutes before it fires, while per-turn bounds the same damage ~6× earlier. Left as a possible backstop, deliberately not built.

**No budget.** The pre-change status quo; the 2026-09-02 run is the priced evidence against it.

## Consequences

- Worst case for one bad turn drops from unbounded (35 min, tens of millions of tokens) to ≤180 s of continuous activity; a whole scenario is implicitly bounded near turns × 180 s.
- Legitimate long turns now fail loud instead of completing: a corpus scenario that genuinely needs more than 180 s of agent work in one turn must raise the budget via flag or eval.yaml, and the raise is visible in the report stamp. The v0 corpus's conversational turns sit far below the defaults.
- Report stamp discipline: runs with different budgets are scored under different calibrations; the stamp makes that visible rather than comparable-silently.
- Still open: a deterministic per-minute token cap (a pacing proxy) — the budget bounds a turn's damage, not the per-minute rate; see [eval child home isolation](2026-09-03-eval-child-home-isolation.md), whose "left open" item this note resolves.

## Testing

- `tests/eval-config.spec.ts`: section parsing (present/absent/`0`-off/half-pasted/unknown-field/negative/float/scalar all loud), the three-layer resolution (flag > file > defaults, `0` wins per dimension), and the breach verdict (within/wall/tool/off dimensions, boundary values).
- `tests/eval-report.spec.ts`: the stamp carries `turnBudget`, the markdown header renders the budget line and the `unbounded` form.
- End to end through the real spawn path (mock `tool_call_success`, budget 5 calls): the prompt rejects with `eval boot: turn budget exceeded (toolCalls 6 > 5) — turn aborted, scenario fails`; the runbook records the script.
- `npm run eval:smoke` passes under the defaults; the strict `tsc` gate over `eval/` reports 0 errors; the full vitest lane passes (772 passed, 6 env-gated skips).
