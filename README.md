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

### From GitHub (no npm publish required)

```sh
dsh plugin --profile web add github:chenhw7/dsh-memory
```

pnpm ≥10 blocks a git dependency's `prepare` (build) script until allowed, so the first `add` fails with a hint. Copy the exact key pnpm prints into the profile's `pnpm-workspace.yaml` and re-run:

```yaml
allowBuilds:
  @chenhw7/dsh-memory: true
```

Then re-run the `add`. Pin a commit (`github:chenhw7/dsh-memory#<sha>`) so a later push cannot silently change what runs.

### From a local checkout

```sh
git clone https://github.com/chenhw7/dsh-memory.git
cd dsh-memory
npm install && npm run build
dsh plugin --profile web add file:.
```

### From a tarball (no build permission needed)

```sh
npm pack              # produces chenhw7-dsh-memory-0.1.0.tgz with built lib/
dsh plugin --profile web add ./chenhw7-dsh-memory-0.1.0.tgz
```

## Verify

```sh
dsh --profile web --dump-config | grep memory   # shows the four memory rows
dsh web                                          # start; settings UI shows the memory namespace
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
