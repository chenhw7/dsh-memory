# Agent Note: Memory management moves to the sidebar's panel list

Status: implemented

English | [中文](2026-11-25-sidebar-panels-for-memory-management.zh.md)

## Problem

Both management surfaces shipped as Settings sections: the `settings.section` entries `memory` (order 25) and `identity` (order 26), registered from `src/client/index.ts`. The DSH 0.2 port kept them there because it was porting the host contract, not choosing a shell, and the settings nav was the only page-sized seat the old contract offered.

Two problems accumulated:

- **Settings is the host's preference shell, not the plugin's page.** The ecosystem's management surfaces moved to the left sidebar's global panel list — a `sidebar.panellist` icon plus a `main` page. `dsh-context` (an external bundle) registers exactly `main` + `sidebar.panellist` + `plugins.bundle.config` and never touches `settings.section`; the shipped plugins/schedules/ssh panels use the same pair. A management surface in Settings has no rail entry, and the settings column is built for one short page per entry, not for a page-sized, lazily loaded list.
- **The planned feature wave would have been built on the shell about to move.** Metrics, the audit log, the create form, and proposal-action badges were scoped against the Settings section; building them there and migrating afterwards pays for the UI twice.

## Decision

**Each management page is a sidebar panel: a `main` occupant keyed `memory` / `identity`, paired with a `sidebar.panellist` entry of the same id.** Configuration stays on the bundle page (`plugins.bundle.config`, the transport recorded by [the DSH 0.2 host-contract note](2026-11-25-dsh-0.2-per-entry-settings-and-client-page.md)); Settings keeps no trace of this bundle.

- **Pair the key and the id.** The `sidebar.panellist` list `id` is also the `main` key — the sidebar's button selects the panel by that id (`layout.selectPanel` throws for an id without a `main` occupant), so `main` registers first and the icon second.
- **Icon, not text.** The panellist component renders a currentColor glyph from `{ size, active }` (`panel-icons.tsx`); the row title is a `label` thunk, re-read on locale change without re-registering.
- **Register unconditionally.** The client half only loads when the bundle is composed, and the bundle's own patch always inserts the rows these pages read, so a settings-wire gate would couple navigation to an unrelated transport. The first live install proved it: with `whileServed` gating, the pages never appeared at all.
- **The page frame is the panel's.** `.dsm-s-panel` owns the scroll container and measure, pads its top by `--dsh-frame-top-clearance` and its leading edge by `--dsh-frame-leading-clearance` (the window-chrome band, present only while that seat is mounted), and `load()` stays idempotent because the layout retains `main` mounts across navigation.

Manifest metadata ships with the move: `dsh.manifestVersion: 1` plus a package-root `icon` (the host resolves it into the plugin manager's display metadata), so an install reads as a first-class plugin instead of a bare package name.

**The editable config became live/volatile, because otherwise nothing in Settings could see it.** The host's settings wire projects a namespace only when its schema carries `volatile` fields (`SettingsForms.describe()` filters through `volatileForm`), and it hands those fields to `apply` as live refs that the loader updates in place after a commit — `loader/volatile-update` instead of a fiber restart. Every knob the bundle's pages edit is now declared `.volatile()` and resolved through `liveValue` (`src/live-config.ts`), which accepts both the host ref and the plain value a unit test passes; `storage`, `entriesCap`, `crossProcessProbeMs`, and `identitySeedDir` stay ordinary mount-time fields and restart the entry. The frozen session snapshots keep their boundary semantics: live knobs (mode, budget reads) apply on the next step, frozen content catches up at the next freeze (compaction or a new session).

**Each composed row carries its own package identity, because the client-modules scanner refuses an ambiguous package.** The scanner maps every active Loader row to its nearest `package.json` and rejects a package that several rows resolve to (`multiple active Loader sources`); with eight rows all resolving to the package root, the whole client half was silently skipped. `scripts/fix-imports.cjs` now stamps `lib/<row>/package.json` (name + `type: module`, no `dsh.client`) for the seven subpath rows, so only the root row carries `dsh.client` — the same shape `dsh-ops/lib/components/*/package.json` uses.

The two components keep their existing structure: `MemorySection` and `IdentitySection` each gained a thin framed wrapper and their runtime face moved from `PropsRuntime<'settings.section'>` to `PropsRuntime<'main'>`; the page bodies (tabs, controllers, RPC faces, styles) are unchanged.

## Alternatives considered

**Keep `settings.section`.** Rejected: no rail entry, no room for the page the next wave needs, and the settings column is not the place the host's own plugins put management surfaces.

**One panel with an Identity tab.** Rejected: rendering `IdentitySection` inside `MemorySection` means reproducing the slot renderer's inject-face transformation (`hooks` → `useX` props) by hand, or declaring a child slot under `main`; both add machinery whose only payoff is saving one rail icon. Two panels reuse both components untouched.

**Dual-home, like skills-manager** (keep the Settings section and add the panel). Rejected: two shells to keep in sync and duplicate registration tests, for a configure-nothing surface. skills-manager can afford it because its settings section is real configuration; these two were never configuration.

**Move configuration into the panel too.** Rejected: `plugins.bundle.config` is the host's configuration contract and `dsh-context` keeps its configuration there as well; the panel's intro line points at the Plugins tab instead.

**Gate the panels on the settings wire** (`ctx.configForms.whileServed`), the first cut. Rejected by the live install: the wire serves volatile namespaces only, and the entries had none, so both the panels and the configuration page vanished without an error. Navigation must not depend on the configuration transport.

**Keep every config field ordinary and let a fiber restart refresh the editors.** Rejected: the host's settings forms only edit volatile fields, so no editor would ever appear. Marking the fields volatile is what makes the pages visible at all.

**Ship the multi-row bundle without per-row package identities.** Rejected by the live install: the scanner rejects the ambiguous package and skips the client half silently — the second reason the pages never appeared.

## Consequences

- Settings → Memory / Identity disappear; the rail gains two icons (orders 30/31: after the context panel's 20, before ssh's 40). The identity panel is read-only governance, unchanged in behavior.
- The bundle's configuration page now composes and edits live; mount-time knobs (backend, caps, seed directory) still restart their entry, and `identitySeedDir` is therefore no longer on the settings page.
- `dsh.client.inject` is unchanged: the two slot-host packages (`@deepseek-ai/dsh-client-ui-layout`, `@deepseek-ai/dsh-client-ui-sidebar`) are devDependencies and type-only imports for the SlotMap merge, so they add no runtime require — the inject list stays informational, as the manifest contract says.
- The host composes the new rows immediately on install and pushes the client graph to a connected page; a fresh page load is the fallback, never a restart.
- The client registration contract now has its own test (a recording slot registry pins the key/id pairing and asserts no `settings.section` registration remains), and `tests/live-config.spec.ts` pins the volatile markers, the live-ref resolvers, and the store's live settings read; the jsdom suites still mount the components directly and never prove slot wiring.
- Bought: management sits in the navigation the other plugins use, the next wave's UI lands inside the panel instead of a migration, settings are actually editable again, and one shell less to maintain.

## Testing

`npm run build` (host `tsc` + client type gate + esbuild bundle) and `npm run test` (1102 tests, including `tests/client-registration.spec.ts`, `tests/live-config.spec.ts`, and the review runtime-state spec), then an isolated `dsh web` profile carrying this bundle: the boot graph lists `@chenhw7/dsh-memory/client.js`, a headless Chrome run shows both rail icons, the Memory page's three tabs, the Identity page, and all five configuration sections with live values; the same install was then applied to the live desktop host, where the slots and the configuration page occupied their seats without a restart.
