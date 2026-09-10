# Agent Note: Site pages re-sync to the shipped facts (identity layer, digest default, current counts)

Status: implemented

English | [中文](2026-09-10-site-pages-source-fact-sync.zh.md)

## Problem

Both bilingual site page pairs (`index.html` / `index.zh-CN.html`, `memory-architecture.html` / `memory-architecture.zh-CN.html`) were baked at v0.9.1 and drifted from the source. v0.9.2 shipped the identity layer (SOUL.md / USER.md, the `identity_update` tool, the `identity` / `identity_history` tables, three identity-governance RPCs, a fifth settings card, an eighth Cordis row) and made `digest` the factory-default injection mode; the test suite grew from 967 to 1096 cases. The pages also carried older mechanics: consolidation prefilter ≥ 0.15 (now 0.2 plus a rare-anchor OR signal), the sweep described as "top 20 pairs catching zero-shared-token rewrites" (actually top 20 entries exhaustively paired under the same lexical gate, plus a first-session startup pass), prompt-section order 90/91 (now 6000/6001, after the host's tool section at 5000), 15 RPC methods (now 18, with `identityRevert` behind a second switch), and the importance tie-break described as "absent reads mid-range" while the code reads absent as 0 — the same stale claim also lived in `src/store/index.ts`, `src/types.ts`, and the `memory_add` parameter description. Demo 2's CJK test regex had dropped the Hangul range the source tokenizer keeps, so the "byte-identical algorithm" claim no longer held.

## Decision

Re-sync both page pairs to verified current facts, zh and en together, every change traced to a source location:

- **Identity layer becomes visible.** A fifth capability card on the index pages; a dedicated IDENTITY block plus the `identity` / `identity_history` table cards in station 02; `memory-identity` in the now-eight Cordis rows; the soul / user-profile section orders (80 / 81) in station 05; `identityRevert`'s second gate (`identityRevertEnabled`) in station 07; `src/identity/` in the footer references; and the anti-echo prefilter (IDF-weighted overlap > 0.6 against the injected identity documents) in station 01.
- **Injection modes.** Six modes with `digest` as the default since v0.9.2; demo 3 gains a digest view (policy standing ≈434 tokens plus a one-time ≈126-token `<memory-digest>` inventory on the first step, re-sent after compaction) and the whybox re-argues the digest default.
- **Numbers.** 9+1 tools (nine memory tools + `identity_update`, identity off by default), 1096 tests (1090 passing + 6 key-gated skips), 6 durable tables, 18 RPC methods (10 read / 8 write), the baked status snapshot moved to v0.9.3 / 241 commits / 2026-09-09, the host channel pinned at 0.1.2-alpha.2, and the eval table gains identity-v0 (3 scenarios / 6 questions).
- **Mechanics corrections.** Prefilter ≥ 0.2 with the df ≤ 2 anchor OR signal (0.15 stays behind `consolidation: 'legacy-judge'`); the sweep rewritten as top-20 entries + exhaustive pairing capped at 20 candidate pairs under the unchanged lexical gate; the importance tie-break documented as absent-reads-0 on the pages and in the source texts that carried the stale "mid-range" claim; demo 2's tokenizer regains the Hangul range so it matches `src/store/bm25.ts` byte-for-byte again; the tool module header counts ten tools; the `memory_forget` ceiling comment now names the live search cap (maxSearchResults/2), and the HOST_CONTRACT forensics baseline moves from the rc.5–rc.8 line to 0.1.2-alpha.2.

## Alternatives considered

- **Leave the drift for the next redesign.** Rejected: the pages advertise CI-gated accuracy ("numbers, not vibes"), and a wrong default mode plus a wrong sweep mechanism are exactly the facts the deep-dive exists to teach.
- **A full new station for the identity layer.** Rejected for now: the layer is off by default, and prominent blocks inside existing stations carry it without renumbering the navigation; revisit if identity ever turns default.
- **Change the code to match the "mid-range" prose** instead of the prose to the code. Rejected: the `?? 0` tie-break is shipped and pinned by tests; the prose was the drift.

## Consequences

- Every quantitative claim on both pages once again points at a source of truth, and demo 2's tokenizer is byte-identical to `src/store/bm25.ts` (Hangul included).
- The sync surfaced five source-side stale texts (tool module header, the forget-ceiling comment, two importance comments, the `memory_add` description), all fixed in the same change — the fix direction was always "docs follow code", never the reverse.
- Cost: future fact-changing work must update four HTML files, and the site has no mechanical gate — the change list above is the checklist.
