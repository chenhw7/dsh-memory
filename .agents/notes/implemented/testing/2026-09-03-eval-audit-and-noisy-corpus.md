# Agent Note: Eval suite audit and the noisy long-prompt corpus slice

Status: implemented

English | [中文](2026-09-03-eval-audit-and-noisy-corpus.zh.md)

## Problem

Two observations point at the same blind spot — corpus realism.

First (the motivating observation): the 96 plant turns of `core-v0` have a median length of 25 characters and a maximum of 123; the 31 planted turns median 46 characters, one intent per turn, grammatically clean, 7 carrying explicit anchors ("记住" / "记着" / "记牢" / "Put that in memory"). Real user prompts do not look like that: environment, history, a gripe, and the actual ask arrive mixed in one 300–800 character context dump; IME homophone typos (在/再, 的/得); voice-input phrasing; mid-sentence self-corrections ("不对，是…"); topic drift; and typically only part of a long message deserves to become a memory at all. The current corpus cannot measure: whether extraction finds a fact buried mid-message in long noise (extraction recall), whether it refrains when 90% of a message is not memory-worthy (extraction selectivity), and whether colloquial, typo'd input is normalized into clean entries.

Second (the audit below, handled in the same window): the suite has structural measurement gaps, three of them P0 — the storage layer cannot see updates to existing entries, the scope dimension's ground truth does not exist for most plant scenarios, and the recall rubric has no tier for the corpus's main distractor mechanism (the accurate same-topic neighbor entry). Reviewing noisy material would collide with all three (normalization needs dim-1 guidance; incidental details land in the precision gap), so the fixes and the new slice share one rubric version bump.

## Audit findings (2026-09-03, per-metric × per-scenario over `eval/`)

Qualitative verdict: the harness engineering is production-grade (short-lived isolated homes, invalid protocol, versioned rubrics stamped into every report, the deterministic EQUAL invariant, per-turn work budgets); the weaknesses are measurement-theoretic. Metric implementations live in [eval/mechanical.ts](../../../../eval/mechanical.ts), [eval/judge.ts](../../../../eval/judge.ts), [eval/report.ts](../../../../eval/report.ts), [eval/runner.ts](../../../../eval/runner.ts); the rubrics at audit time were the v1 pair (frozen in the tree: [storage-v1](../../../../eval/rubric/storage-v1.md) / [recall-v1](../../../../eval/rubric/recall-v1.md)); this window ships the active [storage-v2.md](../../../../eval/rubric/storage-v2.md) / [recall-v2.md](../../../../eval/rubric/recall-v2.md) pair (see Decision); the shipped design is recorded in [the harness-eval-suite note](2026-09-01-harness-eval-suite.md).

P0:

1. **Storage scoring cannot see updates.** `writtenIds = after − before` filters by entry id (eval/runner.ts), so a merge/update of a pre-existing entry keeps its id and is never judged and never enters precision. The four hybrid scenarios (prog101, prog112, prog116, work208) are exactly the conflict/revision scenarios where updating is the textbook-correct behavior; `mergeBehavior` degenerates to measuring only "did it avoid creating a duplicate".
2. **The scope dimension's ground truth does not exist for most plant scenarios.** In 8 of 9 programming plant scenarios the dialogue never names the repository (only prog112 names `ui-kit`), yet the rubric requires repo facts stored as `project` + `projectName` — otherwise the total caps at 1. The corpus carries no `expectedScope`/`expectedCategory` fields, so the "correct" answer is whatever the judge infers per run.
3. **The recall rubric has no tier for the accurate distracting neighbor.** 21 scenarios seed same-topic legacy distractors; when the question is asked, the injected distractor line is accurate, unannotated, and steers the answer — neither tier 3 ("nothing points the wrong way"), tier 2 ("noise"), nor tier 1 ("misleading about the required fact"). The judge improvises each time; this is the largest source of judged variance.

P1 (selected): effective independent items ≈ 68 of 128 — the 60 paraphrase questions share `gold`/`requires` with their parents and are mostly weak rewordings ("…来着"), with means presented as 128 independent samples and no uncertainty (this damages report interpretation, not measurement validity; a cheap report-layer fix rides the same window — see Decision); seed-side standingHit is near-tautological (the index line renders the summary verbatim by plugin contract, and the descriptive id slug — `f102-vitest` — leaks into the distinctive-token match); noiseRatio is a corpus constant at store sizes 2–4 (everything injects); storagePrecision punishes "true but unplanted" identically to "fabricated"; the storage `total` trusts judge arithmetic instead of the harness recomputing sum+cap; storage dim 4 (merge keeps both sides) and recall tier 1 (unannotated stale conflict) pull in opposite directions on the same conflict scenarios; the index-mode search round-trip has no deterministic measurement (answerCorrectness is real-model-only); `ceil(chars/4)` underestimates zh cost ~2×; negative questions produce no mechanical signal (zero signal in judge-less runs); no judge repeats, no confidence intervals, no judge calibration set; `expectedStandingHit` is recorded but never aggregated (A/B fingerprint only); conflict-discrimination ability is measured nowhere (4 conflict setups, zero questions asking current-vs-deprecated); life303's planted `f303-rest` is never asked; `language` tags whole scenarios rather than questions; the plant `assistant` script fields are never consumed by the runner (a readability illusion).

Per-scenario one-liners:

| scenario | note |
|---|---|
| prog101-build-toolchain | best conflict material (legacy-npm seed vs planted pnpm); hits P0#1 + no repo name; no conflict question |
| prog102-test-runner | standard; jest-legacy distractor falls in the rubric gap (P0#3); id slug leak |
| prog103-runtime-pin | node22 vs docker node:20; `q103-2p` is a yes/no question with a range-shaped gold |
| prog104-ci-gate | clean far-field negative (ruff/flake8); no repo name |
| prog105-e2e-port | weakest paraphrase ("…来着") — near-zero rewording pressure |
| prog106-commit-style | revision signal (mind changed mid-dialogue); revoked-fact storage only punished implicitly via precision |
| prog107-git-flow | textbook correction signal; no repo name |
| prog108-editor-setup | clean; `q108-1p` (vim vs emacs) is among the few strong paraphrases |
| prog109-dep-pinning | `q109-mh` is the most standard of the 3 multi-hop questions |
| prog110-local-postgres | `q110-2p` asks "where" while gold opens with "won't lose data" — gold reuse misalignment |
| prog111-monorepo-tsc | "这条别记" explicit-do-not-store, covered indirectly via precision; repo inferable but unnamed |
| prog112-lint-rules | the only plant scenario naming its repo — the natural control for the scope dimension |
| prog113-review-prefs | clean dual hard-gates, user scope reachable |
| prog114-logging | standard; "never hardcode" directionality good |
| prog115-registry-mirror | `q115-1` is causal phrasing with real rewording distance |
| prog116-cache-invalidation | most valuable conflict setup (TTL seed vs write-path plant); zero discrimination questions; update path blind |
| prog117-release-signing | ordered-fact sequence; no repo name |
| work201-weekly-report | fullest type coverage (+mh +neg); weekly-report scope (user vs project) left to judge discretion |
| work202-standup-wiki | stable numeric anchors (9:30/10:00) |
| work203-docs-style | pure-zh, exercises the CJK-bigram distinctive path |
| work204-tz-scheduling | `q204-2` asks about Friday, the fact covers afternoons only |
| work205-comm-style | the "reasonably memorable but unplanted" precision-conflation showcase |
| work206-morning-triage | order + budget dual facts, clean |
| work207-adr | minimal (1 fact, 2 questions) |
| work208-1on1 | "Put that in memory" meta-instruction + "her preference ≠ mine" scope trap — best scope probe |
| work209-changelog | standard project pair |
| work210-focus-mornings | `q210-neg` (Wednesday all-hands) is the strongest negative — near-field |
| life301-travel | natural preference set |
| life302-cooking | `q302-neg` (soy-sauce brand): categories given, brand not — tests not inventing from neighbors |
| life303-running | planted `f303-rest` never asked — wasted plant |
| life304-grocery | "don't record the brand, remember the blue box" — embedded exclusion, best fidelity probe |
| life305-sleep-coffee | standard |

## Decision

Work in two stages under one principle: **noise is an authored, controlled variable; the corpus only grows; one rubric v2 bump amortizes every anchor change.**

Stage 0 (pilot) lands in two ordered steps within the same window — two commits, independently revertable. The four anchor fixes do not depend on noisy corpus material: they land first and are validated on core-v0; the noise pilot is then reviewed against the finished v2, so pilot iteration cannot hold the P0 fixes hostage.

Step 1 (rubric v2 anchor fixes, validated on core-v0):

1. Rubric version bump (new `storage-v2.md` / `recall-v2.md`, `Rubric version: 2` first line) absorbing four anchors in one window: (a) dim 1 guidance — normalizing obvious typos/disfluencies is not fabrication, preserving them is not a loss either; (b) an explicit tier for the accurate same-topic neighbor (audit P0#3); (c) storage scoring moves to a medium-diff basis — `updated` is pinned to "entry id present in storeBefore AND any of content/scope/category/summary differs"; updated entries enter the judge input flagged `updated: true` and count in the precision denominator (audit P0#1; precision semantics gain one more layer of non-comparability, covered by the no-cross-version rule); (d) conflict-discrimination questions for prog101/prog116 with recall-rubric guidance on annotated staleness.
2. The report layer picks up the independent-items problem (audit P1): a headline mean over independent questions beside totals — paraphrase leaves the headline, the `type=paraphrase` slice stays.
3. v2 done-ness: one judged A/B over core-v0 (env-gated, never in CI) with sane dimension distributions and no invalid-rate growth; the rubric file-name sync lands in the same pass (judge.ts file-name constants, docs/EVAL file-name references).

Step 2 (noise pilot, on top of v2):

4. `scenarioSchema` gains optional fields: scenario-level `register: 'clean' | 'noisy'` (default `clean`), with a `register` slice axis in the report when present; fact-level `factText` — a normalized clean excerpt entering the judge ground truth and replacing the whole dump as the mechanical layer's fact text (a fact buried mid-turn means the materialized statement is the whole 150–600 characters: dim 1's "every component survives" would push correct selective extraction down to tier 1, in direct conflict with the selectivity goal, while the huge token set loosens standingHit false positives; facts without the field keep the current materialization); fact-level `anchors` — anchor-token arrays for the spec lint (every anchor of a noisy fact appears verbatim in its materialized home turn); `expectedScope` / `expectedCategory` for the pilot scenarios (audit P0#2: new corpus is not bound by "addition only", and the pilot must carry its own scope ground truth, or pilot variance absorbs the judge's scope improvisation). The dataset spec gains noise floors (scenario count, turn-length distribution).
5. New dataset `eval/datasets/noise-v0.jsonl`, ~6 long-form plant scenarios (zh 4 / en 1 / mixed 1): turns 150–600 characters; planted facts buried mid-message in long turns; unplanted material ≥ 60% of message volume; four long/difficult patterns covered — context-dump, voice-input phrasing, mid-sentence self-correction, topic drift; 1–2 planted facts per scenario; 2–3 mildly-typo'd paraphrase questions across the slice; negatives and golds stay clean.
6. The noise style guide (next section) is the contract, restated as a checklist in the dataset spec's review notes: anchor tokens are never corrupted.
7. Extraction-chain evidence runs on the fake-LLM external route (the existing plant-chain runbook): mock does not route by content and cannot test "does extraction find the fact buried mid-noise"; the fake LLM gets per-content routes for noisy scenarios (`eval/harness/noise-routes.ts`, scripts from the fixture beside the corpus) — credential-free, deterministic, with the extraction chain actually running. **Shipped correction (diverges from the draft's trigger assumption)**: the noisy lane does not fire extraction on the dispose flush — measured 2026-09-03 on the SDK stdio path, the harness hard-exits ~26 ms after emitting `session/disposed`, so the flush's LLM round-trip plus store write is a race the eval cannot win; the runner instead pins `reviewCandidateThreshold: 1` for noisy scenarios (`noisyReviewPatch`), every planted turn carries an explicit memory keyword, and the periodic review fires mid-session at the next pre-step, where the write is guaranteed to settle before the question session. The flush route stays in the table but answers empty (a safe no-op) in case it ever wins the race.
8. Pilot judging through five gates in run order (`eval/pilot.ts` orchestrates, `eval/pilot-gate.ts` holds the pure functions + vitest coverage, `npm run eval:pilot`): G1 chain health on the mock full chain (no scenario errors, prompt captured); G2 same-build A/B self-diff EQUAL on the deterministic layer; G3 anchor matchability — anchor hits asserted on entries ACTUALLY WRITTEN, with `entryCount > 0` as the precondition, not the assertion (the anchor ban guarantees "matchable once written", not "written at all"; a 0-vs-0 parity is a hollow pass); G4 the same noisy material judged twice — no entry or question flips more than 1 tier across the passes; G5 the calibration set fully hits. The decision rules are pre-registered (so the gate cannot decay into a formality). The calibration set is 3–5 noisy entries with author-pinned expected tiers (the fixture `noise-v0.pilot.json`): agreement measures only test–retest reliability — at temperature 0 the judge can be consistently wrong; the calibration set measures validity. At n≈6–12 the bare-agreement confidence interval is too wide for a numeric threshold; overlap with clean extends the pilot rather than passing it.
9. Time-box and rollback: two rounds of rubric iteration still failing the rules → the noise slice is frozen as rejected; v2 and the report-layer fixes ship alone.

## Shipped state and verification (2026-09-03)

Step 1 (v2 + report layer) and step 2 (the noise pilot) shipped in the order above: `eval/rubric/{storage,recall}-v2.md` (the v1 pair frozen in the tree, both directions guarded by `tests/eval-rubric.spec.ts`), the judge.ts file-name constants and docs synced in one pass, the report layer's `independent` headline and the `register=` slice axis, medium-diff update tracking (`updatedIds` + `JudgedStoredEntry.updated`), additive conflict-discrimination questions for prog101/prog116 in core-v0 (q101-cd/cdp, q116-cd/cdp; 128 → 132 questions), `noise-v0.jsonl` (6 scenarios, 14 questions; anchor/keyword/floor lints in `tests/eval-noise-dataset.spec.ts`) with the pilot fixture, and the five gates in `eval/pilot.ts` + `eval/pilot-gate.ts`.

The pre-registered decision rules, measured live (judge fuyao-data via the fuyao gateway, temperature 0): **round 3 passes everything** — G1 chain health, G2 same-build A/B per-scenario EQUAL, G3 all six scenarios wrote entries through the review lane with every non-negative question's anchors hitting, G4 zero flips above one tier across the two judged passes, G5 the calibration set hit 4/4. Both time-boxed rubric iterations went to the same discovered scale ambiguity (`calib-contradiction`, the same-topic contradictory entry): iteration 1 pinned "trace follows the subject; the contradiction scores 0 on fidelity" into Step 1 (the judge's reading matches the rubric's own dim-1 tier-0 example; the author's original pin matched it worse), and iteration 2 pinned "a contradicted value is not a lost token" into dimension 3 (a wrong value fills the same slot — the ask still surfaces the entry; the wrongness belongs to fidelity). This is exactly the failure shape the calibration set exists to catch: at temperature 0 the judge was not unstably scoring — it was stably reading an underspecified scale; after the two iterations judge, author, and rubric text agree.

One v2 done-ness item remains open: the core-v0 judged A/B (real model + judge, env-gated) — the first attempt on 2026-09-03 aborted half-way through the baseline pass on gateway congestion (three 120s notification timeouts, three turn-budget breaches, ~6 of 13 scenarios failed, no report produced); it is to be re-run once the gateway recovers. All other acceptance evidence is above.

The pilot also exercised the runtime-realism rules as pre-registered: mock G1's standing hits are 0/x (mock does not route by content, extraction writes nothing) while G3 (the fake-LLM content routes drive the real extraction chain) wrote in every scenario with all anchors hitting — both "matchable once written" and "0-vs-0 parity is a hollow pass" were activated by the run itself.

Stage 1 (scale and merge): grow the slice to ~12 scenarios; add the extreme partial-extraction case (one memorable sentence in a long message) and long turns with pasted code blocks/logs; rolling scope ground truth out to the core side goes through corpus fields plus a dataset version bump (core-v1: turns/questions/facts byte-identical, the mechanical-layer series survives, the judged layer re-bases on v2 anyway; in-dialogue naming is rejected — see Alternatives); noise authoring may bake typos through a deterministic fixed substitution table (see Alternatives); corpus spec floors enter the existing vitest; the noisy full-chain mock deterministic layer rides pre-push evidence or a new nightly lane (a scheduled workflow with the harness checkout pinned to a commit SHA — unpinned, a nightly red can trace to upstream drift rather than the build under test).

## Noise style guide (contract)

- Anchor tokens (tool names, numbers, identifiers, paths) are never corrupted. Corrupting them would break the mechanical distinctive-token match against the verbatim statement (the extraction normalizes, the statement does not — a guaranteed false miss). A future hard tier may relax this deliberately. The ban is mechanically enforced by the spec's anchors lint, not by human discipline.
- zh: IME homophones (在/再, 的/得, 做/作, 必需/必须), dropped punctuation, run-on sentences, fillers, mid-sentence self-corrections.
- en: keyboard-adjacency typos, dropped articles, case drift, autocorrect artifacts.
- universal: topic drift (several topics per message), context-dump (environment + history + ask in one message), voice-input phrasing; typo density 1–3 per 100 characters with variation (per 100 characters counted over the whole turn).
- off-limits: negative questions, gold answers, and the anchor-bearing phrasing of required facts stay clean; the `assistant` script fields may be colloquialized for readability (a display field the runner never consumes — the schema comment marks it display-only so future contributors do not assume it is measured).

## Alternatives considered

- **Programmatic typo injection (runtime/random)** — rejected. Real typos are patterned (IME homophones, keyboard adjacency); random injection produces uninterpretable judge variance — it would corrupt the measurement rather than the system under test. A deterministic fixed substitution table (a homophone/adjacency map baked in at authoring time, auditable instance by instance, reproducible verbatim) is not in this bucket and stays available as a stage-1 authoring aid.
- **No `factText` field — rubric guidance alone** — rejected (review reverses the draft's "deferred"). The deferral reasoned the change chain is long (schema + the one-home materialization rule + both rubrics + spec), but it is the same magnitude as the accepted `register` field; and once facts sit mid-long-turn, the whole-dump ground truth breaks the dim-1 reading and mechanical false-positive control at once — the field is load-bearing for the noise slice, not an escalation path. Full schema normalization (statement wholesale replacing one-home materialization) remains the escalation path if variance still fails the gate.
- **In-dialogue repo naming for scope ground truth** — rejected. Turn text is the input of the materialized statement and the mechanical verbatim match; editing core-v0 turns silently breaks mechanical cross-version comparability with no stamp to flag it. Corpus fields reach only the judge input; the judged layer re-bases on v2 anyway, and the mechanical series survives.
- **Sampling noise from real user logs** — rejected. No sanitized log source, and real noise drags in uncontrolled variables that conflict with "noise is a controlled variable".
- **Editing core-v0 in place** — rejected. Scores are only comparable per stamped dataset; silently mutating the corpus invalidates every historical report.
- **No `register` field — slice by id prefix and `--filter`** — viable for the pilot, but a first-class slice axis costs a tiny backward-compatible diff; added directly.
- **Noisy negative questions** — rejected. Negatives probe non-hallucination; noise there adds nothing but ambiguity.

## Acceptance criteria

- Step 1 (v2): the core-v0 judged A/B shows sane dimension distributions with no invalid-rate growth; reports stamp v2 and carry the independent-question headline mean; documentation names v1↔v2 score comparison as forbidden (including precision, whose semantics shift again once updated entries enter the denominator).
- Step 2 gates split in two: chain health — noisy scenarios run the full mock chain without failures, fences present, within turn budget, and a same-build `eval:ab` self-diff stays EQUAL over the noisy scenarios; conditionalized matchability — anchor hits are asserted on entries actually written (standingHit read with entryCount > 0 as the precondition: the anchor rule guarantees "matchable once written", not "written at all"; plant extraction is structurally weak under mock, and a 0-vs-0 parity is a hollow pass). Extraction-chain evidence rides the fake-LLM route.
- The pilot decision rules fully pass (≤1-tier flips across two passes + calibration set all-hit); otherwise rollback per the time-box.
- The new dataset-spec floors and anchors lint pass; reports carry the `register` slice.
- Measured per-scenario wall time and per-turn tool calls on noisy scenarios are not meaningfully above clean (headroom under the default 180s / 32-call budget; if not, adjust and stamp the budget first).

## Risks

- Judge variance grows on long/noisy statements — mitigated by the pre-registered decision rules plus the calibration set; the biggest hidden risk is precisely a false-negative pass of an agreement-only gate (the judge being consistently wrong), which the calibration set exists to catch. Still over threshold → the full schema-normalization escalation.
- Anchor corruption breaks mechanical matching — the style-guide ban plus the anchors lint (mechanically enforced once the field lands, not left to human discipline); the long-dump token-set false positives are collapsed by `factText`.
- Partial extraction amplifies the precision conflation between "true but unplanted" and "fabricated" — considered in the same window (split precision into fabricated vs incidental columns).
- Real-model + real-judge runs over the extra slice double cost; they stay env-gated and out of CI.
- v1↔v2 scores are incomparable by design — enforced by the stamping discipline; historical reports must not be re-read on the new scale.
- v2's shipping held hostage to pilot iteration — dissolved by the two-step order: freezing the pilot never blocks v2 shipping alone.
- Nightly-lane upstream drift — pin the harness checkout to a commit SHA; a red attributes to upstream first, the build under test second.
