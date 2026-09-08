# Agent Note: The Chinese site pages move to a new light/dark design system

Status: implemented

English | [中文](2026-09-08-site-zh-redesign.zh.md)

## Problem

The GitHub Pages site (repo root, three hand-written HTML files) had two structural problems. First, presentation: a single dark-only amber "parchment" theme duplicated inline per page, no light mode at all, and no Chinese landing page — `index.html` was English-only, so the zh audience entered the site through a nav link on a foreign-language page. Second, facts: the zh deep-dive predated the v0.9 write-path rework — it claimed three durable tables (there are four since v0.9), described storage as `memory.json` only (no SQLite backend, no write-amplification A/B), called the consolidation prefilter "Jaccard" (it is IDF-weighted overlap since the two-tier rework), and omitted the v0.9 entry fields (`summary` was there; `anchors`, `status`/`supersededBy`, `hitCount` were not). The marketing face of the repo was stale about the product.

## Decision

The Chinese pages are rebuilt from scratch on one shared design system, Chinese-first; the English pages follow in the same review, rebuilt on the same system with English copy.

- **Design system, shared by all four site pages:** `assets/site.css` (theme tokens + component vocabulary) and `assets/site.js` (theme toggle wiring + scroll-reveal observer). Light mode is white + DeepSeek's brand blue `#4D6BFE`; dark mode derives from the same hue family (night-blue backgrounds, brightened accent). Theme behavior: first visit follows `prefers-color-scheme`, a manual toggle persists via `localStorage('cairn-theme')`, and a pre-paint inline script in each `<head>` sets `data-theme` before first paint (no flash). Type: self-hosted **Smiley Sans** (得意黑) display headings — the maintainer's explicit "no thin fonts" call — with Noto Sans SC 500 body and IBM Plex Mono numerals; Noto Serif SC is dropped from the new pages.
- **`index.zh-CN.html` (new)** — the Chinese landing, a full product page: hero ("重启之后，它还记得。"), no-memory-vs-Cairn contrast, four capability cards, a stat wall, a three-step "how it works" strip, trust section, memory-console mock, honest limits, a light **project-status** strip (npm registry version + `stats.json` totals; baked snapshot fallback, `?offline=1` for pure-static demo), and entry links.
- **`memory-architecture.zh-CN.html` (rewritten, URL unchanged)** — the deep-dive is now a station journey, "一条记忆的一生": Overview → Birth (capture) → Store (write gates) → Grow (consolidation) → Recall (BM25) → Inject → Decay → Farewell (forget/human review), plus a closing evidence section; every station carries a "why designed this way" decision box. Facts corrected to v0.9.1: four tables, dual backends with the write-amplification A/B, two-tier consolidation with `supersededBy`, the v0.9 entry fields, and the 967-case test count.
- **`index.html` and `memory-architecture.html` (English, rebuilt in the same review)** — the same structure, demos, and design system as the Chinese pages with English copy; the legacy amber pages — including the three-lane pulse panel and its baked `v0.8.0` version plate — are replaced. Both URLs are unchanged.
- **Interactivity narrowed to four ported demos** (write-path gates with the rAF-glide payload, the real BM25 kernel playground, the injection-mode switcher, the decay slider); the extraction simulator, particle hero, loop animation, and suggestion-queue demo became static figures.
- **Numbers policy:** every figure on the pages is CI-gated or recorded in an Agent Note (scanner rule counts recounted against `src/scanner.ts`; ranking order against `src/store/index.ts`; test count from the 2026-09-07 eval-workspace note). The partial real-model judged slice (91.3%) is deliberately not cited.
- **Peripheral:** `sitemap.xml` carries all four pages with refreshed lastmod. The `stats.json` pipeline is untouched — both landings consume it read-only. Language cross-links live in each page's nav (EN ↔ zh on landing and deep-dive).

## Alternatives considered

- **Rewrite `index.html` in place as Chinese.** Rejected: the root URL is the English site today; replacing it deletes the English landing outright while the EN redesign is explicitly deferred. A new sibling URL keeps both audiences served.
- **Keep per-page inline styles, as the existing pages do.** Rejected: two pages now share one token set, and the deferred EN rebuild is expected to adopt the same system — one home for the design tokens instead of a third and fourth copy of drift-prone CSS.
- **Port all seven existing demos.** Rejected: four signature demos carry the story; the other three restyled-and-retested demos would add maintenance surface without adding the page's core argument.
- **Static numbers only on the landing.** Rejected: baked version plates go stale between releases (the EN page's baked `v0.8.0` is the live example); the light npm + stats.json lane with a graceful baked fallback keeps the strip honest for near-zero cost.

## Consequences

- All four site pages share one design system; the interim two-skin state ended when the English pages were rebuilt in the same review (2026-09-08).
- `assets/fonts/SmileySans-Oblique.woff2` adds ~1.4 MB of font binary to the repo. It ships under SIL OFL 1.1 with the license committed alongside (`assets/fonts/SmileySans-OFL.txt`); the font is used unmodified, so the Reserved Font Name clause is respected.
- The zh deep-dive keeps its URL, so all inbound links and search-indexed references keep working.
- Every page loads `assets/site.css` + `assets/site.js`; the only language-carrying shared rule is the decay overlay, whose text comes from a per-page `data-dead` attribute.
- Pages citing fast-moving numbers (test count, version) will drift and need refreshes with releases; the design decision is that they are updated in the same change as the release, like any other doc claim.
- The landing's original two-session pnpm dialogue vignette was removed in review (2026-09-08): its `.msg` rows inherited a flex layout that split sentence fragments into separate boxes, and the maintainer preferred the three-step strip to stand alone — the `.dg`/`.msg` styles were deleted with it.
- The deep-dive hero's intro paragraph is left-aligned (2026-09-08 review follow-up): `.hero-sub`'s `margin: auto` centering fought the deep hero's left alignment, so `body.deep .hero .hero-sub{margin-left:0}` pins it to the title's left edge; both language versions share the rule.
- All small text sits on a 12/13/13.5/14px ladder (2026-09-08 review follow-up): IBM Plex Mono 600 below ~13px gets pixel-grid hinting distortion on Windows at 100% zoom (device pixel ratio 1), so every 9.5–13.5px size was raised one tier — approximately what the 125% zoom level already rendered. The queue header's inline duplicate of `.ms-head` was folded into the shared rule, and the search demo's token label moved 11px → 12px. Keeping the typefaces unchanged was deliberate: the distortion is a rasterization artifact of size, not a property of the fonts (a font swap or `text-rendering` overrides were considered and rejected).
