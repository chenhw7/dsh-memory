# Bilingual documentation

English | [中文](README.zh.md)

Cairn's documentation is read by both external plugin users and maintainers, so the documents in scope are maintained in English and Simplified Chinese with equal authority. This page defines the pairing contract, the sidecar record, and the scope for this repository; [translation-rules.md](translation-rules.md) defines how to translate; [terminology.md](terminology.md) is the terminology source of truth. The extended [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) workflow runs only on explicit user invocation.

## The pairing contract

- **Both languages carry equal authority.** A document may be authored and reviewed in either language first, and the counterpart is updated from it. Neither file outranks the other; what binds them is that they must say the same thing.
- **A pair is three sibling files.** The English `foo.md`, the Chinese `foo.zh.md`, and a consistency record `foo.i18n.yaml`, all in the same directory. No locale directories, no interleaved bilingual files. A change never lands one language without the other two files.
- **The consistency record.** `foo.i18n.yaml` holds the full git blob hash of each side as of the last time the two were confirmed to say the same thing:

  ```yaml
  foo.md: 3f786850e387550fdab836ed7e6dc881de23001b
  foo.zh.md: 89e6c98d92887913cadf06b2adb97f26cde4849b
  ```

  Blob hashes, not commit hashes, so the record is computable with `git hash-object foo.md` for files edited in the same change. Upstream harness gates and merge drivers do not run in this repository; this repo applies the same discipline by hand, as [the notes tree adaptation](../../.agents/notes/README.md#adaptations-in-this-repository) records. After bringing a pair back in line, re-record both hashes with `git hash-object` and commit the sidecar diff as the reviewable act of confirming consistency. An out-of-sync pair is updated by patching the counterpart minimally against the edited side's diff — never by re-translating whole files.
- **Language switcher.** The Chinese file links back immediately after its H1 heading with `[English](foo.md) | 中文`. The English file reciprocates with `English | [中文](foo.zh.md)`.
- **Structure mirrors the counterpart.** Heading depths and order, list kinds, ordered-list starts, list item counts, table row and column counts, and verbatim code blocks match one to one across the pair. When a relative document link targets the active bilingual corpus, the English side uses its `.md` path and the Chinese side uses its `.zh.md` path. A missing counterpart in that corpus is a pair-completeness error rather than a fallback; targets outside the corpus keep the authored path.

## Scope

The standing bilingual pairs are exactly:

| Pair | Reader |
|---|---|
| root `README.md` / `README.zh.md` | plugin users and the npm listing |
| `docs/README.md` / `docs/README.zh.md` | documentation index |
| `docs/TECH_DESIGN.md` / `docs/TECH_DESIGN.zh.md` | external integrators and maintainers |
| `docs/SEQUENCE_DIAGRAMS.md` / `docs/SEQUENCE_DIAGRAMS.zh.md` | external integrators tracing flows |

Everything else under `docs/` is Chinese-only by the [documentation index convention](../README.md#conventions) — a deliberate cost trade for a single-maintainer repository, not an omission to fix. New user-facing documents that external readers will consult join this table; do not pair a document silently. `docs/archive/**` documents are frozen records: rename their sidecars only when the pair convention itself changes, and never re-translate them. A rename of any paired file updates the switcher links, the inbound references, and the sidecar in the same change.

## Applying the contract by hand

1. Edit one side.
2. Patch the counterpart minimally: same propositions, [terminology](terminology.md) applied, code blocks byte-identical.
3. Re-record the sidecar: `git hash-object foo.md foo.zh.md`, then write both hashes into `foo.i18n.yaml`.
4. Verify the structure by eye — heading list, code fences, table shape — and the terminology against [terminology.md](terminology.md).

For the full procedure, see [translation-rules.md](translation-rules.md).
