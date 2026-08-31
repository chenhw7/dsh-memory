# Page style

## Summary

Page-level style preferences that make this repository's pages scannable and difficult to misread: a short Summary, controlled technical English, `-----` separators between major parts, `<details>` folds that keep section titles visible, and disciplined emphasis. The template is the root `README` pair.

## Table of Contents

- [Short summary](#short-summary)
- [Controlled technical English](#controlled-technical-english)
- [Section separators](#section-separators)
- [Foldable content sections](#foldable-content-sections)
- [Emphasis discipline](#emphasis-discipline)
- [Dev Note](#dev-note)

## Short summary

Open every authored page with a short `Summary`: three to five sentences in one paragraph stating what the subject is, why the reader cares, the operating model, and the most important boundary. The Table of Contents and the sections carry the detail; placement and section order live in [structure-hierarchy.md](structure-hierarchy.md).

## Controlled technical English

Use an [ASD-STE100](https://www.asd-ste100.org/)-inspired review pass for English prose that an agent, translator, or non-native reader must parse. This is a clarity discipline, not certified ASD-STE100 compliance. The repository does not reproduce or validate the standard's controlled dictionary.

- Name the actor and action. Prefer active voice when the actor matters.
- Use one stable term for each concept. Do not rotate synonyms for variety.
- Prefer direct verbs. Replace nominalizations and ambiguous phrasal verbs when a precise verb exists.
- Put one instruction in each sentence. Use a list for three or more steps or conditions.
- Split semicolons and long clause chains. Keep each paragraph on one topic.
- Remove unsupported quality adjectives and stacked hedges. Preserve every fact and degree of uncertainty from the source.

Treat 20 words for an instruction and 25 words for a description as review prompts, not mechanical gates. Keep a longer sentence when a split would hide a condition or relationship. Never remove or strengthen `must`, `may`, `never`, timing, exceptions, numbers, or other contract terms to meet a length target. The [prose standard](../../dsh-prose-standard/SKILL.md) owns the complete-proposition rule.

The same discipline applies to Chinese prose in zh-only documents: explicit actors, one term per concept per [terminology.md](../../../../docs/i18n/terminology.md), direct verbs, and full-width punctuation with half-width spaces around Latin words and digits.

## Section separators

Separate the major parts of a page with a `-----` horizontal rule on its own line, with a blank line before and after it. A rule directly after a paragraph would parse as a Setext heading. A page this small rarely needs more than three parts: front matter → use section → folded developer section → Further Exploration.

## Foldable content sections

Fold developer-facing detail and the final Dev Note behind GitHub-native `<details>`/`<summary>` blocks. Keep the section title (H2 or H3) and its `<a id>` anchor visible; fold only the content under the title. Inside the block, put a blank line after `<summary>`, keep every Markdown line at column 0 (indented content becomes a code block), and close with `</details>` after a blank line. Headings, lists, tables, and links inside the fold parse normally and keep their anchors.

## Emphasis discipline

Reserve bold for the clause that changes behavior or for the comparison that matters. In comparison tables, bold the column headers and the best value in each row.

## Dev Note

None.
