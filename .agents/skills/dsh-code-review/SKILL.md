---
name: dsh-code-review
description: Use when reviewing a change in this repository (dsh-memory) before commit or after the fact — orients the reviewer to this codebase's standards (root AGENTS.md, defensive patterns, testing policy, Agent Notes, i18n pairing) and the review-specific checks that code alone can't show
---

# Reviewing a change in this repository

**This skill is guidance, not a complete checklist.** Establish the change's live base and scope first (`git fetch origin main`, then `git diff --stat origin/main...HEAD` plus worktree status) and read enough surrounding code to understand the design before reading the diff line by line. The repository is single-maintainer with direct pushes to `main`, so "review" means reviewing your own outgoing change with fresh eyes, or reviewing a specific past commit range on request. Prioritize correctness, lifecycle, security, and broken required behavior over style; a short review with one substantiated blocker is better than a list of nits.

## Sources of truth

- [AGENTS.md](../../../AGENTS.md): standing repository rules — release lane, no repo-file writes, no hardcoded tunables, loud misconfiguration, empty-catch naming, boundary validation.
- [docs/defensive-patterns.md](../../../docs/defensive-patterns.md): async-state, disposal-to-quiescence, callback containment, and untrusted-input bug classes.
- [docs/AGENTS.md](../../../docs/AGENTS.md): documentation placement, one home per fact, and prose discipline.
- [dsh-prose-standard](../dsh-prose-standard/SKILL.md): required coverage and editorial judgment for comments, docs, prompts, and visible strings.
- [dsh-ci-test-reliability](../dsh-ci-test-reliability/SKILL.md): isolation and regression-proof rules for resource-owning, asynchronous, or flaky tests and fixtures.
- [docs/testing.md](../../../docs/testing.md): test tiers, golden corpora, mock policy, and the key policy for the real-API judge suite.
- [Agent Notes](../../notes/README.md): design rationale. Treat disagreement with an Agent Note as a design discussion, not an automatic veto.
- For bilingual changes, read [translation-rules.md](../../../docs/i18n/translation-rules.md) and [terminology.md](../../../docs/i18n/terminology.md); the extended translation skill is outside automatic review and runs only on explicit user invocation.
- Host-facing changes: [HOST_CONTRACT.zh.md](../../../docs/HOST_CONTRACT.zh.md) records the harness API contract with source evidence; §9 is the bump checklist.

## Blocking requirements

1. **New prose receives semantic review.** Use [dsh-prose-standard](../dsh-prose-standard/SKILL.md) to critically review every added or changed Markdown passage, JSDoc, comment, prompt, description, diagnostic, and visible string. Verify required coverage, accuracy, placement, and editorial quality against the owning code or behavior; no automated check establishes those properties here.
2. **Docs match the code.** Config fields, defaults, errors, store schema, and public behavior update the README (and its zh counterpart when the pair is in scope) and JSDoc in the same change. Comments state non-obvious contracts; flag implementation narration, test walkthroughs, review history, and duplicated rationale for deletion or a link to their one home.
3. **Schema, settings, and README agree.** A change to a `Config` field or settings schema updates the settings-card UI (`src/client`), the README configuration tables, and [TECH_DESIGN](../../../docs/TECH_DESIGN.md) in the same change; the three drift silently otherwise (past incidents: dropdown options derived from the wrong source, false-override sentinel writes).
4. **Client bundle compiles.** Every `src/client` change proves `npm run build` green — the client bundle is esbuild-only and outside tsc's emit, so the compiler alone does not gate it.
5. **Required evidence exists.** Verify the relevant local checks ran for the diff per [docs/testing.md](../../../docs/testing.md) and [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md): the owning vitest file for behavior, with-key run for review-pipeline changes, `npm run build` for type or client surfaces.
6. **Prompt-visible text changes carry behavior evidence.** Text that reaches the model (system-prompt sections, tool descriptions, extraction prompts) changes behavior: update the owning test or golden fixture, and run the real-API suite when the judge prompt moved. UI copy stays locale-owned — reject hardcoded strings that bypass the client dictionary pattern.
7. **No repository-file writes return.** Diff must add no generator that writes into the repository (the 0.6 rule); user data goes to `$DSH_HOME` paths only.

## Manual checks

- **Intent and interface contracts:** trace both sides of every changed interface — exported function, settings field, tool schema, store record. Confirm the implementation matches the intent and any Agent Note, including errors, cancellation, ownership, and disposal.
- **Lifecycle and concurrency:** for async setup, callbacks, processes, or teardown, apply [defensive-patterns.md](../../../docs/defensive-patterns.md). The review pipeline, store flushes, and decay timers are the recurring risk sites; check races before publication, cancellation during awaits, independent error reporting, callback containment, ownership before reentry, and quiescent disposal.
- **Scope, ownership, and necessity:** map each abstraction, option, defensive copy, and compatibility path to its current contract, production consumer, and owning module. Challenge unrelated features and speculative generality, then test the change against the [root rules](../../../AGENTS.md).
- **Configuration and public choices:** ask what current-consumer evidence or prior art supports each default, public operation set, or format. Require an explicit choice or deferral when that evidence is absent.
- **Model perspective:** inspect the exact prompts, tool schemas, and results the model receives — the injected memory section, project-notes section, and tool descriptions are model-visible surfaces. Flag concepts outside the model's task; verify stable text verbatim and dynamic behavior through tests.
- **Untrusted input paths:** scanner inputs, extracted content, and notes text pass the scanner rules before storage; injected sections never gain tool authority. Trace every path from external text to storage or prompt.
- **Bounds cover the final operation:** locate the owner of the complete stored or rendered result, including wrappers and metadata. Probe empty input, exact limits, oversized single payloads, and multibyte/CJK text for the BM25 tokenizer and size caps.
- **Real entry path:** the shipped surface is the plugin loaded through `cordis.patch.yml` in a real harness profile (`tests/integration/`); a hand-mounted plugin suite does not catch composition regressions. Keep the composition smoke green for changed plugin shape.
- **Test strength:** assertions fail on the intended regression and verify external state — re-read the store file, re-run the scan — rather than restating the implementation or trusting a component's report.
- **Test reliability:** for a resource-owning, asynchronous, platform-sensitive, or flaky test, apply [dsh-ci-test-reliability](../dsh-ci-test-reliability/SKILL.md) to the real topology, resource allocation, global-state restoration, synchronization, timeout budget, and quiescent teardown.
- **Implemented Agent Notes match shipped reality:** when a change implements a proposed Agent Note, move and rewrite it as present-tense shipped state in the same commit, then verify paths, names, and mechanisms against the implementation.
- **Behavior changes update their tests:** a changed behavior ships with its test update in the same change; review golden-value diffs as behavior changes, not formatting noise ([testing policy](../../../docs/testing.md#golden-corpora)).
- **Bilingual changes:** compare meaning and terminology on both sides; a re-recorded sidecar hash does not prove translation quality ([translation rules](../../../docs/i18n/translation-rules.md)).

## Reporting findings

State the defect, location, impact, and evidence. Separate blockers from suggestions and omit issues already covered by a passing check. When receiving review on an upstream harness PR, verify each claim and fix or rebut it on technical grounds without performative agreement.
