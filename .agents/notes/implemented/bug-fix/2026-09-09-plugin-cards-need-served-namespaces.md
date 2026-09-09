# Agent Note: Plugin cards need a served settings namespace each

Status: implemented

## Problem

The bundle's client registered five cards into `settings.plugin.item`, but only two ever rendered in the live console's Plugin configuration: *Memory* and *Automatic Extraction*. The *Project Notes*, *Auto Recall*, and *Identity* cards (the identity card was this branch's new surface) were silently missing — the plugins tab showed no trace, no error, and the console logs stayed clean. The five-cards claim in the README and the client header had never been true on the installed harness line: the root cause predates the identity layer.

The mechanism: the harness's plugins tab dispatches `settings.plugin.item` **one card per served settings namespace** — a card renders only when its slot key names a namespace the Host registered (`served.has(entry.options.key)` over the `settings.describe` mirror, `ui-settings-plugins/src/client/tab-store.ts:89-91`; one `renderSlot` dispatch per namespace, `ConfigurablePluginsTab.tsx:37`; the keyed slot renders only the first entry matching the key, `ui-renderer/src/client/scoped-slots.tsx:800-806`). The bundle registered only two settings namespaces host-side (`memory`, `memory-review`) while keying three sub-cards `memory-notes` / `memory-autorecall` / `memory-identity` — all three bound to namespace `memory`. Keys that are not served namespaces are dropped silently: no error, no card, nothing in any log.

## Decision

One settings namespace per card. `memory-context` registers the full memory family host-side — four `installSection` calls (`memory`, `memory-notes`, `memory-autorecall`, `memory-identity`) — and every client card's slot key IS its namespace:

- **Schema fragments, one home per default.** The composition `Config` schema is composed from four shared field fragments (`INJECTION_FIELDS`/`NOTES_FIELDS`/`AUTORECALL_FIELDS`/`IDENTITY_FIELDS` in `src/context/index.ts`), and each namespace's schema reuses the same fragments — the composition layer and the four namespaces cannot drift.
- **The composition config stays one full shape.** `MemoryConfig` (now an intersection of four slice interfaces) remains the cordis composition config and the plugin's internal settings view; each namespace's `base` layer is a projection of it (`injectionEntry`/`notesEntry`/`autoRecallEntry`/`identityEntry`), and `current()` merges the four live scope sources back into the one `MemoryConfig` shape every consumer already reads. Composition keys keep their home (the `memory-context` row's `config:`), so existing `cordis.yml`/patch configs and the eval overlays keep working untouched.
- **Cross-namespace readers follow their keys.** The identity plugin reads `memory-identity` (via `resolveIdentitySettings`), the notes plugin reads `memory-notes` (via `resolveNotesSettings`), and `tool-memory` reads the identity gate/budgets from `memory-identity` — the same defensive `ctx.settings.get` pattern as before, only the namespace changed. `decayDays` stays in `memory` (the review janitor's read is untouched).
- **Client: the card keys already matched.** The client's `CARDS` entries now bind `ctx.settingsScope.bind({ namespace: card.key })` directly (the `namespace` override option is deleted — key and namespace are the same string for every card), and the curated `MemoryPluginCard`'s wire type/default draft drop the moved keys it never rendered.
- **Migration is a non-event.** A user document may still carry the moved keys under the `memory:` section from older deployments; schemastery objects pass unknown keys through (verified against the installed schemastery), so they resolve inertly and nothing fails at boot. No migration code.

## Alternatives considered

- **Collapse the three sub-cards into the curated Memory card.** Loses the documented per-card surface (the README's five-cards promise) and makes the Identity card — this branch's deliverable — unreachable. Rejected.
- **Relax the harness's dispatch rule** (render every registered entry, or drop the served-namespace pairing). The pairing is deliberate Host-side validation — a plugin this deployment did not compose must leave no trace in the plugins tab — and the harness repository is not ours to change. Rejected.
- **The identity plugin owns `memory-identity`.** It would fight two shipped constraints: the load-time seed-dir gate must live in `memory-context`'s apply (cordis swallows throws from `ctx.inject` callbacks — verified at runtime), and the identity plugin has no composition config of its own (the identity keys ride `memory-context`'s row), so the base layer would have nowhere to come from. `memory-context` owning all four namespaces keeps the settings ownership where the consumers are.

## Consequences

- All five cards render on the installed harness (dsh-v0.1.2-alpha.2); the regression is pinned by `tests/settings-live.spec.ts`: the four-namespace pairing test (`settings.describe()` must list every card key; the curated `memory` schema must no longer carry the moved keys), a live write to `memory-autorecall` arming the pre-step fence, and a live write to `memory-identity` arming the identity snapshot. The consumer-side namespace switches are pinned by namespace-aware settings fakes in the identity/notes/tool specs.
- The user document layout changes shape: `$DSH_HOME/settings.yaml` now keeps one section per namespace (`memory-notes:` etc.). Legacy `memory.notes*`/`memory.identity*`/`memory.autoRecall*` user keys resolve inertly (defaults win) — a deployment that had set them by hand re-pins them in the new sections.
- The settings-fakes convention in tests is now namespace-aware: a fake that answers every namespace with one object would have hidden exactly this class of bug, so the fakes key on the namespace they serve.
- The dispatch rule is recorded in [HOST_CONTRACT §8](../../../docs/HOST_CONTRACT.zh.md) so the next card cannot repeat the mismatch.

## Testing

`tests/settings-live.spec.ts` (three new cases under "plugin-card namespaces — one served namespace per card"), the namespace-aware fakes in `tests/identity.spec.ts`, `tests/notes.spec.ts`, `tests/tools.spec.ts`, `tests/tools-confirm-and-window.spec.ts`, and the full vitest suite (1047 cases) plus both tsc programs and the client bundle gate (`npm run build`).
