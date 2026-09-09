# Agent Note: The eval prompt capture follows the harness system/message surface event

Status: implemented

English | [中文](2026-09-09-eval-prompt-capture-follows-system-message.zh.md)

## Problem

The harness rework that made the system prompt surface node 0 (harness `.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md`, merged 2026-09-06) removed `system` from the `request/header` event: `EpochHeader` became `{config, adapterDefaults?, tools?}` and the rendered prompt rides the new `system/message` surface event. The harness's own note promises that a reader expecting the old field "fails at compile time" — true for harness-typed consumers, but the eval suite reads the session-event stream across an untyped JSON-RPC wire (`SessionEventPayload` is `{type: string, data: Record<string, unknown>}`): `collectSessionEvent`'s `request/header` case read `.system` off a cast and got `undefined` on every turn, silently.

The M0 chain smoke failed with "no system prompt captured from turn 1 (request/header event missing)" — a message written from the old contract that misdirected the diagnosis: the event arrives fine; its payload no longer carries the prompt. The failure was proven pre-existing (byte-identical on `origin/main` in a detached worktree), and the plugin itself was healthy the whole time — the session log carried the `<memory-index>` fence intact inside the 6400-char `system/message` event.

## Decision

`collectSessionEvent` (`eval/harness/sdk-client.ts`) folds `system/message` instead: the turn collector's `systemPrompt` is `messageText(event.data.message)` — the same extraction the assistant path uses. An empty-content node (the harness's "no system prompt") reads as the empty string, not undefined, so the boot's standing-prompt fallback cannot carry a dead prompt past a prompt that became empty. Unchanged prompts emit no new event (the harness appends on first render and replaces node 0 on change), so `eval/boot.ts`'s existing `lastSystemPrompt` fallback — originally written for unchanged headers — carries the standing prompt across unchanged turns with no code change.

`HOST_CONTRACT.zh.md` gains §12 — the SDK session-event seam with its source evidence — and §10 checklist item 11: the seam has no type guard, so the checklist line ("run `npm run eval:smoke`") is the only defense against the next event-surface drift. The checklist's §11 back-reference was re-pointed to its item (10) in the same change; the checklist pointer in `AGENTS.md` had drifted to §9 and now names §10.

## Testing

`npm run eval:smoke`: red before (identical on the base tree), green after — both turns report the 6400-char prompt (turn 1 from the event, turn 2 from the standing fallback), the `<memory-index>` fence carries both seed facts, and the medium keeps both entries after dispose. The vitest suite is untouched (the change lives entirely in `eval/`, which no vitest lane compiles).

## Alternatives considered

- **Read both `request/header.system` and `system/message` for older-harness compatibility.** Rejected: the eval drives exactly one installed harness checkout — there is no version matrix to support, and the dual read is precisely the silent-drift shape this fix removes.
- **Type the session-event payloads against the harness's exported event union**, so a contract change breaks at compile time. Rejected: the smoke runs the built harness checkout while the installed npm peers can lag it; compile-time types from `node_modules` would assert a version the runtime may not match. The wire stays untyped by design; the §10 checklist item is the recorded mitigation.
- **Capture the prompt from request context rather than the event stream.** Not available: the session-event notification stream is the eval's only window into the child; request internals are not on the SDK surface.

## Consequences

- The M0 smoke and every eval mechanical measure reading `TurnResult.systemPrompt` (fence parsing, standing-hit booking, index coverage) are restored by the one capture point.
- The failure message now names the live contract ("system/message event missing"), so the next drift fails at the assertion instead of after a misdirected investigation.
- A harness change to either event shape still reaches this seam silently at runtime; the defense of record is HOST_CONTRACT §10 item 11 — the smoke runs on every harness bump.
