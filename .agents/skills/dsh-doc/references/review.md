# Review criteria

## Summary

Review documentation by whether a reader completes an outcome, not by whether every heading exists. Verify prose against code and tests, preserve exact contracts, and keep the user README useful to consumers while exposing enough implementation detail for maintainers. Run the hand checks in this file; no doc gates execute in this repository.

## Table of Contents

- [Newcomer test](#newcomer-test)
- [Evidence review](#evidence-review)
- [Verification](#verification)
- [Dev Note](#dev-note)

## Newcomer test

A professional engineer with no repository context should answer the following after three to five linked pages: what the plugin does, how to install and use it safely, where its state lives, which module owns it, how it fails, and where to change it. If the reader must inspect source merely to discover the public flow, restore the missing explanation. If the reader must absorb unrelated internals, move those details deeper.

## Evidence review

Check each material statement against its strongest owner. Use package metadata for names and entry points, public types and JSDoc for API contracts, runtime code for behavior, tests for exercised failure paths, and active Agent Notes for rationale. Never treat a prior README, discussion, or report as stronger than current code and tests.

For every operational claim — a command, a config snippet, a default value, an error message, a platform difference — the evidence is running it, not reading it. Execute the exact command or mount the exact configuration against the current checkout before the page may state its behavior; quote only observed output, warnings, and failures. Claims that depend on unavailable keys or host installs name their verification owner instead of asserting behavior. For pre-existing pages, compare against latest `origin/main` and re-verify stale statements against code.

Classify the surface before reviewing install guidance: this package has exactly one shape — a profile bundle installed with `dsh plugin add` and configured through `cordis.patch.yml` or the settings UI. Reject any guidance presenting another install or activation path.

Retain a statement only when it helps the target reader act, reason, or avoid misuse. Move rationale, history, test walkthroughs, duplicate catalogs, and unrelated detail to their owners.

## Verification

Run the smallest focused checks while iterating, then the standing checks by hand:

```sh
npm run build        # when JSDoc, types, or client sources changed
npx vitest run tests/<owning>.spec.ts   # when behavior claims changed
git diff --check
```

Also verify by hand: every relative link resolves from its file; each bilingual pair's sides say the same thing with the [terminology](../../../../docs/i18n/terminology.md) applied and a re-recorded sidecar ([hand procedure](../../../../docs/i18n/README.md#applying-the-contract-by-hand)); every frontmatter claim a document makes (none, by the [frontmatter policy](metadata-links-i18n.md#frontmatter-policy)) is absent. Re-read the final diff once for factual completeness and once for brevity, navigation, and ownership.

## Dev Note

None.
