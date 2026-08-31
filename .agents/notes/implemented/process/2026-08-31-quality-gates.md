# Agent Note: Mechanical quality gates over prose guidelines

Status: implemented

English | [中文](2026-08-31-quality-gates.zh.md)

This record adapts the upstream harness quality-gates note ([2026-06-11, harness](../../../../../deepseek-harness/.agents/notes/implemented/process/2026-06-11-quality-gates.md)) to what actually gates this repository.

## Problem

This codebase is developed primarily by coding agents. Agents follow enforced gates far more reliably than prose conventions. This repository has no lint runner and no doc-gate runner, so which checks actually enforce what needs a record: an agent assuming harness-grade gates (100% coverage, lint, doc-sync) here would either wait for checks that never run or claim evidence that does not exist.

## Decision

The enforced set is deliberately small, and every member is mechanically checkable:

- `npm run build`: `tsc` over `src/` plus the esbuild client bundle — this is the typecheck lane, the compile gate, and the client-bundle gate. There is no separate `typecheck`, `lint`, or `coverage` script.
- `npm run test`: vitest over `tests/`; the only behavioral gate. CI (the tag-triggered publish workflow) runs exactly `prepublishOnly` = `build && test` before `npm publish`, after a tag/version consistency check.
- Review: everything not mechanically checkable — prose discipline, test strength, placement, pairing quality — is owned by review per [dsh-code-review](../../../skills/dsh-code-review/SKILL.md) and the [documentation standard](../../../../docs/AGENTS.md).
- No Git hooks run in this repository; the pre-push evidence discipline is carried by [dsh-pre-push-checks](../../../skills/dsh-pre-push-checks/SKILL.md).

The upstream gates this repository deliberately does not carry: per-file 100% coverage, Oxlint/jscpd, publint and workspace constraints, and the doc-sync suite. The single-maintainer, single-package shape makes the build+test pair the cheapest set that still catches the recorded failure classes (tests that don't typecheck, client bundles that don't compile).

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

- Conventions survive agent turnover only where a gate enforces them; everything else depends on review following the skills.
- The gates themselves are code to maintain; `package.json` script changes are reviewed like any change.
- The gate set is a contract for agents: report evidence only from the commands above, and treat "run the linter" as unavailable rather than pending.
