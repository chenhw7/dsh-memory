# Agent Note: Align the settings seam with @deepseek-ai/dsh-settings 0.1.2-alpha

Status: implemented

English | [中文](2026-08-31-align-settings-seam-with-dsh-settings-0.1.2-alpha.zh.md)

## Problem

`@chenhw7/dsh-memory` 0.6.0 is compiled against the rc-era `@deepseek-ai/dsh-settings` API (0.1.0-rc.8 in the lockfile; peer range `^0.1.0-rc.5 || ^0.1.1-rc.1`). Under the harness's `0.1.2-alpha` channel the plugin fails to load.

The upstream removal is verified at the version boundary:

| Tag | `installSettingsSection` / `settingsNamespace` as top-level exports |
|---|---|
| `dsh-v0.1.1-rc.2` | present |
| `dsh-v0.1.2-alpha.1` | present |
| `dsh-v0.1.2-alpha.2` (npm `alpha` dist-tag, 2026-08-30) | **removed** |

The removal happened in the upstream runtime-dependency-decoupling change (merge `a69941bf51`, PR #3319; commit `f4e49ccf8f` "refactor(services): move shared values behind service APIs"), which moved the free helper behind the service API: the function is now the instance method `SettingsProvider.installSection(owner, ns, schema, entry, hooks)` (`~/deepseek-harness/packages/settings/settings/src/index.ts`), and the `settingsNamespace()` brand helper is gone entirely — namespaces are plain strings validated by the `SettingsNamespaceInput` template-literal type and at runtime by `parseSettingsNamespace`.

Four of the seven bundle units mount code that statically imports the removed names:

- `tool-memory` — `src/tool/index.ts` imports `settingsNamespace`
- `memory-notes` — `src/notes/index.ts` imports `settingsNamespace`
- `memory-context` — `src/context/index.ts` imports `installSettingsSection` + `settingsNamespace`
- `memory-review` — `src/review/index.ts` imports `installSettingsSection` + `settingsNamespace`

ESM resolves missing named exports at link time, so each unit dies with `SyntaxError: … does not provide an export named …` during plugin load. `memory-root`, `memory-store`, and `memory-remote` survive, but the memory feature set (tools, context injection, review, notes) is broken as a whole.

Independently, the declared peer range `^0.1.0-rc.5 || ^0.1.1-rc.1` cannot match `0.1.2-alpha.2` (nor `0.1.1-rc.2`): under semver, a prerelease version only satisfies a comparator set if a comparator with the same `[major, minor, patch]` tuple itself carries a prerelease.

The upstream repository does not call this third-party impact out anywhere — the old names are scrubbed from its docs, the two commits carry no bodies, and its Agent Notes policy is fail-loud with no compatibility aliases (`~/deepseek-harness/.agents/notes/implemented/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md`). The new API is documented only positively, in the settings package README and `docs/subsystems/settings.md`. This note records the diagnosis and owns the migration decision for this repository.

## Decision

This repository now targets the 0.1.2-alpha line end to end: the four host-side settings call sites use the provider method, the dependency ranges require `^0.1.2-alpha.2` across the whole dsh family, and the client bundle is migrated off the removed `dsh-client-runtime`. Three further alpha renames surfaced during the migration and are aligned in the same change (`ToolCallId`, the session-projection state/wire split, and the client module graph's package moves).

### Settings call sites: free function → provider method

`src/context/index.ts` and `src/review/index.ts` call the settings wiring through the in-repo canonical consumer pattern (reference: `~/deepseek-harness/packages/web/web-search-deepseek/src/index.ts`):

```ts
ctx.inject(['settings'], (settingsCtx) => {
  settingsCtx.settings.installSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
})
```

The `SettingsSectionHooks` shape is unchanged from rc.8 (`setSource`, `onChange`, optional `validate`), so the hook objects carried over as-is. The `inject(['settings'], …)` guard replaces the free function's internal optional-service lookup: while no settings provider is mounted, the callback never runs and the consumer keeps its composition entry. Each of the four modules imports `@deepseek-ai/dsh-settings` type-only so the `Context.settings` augmentation stays in the program after the value imports disappeared.

### Namespace constants: branded helper → plain string literals

`settingsNamespace('memory')` / `settingsNamespace('memory-review')` became the plain string literals `'memory'` / `'memory-review'` in `src/tool/index.ts`, `src/notes/index.ts`, `src/context/index.ts`, and `src/review/index.ts`. `ctx.settings.get(ns)` / `sctx.settings.get(ns)` reads are unchanged; the literal types satisfy the `SettingsNamespaceInput` grammar check.

### Dependency ranges: the alpha channel

All `@deepseek-ai/dsh-*` peers and dependencies moved from `^0.1.0-rc.5 || ^0.1.1-rc.1` to `^0.1.2-alpha.2`; `@deepseek-ai/cordis` (`^4.0.1`) and `@deepseek-ai/schemastery` (`^3.18.1`) keep their vendored-version lines. `@deepseek-ai/dsh-client-runtime` is gone from the devDependencies — it was unpublished at alpha and removed upstream (commit `be531688f3` "refactor(client): migrate consumers and remove Runtime", 2026-08-22) — replaced by `@deepseek-ai/dsh-client-store`. The README (English and Chinese) documents the channel requirement in the install prerequisites and Known Limitations.

### The two renames the proposal did not anticipate

- **`CallId` → `ToolCallId`** (`@deepseek-ai/dsh-llm`): the test files import the brand function under the old name via `import { ToolCallId as CallId }` to keep call sites unchanged.
- **Session-projection state/wire split**: `ProjectionDefinition.schema` became `stateSchema` (validating persisted state), and the `view` moved under an optional `wire: { viewSchema, view }` — `SessionProjectionMap` (client-visible keys) is now distinct from `SessionProjectionStateMap` (host state). The `memory-review-candidates` unit is host-only: accumulator.ts declares `SessionProjectionStateMap` (not the wire map), the registration omits `wire`, and the review drain reads `projections.stateOf(session, key)` instead of `snapshot()` — alpha.2's `snapshot()` only iterates wire-visible units, so a host-only unit is invisible to it.

### Client bundle: migrated off the removed `dsh-client-runtime`

The verification the proposal deferred found the client-runtime removed upstream. The migration mapped every import to its alpha.2 home:

| rc.8 import | 0.1.2-alpha.2 home |
|---|---|
| `createSnapshotStore`, `SnapshotStore` | `@deepseek-ai/dsh-client-store` (main entry; Node-importable, sync flush by default) |
| `SettingsScope`, `SettingsScopeSnapshot` | `@deepseek-ai/dsh-client-ui-settings/client` (contract unchanged: `getSnapshot`/`subscribe`/`set`/`unset`) |
| `ClientContext` | `Context` from `@deepseek-ai/cordis` (the client face; merges arrive via type-only imports) |

The bundle format itself needed no change: `window.__ModuleLoader__.load({ id, factory })` and the `factory(require)` shape are unchanged in alpha.2 (`ClientBundleRegistration` in `~/deepseek-harness/packages/client/modules/src/client/manifest.ts`). `scripts/build-client.cjs` externals and the `dsh.client.inject` manifest field swap `dsh-client-runtime` for `dsh-client-store`. The vitest stub for `dsh-client-runtime/client` is deleted: the real `@deepseek-ai/dsh-client-store` is plain ESM importable from Node, so the jsdom suite drives the published implementation.

## Alternatives considered

**Stay on the rc/next channel and keep the old API.** Rejected. npm's `next` dist-tag points at `0.1.1-rc.2`, a line the harness's forward work has already left; the plugin would run only on a channel that receives no further releases, and the stated goal is alignment with 0.1.2-alpha.

**Dual-path code that supports both rc and alpha** (`typeof ctx.settings?.installSection === 'function' ? … : installSettingsSection(…)`). Rejected. It plants two vocabularies for one seam in this codebase — the exact condition the upstream no-alias policy exists to prevent — and doubles the test surface for an audience of zero released consumers.

**Re-implement the removed helper locally** on top of `register`, keeping the free-function call shape. Rejected. It duplicates a helper the harness now owns on the provider service, and a local copy drifts from upstream semantics (fallback-on-provider-loss, unload suppression via the owner fiber's state) with no test tying it to the real implementation.

**Wait for the 0.1.2 stable release before touching code.** Rejected. The plugin is already broken on the alpha channel that users are adopting, the migration is small and mechanical, and the target API is shipped and documented in-tree — waiting only extends the broken window.

## Testing

- The full vitest suite passes against the published 0.1.2-alpha.2 artifacts (488 tests, 26 files; one skipped suite is the opt-in real-API judge).
- `tests/settings-live.spec.ts` gained a provider-unload fallback test: with a mounted provider a user override applies live, and after the provider fiber disposes every consumer reads its composition entry again — pinning `installSection`'s detach wiring and the tool plugin's namespace-read fallback.
- `npm run build` (tsc over `src/` against the alpha.2 declarations, then the esbuild client bundle) passes; the client suite exercises the real published `dsh-client-store`.

## Consequences

What this bought:

- The bundle loads under the harness `alpha` channel: all four previously failing units (`tool-memory`, `memory-review`, `memory-notes`, `memory-context`) import only names that exist in `0.1.2-alpha.2`, and the settings wiring keeps its observable contract — registration with the composition entry as `base`, fallback when no provider is mounted or when it unloads, live re-reads per event/call.
- The client bundle compiles against alpha client packages and keeps its loader contract; the settings cards' `SettingsScope` face is byte-compatible.

What this costs:

- **The rc/next channel is cut off.** `installSection` exists only on the 0.1.2-alpha provider, so the peer ranges cannot serve rc users; a future rc-line consumer needs a new note.
- **The alpha line is a moving target.** Further `0.1.2-alpha.x` bumps require re-diffing the peer packages' exports against the symbol list in the Problem section plus `ToolCallId` and the projection state/wire map.
- **The client bundle is build-verified, not runtime-verified.** The suite covers the store and components in jsdom, but no test drives the bundle through a live alpha.2 web host's module system; the first interactive session against an alpha host is the remaining proof.
- **A version bump is still owed.** The change breaks rc users, so the next release must carry a version bump and the channel note; the release flow owns the number.
