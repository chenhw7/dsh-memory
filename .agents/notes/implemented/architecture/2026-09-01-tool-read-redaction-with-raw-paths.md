# Agent Note: Display layers redact blocked payloads; raw reads are explicit and audit-logged

Status: implemented

English | [中文](2026-09-01-tool-read-redaction-with-raw-paths.zh.md)

## Problem

The write-time scanner rejects new payloads, but already-stored content predating a rule update only met `redactBlocked` on the prompt-injection faces. The model-facing tool projections (`toEntryJson` in `src/tool/index.ts`, `formatEntryLine`) and the management-UI remote projection (`toEntryJson` in `src/remote/index.ts`) returned stored content verbatim — a blocked payload re-entered the model's context through `memory_search`/`memory_list`/`memory_get`, and the UI displayed it as-is. Redacting both faces without an escape hatch would leave a blocked entry permanently unreadable, turning a security hardening into a repair dead-end: neither the human nor the model could see what `memory_replace` needs to overwrite.

## Decision

Display redaction with two explicit, audited raw paths, landed together:

- **Redaction at both display faces.** The tool projection and the remote entry projection now run `redactBlocked` over `content` and `summary`; the tool line formatter redacts its render input. Blocked payloads surface as `[BLOCKED: …]` everywhere a consumer reads an entry.
- **Model-side raw path.** `memory_get` gains `raw: true` — same projection without redaction, intended solely to recover the original text before repairing the entry with `memory_replace`. The store appends a `readRaw` audit record (`source: 'ui'`) per call.
- **UI raw path.** A new `getRaw` `@Remote` method wraps the store's `getRaw`; the settings-UI inline editor fetches the unredacted content when it opens, so a blocked entry can be read and fixed instead of editing the placeholder. The same `readRaw` audit record applies.
- **Store contract.** `MemoryStore.getRaw(id)` defaults to a no-op returning `undefined` (same precedent as `markRecalled`), so providers without raw support stay conformant. `AuditOp` gains the `readRaw` kind; the durable audit schema accepts it.

## Alternatives considered

- **Redact without any raw path.** Rejected: a blocked entry becomes an opaque `[BLOCKED: …]` row the human can delete but never fix, and `memory_replace` loses its readable target.
- **Serve raw text through a new memory tool.** Rejected: an extra model-visible tool widens the tool surface for a rare operation; a parameter on `memory_get` keeps the tool count stable and the intent explicit at the call site.
- **Leave the UI unredacted (human trust).** Rejected: the settings UI renders into the browser session; a blocked payload belongs behind the placeholder there too, with the raw text one explicit click away.

## Consequences

- Every raw read is visible in the audit log next to the mutations — a `readRaw` record proves someone recovered a blocked payload.
- `getRaw` returning an entry to the model does not bypass any scanner: redaction is display-only, and writing repaired content re-enters through the same scan gates.
- The `readRaw` op must stay in sync across the audit schema, `AuditOp`, and the client-mirrored `AuditOpJson`; a raw-read test at the store, remote, and tool layers pins each.
