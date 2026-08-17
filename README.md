# @chenhw7/dsh-memory

Long-term memory for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), packaged as one installable profile bundle. Cross-session persistent memory — facts, preferences, corrections, and lessons survive across sessions and restarts.

This is a **self-contained single package** (not a multi-package workspace). It depends on dsh core services as **peer dependencies** (provided by the dsh installation you already have) and ships its own `cordis.patch.yml` so `dsh plugin add` activates it as one profile layer.

## What it does

Your dsh agent normally forgets everything when you close a session. This bundle fixes that:

- **Persistent memory** — facts, preferences, and conventions stored in a durable KV backend.
- **Three-layer scoping** — `global` (cross-project), `project` (per-repo, auto-detected), and `user` (cross-project profile).
- **Six model-facing tools** — `memory_search`, `memory_add`, `memory_replace`, `memory_remove`, `memory_list`, `memory_get`.
- **Automatic learning** — a projection accumulator watches the conversation and extracts candidate memories via lightweight rules, then runs an LLM extraction when enough candidates accumulate.
- **Compaction-aware flush** — when compaction shadows old context, the raw events are scanned for anything worth remembering.
- **Security scanning** — API keys, tokens, prompt-injection patterns, and exfiltration attempts are blocked from being saved.
- **Frontend-configurable** — all settings exposed through the dsh settings UI, apply live.

## Install

### Prerequisites

- The `dsh` CLI installed and on your PATH (`npx @deepseek-ai/dsh` or built from source).
- A profile you want to add memory to (this guide uses `web`).

### From GitHub (recommended)

pnpm >= 10 blocks a git dependency's `prepare` (build) script until you explicitly allow it, so installation is **two steps**:

**Step 1: allow the build script.** Edit your profile's `pnpm-workspace.yaml`:

```sh
# The file lives at ~/.dsh/profiles/web/pnpm-workspace.yaml
# (or $DSH_HOME/profiles/web/pnpm-workspace.yaml if you set DSH_HOME)
```

Add this section (merge with existing content if the file already has fields):

```yaml
onlyBuiltDependencies:
  - "@chenhw7/dsh-memory"
```

This grants permission for the package's `prepare` script (`npm run build`) to run on your machine at install time. Only allow packages whose source you trust, and pin a commit so a later push cannot silently change what runs.

**Step 2: install the plugin:**

```sh
dsh plugin --profile web add github:chenhw7/dsh-memory
```

Or pinned to a specific commit for reproducibility:

```sh
dsh plugin --profile web add github:chenhw7/dsh-memory#e295960
```

### From a local checkout

If you want to hack on the plugin, clone and build it first, then install from the local path:

```sh
git clone https://github.com/chenhw7/dsh-memory.git
cd dsh-memory
npm install && npm run build
dsh plugin --profile web add file:.
```

A `file:` install still runs `prepare`, so the same `onlyBuiltDependencies` allowance above is needed unless the `lib/` is already built (pnpm skips `prepare` when the entry points exist).

### From a tarball (no build permission needed)

If you'd rather not grant build-script permission, pack a tarball from a checkout with `lib/` already built, then install it -- a tarball install needs no `onlyBuiltDependencies` entry:

```sh
cd dsh-memory
npm install && npm run build
npm pack                    # produces chenhw7-dsh-memory-0.1.0.tgz
dsh plugin --profile web add ./chenhw7-dsh-memory-0.1.0.tgz
```

## Verify

After install, confirm the four memory rows are in the composed profile tree:

```sh
dsh --profile web --dump-config | grep memory
```

You should see four rows pointing at `@chenhw7/dsh-memory/*`:

```
- id: memory-store
  name: '@chenhw7/dsh-memory/store'
- id: tool-memory
  name: '@chenhw7/dsh-memory/tool'
- id: memory-review
  name: '@chenhw7/dsh-memory/review'
- id: memory-context
  name: '@chenhw7/dsh-memory/context'
```

Then start dsh and check the settings UI shows the `memory` namespace:

```sh
dsh web
```

## Configuration

All settings are editable from the dsh frontend settings page (the `memory` namespace) and apply live. They persist in `$DSH_HOME/settings.yaml`.

| Setting | Default | Meaning |
|---|---|---|
| `memoryMode` | `policy-only` | `full`: inject memory content + guidance. `policy-only`: inject guidance only, model searches on demand. `custom`: inject user-defined policy text. `off`: no injection. |
| `memoryPolicyCustomText` | — | Custom policy text used when `memoryMode` is `custom`. |
| `reviewEnabled` | `true` | Enable automatic periodic review extraction. |
| `reviewCandidateThreshold` | `10` | Number of candidate messages before an LLM extraction runs. |
| `flushOnCompaction` | `true` | Extract memories from shadowed events after compaction. |
| `flushOnDispose` | `true` | Extract remaining context when a session is disposed. |
| `memoryCharLimit` | `5000` | Per-scope character limit for injected memory content. |

## Architecture

The bundle inserts four rows over `dsh-base`, each pointing at this package's own export sub-path:

| Row | Export | Role |
|---|---|---|
| `memory-store` | `@chenhw7/dsh-memory/store` | Opens the `memory` domain, registers `ctx.memory` |
| `tool-memory` | `@chenhw7/dsh-memory/tool` | Six model-facing tools |
| `memory-review` | `@chenhw7/dsh-memory/review` | Automatic extraction (projection + flush) |
| `memory-context` | `@chenhw7/dsh-memory/context` | System-prompt injection + settings namespace |

**Storage**: this bundle does **not** insert `storage-json` / `storage-domain` rows. The `dsh-web-app` bundle already provides them (with the correct root path under `$DSH_HOME/storages`). Inserting them here would clobber that config (patches replace whole rows, last-write-wins). The memory store provider consumes the `storageDomain` service as a peer dependency.

### Headless profiles

`dsh-headless` does **not** ship a storage layer. To use this bundle with `dsh --profile headless`, add the storage rows to your profile's `cordis.patch.yml` (NOT this bundle's patch):

```yaml
# $DSH_HOME/profiles/headless/cordis.patch.yml
- insert:
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
```

## Known Limitations

- **No semantic/vector retrieval** — `memory_search` is substring matching over structured KV entries, not embeddings.
- **Extraction quality tracks the session model** — review/flush reuse the session's routed provider/model.
- **git install needs a build allowance** — pnpm ≥10 blocks the `prepare` script until you allowlist the package. Use a tarball or npm publish to avoid this.
- **dsh is in developer preview** — breaking changes are expected; this bundle's peer dependency ranges track the dsh release line.

## License

MIT
