# Agent Note: Eval child home isolation

Status: implemented

English | [中文](2026-09-03-eval-child-home-isolation.zh.md)

## Problem

The eval suite's throwaway `$DSH_HOME` isolated harness state, but the `dsh` child inherited the outer process's `HOME`. Two consequences surfaced in the first full real-model pass over `core-v0` (2026-09-02, fuyao-coding at reasoning effort high, fuyao-data judge, concurrency 2):

1. **A machine-dependent prompt ingredient.** The harness discovers user skills at `$DSH_AGENTS_HOME ?? homedir()/.agents` (harness `packages/skill/skill-filesystem`), so every SUT request carried the running machine's global skills catalog — a ~8.9K-char (≈4.2K-token) user-role block, ~27% of the per-call fixed input. It differs per machine and drifts as the user's skills change, so the SUT's prompt — and therefore every standing-injection measurement — was a function of the machine running the eval, violating the suite's charter that the plugin build is the variable.
2. **Scenario fiction colliding with the real machine.** The SUT read the injected skills as license to act on the host: work210 attempted a real Lark OAuth flow and blocked polling `job_output` for a human QR scan until the eval's 120 s turn timeout killed the scenario (failed twice, reproducibly); prog116 spent ~60 tool calls exploring the maintainer's actual home directory for the scenario's fictional cache bug and then hung one LLM call to the 384K `max-tokens` cap with no visible answer; prog104 improvised a fake monorepo and ran a 347-tool-call coding marathon (est. 15–25M tokens, killed manually). 3 of 32 scenarios failed; none of the failures were rate-limit or memory-chain failures (0 judge errors, 0 invalid verdicts, 0 HTTP 429s across 166 judge calls).

## Decision

`eval/boot.ts` materializes a fake child home at `<dshHome>/home/` — an empty directory with one pinned `.gitconfig` (identity `dsh-eval <dsh-eval@localhost>`, `init.defaultBranch = main`) — and points the child's `HOME` there, alongside the existing `DSH_HOME` pin. The harness's skill discovery resolves to zero entries and git identity is deterministic; no real-machine path is reachable through `homedir()`. `materializeChildHome` is idempotent across the two handles a plant chain opens on one dshHome, and the fake home shares dshHome's lifecycle: deleted with it on success, retained for forensics on failure. The pinned `.gitconfig` exists because plant dialogs ask the SUT to commit; without an identity, git fails in a way that itself perturbs behavior.

## Alternatives considered

**`DSH_AGENTS_HOME` override only.** Isolates the skills catalog with the same one-line cost but leaves `~/.gitconfig` and every other `homedir()` consumer inherited — a narrower cut that keeps exactly the class of machine leakage (git identity, caches) the suite exists to exclude.

**Seed a pinned skills snapshot into the fake home.** Would keep the skills dimension measurable while making it machine-independent. Rejected: it preserves the ~4.2K tokens/call cost and the deterministic OAuth-wait hang (skill files are instructions; the auth backend still needs a human), so the measurement stays fragile for no measured gain.

**Pin the skill provider's `config.agentsHome` through the profile patch layer.** Same effect on skills but requires per-run template substitution into the pinned config and couples the eval to one provider's config schema; a child-env row is one line, mode-independent, and covers every `homedir()` consumer at once.

## Consequences

- Per-call SUT fixed input drops ~15% (measured full request body 58.3K → 49.3K chars; the skills block was ~4.2K of the ~15.5K-token fixed base).
- The three recorded failure modes lose their trigger: scenario fiction can no longer be "solved" against the maintainer's real home, and no lark/skill surface exists to pull the SUT into interactive flows.
- Reports stamped before this change measured a skills-bearing SUT prompt and are **not comparable run-over-run** with post-change runs; [the runbook](../../../../docs/EVAL.zh.md) records the condition in its isolation section.
- The SUT intentionally diverges from the maintainer's interactive deployment (no skills catalog). Measuring how the deployed agent behaves with its real skills is a deployment-behavior audit, not this instrument's job.
- Left open: per-scenario work budgets (a marathon can still run inside the fake home) and a deterministic per-minute token cap (a pacing proxy); both are separate decisions.

## Testing

- `tests/eval-harness.spec.ts`: the fake home materializes inside dshHome with the pinned git identity, and is idempotent for a second handle on the same dshHome.
- One full mock SUT request captured before/after: the 8.9K-char skills user-message is gone; the system prompt and the 34-tool schema are unchanged.
- `npm run eval:smoke` passes; the full vitest lane passes (763 passed, 6 env-gated skips); the hand-run strict `tsc` gate over `eval/` reports 0 errors.
