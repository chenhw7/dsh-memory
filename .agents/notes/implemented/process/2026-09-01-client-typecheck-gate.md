# Agent Note: The client source gains its own type gate

Status: implemented

English | [中文](2026-09-01-client-typecheck-gate.zh.md)

## Problem

`tsconfig.json` excluded `src/client` from the host tsc program, and nothing else type-checked it: the only client compiler was the esbuild bundler, which erases types without checking them. A type error in the settings cards or the memory section shipped as silently broken (or silently working-by-luck) runtime code. The gap was real, not hypothetical — the `getRaw` RPC addition landed a wire declaration without wiring the client-side face, and only a type check over `src/client` would have caught it. The [quality-gates note](2026-08-31-quality-gates.md) had recorded the exemption as an architectural decision, so closing the gate required updating that record in the same change.

## Decision

A dedicated client typecheck program, wired into the existing build lane:

- **`tsconfig.client.json`** — extends the host config, overrides to `noEmit` + `composite: false`, sets `jsx: "react-jsx"` (the automatic runtime, matching `build-client.cjs` and `vitest.config.ts`), swaps the lib to `es2023 + dom + dom.iterable` (client code runs in the browser), and drops Node from `types`.
- **Host-package type mapping.** Five host packages the client imports (`dsh-client-ui-slots`, `-ui-primitives`, `-ui-settings/client`, `-ui-settings-plugins/client`, `-client-locale/client`, plus `-ui-renderer/client` for `ctx.slots` and `-api-remotes/client` pulled in transitively) ship no types inside this package's node_modules; their `paths` entries point at the harness workspace checkout's `lib/types` outputs. The client bundle keeps resolving them at runtime through the injected `require` — the mapping types the imports without changing what ships.
- **`@types/react@18.3.31`** as a devDependency, matching the react 18.3.x runtime.
- **Build wiring.** `npm run build` = `tsc (host)` → `tsc -p tsconfig.client.json` → `fix-imports` → `build-client`. The gate runs before the bundle, so a client type error fails the build instead of shipping.

The stock measurement that decided "clean first, then wire": with the environment in place (`@types/react` + the paths mappings), the raw 409 errors resolved to 12 real ones — 323 were JSX-runtime absence and 11 missing host declarations. All 12 were fixed here: the `settings.memory` locale namespace declaration (owned by this bundle, keyed to its own dictionary), the `ctx.slots` Context merge import, the missing `getRaw` on the client RPC face, `FieldSpec` locale keys narrowed to the dictionary union, and an exactOptionalPropertyTypes signature fix in the suggestion-reject path.

## Alternatives considered

- **Wire the gate first, fix the stock later.** Rejected: a red build blocks every other track; the measured stock made "fix 12, then wire" the cheaper order.
- **Publish type declarations for the host packages from this repo.** Rejected: the declarations live in the harness workspace where the packages live; duplicating them here would drift.
- **Fold the client check into the host tsconfig.** Rejected: the two programs need different jsx/lib/types settings; forcing one config would weaken the host program's Node-accurate checks.

## Consequences

- Client type errors fail `npm run build` and therefore CI, like host errors already did.
- The harness-workspace paths in `tsconfig.client.json` assume the sibling checkout layout; a deployment building this package without the harness workspace next to it must provide the declarations another way (the bundle itself does not depend on them).
- `AGENTS.md`'s client bullet and the [quality-gates note](2026-08-31-quality-gates.md) now describe the gate as enforced, not exempt.
