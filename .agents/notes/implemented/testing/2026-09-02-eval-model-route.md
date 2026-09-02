# Agent Note: Eval model route — agent-default-model default with a --model override

Status: implemented

English | [中文](2026-09-02-eval-model-route.zh.md)

## Problem

The eval suite's model surface had one hole: `--mode real` could only mean DeepSeek official with the hardcoded handshake model `deepseek-v4-flash` ([harness-run eval suite](2026-09-01-harness-eval-suite.md)), and no OpenAI-compatible gateway could be exercised as the model under test — the maintainer's actual deployment (an internal `fuyao` gateway with `fuyao-work`/`fuyao-coding`) had no key-free path into the suite, so the first keyed L2 run had no defined model story.

## Decision

1. **The model id is a CLI variable, not a hardcoded constant.** `--model <id>` (both `eval` and `eval:ab`) names the model under test for `real`/`external` runs; `mock` rejects the flag — the mock route is deterministic and reads nothing.
2. **Default = the deployment's own default.** Without `--model`, the id resolves from the outer deployment home (`$DSH_HOME`, else `~/.dsh`) `settings.yaml` → `agent-default-model.model` — the same model a real session gets. When the deployment declares none, the stock `deepseek-v4-flash` stands. Every resolution prints its source line; a settings document that exists but is unreadable, unparseable, or declares a malformed `agent-default-model` fails loud (`eval/model-route.ts`).
3. **The provider axis stays pinned.** The SDK server mounts only the `deepseek-official` adapter as its initialize fallback (`deepseek-harness/packages/sdk/server/src/server.ts`: any other provider name throws), so the harness reaches an arbitrary OpenAI-compatible gateway by pointing the adapter's endpoint at it — `--base-url` under `external`, `DEEPSEEK_BASE_URL` under `real` — while the model id rides the handshake. The deepseek adapter resolves uncatalogued model ids safely (text-only, default context window), which is exactly what a foreign gateway id needs. A non-DeepSeek deployment provider surfaces only as a printed notice, never as a route.
4. **Reports stamp the model identity.** `EvalReport.model` records `{ mode, id }` (`id: null` for the mock route) next to the build, rubric versions and judge identity — scores never leave their calibration.

## Alternatives considered

**Mount `dsh-llm-pi-ai` in the eval profile and pass the deployment provider through.** It would mirror the deployment more faithfully (compat flags, per-provider model catalogs), but the SDK server throws for any provider it has not mounted, so it needs a profile-bundle change in the throwaway home plus a provider settings block — more moving parts for the same wire. The deepseek-adapter route already speaks OpenAI-compatible chat completions, which is what the fuyao gateway serves. Revisit only if a target gateway needs pi-ai-specific protocol behavior.

**Validate the model id against a catalog at parse time.** The adapter deliberately treats uncatalogued endpoints as text-only; a parse-time catalog would reject exactly the foreign-gateway case this change enables.

**Silent fallback when `agent-default-model` is absent.** Rejected — a resolution that quietly differs per machine is indistinguishable from a stale report; the printed source line keeps it observable instead.

## Consequences

- The first keyed L2 run needs no code change beyond this one: `--mode external --base-url <gateway> --api-key <key>` with the judge env pointed at the same gateway exercises `fuyao-work` (or any `--model`) end to end; the model id lands in the report stamp.
- The `yaml` package joins devDependencies (eval-only; `files` still excludes `eval/`).
- The deployment home's `settings.yaml` is read at CLI start only; a mid-run edit does not affect an in-flight run.
- `EvalReport` gains a required field — A/B JSON payloads and any downstream consumer of the report shape must carry `model`.
