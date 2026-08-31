# Metadata, links, and bilingual pairs

## Summary

Documents are classified by tree position, not YAML frontmatter: the [tier table](../../../../docs/AGENTS.md#the-tier-taxonomy-one-home-per-fact) owns placement, and no frontmatter `kind` system exists in this repository. Bilingual pages keep equal authority, one-to-one structure, and exact physical line alignment. The `*.i18n.yaml` sidecar records the last-confirmed pair. Link syntax must render correctly on GitHub, so repository links stay renderer-valid relative URLs.

## Table of Contents

- [Frontmatter policy](#frontmatter-policy)
- [Description quality](#description-quality)
- [Repository links and path mentions](#repository-links-and-path-mentions)
- [Bilingual line alignment](#bilingual-line-alignment)
- [Bilingual consistency records](#bilingual-consistency-records)
- [Dev Note](#dev-note)

## Frontmatter policy

Do not add YAML frontmatter to documents in this corpus. Nothing consumes it: there is no metadata gate, no template selector, and no search index beyond full-text search. A page title and tree position own identity; adding `description`, `kind`, or `tags` frontmatter creates an ungoverned second home for facts the body already owns. If a future consumer justifies metadata, add it together with that consumer.

## Description quality

When a document needs a one-line summary in the [documentation index](../../../../docs/README.md) or a cross-reference, write it like a skill description: state what the page covers and when a reader should open it. Use one or two concrete sentences, include searchable domain terms, and distinguish the page from nearby owners. Do not summarize every section, claim superiority, repeat the title, advertise vaguely, preserve change history, or write a technical status report.

Good: `npm release runbook: the three-command flow, OIDC trusted-publishing prerequisites, failure triage, and the trust boundary.`

Weak: `Everything you need to know about releasing this package.`

## Repository links and path mentions

Keep link destinations machine-checkable and mentions context-relative. Use fragment-only links for the current page's table of contents. Use full URLs for external resources.

Use renderer-valid relative URLs in Markdown links from every authored page — a leading `/docs/...` URL resolves outside the repository on GitHub and is never checked. Write logical path mentions such as `docs/` or `src/store/` relative to the discussion. Links into the upstream harness repository follow the [notes-tree reference convention](../../../notes/README.md#layout-and-naming): plain `../../../deepseek-harness/...` relative paths, maintained by hand.

## Bilingual line alignment

Keep English and Simplified Chinese equally authoritative. Match headings, blank lines, paragraphs, list items, tables, code fences, link targets, and total physical line count one to one. The English side points every in-corpus relative link at the `.md` target; the Chinese side points it at the `.zh.md` sibling. Translate prose naturally within its corresponding line; do not hard-wrap either language. Keep code blocks byte-identical and reposition first-use terminology annotations without changing line structure.

Line equality is a structural check, not proof of faithful meaning. Review still owns completeness, terminology, natural language, and whether each line expresses the same proposition.

## Bilingual consistency records

Keep the `*.i18n.yaml` sidecar for every bilingual pair in scope ([scope table](../../../../docs/i18n/README.md#scope)). It holds both sides' git blob hashes as of the last confirmed-consistent state; re-record it with `git hash-object` after either language changes ([hand procedure](../../../../docs/i18n/README.md#applying-the-contract-by-hand)). Do not copy content hashes into frontmatter or document bodies: the sidecar is the single home for pair state.

## Dev Note

None.
