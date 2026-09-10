# Agent Note: Site deploys through the Pages Actions pipeline; stats.json leaves the repository

Status: implemented

English | [中文](2026-09-10-pages-actions-deployment.zh.md)

## Problem

Pages was deployed from the main branch root (Pages API `build_type: "legacy"`), so the `stats.json` the landing pages fetch at view time had to live in the repository: `site-stats.yml` regenerated it on every push to main and once daily and committed it back as `github-actions[bot]`. Three verified costs (measured on the 2026-09-10 evaluation snapshot): 42 of the 246 commits on main (17%; 8 of the last 20) were refresh noise; every bot commit forced a fetch+rebase on the maintainer's next direct push to main (the recurring "rejected, fetch first"); and because `build-site-stats.cjs` counts every author, the feed counted the bot's own commits — 2026-09-05/06 show `c:1, a:1, del:1` on days with zero human work, and the daily cron (the `generated` timestamp always changes, so every run commits) guaranteed one commit every day, permanently erasing the quiet-day signal from the activity panel. The committed artifact also stood against this repository's own rule that nothing generated is committed (AGENTS.md: the plugin writes no files into the repository), and the branch-root deployment published repository files (`package.json`, `docs/`, sources) alongside the site.

## Decision

- **Pages now deploys through the Actions pipeline** (Pages API `build_type: "workflow"`, flipped via `gh api`). `.github/workflows/site-pages.yml` assembles the deploy artifact — the four hand-maintained HTML pages, `robots.txt`, `sitemap.xml`, `assets/` — and generates `stats.json` INTO the artifact through the same `build-site-stats.cjs --selfcheck` pass. `site-stats.yml` and the committed `stats.json` are deleted; the path is gitignored for local preview runs.
- Triggers are unchanged (every push to main, daily 17:32 UTC, manual), so the feed stays fresh right after landing work and a quiet repo still gets a refreshed timestamp — on deploy, not on main.
- No workflow writes to main anymore: the deploy job holds `contents: read` only. The push race and the bot-commit noise end here, and the activity feed counts human commits again — the committing bot no longer exists to be counted.

## Alternatives considered

- **Keep branch deployment; mitigate in place** (drop the per-push trigger, filter the bot author out of the aggregation, commit only when the days data actually changes). Rejected: bot commits to main would continue, the repository would keep carrying a generated artifact against its own no-generated-files rule, and the push race would only get rarer, not gone.
- **Commit the generated file to a dedicated site branch.** Rejected: the site moves off the repo root it has always served from, creating a second surface to keep in sync with the hand-maintained pages.
- **Generate the stats in a local pre-push hook.** Rejected: it moves the churn into every maintainer push and still commits the artifact.

## Consequences

- No bot commits to main going forward; the 42 existing refresh commits stay as history. `git log` and bisect archaeology are human-only from 2026-09-10 on, and the maintainer's pushes no longer race a scheduled writer.
- The activity panel's data is honest again: quiet days show as absent (the self-referential daily commit is gone) and the feed counts only human work. The pages' baked labels ("CI 每日刷新" / daily build) remain accurate — the deploy is still daily CI. The pages themselves are untouched; they still fetch `stats.json` at view time, only its home changed (see the [site pages source-fact sync](2026-09-10-site-pages-source-fact-sync.md) for their content contract).
- The site now serves exactly the artifact file list, so the legacy branch-root deployment's accidental publication of repository files (`package.json`, `docs/`, README) stops. A new root-level site file must be added to the workflow's copy list and `sitemap.xml` in the same change — the one manual step that replaces the old commit noise.
- Publishing now depends on this workflow being green (Settings no longer serves the branch directly); a failed deploy leaves the last published artifact standing. Action versions are pinned to commit SHAs like the rest of the repository's CI.
