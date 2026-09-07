# Agent Note: memory tool output schemas omitted the projected summary field

Status: implemented

English | [中文](2026-09-07-summary-undeclared-in-memory-tool-output-schemas.zh.md)

## Problem

The harness ToolRuntime validates every tool result against the tool's declared `output.schema` with `additionalProperties: false`, and fails the whole call (`INVALID_TOOL_OUTPUT`) on any undeclared property. Four of the five tools whose output carries the entry projection — `memory_search`, `memory_list`, `memory_get`, `memory_replace` — did not declare `summary`, while the projection (`toEntryJson`) emits it whenever an entry has one; `memory_add` declared it. Any of those four calls returning a summary-carrying entry therefore failed wholesale: `"value.entries[0].summary" is not a declared property (additionalProperties: false)`.

The failure shape hid it from every pre-existing lane. The mock eval model never calls tools (deterministic layer only). The unit/integration tests mount the same ToolRuntime — the validator would have fired — but their seeded entries carried no summaries. Standing injection reads the store through the context injector, not the tool layer, so session prompts stayed healthy. The write tools stored summaries fine; the first read after one failed. It surfaced only in the 2026-09-07 real-model judged run: the seed scenario's answers reported `memory_get`/`memory_search`/`memory_list` all failing ("因 schema 问题"), and the kept-home transcript of an aborted scenario shows the verbatim error from the turn after a model-added summary made the store non-empty — the model's retry variants then fed that turn's runaway loop.

## Decision

`summary: { type: 'string' }` is declared in all four entry-projection output schemas — the `entries` item objects of `memory_search` and `memory_list`, and the `entry` objects of `memory_get` and `memory_replace` — matching the existing `memory_add` declaration in name, type, and position. The projection is unchanged: `summary` still emits whenever present, and the declared schemas now cover every field the projection can emit (`id`, `scope`, `content`, `summary`, `createdAt`, `updatedAt`, `category`, `projectName`, `stale`, `superseded`, `importance`, `accessCount`).

## Testing

`tests/tools.spec.ts` gains `output schema covers the entry projection`: each of the four tools is driven through the real ToolRuntime over a seeded entry carrying every projected optional field, asserting the call resolves and the returned value carries `summary`. The suite is red on the unfixed tree (every case `isError: true` — the same runtime validation that failed in the eval session) and green after the fix; the full lane is **949 passed | 6 skipped (955)**. A real-mode rerun of the seed scenario (prog109, `/tmp/eval-real-prog109-postfix.json`) completes with standing hit 5/5, every answer judged 2/2, and no tool-failure language in the answers.

## Alternatives considered

- **Drop `summary` from the projection instead.** Rejected: the summary is the digest the index-mode fence tells the model to expand via `memory_get`; narrowing reads to satisfy a declaration bug degrades every read surface.
- **Relax `additionalProperties` on the entry schemas.** Rejected: strict result validation is the contract that catches undeclared wire fields — this bug is its proof; loosening the declared schemas would silence exactly this failure mode.
- **A structural schema-vs-projection equality test.** Rejected: `ctx.tools.schemas()` whitelists only `name`/`description`/`parameters`, so the output schema is not reachable there; driving the tools through the runtime's own output validation is both stronger and simpler.

## Consequences

- Real-model sessions can read non-empty stores again. Before the fix, a seed scenario (prewritten summaries) failed its first tool call, and any session that stored a summary lost its own memory reads from that point on — answering from the standing index alone.
- The four-against-one declaration asymmetry (add declared `summary`; the readers did not) is closed. A future projection field must be declared in every output schema that can carry it, and the all-fields regression test now forces that for the projected set.
- Judged baseline readings taken before this fix ran with degraded tool access; the 2026-09-07 slice in the [write-path rework note](../architecture/2026-09-04-write-path-rework-implementation-plan.md) states that condition wherever its readings are cited.
