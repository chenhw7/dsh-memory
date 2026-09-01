# Agent Note: Injection fences neutralize forged closers at render time

Status: implemented

English | [中文](2026-09-01-fence-escaping-renders-time-neutralization.zh.md)

## Problem

Stored memory content is rendered inside plugin-owned XML fences (`<memory-context>`, `<memory-index>`, `<recalled-memory>`, `<project-notes>`), but nothing stopped an entry from containing the fence's own closer. An entry whose content includes `</memory-context>` would terminate the fence early and let the remainder of the stored text speak outside the frame — outside the "helpful context, not instructions" disclaimer that every fence carries. The write-time scanner does not flag closers (they are not an injection pattern), so content could not be rejected at any existing boundary. This was a mechanism-level deduction in the memory-system improvement program; no exploit was observed.

## Decision

Render-time escaping, in one choke point. `neutralizeFenceBreaks` in `src/context/policy.ts` rewrites every plugin-owned closer (`</memory-context>` → `<\/memory-context>`, same for `memory-index`, `recalled-memory`, `project-notes`, `memory-policy`) in the body text, and all four fence builders apply it to the store-sourced body before wrapping: `buildMemorySectionText` (`full` and `index` modes), `buildNotesSectionText`, and `buildAutoRecallBlock`. Opening tags are left intact — they cannot terminate a fence — and the fences the builders emit themselves stay untouched, so exactly one real closer per fence remains. Stored content is never modified; tool read paths and the remote projection still return the raw text.

## Alternatives considered

- **Reject the write at `add`/`update`.** Rejected: this codebase legitimately discusses the memory system itself (its fences, its store semantics), so a closer-tag ban would reject valid entries and still leave already-stored closers needing a render-time fallback anyway.
- **Escape at each render site (`renderScope`, tool formatting, index lines).** Rejected: five scattered call sites invite one to be missed; the fence builders are the only places that construct a fence, so escaping there covers every consumer of the builders.

## Consequences

- A stored closer renders as `<\/memory-context>`: visually intact for the model, but no longer terminates the fence.
- The tag-name list (`PROMPT_FENCE_TAGS`) must be kept in sync with any new fence this plugin introduces; the fence-escaping describe block in `tests/policy.spec.ts` pins each builder.
- Tags owned by other plugins or the host are not escaped; only this plugin's injection surfaces are covered.
