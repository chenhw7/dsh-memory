---
name: dsh-translate-docs
description: Manually run the extended bilingual-document workflow for this repository (dsh-memory), including golden-corpus recovery, delegated prose translation, whole-document translation, and scoped pairing verification.
disable-model-invocation: true
user-invocable: true
---

# Translating this repository's docs

## Invocation boundary

Run this extended workflow only when the user explicitly invokes `dsh-translate-docs` by name. Never select or load it for ordinary documentation work, from another skill, or from an inferred translation need; routine translation follows the one-shot, one-pass rule in [docs/AGENTS.md](../../../docs/AGENTS.md).

## What this skill is

**This skill is guidance, not a translation memory.** It is the workflow map for keeping `foo.md ↔ foo.zh.md` pairs consistent and natural in both languages. Both languages carry equal authority — a change is authored in either one, and that side is the source for that update. You are the translator: the rules below say what must hold, not how to phrase any particular sentence — phrasing judgment is yours, terminology is not.

## Triage by change type — this decides everything else

- **Update** (pair exists, one side edited): follow [the update path](#the-update-path-minimal-patch). It is deliberately cheap: no guidance-corpus reading, no git archaeology beyond the sidecar, smallest counterpart edit. Never re-translate a whole document to apply an update — a minimal update preserves the reviewed phrasing of everything that didn't change; a re-translation throws that review away.
- **New pair** (no counterpart yet): follow [the whole-document path](#the-whole-document-path-new-pairs), and add the pair to the [scope table](../../../docs/i18n/README.md#scope) in the same change.
- **Deleted or renamed doc**: delete or rename the counterpart and the `.i18n.yaml` alongside it — the pair is otherwise incomplete.

Frozen trees (`.agents/notes/archived/`, `docs/archive/`) are not translation work. Their records are sealed; never update, re-record, or repair either side inside them.

## The update path (minimal patch)

The sidecar plus git history replace the upstream briefing tooling, which does not exist here.

1. **Establish the change surface**: `git diff HEAD` for the edited side, and `git show <recorded-blob>:<file>` (blob from `foo.i18n.yaml`) to recover the last-confirmed text. The diff of the edited side since the recorded blob is the change set.
2. **Mechanical-only diff?** When every change lies inside code fences that the pair shares byte-identically, copy the corrected fences into the counterpart directly — no translation judgment, no subagent.
3. **Prose diff?** Apply the changed hunks clause by clause yourself, or delegate to a subagent passing the change set: the edited side's diff, each changed unit's last-confirmed source, current source, and current counterpart text, plus the [terminology rows](../../../docs/i18n/terminology.md) the change touches. The delegate escalates to the whole-document path only when the change set leaves a specific decision genuinely unanswerable — an unlisted term with no precedent in the surrounding text, or a change so broad that unit alignment fails.
4. **Smallest edit that covers the diff.** Preserve the reviewed phrasing of everything the diff does not touch, then verify the changed hunks clause by clause against the source: nothing added, nothing dropped, terminology per the table, code spans verbatim.
5. **Record and verify, scoped**: recompute `git hash-object foo.md foo.zh.md`, write both hashes into `foo.i18n.yaml`, and eyeball the structure (headings, fences, table shapes) against the [pairing contract](../../../docs/i18n/README.md#applying-the-contract-by-hand). Confirm only pairs you actually verified — the sidecar diff is the reviewable statement of consistency.

## The whole-document path (new pairs)

When a translation needs to be written from scratch, the orchestrating agent does not translate: spawn a subagent to do the translation work. The translator reads the sources of truth below first, then translates the whole file into the other language — section by section for long documents, keeping each section's structure locked to the source as you go rather than fixing structure at the end.

### Sources of truth (read, don't re-summarize)

- **[docs/i18n/README.md](../../../docs/i18n/README.md)** — the pairing contract: the three-file pair (`foo.md`, `foo.zh.md`, `foo.i18n.yaml`), the consistency record's both-side blob hashes, the language-switcher lines, scope, and the hand-applied procedure.
- **[docs/i18n/translation-rules.md](../../../docs/i18n/translation-rules.md)** — how to translate: faithfulness, structure preservation, terminology discipline, typography.
- **[docs/i18n/terminology.md](../../../docs/i18n/terminology.md)** — the terminology table, binding in both directions. Load it BEFORE translating, not when a term feels uncertain; the terms you don't notice are the ones that drift.
- **[dsh-prose-standard](../dsh-prose-standard/SKILL.md)** — required prose coverage and editorial judgment. Apply it to both sides without adding or dropping source propositions.

### Translate

- **Pass 1 — write, don't transpose.** Read a semantic unit, then restate it as a native technical author in the register of the repository's existing [paired documents](../../../docs/README.md). Preserve the required frame without forcing sentence-by-sentence correspondence.
- **Pass 2 — verify against the source, clause by clause.** Fidelity is checked here, not written in: confirm nothing was added or dropped, every term follows the table, and each code span survived verbatim. Fix by rewriting the sentence natively, not by patching words into it.
- **Read the completed counterpart alone.** After the source comparison, read the translated file without the source beside it and rewrite phrasing whose awkwardness only becomes visible in isolation.
- Write only the final text to the file, never drafts or notes.
- Every term in [terminology.md](../../../docs/i18n/terminology.md) renders exactly as specified. For a Chinese target, an unlisted term needs a citable Chinese OSS/vendor precedent or stays English with a first-use gloss; add confirmed terms to the table in the same change. Never invent a rendering inline for a listed term.
- Code blocks are byte-identical across the pair, comments included. Repository-relative document links keep the same semantic target and exact query/fragment suffix: targets in the active bilingual corpus use `.md` on the English side and `.zh.md` on the Chinese side, a missing in-scope counterpart is an error, targets outside the corpus keep their authored path, and the switcher is the cross-locale exception.
- Manually verify list and table order, noncanonical list numbering, inline code, emphasis, meaning, terminology, and tone.

## Find the work

- The pairs in scope are the [scope table](../../../docs/i18n/README.md#scope). Any `.i18n.yaml` whose recorded hashes differ from `git hash-object` output is out of sync; that check is the repo's pairing `--list`:

  ```sh
  for y in **/*.i18n.yaml(.N); do echo "== $y"; done   # zsh glob; or use find -name '*.i18n.yaml'
  ```

- In a change that edits paired docs, the work list is the diff itself: every changed side of a pair needs its counterpart updated and the sidecar re-recorded in the same change.
- Out-of-scope `.zh.md` files (zh-only maintainer docs) are not violations — the [language convention](../../../docs/README.md#conventions) keeps them single-sided.

## Finish the pair

1. Switcher: `[English](foo.md) | 中文` immediately after the Chinese file's H1, `English | [中文](foo.zh.md)` after the English file's H1 — add both if this is a new pair.
2. Record consistency: write both `git hash-object` blob hashes into `foo.i18n.yaml`. The yaml diff is the reviewable statement "I confirmed these two say the same thing" — only record it after you actually have.
3. Add the new pair to the [scope table](../../../docs/i18n/README.md#scope) and, when the language convention changes, to the [documentation index conventions](../../../docs/README.md#conventions) — in the same change, on both sides of each paired file you touch.
4. Before the change lands: the touched pairs' sidecars match their current hashes, and every inbound link still resolves. Full-suite evidence follows [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md).
5. Keep the change reviewable: state which pairs are new versus minimally updated and list 「待定术语」 prominently.

## How to respond to translation review

Follow the [review reporting guidance](../dsh-code-review/SKILL.md#reporting-findings): evaluate each comment on its merits, and for terminology comments, remember the terminology table is the contract — apply a reviewer's rendering decision to [terminology.md](../../../docs/i18n/terminology.md), not only to one file.
