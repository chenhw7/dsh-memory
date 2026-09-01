# Agent Note: The factory default promotes to index mode, with a documented escape hatch

Status: implemented

English | [中文](2026-09-01-index-default-promotion.zh.md)

This note supersedes [Injection modes stay on policy-only default](2026-08-26-index-mode-stays-policy-only.md). The superseded note's reintroduction condition — online recall-trigger statistics showing real sessions miss searchable answers — was recorded as indefinitely blocked: the session capture it depends on has produced zero observable sessions in 30 days, with no owner scheduled. The memory-system improvement program ([proposed/architecture/2026-09-01](../../proposed/architecture/2026-09-01-memory-system-improvement-program.zh.md)) ruled that a condition nobody can satisfy should not hold the default hostage, and flipped the burden of proof: promote now, guarded by regression floors and an explicit rollback switch instead of waiting for telemetry.

## Problem

`policy-only` injects guidance telling the model to search memory, but the model must choose to search. Across real multi-hour sessions the model demonstrably under-searches: recall happens only when the model happens to think of it, and every missed search is invisible — no error, no log, just context the model never had. The 2026-08-26 note held the default at policy-only pending online statistics; those statistics are now recorded as permanently unavailable rather than pending, so the choice is between a known cost and an unobservable miss.

## Decision

**`memoryMode` defaults to `index`** (the `memory` settings namespace default in `src/context/index.ts`). The measured case, over the grown 35×35 golden fixture with the wave-3 retrieval upgrades:

- **Standing cost:** `index` ≈1102 tokens at the fixture's 35 entries (≈26 tokens/entry, reaching the 5000-char budget around 100–140 entries before rolling up into category-count lines) versus `policy-only` ≈344 tokens flat — ≈0.5% of a 200k context at fixture scale, growing with the store.
- **What it buys:** every entry becomes visible to the model on every session as an existence line — the model no longer needs to guess that a memory *might* exist before issuing a search. The synonym slice added in wave 3 is precisely the failure class a standing index prevents: queries phrased differently from the stored text.
- **The rollback switch ships with the change** (not after): `memoryMode` is a live settings-namespace field, editable per deployment from the settings UI or `cordis.patch.yml` without restart — reverting to `policy-only` is a one-line config change, and `off`/`custom`/`full` remain first-class.

## Alternatives considered

- **Keep policy-only until the telemetry exists.** Rejected: the telemetry has been unobtainable for the program's whole life (session capture is host-side and broken — `session-capture-repair` parked); a default held hostage to an unsatisfiable condition is the status quo, not a decision.
- **Promote `full`.** Rejected: full content folds at the 20-entry fold line and costs more standing tokens than `index`; a default that loses visibility as the store grows is backwards.
- **Promote with a new Config field instead of reusing `memoryMode`.** Rejected: `memoryMode` already has five modes, live settings resolution, and UI wiring; a parallel switch would duplicate the surface.

## Consequences

- Standing injection cost rises from ≈344 to ≈1102 tokens at fixture scale and grows linearly with the store; deployments with tight context budgets set `memoryMode: 'policy-only'` (or `off`) explicitly — the cost table regenerates via `DSH_MEMORY_EVAL_VERBOSE=1 npx vitest run tests/recall-golden.spec.ts`.
- The KV-cache discipline is unaffected: the index text is still frozen per session at `session/created` and refrozen only at compaction.
- The superseded note's benchmark evidence (tool retrieval saturating the golden set) remains valid and unchanged; what changed is the decision standard — the program flipped the burden from "prove the model misses searches" to "prove index hurts", because only the first half was ever measurable.
