# Page structure and hierarchy

## Summary

Each page gives a newcomer a short front door before it exposes operational or implementation depth. Cross-package learning and engineering material lives under `docs/`; the user contract lives in the root README. Small rule files own one independently searchable requirement, but arbitrary fragmentation is not a goal. The final Dev Note isolates active working context from the stable explanation above it.

## Table of Contents

- [Page order](#page-order)
- [Section progression](#section-progression)
- [Documentation hierarchy](#documentation-hierarchy)
- [Small rule files](#small-rule-files)
- [Further Exploration](#further-exploration)
- [Dev Note ownership](#dev-note-ownership)
- [Dev Note](#dev-note)

## Page order

Use this order for authored human-facing pages when the format owner permits it. Agent Notes retain their [repository-defined skeleton](../../../notes/README.md#the-file-format), and archived documents are frozen.

1. H1 title.
2. Language switcher for a bilingual page.
3. `## Summary`: three to five explanatory sentences stating what the subject is, why a reader would care, the main operating model, and the most important boundary.
4. `## Table of Contents`: links to the page's H2 sections; keep it navigational rather than descriptive.
5. Stable content, ordered from user-facing use to developer-facing design and operational detail.
6. Optional `## Further Exploration` for newcomer-oriented links to adjacent subjects.
7. Final `## Dev Note` for non-authoritative active working context (pages following the README format; other formats may omit it).

Do not force a Summary/Table of Contents wrapper around tiny machine-owned files or formats whose executed parser defines another header. State the exception in the format owner rather than creating invalid output.

## Section progression

Open every substantive H2 with a short orienting paragraph before tables, code, or H3 subsections. Explain the section's subject and decision-relevant point; do not repeat its complete contents.

Within a page, order content by reader depth:

1. Basic use: when to choose the feature, required inputs, shortest safe example, observable success, and likely recovery.
2. Advanced use: configuration choices, limits, operations, and integration behavior.
3. Developer detail: ownership, lifecycle, data model, failures, performance, security, and extension points worth maintaining.

Fold heavy developer detail and the final Dev Note behind `<details>` blocks with the section titles visible (mechanics in [style.md](style.md)).

Folded developer detail is concept-level by requirement: the overall design concept, the architecture of the main components, and hand-waving dataflow — enough to understand how the package works — plus links to code for exact detail. It never becomes an exhaustive catalog: no full API inventories, column lists, or JSDoc restatement. The Dev Note is the only place allowed to hold partial ideas, scratches, and undecided directions; everything else, folds included, is polished current-state prose.

## Documentation hierarchy

This repository's tree is flat and small; keep it that way:

```text
docs/
  README.md            documentation index (pair)
  TECH_DESIGN.md       full technical reference (pair)
  SEQUENCE_DIAGRAMS.md flow diagrams (pair)
  AGENTS.md            documentation standard (pair)
  testing.md           test policy (pair)
  defensive-patterns.md bug-class rules (zh-only conventions allow EN too)
  i18n/                pairing contract, rules, terminology
  archive/             frozen planning/analysis records
```

Treat this as a target map, not permission for opportunistic reorganization. Move one coherent topic at a time, repair every inbound link atomically, and record a structural move in an Agent Note when it changes where a fact lives.

`docs/archive/` contains frozen, completed planning and analysis documents. Each archived doc keeps its "archived" status line and its recorded implementation deviations; local disposable notes remain ignored and uncommitted.

## Small rule files

Give an independently searchable rule, practice, or decision one small file when it has its own owner, change cadence, or inbound links — [defensive-patterns.md](../../../../docs/defensive-patterns.md) is the example. Keep tightly coupled rules together when splitting would force readers to open several files to understand one obligation. Do not create an index page for one or two files; the [documentation index](../../../../docs/README.md) already maps the corpus.

## Further Exploration

Use this optional section for a reader who finished the page and wants adjacent understanding. Link three to seven directly related pages, order them from closest prerequisite to deeper exploration, and say in a short phrase what each adds. Do not turn it into a complete site index.

## Dev Note ownership

End authored pages with Dev Note, but keep it explicitly non-authoritative. Active hypotheses, compatibility concerns, rough alternatives, progress pointers, and unresolved questions may live there; stable behavior, required limitations, and accepted rationale belong in their ordinary owners.

Dev Note may mirror or link task progress but must not become a second writable queue. When work closes, promote durable conclusions, move reusable rationale to an Agent Note, keep incident chronology in an archived document, and delete resolved chatter. Git history preserves old iterations.

## Dev Note

The mandatory final section is intentionally the least polished part of an authored page, but it still has lifecycle discipline. A blank Dev Note should say `None.` rather than accumulate placeholder prose; formats owned by an executed parser may omit it through a named exception.
