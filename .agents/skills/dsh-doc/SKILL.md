---
name: dsh-doc
description: Create, restructure, review, audit, or migrate this repository's (dsh-memory) Markdown documentation — root README, docs/ tree, and Agent Notes — using audience-first hierarchy, one home per fact, bilingual pairing, current-state prose, executed-operation fact-checking, and hand-run validation. Use for new or revised docs, docs-tree organization, documentation-quality audits, and bilingual documentation changes.
---

# This repository's documentation

## Summary

The documentation standard: make every page searchable, newcomer-readable, and exact enough for agents and maintainers. Apply the root [AGENTS.md](../../../AGENTS.md), [docs/AGENTS.md](../../../docs/AGENTS.md), and executed checks first, then this workflow for placement, progressive detail, line-aligned bilingual pages, and corpus audits. Preserve one owner per fact: source, tests, package READMEs, guides, Agent Notes, and archive each keep their own kind of truth. The root `README` pair is the reference example of the format.

## Table of Contents

- [Workflow](#workflow)
- [Fact-check procedure: test, do not assume](#fact-check-procedure-test-do-not-assume)
- [Document kinds](#document-kinds)
- [Voice rules](#voice-rules)
- [Quality criteria](#quality-criteria)
- [Audit the corpus](#audit-the-corpus)
- [Bilingual pages](#bilingual-pages)
- [Detailed references](#detailed-references)
- [Validation](#validation)
- [Dev Note](#dev-note)

## Workflow

Follow this sequence for each requested scope. Keep the common reader path brief, but do not delete failures, ownership, limitations, or other required contracts merely to reduce words.

1. Read the root [AGENTS.md](../../../AGENTS.md), [the documentation standard](../../../docs/AGENTS.md), the target page, its source/tests, and the bilingual record.
2. Classify the page by one primary job and reader: user quick start, maintainer reference, architecture overview, agent instruction, decision record, or archived analysis.
3. Place the page at its nearest owner ([tier taxonomy](../../../docs/AGENTS.md#the-tier-taxonomy-one-home-per-fact)): package contracts in READMEs, cross-package learning in `docs/`, rationale in Agent Notes, history in `docs/archive/`.
4. Define the reader's starting state, observable outcome, likely failure, recovery path, and next useful depth before writing details.
5. Write user-facing content first, developer-facing detail second, an optional `Further Exploration`, and — for pages following the README format — a final non-authoritative `Dev Note`.
6. Update the bilingual counterpart in the same pass when the page is one of the paired documents ([scope](../../../docs/i18n/README.md#scope)). Keep headings, lists, tables, code, links, frontmatter layout, and physical line count aligned.
7. Verify every claim against code, tests, package metadata, or a current decision owner — and run the operations the page instructs, per the fact-check procedure below. Update the owner before any derivative artifact.
8. Run the focused checks in [Validation](#validation), then re-read the complete diff for correctness and then for brevity and repository fit.

## Fact-check procedure: test, do not assume

Documentation states how the product behaves today, and the only admissible evidence for an operation claim is having run it. This procedure is mandatory for every new document and every new paragraph that claims an operation, command, default, error, or platform difference.

1. **Classify the surface before writing install guidance.** This package is one shape only: a profile bundle (`cordis.patch.yml`) installed with `dsh plugin add`. There is no separate library or plugin-package distinction here; never present another install path.
2. **Run every claimed operation against the current checkout.** Execute each command, config snippet, and settings path exactly as the document will show it; write down only what you observed, including the exact output, warnings, and failure modes. If a claim depends on a key or a host harness install you do not have, say so and name the verification owner instead of asserting the behavior.
3. **Delete what you could not reproduce.** Never carry a command, field, default value, or behavior from memory, analogy, or a neighboring document. When a claim fails to reproduce, fix the claim — not the test.
4. **Check old docs against current `main`.** Before revising pre-existing pages, `git fetch origin` and compare the section against `origin/main`; the pairing sidecar recovers the last-confirmed text of either side. A stale statement on `main` is still wrong: correct it against the code, not against the old prose.
5. **Re-record the pair after every edit.** Each paired edit re-records the sidecar with `git hash-object` so it tracks the confirmed pair ([contract](../../../docs/i18n/README.md#applying-the-contract-by-hand)).

## Document kinds

This repository has a small, closed set of document kinds; each maps to an owner and a validation path:

- **User guide (root `README.md` pair)** — install, update, uninstall, verify, configuration. Validated by running the documented commands; zh pair maintained per the i18n contract.
- **Documentation index (`docs/README.md` pair)** — maps every standing document by purpose and owns the language convention.
- **Technical reference (`docs/TECH_DESIGN.md` pair, `docs/SEQUENCE_DIAGRAMS.md` pair)** — exhaustive about its own subject; no decision rationale (→ Agent Notes) or incident chronology (→ `docs/archive/`).
- **Standards (`docs/AGENTS.md` pair, [testing](../../../docs/testing.md), [defensive patterns](../../../docs/defensive-patterns.md), [i18n](../../../docs/i18n/README.md))** — the rules other documents and code follow; changes here are non-trivial and need an Agent Note.
- **Maintainer references (zh-only by convention)** — HOST_CONTRACT, RELEASING, CLIENT_UI_LESSONS, INDEX_MODE_EVALUATION, SECURITY_AUDIT, PROJECT_NOTES.
- **Archived analysis (`docs/archive/`)** — frozen records; never restructured, only linked.
- **Agent Notes (`.agents/notes/`)** — the decision records; their format is owned by [the notes README](../../notes/README.md), not this skill.

No frontmatter `kind` system: documents are classified by tree position and the [tier table](../../../docs/AGENTS.md#the-tier-taxonomy-one-home-per-fact), not YAML metadata. Do not introduce frontmatter metadata without an owner that consumes it.

## Voice rules

These rules decide what a section may say. They apply to every authored human-facing page, and to the root README with particular force.

- **Summary says what the subject does.** The opening section and the user-facing sections describe what a user or agent can DO with the subject — outcomes, benefits, when to choose it, main cost — never its role, type, or internal identity. "The context plugin registers `ctx.memory`" is identity narration; "your facts survive restarts and get recalled into new sessions" is what it does.
- **Developer sections explain, never enumerate.** Implementation content covers the design concept, architecture, and dataflow — enough to understand how the package works — and links code for exact detail. No full API catalogs, exhaustive column lists, event enumerations, or JSDoc restatement.
- **Current state only.** No compatibility shims, migration talk, or history ("previously", "now", "no longer", renamed); the codebase as it is today is the only subject. Change stories belong in commits, Agent Notes, or `docs/archive/`.
- **Use controlled technical English** ([reference](references/style.md#controlled-technical-english)): explicit actors, one stable term per concept, direct verbs, one instruction per sentence. Preserve modality — `must`, `may`, `never` — exactly.

## Quality criteria

Use these definitions in review. Each section opens with a short orienting paragraph before subsections or exhaustive detail.

- **Brief:** the common path contains only facts needed for its outcome; exhaustive truth remains one direct link away.
- **Intuitive:** prerequisites precede dependent concepts, one next action is obvious, and headings use terms readers search for.
- **Friendly:** readers can recognize success, understand risk before acting, recover from likely failure, and choose whether to continue deeper.
- **Accurate:** each durable claim has one owner and a verification path proportionate to its risk.
- **Agent-readable:** stable headings, anchors, terminology, ownership, and current status support targeted retrieval without loading the corpus.
- **Newcomer-complete:** a professional engineer with no repository context can reconstruct the relevant architecture or feature through three to five linked pages.

Do not apply a universal word limit to exhaustive references. Measure entry-path length, unrelated material scanned for one lookup, largest section, heading count, and page size; split by an existing domain owner when retrieval cost is high.

## Audit the corpus

Read, do not re-summarize, the owning contracts: [docs/AGENTS.md](../../../docs/AGENTS.md) for hierarchy, tutorial/reference forms, and the slop checklist; [.agents/notes/README.md](../../notes/README.md) for Agent Note lifecycle; [docs/i18n/README.md](../../../docs/i18n/README.md) for the bilingual pairing rules; and the [root AGENTS.md](../../../AGENTS.md) for standing orders. Exclude `.agents/notes/archived/` and `docs/archive/` from audits and edits — both are frozen history.

Apply the standard's authoring order to every human-facing document in scope (not to Agent Notes): locate the document and state its own subject; set the permitted detail level and move deeper explanations to owning documents with links; classify tutorial or reference from intended use, not path; split substantial mixed forms. Then check placement constraints: paired docs cost a counterpart update and a sidecar re-record on every edit; a move is atomic with every inbound link repaired in the same change.

After the structural pass, hunt the slop checklist with the cheapest probes first. Use [dsh-trim-cot-leakage](../dsh-trim-cot-leakage/SKILL.md) for reasoning-transcript leakage, grep distinctive phrases to find duplicated rules, and replace hand-written catalogs and status inventories with their authoritative owners. If removing prose changes a promised behavior rather than its explanation, propose the behavior change first (follow [dsh-find-simplifications](../dsh-find-simplifications/SKILL.md)). Keep every load-bearing rule, preferably as one to three lines plus a link to its rationale.

## Bilingual pages

The pairing contract, scope, and sidecar procedure live in [docs/i18n/README.md](../../../docs/i18n/README.md); the translation rules live in [docs/i18n/translation-rules.md](../../../docs/i18n/translation-rules.md). Keep English and Simplified Chinese equally authoritative, match structure one to one, keep code blocks byte-identical, and re-record the sidecar after either side changes. There is no documentation website: GitHub renders the Markdown directly, and the two standalone HTML deep-dive pages under the repository root are hand-maintained artifacts outside this corpus.

## Detailed references

Load only the reference needed for the task. Each reference links directly from this file so the skill has no deep reference chain.

- [Metadata, links, and bilingual pairs](references/metadata-links-i18n.md): link rules, line alignment, and the sidecar record.
- [Page structure and hierarchy](references/structure-hierarchy.md): section order, user-to-developer progression, docs tree placement, and Dev Note ownership.
- [Page style](references/style.md): short Summary, `-----` section separators, foldable content sections, and emphasis discipline.
- [Review criteria](references/review.md): newcomer test, evidence checks, and verification.

Use [dsh-prose-standard](../dsh-prose-standard/SKILL.md) for sentence-level contract coverage and editorial judgment. The root `README` pair is the reference example: language switcher, Summary, Table of Contents, user-to-developer progression (Install → Verify → Configuration → Architecture → Known Limitations), and bilingual line alignment.

## Validation

Validate the affected format, not merely Markdown syntax. No doc gates run in this repository; the checks below run by hand.

- Every relative Markdown link resolves from the linking file's directory; links into the harness repository follow the [notes-tree reference convention](../../notes/README.md#layout-and-naming).
- Bilingual pages: verify structure, physical line count, terminology per [terminology.md](../../../docs/i18n/terminology.md), link locale, and the re-recorded sidecar.
- Tutorials: exercise the documented entry path or name an explicit manual verification owner.
- Operational claims: re-run the command the page instructs before merging a claim about it.
- Skills: frontmatter parses (name, description; kebab-case invocation keys only).

## Dev Note

None.
