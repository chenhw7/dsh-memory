# Translation rules

English | [中文](translation-rules.zh.md)

How to write or update the Chinese side of a bilingual pair (and, when translating into English, the reverse). The [pairing contract](README.md) owns scope and the sidecar; this file owns faithfulness, structure, and typography.

## Faithfulness

- **Say the same thing, nothing more and nothing less.** Every proposition on one side appears on the other: actor, action, condition, modality (`must` / `should` / `may` / `never`), numbers, exceptions, and negative guarantees survive. Translation is not adaptation: do not resolve an ambiguity by choosing one meaning silently — keep the ambiguity or fix the source first.
- **Edit the counterpart minimally.** An update patches only the hunks the edit touched and preserves the reviewed phrasing of everything else. Re-translating a whole document to apply one paragraph throws the prior review away.
- **No silent improvement.** A clearer sentence discovered while translating belongs to the source side first; fix it there, then mirror it. Diverging content in the name of better wording is a contract violation, not a favor.

## Structure

- Heading depths, order, list kinds, ordered-list starts, item counts, and table row/column counts match one to one.
- **Code blocks are byte-identical**, comments included. Fix a code comment once and copy the corrected fence into both files; translating a fence comment differently per side breaks the pairing contract even when both versions are individually fluent.
- Relative document links into the active bilingual corpus use `.md` on the English side and `.zh.md` on the Chinese side, with identical query/fragment suffixes. Links outside the corpus keep the authored path on both sides.
- One physical line per paragraph on both sides; use editor soft-wrap.

## Terminology

- Load [terminology.md](terminology.md) before translating, not when a term feels uncertain — the terms you don't notice are the ones that drift.
- Every listed term renders exactly as specified, in both directions. First-use rendering follows the terminology table's first-occurrence guidance; an unlisted term needs a citable Chinese OSS/vendor precedent or stays English with a first-use gloss (`BM25(一种词频相关性排序算法)` style), and is added to the terminology table in the same change once confirmed.
- Never invent a rendering inline for a listed term.

## Typography

- Chinese prose uses full-width punctuation; keep half-width inside code spans, identifiers, and URLs.
- Put a half-width space between Chinese characters and Latin words or digits (`BM25 检索`, `3 个作用域`); no space between Chinese characters and full-width punctuation.
- Preserve emphasis, `MUST`-level modality, and link text meaning; decorative re-styling of either side is out of scope for a translation update.

## Working rules

1. Read the source semantic unit, restate it as a native technical author, then verify clause by clause: nothing added, nothing dropped, terms per the table, code spans verbatim.
2. After the source comparison, read the translated file alone and rewrite phrasing whose awkwardness only becomes visible in isolation.
3. Re-record the sidecar after both sides are confirmed consistent (see [README.md](README.md#applying-the-contract-by-hand)).
4. When the source side itself is wrong, fix the source first, then mirror — the translator is not an editor of record for either language alone.
