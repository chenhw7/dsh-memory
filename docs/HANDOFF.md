# Handoff: dsh-memory Plugin — Remaining Client UI Integration Work

## Context

This is a handoff for the `@chenhw7/dsh-memory` plugin (`/home/chenhw7/dsh-memory`), a long-term memory subsystem for the DeepSeek Harness (`~/deepseek-harness`). All 14 TODO items (P0+P1+P2) have been implemented and committed. 258 tests pass. The plugin's core functionality (storage, retrieval, extraction, context injection, tools, audit, dedup+LLM judge, lifecycle, observability, scanner hardening, conflict detection) is fully working and verified end-to-end in a real dsh environment.

The **remaining work** is purely client-side UI refinement for §3.8 (Memory Management UI). The host-side `@Remote` service works (health/list/add verified via curl), the client bundle is discovered in the boot graph, and the `settings.section` slot registers successfully. What's left is making the UI render correctly.

## Current State of Client UI Integration

### What works
- **Boot graph discovery**: `@chenhw7/dsh-memory` appears as entry #43 in `window.__DSH_BOOT__` with URL `/plugins/@chenhw7/dsh-memory/client.js` (HTTP 200)
- **Client bundle loads**: The esbuild-built `lib/client/index.js` in `window.__ModuleLoader__.load({id, factory})` format executes successfully in the browser
- **settings.section slot registers**: A "nav" button appears in the Settings dialog navigation (alongside General, Models, Plugins, Agent presets)
- **@Remote host service**: `memoryRemote/health`, `memoryRemote/list`, `memoryRemote/add` all return correct data via the Typert Gateway

### What needs fixing (3 items)

#### 1. i18n labels show as "nav" instead of "Memory"

**Problem**: The `settings.section` registration uses `label: () => ctx.locale.bind(NS)('nav')` where `NS = 'settings.memory'`, but no locale dictionary is registered for the `settings.memory` namespace. The label falls back to the raw key "nav".

**Fix**: Register locale dictionaries in `src/client/index.ts` `apply()`:
```ts
ctx.effect(() => ctx.locale.register('settings.memory', {
  en: { nav: 'Memory', title: 'Memory Management', /* ... */ },
  zh: { nav: '记忆', title: '记忆管理', /* ... */ },
}), 'dsh-memory: locale dictionaries')
```
Follow the pattern in `ui-agent-preset/src/client/locales.ts` (import `en`/`zh` objects, register in `apply`).

**File**: `/home/chenhw7/dsh-memory/src/client/index.ts`
**Also update**: `/home/chenhw7/dsh-memory/src/client/MemorySection.tsx` and `MemoryPluginCard.tsx` (their `t()` calls will resolve once the dictionary is registered)

#### 2. `ctx.remote.memory` is undefined in the client component

**Problem**: The `MemorySection` component calls `ctx.remote.memory.list(...)` but `ctx.remote.memory` is undefined at runtime. The hand-written `TYPERT_REMOTE` in `src/typert.remote-client.js` provides the descriptors, but the client-side type augmentation (`TypertRemoteNamespaceMap['memory']`) is not merged because the `.d.ts` file doesn't declare the module augmentation.

**Fix**: Add the module augmentation to `src/typert.remote-client.d.ts`:
```ts
import type { TypertRemoteContribution, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    memory: {
      list: (request: { scope?: string; limit?: number }) => Promise<RemoteResult<{ entries: unknown[]; total: number }>>
      // ... all 9 methods
    }
  }
}

declare const TYPERT_REMOTE: TypertRemoteContribution
export default TYPERT_REMOTE
```

Also verify the `inject` array in `src/client/index.ts` includes `'remote'` and `'remote.memory'` (or just `'remote'` — check how `ui-cordis` does it: it lists `'remote'` and `'remote.dynamicCordisRunner'`).

**Files**:
- `/home/chenhw7/dsh-memory/src/typert.remote-client.d.ts` (add module augmentation)
- `/home/chenhw7/dsh-memory/src/client/index.ts` (verify inject includes the remote namespace)

#### 3. `settings.plugin.item` card doesn't appear in Plugins tab

**Problem**: The `MemoryPluginCard` registered under `settings.plugin.item` with `key: 'memory'` doesn't appear in Settings → Plugins → Plugin configuration. The Plugins tab uses `ConfigurablePluginsTabController` which reads from `ctx.settingsScope.describe()` to list available namespaces. The `memory` namespace must be **described** (visible in the settings describe mirror) for the card to appear.

**Fix**: Verify that the `memory` settings namespace is correctly registered by `memory-context` (the `installSettingsSection` call in `src/context/index.ts`). The namespace should appear in the settings describe response. If it doesn't, the Plugins tab won't show a card for it. Check via:
```bash
curl -s -X POST http://127.0.0.1:10026/api/settings/describe \
  -H "Content-Type: application/json" \
  -d '{"type":"client-request","rpcId":"test","method":"settings/describe","payload":{"args":{}}}' | python3 -m json.tool | grep memory
```

If the namespace is described but the card still doesn't show, the `key` in the `settings.plugin.item` registration may need to match exactly. Check `packages/client/ui-settings-plugins/src/client/slot-contract.ts` for the keyed slot contract.

**Files**:
- `/home/chenhw7/dsh-memory/src/client/index.ts` (verify `key: 'memory'` matches the settings namespace name)
- `/home/chenhw7/dsh-memory/src/client/MemoryPluginCard.tsx` (verify the card component renders correctly)

## Build & Test Commands

```bash
# Build (tsc + fix-imports + esbuild client bundle)
cd /home/chenhw7/dsh-memory && npm run build

# Run tests
npm test

# Real API judge tests (optional)
JUDGE_API_BASE=https://fuyao-ai-gateway.xiaopeng.link/v1 \
JUDGE_API_KEY=<key> \
JUDGE_API_MODEL=fuyao-coding-exp \
npm test

# Start dsh for browser testing
cd ~/deepseek-harness
pkill -f "apps/cli/src/bin.ts" 2>/dev/null; sleep 3
node --import tsx/esm apps/cli/src/bin.ts --profile web --no-open --port 10026 &
sleep 15
# Check boot graph for @chenhw7/dsh-memory
curl -s http://127.0.0.1:10026/ | python3 -c "import sys,re,json; html=sys.stdin.read(); m=re.search(r'__DSH_BOOT__\s*=\s*({.*?})\s*</script>',html,re.DOTALL); d=json.loads(m.group(1)); print([e['id'] for e in d['entries'] if 'memory' in e['id']])"

# Test @Remote endpoints
curl -s -X POST http://127.0.0.1:10026/api/memoryRemote/health \
  -H "Content-Type: application/json" \
  -d '{"type":"client-request","rpcId":"t1","method":"memoryRemote/health","payload":{"args":{}}}'
```

## Key Files

| File | Purpose |
|---|---|
| `src/client/index.ts` | Client plugin entry: registers `settings.section` + `settings.plugin.item` slots |
| `src/client/MemorySection.tsx` | Full memory management page (CRUD + activity panel) |
| `src/client/MemoryPluginCard.tsx` | Compact card for Plugins tab (memory settings) |
| `src/typert.remote-client.js` | Hand-written `TYPERT_REMOTE` contribution (9 method descriptors) |
| `src/typert.remote-client.d.ts` | Type declaration for the contribution (needs module augmentation fix) |
| `src/remote/index.ts` | `MemoryRemoteService` — host-side `@Remote` service with `apply()` |
| `scripts/build-client.cjs` | esbuild-based client bundle builder → `lib/client/index.js` |
| `scripts/fix-imports.cjs` | Post-build: rewrites `.ts` imports to `.js` + copies typert artifacts |
| `cordis.patch.yml` | 6 rows: memory-root (no-op for scanner) + store/tool/review/context/remote-service |
| `tsconfig.json` | Excludes `src/client` from tsc (esbuild builds it separately) |

## Host Repo Changes (already committed in ~/deepseek-harness)

| File | Change |
|---|---|
| `pnpm-workspace.yaml` | Added `../dsh-memory` as workspace member |
| `packages/api/remotes/src/client/index.ts` | Import + mount `memoryRemote` contribution |
| `packages/api/remotes/package.json` | Added `@chenhw7/dsh-memory` to peerDeps + devDeps |
| `packages/client/connection/src/index.ts` | Pinned `memoryRemote.add/update/remove/pin` to PRIVILEGED_METHODS |

## Precedent Patterns to Follow

- **ui-agent-preset**: `packages/client/ui-agent-preset/src/client/index.ts` — settings.section registration + locale dictionary registration pattern
- **dsh-message-feedback**: `packages/feedback/message-feedback/src/index.ts` — `@Remote` service class pattern (closest CRUD analog)
- **dsh-goal**: `packages/goal/goal/src/index.ts` — `GoalService extends TypertRemoteService`
- **ui-cordis**: `packages/extensions/ui-cordis/src/client/index.ts` — `ctx.remote.*` calling pattern from client side

## Suggested Skills

- `control-browser` — for browser-based UI verification after fixes
- `implement` — for implementing the remaining fixes
- `code-review` — for reviewing the final client UI integration
