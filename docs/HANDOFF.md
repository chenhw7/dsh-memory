# Handoff: dsh-memory Plugin — Typed Proxy + Settings Page (blank-page fix)

## Status

Settings → Memory renders and is functional via the **typed** `ctx.remote.memoryRemote`.
The plugin is self-contained: it works against the **currently-running dsh with
no host rebuild**, and remains correct after the host rebuild lands.

> The previous handoff marked this "RESOLVED" — that was wrong. The page was
> never verified in a browser; only the `/api` RPC was curl'd. The real blank-page
> cause (below) was present in every prior version.

## Two root causes of the blank page (both in all prior versions)

1. **Slot hook naming (the actual crash).** The slot renderer binds each
   `inject.hooks` source as `use<Capitalize(key)>`
   (`packages/client/ui-renderer/src/client/scoped-slots.tsx`:
   `hooks[\`use${name[0].toUpperCase()}${name.slice(1)}\`] = factory(...)`).
   The plugin registered `hooks: { rpc }` (and `getRemote`, and the card's
   `settingsScope`) but the components called `props.useMemorySection()` /
   `props.useMemoryPluginCard()` — keys that were never generated → `undefined`
   → `TypeError` on render → **blank section** (and a blank Plugins-tab card).
   Fix: name the hook key `memorySection` (→ `useMemorySection`); the card uses
   the generated `useSettingsScope`.
2. **`ctx.remote.memoryRemote` was undefined.** The host's
   `packages/api/remotes/lib/client.js` was a **stale build** (from before the
   memory contribution was wired into `src/client/index.ts`), so the api-remotes
   client assembly never `$mount`ed the namespace. See "Mount path" below.

## Mount path: the typed proxy is live two ways

The canonical owner is the **host build**: dsh-memory is an api-remotes project
reference, so the host client build inlines this package's `./remote`
TYPERT_REMOTE contribution into the `@deepseek-ai/dsh-api-remotes` client bundle,
whose assembly `$mount`s it at boot (`packages/api/remotes/src/client/index.ts`,
committed in 81ef0fdae3).

Until that host build ships (the running api-remotes bundle is stale), the
section **lazily self-mounts** the same contribution on first use — one-shot,
deferred to user interaction — so it can never race the host's boot-time
`$mount` (a duplicate `$mount` of an installed method throws and would fail
boot). In a current host build the namespace is always present by the time the
UI runs, so the self-mount path is never taken (a pure read).

Net: the page works with the **current** dsh (no host rebuild) **and** after
the host rebuild (where it becomes a no-op). `ctx.remote.memoryRemote` is the
real typed proxy in both cases — the gateway client (`packages/api/gateway/
src/client/index.ts`) provides `$mount` + the namespace proxy and builds the
wire `connection.rpc.call('/api', endpoint, { args })` from the descriptor.

## Wire format (unchanged; now owned by the gateway client's typed proxy)

`ClientRemoteService.invoke` builds `args` from the descriptor's parameters and
calls `connection.rpc.call('/api', 'memoryRemote/<method>', { args })`. For a
0-parameter method (`health`) `args` is `{}`. Host `invokeRpc` +
`assertExactArguments` require exactly the method's parameter wire names.
Result envelope: `{ ok: true, value: T } | { ok: false, error: {…} }`.

## Changes in this package (dsh-memory)

| File | Change |
|---|---|
| `src/client/index.ts` | `inject` uses `remote` (not `connection`); re-added the `@deepseek-ai/dsh-api-remotes/client` type import; `apply` is sync and defines `ensureMemoryRemote` (reads the namespace; self-mounts the TYPERT_REMOTE contribution lazily/once when absent); the section hook key is `memorySection` returning `{ ensure }`. |
| `src/client/MemorySection.tsx` | Uses `props.useMemorySection().ensure`; all 9 methods via the typed `MemoryRemote` proxy (`RemoteResult` envelope); keeps business-error surfacing for `add`/`update`. Removed the unused `SnapshotStore` import. |
| `src/client/MemoryPluginCard.tsx` | Uses the generated `useSettingsScope` hook (was `props.useMemoryPluginCard().hooks` — never generated). |
| `tsconfig.json` | `composite: true` (project-reference target for the host `tsc -b`). |
| `scripts/build-client.cjs` | Externals line restored to `@deepseek-ai/dsh-api-remotes/client`. |
| `src/typert.remote-client.js` | `health` descriptor `parameters: []` (kept; now actually mounted). |

## Host-side changes (deepseek-harness)

| File | Change | Status |
|---|---|---|
| `packages/api/remotes/tsconfig.client.json` | `+ { "path": "../../../../dsh-memory" }` (project reference; dsh-memory is a repo **sibling**) | applied to disk, **uncommitted** |
| `packages/api/remotes/src/client/index.ts` | imports + `$mount`s the contribution | committed (81ef0fdae3) |
| `packages/api/remotes/package.json` | `@chenhw7/dsh-memory` in peer/dev deps | committed |
| `pnpm-workspace.yaml` | `../dsh-memory` member | committed |
| `packages/client/connection/src/index.ts` | `memoryRemote.add/update/remove/pin` pinned to PRIVILEGED (loopback) | committed (stale bundle; rebuilt with the host build) |

> The project reference is **optional for a working page** (the plugin
> self-mounts). It only takes effect after a host client build, where it makes
> the canonical placement live and turns the plugin self-mount into a no-op.

## Verification

- Plugin build: `npm run build` ✅; bundle contains `ensureMemoryRemote` +
  `useMemorySection` + `useSettingsScope` + the lazy one-shot `$mount`.
- Plugin tests: `npm test` — 256–258 pass; **2 audit-store tests are a
  pre-existing flake** (`tests/integration/composition.spec.ts`: "caps audit
  records at 200" / "appends an audit record on update") — same-millisecond
  `ts` + random-uuid tiebreak in the trim sort; host-side domain code this task
  never touched. Reproducibly flaky across runs (pass/fail varies), not a
  regression.
- Live dsh on :10026 (no restart): the served `/plugins/@chenhw7/dsh-memory/
  client.js` is the **new** bundle (serveBundle reads from disk per request);
  `/api/memoryRemote/health` → `{ ok:true, value:{ totalEntries:17, … } }`;
  `/api/memoryRemote/list` → entries. Host side unchanged and intact.

## Remaining steps (user terminal — the sandbox here mounts the harness RO)

The plugin side is done and self-contained. To realize the canonical host
placement (optional) and to cache-bust the browser:

```bash
cd ~/deepseek-harness
npm run build:lib:client        # tsc -b (builds the new dsh-memory reference) + tsdown client face
# sanity: grep -c memoryRemote packages/api/remotes/lib/client.js   # > 0
#         grep -c memoryRemote packages/client/connection/lib/client.js
# restart dsh so the boot manifest recomputes revs (cache-bust):
#   (Ctrl-C the running `pnpm dsh web --port 10026`, then)
pnpm dsh web --port 10026
```

If you skip the host build entirely, the page still works (plugin self-mounts);
just restart dsh (or hard-refresh the browser) so the new plugin bundle/rev
loads.

## Key files

| File | Purpose |
|---|---|
| `src/client/index.ts` | Client entry: locale + `settings.section` + `settings.plugin.item`; `ensureMemoryRemote` lazy self-mount; `memorySection` hook |
| `src/client/MemorySection.tsx` | Memory management page (typed proxy, business-error aware) |
| `src/client/MemoryPluginCard.tsx` | Plugins-tab config card (`useSettingsScope`) |
| `src/typert.remote-client.js` | Hand-written TYPERT_REMOTE (now mounted: host build or plugin self-mount) |
| `cordis.patch.yml` | `memory-root` (scanner) + `memory-remote` (host @Remote service) |
