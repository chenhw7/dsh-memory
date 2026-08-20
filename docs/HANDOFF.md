# Handoff: dsh-memory Plugin — Remaining Client UI Refinement

## Status Summary

All 14 TODO items (P0+P1+P2) implemented. 258 tests pass. Core plugin functionality fully verified in real dsh. Client UI integration partially verified — the "Memory" nav button appears in Settings, the section slot registers, and the client bundle is in the boot graph.

## What's Fixed (commit `9a454d7`)

1. **i18n labels** — `src/client/locales.ts` with en/zh dictionaries registered via `ctx.locale.register('settings.memory', ...)`. Settings dialog now shows "Memory" instead of raw key "nav". ✅ Verified in browser.

2. **Typert module augmentation** — `src/typert.remote-client.d.ts` now declares `TypertRemoteNamespaceMap['memoryRemote']` with all 9 method signatures. The client type system recognizes `ctx.remote.memoryRemote`.

3. **Inject array** — Removed `'remote.memoryRemote'` from `inject` (caused boot failure: "pending waiting for service: remote.memoryRemote"). The namespace service is created by `$mount` at runtime, not available at fiber activation time. Kept `'remote'` only.

4. **Namespace name** — Fixed `ctx.remote.memory` → `ctx.remote.memoryRemote` in `MemorySection.tsx` and `index.ts` (matching `super(ctx, 'memoryRemote')` on the host side).

## What Still Needs Work

### A. Memory section renders blank when clicked

**Symptom**: Clicking "Memory" in Settings nav shows an empty panel (no content, no error).

**Cause**: `ctx.remote.memoryRemote` is `undefined` at runtime when `MemorySection`'s `apply()` runs. The `remote.memoryRemote` namespace is created by `ctx.remote.$mount(memoryRemote)` in `dsh-api-remotes`'s `apply()`, but our plugin's `apply()` may execute before the mount completes. The `sectionInjected` factory captures `ctx.remote.memoryRemote` at registration time, not at render time.

**Possible fixes**:
- **Lazy access**: In `MemorySection.tsx`, access `ctx.remote.memoryRemote` lazily inside the component's render/useEffect, not in the `sectionInjected` factory. Pass `ctx` or a getter instead of the resolved namespace.
- **Wait for mount**: Use `ctx.remote.$mount()` callback or a subscription to know when `memoryRemote` is available.
- Check how `ui-cordis` handles this — it accesses `ctx.remote.dynamicCordisRunner` directly in handlers (called after mount), not in the factory.

**Key file**: `src/client/MemorySection.tsx` — the `sectionInjected` factory should return a getter or the component should access the remote lazily.

### B. Memory plugin card doesn't appear in Plugins → Plugin configuration

**Symptom**: Plugins tab shows Shell, Agent loop, Web search — no Memory card.

**Cause**: The `settings.plugin.item` keyed slot with `key: 'memory'` is registered, but the `ConfigurablePluginsTabController` (in `ui-settings-plugins`) only shows cards for namespaces that appear in the settings describe mirror. The `memory` settings namespace must be visible in `ctx.settingsScope.describe()` for the card to appear.

**Diagnostic**: Check if the `memory` namespace appears in the settings describe response:
```bash
curl -s -X POST http://127.0.0.1:10026/api/settings/describe \
  -H "Content-Type: application/json" \
  -d '{"type":"client-request","rpcId":"test","method":"settings/describe","payload":{"args":{}}}' | python3 -m json.tool | grep -i memory
```

If it doesn't appear, the `memory-context` plugin's `installSettingsSection` may not be registering the namespace in a way the client describe mirror can see. Check `src/context/index.ts` `installSettingsSection` call.

If it does appear but the card still doesn't show, the `key` in `settings.plugin.item` registration must match the namespace name exactly. The existing cards use `key: 'shell'`, `key: 'agent-loop'`, `key: 'web-search-deepseek'` — check `packages/client/ui-settings-plugins/src/client/index.ts` for the exact key format.

**Key files**: `src/client/index.ts` (the `settings.plugin.item` registration), `src/client/MemoryPluginCard.tsx`

## Build & Test Commands

```bash
cd /home/chenhw7/dsh-memory
npm run build    # tsc + fix-imports + esbuild client bundle
npm test         # 258 tests

# Start dsh for browser testing
cd ~/deepseek-harness
pkill -f "apps/cli/src/bin.ts" 2>/dev/null; sleep 5
node --import tsx/esm apps/cli/src/bin.ts --profile web --no-open --port 10026 &
sleep 20
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:10026/
```

## Key Files

| File | Purpose |
|---|---|
| `src/client/index.ts` | Client plugin entry: locale registration + slot registrations |
| `src/client/MemorySection.tsx` | Full memory management page (CRUD + activity panel) |
| `src/client/MemoryPluginCard.tsx` | Compact card for Plugins tab (memory settings) |
| `src/client/locales.ts` | en/zh i18n dictionaries for settings.memory namespace |
| `src/typert.remote-client.js` | Hand-written TYPERT_REMOTE contribution (9 descriptors) |
| `src/typert.remote-client.d.ts` | Module augmentation for TypertRemoteNamespaceMap |
| `scripts/build-client.cjs` | esbuild client bundle builder → lib/client/index.js |
| `cordis.patch.yml` | 6 rows: memory-root + store/tool/review/context/remote-service |
