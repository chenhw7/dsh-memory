# Agent Note: Align the settings seam with @deepseek-ai/dsh-settings 0.1.2-alpha

Status: proposed

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

## Proposal

Align the plugin with the 0.1.2-alpha settings API and require the alpha channel. Four coordinated changes:

### 1. Call-site migration: free function → provider method

In `src/context/index.ts` and `src/review/index.ts`, replace

```ts
installSettingsSection(ctx, NS, Config, config, hooks)
```

with the in-repo canonical consumer pattern (reference: `~/deepseek-harness/packages/web/web-search-deepseek/src/index.ts`):

```ts
ctx.inject(['settings'], (settingsCtx) => {
  settingsCtx.settings.installSection(ctx, NS, Config, config, hooks)
})
```

The first parameter becomes `owner` (the consumer context, which the call sites already pass). The `SettingsSectionHooks` shape — `setSource`, `onChange`, optional `validate` — is byte-identical between rc.8 and 0.1.2-alpha.2 (verified field by field against the rc.8 `.d.ts` and the alpha.2 source), so the hook objects carry over unchanged. The `inject(['settings'], …)` guard replaces the free function's internal optional-service lookup: while no settings provider is mounted, the callback never runs and the consumer falls back to its composition entry, exactly as before.

### 2. Namespace constants: branded helper → plain string literals

`settingsNamespace('memory')` / `settingsNamespace('memory-review')` in `src/tool/index.ts`, `src/notes/index.ts`, `src/context/index.ts`, and `src/review/index.ts` become plain string literals `'memory'` / `'memory-review'`. `ctx.settings.get(ns)` still exists in 0.1.2-alpha.2 and now accepts the plain string, so the read paths in tool, notes, and review keep working. Grammar enforcement moves to the type level (`SettingsNamespaceInput`) plus the runtime `parseSettingsNamespace` inside `register`/`installSection`.

### 3. Dependency ranges: require the alpha channel

Because `installSection` exists only on the 0.1.2-alpha provider (rc.8 ships only the free function), aligned code cannot run on the rc line. Drop the rc peer ranges and require the alpha channel:

- `peerDependencies`/`devDependencies`: `@deepseek-ai/dsh-settings` (and the sibling `@deepseek-ai/dsh-*` peers) → `^0.1.2-alpha.2`, replacing `^0.1.0-rc.5 || ^0.1.1-rc.1`.
- Document the channel requirement in the README alongside the existing storage/headless notes.

### 4. Secondary alignment (same change, verified separately)

- `@deepseek-ai/dsh-client-runtime` devDependency is still `^0.1.0-rc.8`; bump it to the alpha line and re-verify the client injection list (`dsh.client.inject`: `ui-settings-plugins`, `ui-settings`, …) and `src/client/NamespaceCard.tsx` against the alpha client packages.
- Re-verify the remaining import surface. As of 0.1.2-alpha.2 every other symbol this repository imports is intact: `defineTool`, `BlockAssembler`, `createUserMessage`, `Message`, `GenerateOptions`, `Remote`, `TypertRemoteService`, `Session`, `SessionEvent`, `InvariantInstaller`, `InvariantFailure`, `Branded`, `Agent`, `AssembleContext`. The settings seam is the only load-time break; confirm this holds at each future alpha bump by diffing the peer packages' `src/index.ts` exports against this list.

## Alternatives considered

**Stay on the rc/next channel and keep the old API.** Rejected. npm's `next` dist-tag points at `0.1.1-rc.2`, a line the harness's forward work has already left; the plugin would run only on a channel that receives no further releases, and the stated goal is alignment with 0.1.2-alpha.

**Dual-path code that supports both rc and alpha** (`typeof ctx.settings?.installSection === 'function' ? … : installSettingsSection(…)`). Rejected. It plants two vocabularies for one seam in this codebase — the exact condition the upstream no-alias policy exists to prevent — and doubles the test surface for an audience of zero released consumers.

**Re-implement the removed helper locally** on top of `register`, keeping the free-function call shape. Rejected. It duplicates a helper the harness now owns on the provider service, and a local copy drifts from upstream semantics (fallback-on-provider-loss, unload suppression via the owner fiber's state) with no test tying it to the real implementation.

**Wait for the 0.1.2 stable release before touching code.** Rejected. The plugin is already broken on the alpha channel that users are adopting, the migration is small and mechanical, and the target API is shipped and documented in-tree — waiting only extends the broken window.

## Acceptance criteria

- All seven bundle units (`memory-root`, `memory-store`, `tool-memory`, `memory-review`, `memory-notes`, `memory-context`, `memory-remote`) load and mount without error against a harness tree on `0.1.2-alpha.2`.
- The vitest suite passes, including settings wiring coverage: attach with a mounted provider (namespace registered with the composition entry as `base`), behavior without a provider (consumer keeps the entry config), and a committed settings change re-judging derived state.
- Installing the bundle alongside an alpha-channel harness resolves with no peer-range warning for `@deepseek-ai/dsh-settings`.
- The README states the required harness channel (`alpha`, `0.1.2-alpha.x`).

## Risks

- **The alpha channel is a moving target.** `0.1.2-alpha.x` may carry further renames before 0.1.2 stable. The per-bump export diff in Proposal §4 is the containment; this note's symbol list is the checklist.
- **Dropping the rc peer ranges cuts `next`-channel users.** The rc line receives no further releases from the harness side; a pre-release plugin following the alpha line loses nothing that will be maintained.
- **Timing of the settings wiring changes shape.** `installSection` now runs when the settings service appears (via `inject`) rather than during the consumer's own attach with an internal absence check. The observable contract is the same — registration with the entry as `base`, fallback on provider loss, `onChange` re-judgement — but the attach-ordering assumption deserves the test called for in the acceptance criteria.
- **Client-side drift is not fully covered here.** The client bundle (client-runtime, UI injection list, `NamespaceCard`) is verified in the same change but is a separate surface; any rename found there follows this note's pattern rather than expanding it.
