# Agent Note: Cite committed artifacts, never design-session ordinals

Status: implemented

English | [中文](2026-08-31-committed-artifact-citations.zh.md)

## Problem

Large design and review sessions leave working shorthand — decision ordinals, audit item codes, plan section numbers, reviewer rulings — that reads naturally while the session transcript is open and resolves to nothing after it closes. This repository is developed almost entirely by coding agents across many sessions, so the risk is structural, not incidental; the [dsh-trim-cot-leakage](../../../skills/dsh-trim-cot-leakage/SKILL.md) skill's taxonomy describes the families. The [documentation standard](../../../../docs/AGENTS.md) bans change narration ("previously", PR references) but before this note stated no citation rule, and the repository had no committed record of the citation rule it follows.

## Decision

This repository adopts the upstream harness citation rule as its own, calibrated to this corpus: durable prose — comments, JSDoc, docs, notes, test comments and titles — cites only committed artifacts, resolvable in-repo without grep archaeology:

- Name the owning Agent Note (its path at least once per file, a searchable name inline), the doc page path, or a GitHub issue number. PR, commit, branch, and stack positions stay banned in docs and code per the [documentation standard](../../../../docs/AGENTS.md); issues are durable and citable, and Agent Notes may cite merged PRs and issues as evidence.
- A design-session ordinal whose decision has a committed owner is replaced by the decision's name and owning note path. An ordinal without an owner is deleted and its factual clause restated to stand alone.
- Fixed regressions are pinned as present-tense counterfactuals ("without X, Y happens"), never as repo history ("used to Y").
- Archived trees are exempt: recorded model output, golden fixtures, `.agents/notes/archived/`, and `docs/archive/` keep their original voice. Inside a note's change-story sections, a historical stage name ("the first cut shipped X") is current-state-safe; indexical stamps ("this cut") stay banned everywhere.
- Authoring-language probes target the opposite-language surface instead of treating the complete Chinese corpus as untranslated residue; this repository's docs are majority-Chinese, so the [recall batteries](../../../skills/dsh-trim-cot-leakage/references/recall-batteries.md) run both directions.
- Model- or user-visible wording changes only with its owning behavior evidence (test or golden fixture updated in the same change), otherwise the audit leaves it unchanged and reports the deferral.

The upstream purge note — [cite committed artifacts (harness)](../../../../../deepseek-harness/.agents/notes/implemented/process/2026-08-09-committed-artifact-citations.md) — owns the rule's full rationale and the repo-wide purge evidence; this note records the adoption, and the [dsh-trim-cot-leakage skill](../../../skills/dsh-trim-cot-leakage/SKILL.md) operationalizes the rules here.

## Alternatives considered

- **Re-translate the upstream note verbatim instead of writing an adapted note.** Rejected: the upstream Problem section describes harness-specific surfaces (generated catalogs, typert pages) that do not exist here, and an unadapted copy would state consequences about gates (`verify-type-equiv`, pairing merge drivers) that do not run in this repository.
- **A mechanical gate for the banned vocabulary.** Deferred, same as upstream: the vocabulary is unbounded natural language and needs judgment to separate leakage from legitimate prose. If the pattern recurs here, the recall batteries in the skill lead the candidate list for a narrow high-precision check.
- **No note — carry the rule only in the skill.** Rejected: skills are workflows, not decision records; the notes tree is this repository's home for the why, and the trim skill's REQUIRED BACKGROUND link must resolve to an owned record.

## Consequences

- Comments and docs in this repository cite by path or name; readers never reconstruct a closed session to follow one.
- Design sessions must land their decisions in Agent Notes before durable prose can cite them; ordinal shorthand stays inside the session.
- Citations get longer (a note path instead of "(decision 21)") in exchange for grep-free resolution.
- No gate rejects a new ordinal citation — review owns the rule, applied per [dsh-code-review](../../../skills/dsh-code-review/SKILL.md).
