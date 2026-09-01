# Agent Note: Remote writes deny by default behind a deployment switch

Status: implemented

English | [中文](2026-09-01-remote-write-guard.zh.md)

## Problem

SEC-04's recorded channel was open end to end: the remote service carried no per-method guard, so any host the transport fence admitted — including a wide `trustedHosts` deployment admitting the whole LAN — could read and write memory from a same-network browser, and every written word re-enters the system prompt of later sessions. The trust boundary was transport-only, and the archived audit's mitigation ("tighten trustedHosts") was not actionable from this bundle.

## Decision

A deployment-level write switch on the remote service, denying by default:

- **`remoteWritesEnabled`** on `memory-remote`'s schemastery Config, defaulting to `false`. A deployment that wants browser-side management sets it in its `cordis.patch.yml` row; the default deployment (no config row) resolves to `false` through the same standard-validate interface the host resolves with — pinned by a test that validates `undefined` through the schema itself, so deleting `.default(false)` fails CI.
- **Seven write methods guard before touching the store**: `add`, `update`, `removeEntry`, `pin`, `archive`, `suggestAdopt`, `suggestReject`. A refused write returns the wire shape the method's own contract defines — `{ error: 'remote writes are disabled on this deployment' }` where the wire has an error field, the method's no-op form (`{ removed: false }` / `{ found: false }` / `{ rejected: false }`) where it does not. Reads (`list`, `search`, `get`, `getRaw`, `projects`, `auditLog`, `health`, `suggestList`) are untouched.
- **The client surfaces the refusal.** The management UI's action path reads the wire error through its existing `actionError` display, so a disabled deployment shows "remote writes are disabled on this deployment" instead of the previously misleading "entry was already gone".
- **The write-path integration suite opts in explicitly** (`remoteWritesEnabled: true` in its composition), because its subject is the write path itself.

## Alternatives considered

- **Per-request loopback checking inside the methods.** Not implementable: `trustedHosts` is host-side configuration this bundle cannot read, and the gateway passes no request headers or source information into `@Remote` invocations — a `local-only` policy would be an unverifiable promise, so the switch is honestly named as a boolean.
- **Throwing a transport-level error on refusal.** Rejected: the wire contract distinguishes transport failure (`result.ok === false`) from a handled refusal; throwing would misclassify a deliberate deployment setting as an outage and break the no-exception remote contract.
- **A settings-namespace toggle (hot-reloadable).** Rejected: this gate bounds a security surface; hot-reloading it invites loosening mid-session. Composition-time config keeps the change in the deployment file.

## Consequences

- A default deployment denies all browser-side memory writes; the model's own tools (which bypass the remote service entirely) are unaffected, so the agent-facing feature set is unchanged.
- An operator who wants the management UI fully functional sets `remoteWritesEnabled: true` in their deployment — a deliberate act recorded in the deployment file.
- The guard is deployment-level, not per-request: it cannot distinguish loopback from LAN callers. The residual exposure for an enabled deployment is exactly what SEC-04 recorded; the mitigations are tightening `trustedHosts` (host-side) and keeping the switch off where unneeded.
