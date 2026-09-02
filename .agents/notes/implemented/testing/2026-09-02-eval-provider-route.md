# Agent Note: Eval provider route — mirror the deployment's llm-pi-ai settings section

Status: implemented

English | [中文](2026-09-02-eval-provider-route.zh.md)

## Problem

The morning [eval model route](2026-09-02-eval-model-route.md) declared the provider axis pinned to `deepseek-official`, pointing non-DeepSeek gateways at the adapter's endpoint instead. That was wrong as a harness claim: the SDK profile's base bundle mounts `dsh-llm-pi-ai` **dormant** (zero routes), and a deployment's `llm-pi-ai:` settings section — exactly what the web Models page writes — activates its routes live. The maintainer's `~/.dsh/settings.yaml` carries `llm-pi-ai.providers.fuyao` plus `agent-default-model: fuyao/fuyao-work`, which is why the web session and the memory-review pipeline can select fuyao while the eval could not: the eval's throwaway home materialized an empty settings document, so the adapter stayed dormant and `initialize` with a non-DeepSeek provider fell into the fallback path that throws. The pin described the eval's own configuration, not a harness limit.

## Decision

1. **The deployment home's `settings.yaml` is the one config source.** The eval reads it through `$DSH_HOME` (the same variable the harness resolves, else `~/.dsh`) — no new eval-owned yaml, no hardcoded paths, so the suite is portable across environments by construction.
2. **`agent-default-model` is the default route (both axes).** A declared `agent-default-model` must carry both `provider` and `model` (a half declaration would silently mix the deployment's provider with the eval's stock fallback — it fails loud). Explicit `--provider`/`--model` flags override per axis; with no declaration the stock `deepseek-official`/`deepseek-v4-flash` pair stands.
3. **`real` mode mirrors the deployment's `llm-pi-ai:` section into the throwaway home** when the resolved provider is non-DeepSeek (`eval/model-route.ts` resolves it; `profile-template.ts` renders it as the throwaway settings document). The child's credentials row is then pointed at the **deployment's managed credentials document** (`.credentials.yaml` — the store the web Models page writes) via a `credentials.path` patch, so every `apiKeyEnv` reference resolves per request exactly as a real session resolves it. The eval never parses credential values — it probes reference names only (`assertCredentialRefsResolvable`), the same probe-never-parse stance as the deepseek key preflight. A profile carrying an inline credential field fails loud before anything is mirrored.
4. **Mode semantics stay honest per route shape.** `mock` is the deterministic deepseek-official shape: it reads nothing and rejects `--model`/`--provider`. `external` impersonates the deepseek adapter wire: provider fixed `deepseek-official`, `--provider` rejected. `real` carries the full resolution — a DeepSeek provider keeps the DEEPSEEK key preflight; a pi-ai provider route is inherently live and requires the mirrored section (`eval/boot.ts` guards both). Reports stamp the route as `model: { mode, provider, id }`.

## Alternatives considered

**A dedicated eval model yaml (e.g. `eval.yaml` beside `settings.yaml`).** It would duplicate the provider dictionary the deployment already owns and need its own path-resolution story for portability; the harness-native settings seam already carries the live truth and edits hot-reload. Rejected — one config source, zero drift.

**Mount `dsh-llm-pi-ai` as an eval profile bundle with provider config in `cordis.patch.yml`.** The composition row already exists in the base bundle; a profile-level mount would hard-code the deployment's provider set into the eval template, which is exactly the per-environment coupling the settings mirror avoids.

**Keep the provider axis pinned; reach gateways through the deepseek adapter's endpoint.** Works for OpenAI-compatible wire (shipped in the morning note), but it bypasses the deployment's provider profile — endpoint, model catalog and compat facts would be re-stated as eval flags, and the model under test would no longer be "the model a real session gets".

## Consequences

- The zero-config keyed run is now `npm run eval -- --mode real --build . --judge`: on this deployment it resolves `fuyao/fuyao-work`, mirrors the `llm-pi-ai:` section, and exercises the exact route a web session uses — including the memory-review pipeline, which rides the session route.
- `--provider` joins the CLI (and `eval:ab`); `EvalReport.model` gains `provider`; the throwaway home's settings document is no longer always the static `{}` template for real runs.
- A deployment whose `agent-default-model` names a provider whose credential reference resolves nowhere fails at **boot** — the eval preflights every mirrored `apiKeyEnv` reference (inherited environment or the deployment's managed credentials document, names only) and fails loud naming both sources, instead of mid-turn with the harness's per-request `MISSING_CREDENTIAL`.
- The zero-config keyed run is real and verified: with the deployment's `llm-pi-ai:` section, `agent-default-model`, and UI-stored credentials all in place, `npm run eval -- --mode real --build .` on the smoke dataset produced real model answers (`fuyao/fuyao-coding`, standing hit 2/2, ~103 s for two turns — vs 1.5 s for the pre-fix silent-failure run).
- A turn that ends idle without an assistant message now fails loud at the boot boundary (`eval/boot.ts`): the agent loop appends an assistant message on every completed or interrupted step, so an idle-without-answer turn is a failed model route, and silence there would let a real-mode run score `ok` with no answers — indistinguishable from a healthy judge-less run. The underlying LLM failure (e.g. `MISSING_CREDENTIAL`) is contained by the harness driver and lives in the runtime's own diagnostics; the eval's error names the remedy.
- The morning note's provider-pin decision is superseded by this one; the two remain cross-linked.
