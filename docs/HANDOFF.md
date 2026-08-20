# Handoff: dsh-memory Plugin — Remaining Client UI Rendering

## Status

All 14 TODO items implemented. 258 tests pass. Core plugin fully verified in real dsh. Client UI integration: "Memory" nav button appears (i18n working), section slot registers, bundle in boot graph. The Memory section page renders blank — `ctx.remote.memoryRemote` returns undefined at component render time.

## Verified Working

- **Boot graph**: `@chenhw7/dsh-memory` is entry #43, served at `/plugins/@chenhw7/dsh-memory/client.js` (HTTP 200)
- **i18n**: Settings dialog shows "Memory" in navigation (en/zh locale dictionaries registered)
- **settings.section slot**: Registered and navigable
- **@Remote host service**: `memoryRemote/health`, `memoryRemote/list`, `memoryRemote/add` all work via curl

## Remaining Issue: Memory Section Renders Blank

**Symptom**: Clicking "Memory" in Settings → nav shows an empty panel.

**Root cause**: `ctx.remote.memoryRemote` is `undefined` when the `MemorySection` component renders. The `remote.memoryRemote` namespace is created at runtime by `ctx.remote.$mount(memoryRemoteContribution)` inside `dsh-api-remotes`'s `apply()`. However, the client-side `ctx.remote` object may not expose the `memoryRemote` property until the mount completes, and the component's `useEffect` fires before that.

**What's been tried**:
1. ✅ Fixed: Removed `'remote.memoryRemote'` from `inject` array (was causing boot crash)
2. ✅ Fixed: Changed `remote` to `getRemote()` lazy getter (no longer captured at registration time)
3. ❌ Still blank: `getRemote()` returns `undefined` — the `memoryRemote` property on `ctx.remote` doesn't exist yet

**Next steps to try**:
1. **Check if $mount ran**: Add a `console.log` in the esbuild bundle to verify `ctx.remote` has `memoryRemote` at render time. If the Typert `TYPERT_REMOTE` contribution isn't being mounted (wrong format?), the namespace will never appear.
2. **Verify the TYPERT_REMOTE format**: The hand-written `src/typert.remote-client.js` exports a `TypertRemoteContribution` object. Compare its exact shape with a generated one (e.g. `packages/feedback/message-feedback/lib/typert.remote-client.js`). The `descriptors` array format may not match what `$mount` expects — the `parameters[0].codec.schema` should be a real zod schema, not `.passthrough()`.
3. **Use a polling/retry pattern**: If `memoryRemote` appears after a delay, add a retry loop in `loadEntries` that waits for `getRemote()` to return non-undefined.
4. **Alternative: skip @Remote entirely** — Use the settings namespace directly for read-only config display (the `MemoryPluginCard` already does this via `settingsScope`), and defer the full CRUD UI to when the host Typert generator can properly generate the artifacts.

## Build & Test

```bash
cd /home/chenhw7/dsh-memory
npm run build    # tsc + fix-imports + esbuild client bundle
npm test         # 258 tests

cd ~/deepseek-harness
pkill -f "apps/cli/src/bin.ts"; sleep 5
node --import tsx/esm apps/cli/src/bin.ts --profile web --no-open --port 10026 &
sleep 20
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:10026/
```

## Key Files

| File | Purpose |
|---|---|
| `src/client/index.ts` | Client entry: locale registration + settings.section + settings.plugin.item |
| `src/client/MemorySection.tsx` | Full memory management page (lazy getRemote pattern) |
| `src/client/MemoryPluginCard.tsx` | Plugins tab card (uses settingsScope, not @Remote) |
| `src/client/locales.ts` | en/zh i18n dictionaries |
| `src/typert.remote-client.js` | Hand-written TYPERT_REMOTE (may need format verification) |
| `src/typert.remote-client.d.ts` | Module augmentation for TypertRemoteNamespaceMap |
| `scripts/build-client.cjs` | esbuild → window.__ModuleLoader__.load format |
| `cordis.patch.yml` | 6 rows including memory-root for scanner discovery |
