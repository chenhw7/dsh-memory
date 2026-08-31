# Documentation standard

English | [中文](AGENTS.zh.md)

This file defines document structure, tiers, and writing rules for Cairn's Markdown corpus. Use [dsh-doc](../.agents/skills/dsh-doc/SKILL.md) for the placement and validation workflow, [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) for required coverage and editorial judgment, and the [bilingual contract](i18n/README.md) for pairing.

## Document structure

These rules apply to human-facing documentation; [Agent Notes](../.agents/notes/README.md) remain outside their scope. A document's subject and tree position fix its scope: describe its own subject at appropriate detail and direct children only by purpose, responsibility, and high-level behavior; link to the owning descendant for lower-level detail. A reference may be exhaustive only about its own subject.

Classify every in-scope document as a tutorial or a reference. Tutorials follow an ordered path to an outcome and introduce only what each step needs. References define a lookup scope and current behavior without a teaching sequence. Separate substantial tutorial and reference content; label a section when either part is small.

Author in this order: locate the document in the tree; set its permitted detail; choose tutorial or reference; for a tutorial, order concepts by prerequisite and difficulty; relocate descendant-owned detail; replace lower-level explanations with links to their owners.

## The tier taxonomy: one home per fact

Each fact has one home: the tier whose job it is; elsewhere, link there.

| Tier | Job | Does NOT belong there |
|---|---|---|
| Root `AGENTS.md` | Standing orders: rules an agent needs in context in every session, one to three lines each, linking its home | Stories, worked examples, situational procedures, anything restated from a linked home |
| Root `README.md` / `README.zh.md` | The package contract for users: install, update, uninstall, verify, configuration, limitations | Generated catalogs, JSDoc restatement, other packages' concerns |
| [docs/README.md](README.md) | Documentation index: maps every standing document by purpose; owns the language convention | Restated summaries beyond one line per document |
| [TECH_DESIGN.md](TECH_DESIGN.md) | Full technical reference: architecture, data model, subsystems, configuration, security, testing | Decision rationale (→ Agent Notes), incident chronology (→ archive) |
| [SEQUENCE_DIAGRAMS.md](SEQUENCE_DIAGRAMS.md) | Flow and call-graph diagrams | Prose that the TECH_DESIGN owns |
| [Agent Notes](../.agents/notes/README.md) | Active decision records: the why, what-was-given-up, and required verification | Migration plans and acceptance checklists once the decision has shipped |
| [archive/](archive/) | Frozen planning and analysis records kept for the "why" | Current behavior; each archived doc's outcomes live in code and baseline docs |
| Package README (`README.md`) | The same root contract, mirrored at the package root for npm | Duplication of docs/ content beyond a link |
| Skills (`.agents/skills/`) | Reusable workflows and specialized decision standards | Product and runtime contracts (→ docs or source) |
| `docs/i18n/` | The pairing contract, translation rules, and terminology | Per-document translation notes |

Placement: rationale → Agent Notes; historical planning → `archive/`; procedures → the owning baseline doc; package contracts → READMEs; standing orders → root `AGENTS.md` with a rationale link.

## Writing rules

- **Document current state, not change history.** Avoid "previously/now/no longer", PRs, commits, and stack positions in durable prose; name the live mechanism. Put change stories in commits, Agent Notes, or an archived document; the latter two may cite merged PRs and issues as evidence.
- **Every non-trivial change includes at least one Agent Note in the same commit.** Update the owning note or add one; only mechanical/local edits are exempt ([scope](../.agents/notes/README.md#when-to-write-one)).
- **One physical line per paragraph**: use editor soft-wrap. Code blocks, tables, and list structure keep their formatting; code comments stay under the linter's column limit.
- **Pairs update together**: a paired document's edit updates the counterpart in one terminology-guided pass and re-records the sidecar ([contract](i18n/README.md)); `dsh-translate-docs` remains user-invoked.
- **Comments and JSDoc state complete contracts, not reasoning transcripts.** Preserve behavior, failure, timing, ownership, modality, exceptions, consequences, and non-obvious orientation; delete narration, test walkthroughs, review analysis, and code restatement. Use [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) for details.
- Write directly: name actors and facts. Reserve `seam` for a defined capability seam; name the exact check, type, API, operation, or behavior instead of metaphorical "gate", "vocabulary", or "surface".
- **Chinese-only docs stay Chinese** per the [language convention](README.md#conventions); when a Chinese-only doc later needs an English counterpart, add the pair through the [bilingual contract](i18n/README.md) rather than writing one file in two languages.

## Budgets

Ceilings are guardrails, not reduction targets; the working gates here are review discipline and the checks below, not a budget runner. Keep entry paths brief, keep one home per fact, and split a document by its domain owner when retrieval cost is high. When a standing document grows past comfortable review size, first relocate content that belongs to another tier, then condense; splitting needs a domain owner, not a size threshold alone.

## The slop checklist

Hunt these in any doc; [dsh-doc](../.agents/skills/dsh-doc/SKILL.md) runs this list as an audit:

- The same rule stated in more than one home. Grep a distinctive phrase; keep one home and link the rest.
- Narrated history or war stories: "previously", "now", "no longer", "used to", "renamed", "was moved", PRs, or commits. State the current fact; link an Agent Note or an archived document when needed.
- Implementation-status annotations in prose ("implemented!", "future: …"). Status rots; the code and the [documentation index](README.md) carry it.
- Hand-restated catalogs, JSDoc, or inventories of tests and files when source is authoritative.
- Reasoning transcripts: step-by-step implementation narration, proof of obvious branches, or rejected local alternatives. Keep the resulting contract or durable rationale; delete the path used to derive it.
- Paragraph walls: one paragraph carrying several rules and parenthetical asides. Split it or demote the detail to its home.
- Emphasis inflation: bold, CAPS, or "critically" everywhere means nothing stands out. Reserve emphasis for the clause that changes behavior.
- Spec-speak in `implemented/` Agent Notes: "should", migration plans, acceptance checklists. An implemented Agent Note describes what is, per [implemented/AGENTS.md](../.agents/notes/implemented/AGENTS.md).

## Cross-reference with machine-checkable links, never free prose

Link repository references with relative Markdown paths, never bare filenames or note numbers. This repository has no link-verification runner; review and [dsh-doc](../.agents/skills/dsh-doc/SKILL.md) audits own the check: every relative link must resolve from the linking file's directory, and cross-references into the harness repository follow the [notes-tree reference convention](../.agents/notes/README.md#layout-and-naming).
