# Agent Note: The site logo becomes a four-step stairway-cairn mark

Status: implemented

English | [中文](2026-09-08-site-logo-refresh.zh.md)

## Problem

Every site page carried a raster logo that had nothing to do with the product: `assets/logo.png` (1254×1254) and `assets/logo-512.webp` were a DeepSeek anime mascot illustration, and `assets/favicon.png` was a crop of the same art. Beyond the identity mismatch, the raster could not adapt to the light/dark design system shipped by [the zh-redesign note](2026-09-08-site-zh-redesign.md) — a fixed-color mascot is illegible on one of the two themes, and an ink-on-transparent raster would vanish on the dark theme. The brand name itself — *cairn*, the stacked-stone trail marker — was unused.

## Decision

The site mark is now **a four-step stairway of rounded stones rising left-to-right** ("石阶 / Stairway", variant 09 of a 12-candidate exploration): each step is one accumulated session of memory, the climb is the growing context, and the top stone — the current session — is DeepSeek blue `#4D6BFE`. Bar heights are 10.5–14 units on the `0 0 100 100` viewBox so the mark stays whole at 16px.

- **Inline SVG in all four pages** (nav brand at 26px, landing hero at clamp(84–128px)): three ink bars with `fill="currentColor"` plus the blue top bar with `fill="var(--accent)"`. The mark follows the theme toggle through the page's own CSS variables with zero extra requests and no raster fallback; `assets/site.css` selects `.brand>svg` instead of `.brand img`.
- **`assets/favicon.png` regenerated at 64×64** as a light tile (`#F0F5FF`, hairline `#D8E2F5`) carrying a favicon-tuned three-step variant with enlarged gaps — at 16px the four-step gaps would alias away, and the tile keeps the mark visible on dark tab strips. One file serves both color schemes; the `sizes="64x64"` link is unchanged.
- **`assets/logo.png` (512×512, transparent) and `assets/logo-512.webp` regenerated** with the new mark as distributable rasters for places that cannot inline SVG. No site page references them anymore.
- The design exploration (12 SVG variants, two showcase pages, render/verify tooling) was kept as untracked scratch in `.logo-design/` and deleted when the change landed; the canonical geometry is the inline SVG in the four HTML pages.

## Alternatives considered

- **11 回路石标 (Loop Cairn):** a two-bar blue mini-cairn seated in the opening of a bold "C" ring — the brand name literally completes the memory loop, and it was the cleverest finalist. Rejected: the ring plus inner bars crowd below 24px, and the C-for-Cairn reading needs the name nearby.
- **12 穿环轨迹 (Through-Loop):** a blue session trajectory threading out of the recall-ring gap to a blue summit dot — the truest fusion of the two shortlisted directions (ring + waypoints). Rejected: three distinct elements (ring, path, dot) blur under 24px, and the entry point of the trajectory reads as arbitrary at small sizes.
- **07 记忆核 (Core Ring):** a thick C ring with a blue core dot — the most minimal finalist and the most robust at 16px. Rejected: the runner-up lost to the stairway's closer fit to the cairn metaphor (stacked steps, not an abstract core); it remains the fallback if the four-step mark ever needs simplifying.
- **Keep the raster logo and swap it per theme via CSS** (`content: url(...)` under `:root[data-theme="dark"]`). Rejected: Safari does not honor `content` replacement on `<img>`, so dark-mode Safari users would get an invisible ink mark; inline SVG adapts everywhere for free.

## Consequences

- The mark is theme-adaptive with zero JavaScript: light theme renders ink `#0B1526` + `#4D6BFE`, dark renders `#E8EDFF` + `#6C87FF`, entirely via the existing token system.
- `assets/logo.png` and `assets/logo-512.webp` are no longer referenced by any page; they are kept as distributable brand rasters (README/npm/social candidates) and are candidates for deletion if nothing adopts them.
- The favicon intentionally diverges from the site mark (three steps on a light tile vs. four bare steps) for 16px legibility and dark-tab visibility — a known, accepted dual form.
- The design-process scratch `.logo-design/` was deleted with the change; the rejected variants' geometry survives only in the Alternatives section above, and nothing shipped depended on the directory.
