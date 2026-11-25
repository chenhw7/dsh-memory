# Agent Note: Governance parity, measured accounting, and the panel's diagnostics

Status: implemented

English | [中文](2026-11-25-governance-parity-and-measured-accounting.zh.md)

## Problem

Three defects shared one shape: a surface that looked finished while silently doing less than it claimed.

1. **The assistant acknowledged "remember this" without writing it.** The injected `<memory-policy>` taught search and scope routing but never told the model to *write*, and the extraction pipeline only ran at ten accumulated candidates. A single "记住我的名字叫X" in a fresh session therefore produced one candidate that never crossed the threshold: nothing was stored, and nothing reported that. My own reproduction confirmed the write path itself was healthy (`memory_add` persisted and the digest fence appeared) — the hole was guidance plus gating.
2. **`confirmBeforeWrite` covered writes only.** Additions and edits queued proposals; `memory_remove`, `memory_forget`, `memory_pin`, and `memory_unpin` mutated the store immediately. The one setting whose promise is "no mutation without a human yes" governed exactly the harmless half, and a model could delete entries a human meant to keep.
3. **Operationally the plugin was unobservable where it mattered.** Reads (searches, injections, extraction calls, usage hits) write no audit row, so a store searched every turn looked idle on the dashboard; and the audit table spent its 200-row cap on `markHits` records — reads logged as `update` writes with unchanged content — pushing real mutations out.

## Decision

**The policy states the write, and one explicit request is enough to extract.** `MEMORY_POLICY_TEXT` now says remembering is part of the job: on an explicit request or a stated durable preference/correction, call `memory_add`/`memory_replace` in the same turn, one fact per entry, search first to replace rather than duplicate. The accumulator marks an explicit remember request `strong` and the drain fires when `unprocessed.length >= threshold` **or any candidate is strong**; preferences and corrections stay threshold-gated. The signal library also grew the missing middle: a `preference` class (我喜欢 / 我习惯 / 一律用 / I prefer / always use / our convention) — the most common way a preference actually reaches a conversation — and the correction phrasings that revise a specific statement (`不是…而是`, `改成`, `instead of`).

**A correction carries its referent.** The projection state keeps the last assistant message text (≤300 chars) and attaches it as `context` to a correction candidate; the review prompt quotes it as `revises assistant: …` and the system prompt says to extract the corrected fact, never the superseded one. "不对，用 pnpm" is uninterpretable otherwise — the model saw only the denial and had to guess what was denied.

**Every proposal carries an `action`, and adoption dispatches on it.** `SuggestionAction` is `add | update | remove | pin | unpin`; absent means the legacy inference (`update` with a target, `add` without). Both `DomainMemoryStore` and `SqliteMemoryStore` persist `action` (SQLite adds the column on open when migrating older tables) and dedup targeted proposals by `(targetEntryId, effectiveAction)` so a removal never collapses into an edit for the same entry. `adoptSuggestion` applies the store operation the action names, so the lifecycle verbs ride the same queue, the same `source: 'ui'` audit path (with `remove` taking an optional `source`), and the same human gate as writes; `suggestAdopt` confirms queue consumption and returns `found: true` for lifecycle proposals. The tool surface routes `memory_remove`, `memory_forget`, `memory_pin`, and `memory_unpin` through `observeSuggestion` (redacting target content via `redactBlocked` so legacy scanner-blocked entries remain removable) when `confirmBeforeWrite` is on and reports `pending: true`; a topic sweep becomes one removal proposal per matched entry, still under the batch ceiling.

**Budget is charged for calls actually made.** `hasBudget` is a pure pre-check; `chargeBudget(session, calls)` runs after a run reports its own `ExtractionRunStats.llmCalls`, counted at each seam (two review prompts, the flush prompt, the consolidation pass, the legacy per-pair judge). A transient failure now charges nothing and a run that needed the judge is charged for it, replacing the old one-unit-per-trigger estimate.

**Read activity is counted, not audited.** `reportMetric(site, amount)` sits beside `reportFailure` (same no-op default, same fire-and-forget discipline) and feeds `health().metrics`: `tool.search`, `tool.searchFallback`, `autoRecall.steps`/`hits`, `digest.emitted`, `extract.calls`, `usage.hits`, `flush.compaction`/`dispose`, `curator.passes`. `markHits` stops appending an audit row — a hit changes neither content nor status, so the audit table's cap belongs to real mutations, and it rises from 200 to 500 now that hits no longer consume it.

**One activity clock for decay and eviction.** `lastActiveTimestamp` (in `store/decay.ts`) reads the newest of `createdAt`, `updatedAt`, `lastRecalledAt`, `lastHitAt`. Reading only `lastRecalledAt ?? createdAt` decayed entries a user had just edited and evicted them ahead of quieter ones.

**The panel gains the diagnostics and the write surface it was missing.** Overview adds the operation counters and the swallowed-failure list — the difference between "nothing happened" and "something failed quietly". A fourth tab shows the mutation trail, filterable by `op` and `source`, loaded on first open rather than on landing. Manage gains a create form writing through the same host `add` path (scanner gates, `source: 'ui'`, optional category and summary). Review rows badge what adoption does, so a removal proposal cannot be mistaken for an addition.

**Two storage caps moved to `store/limits.ts`.** The SQLite backend defaulted to its own literal `200` while the JSON backend used the constant; one module now owns both numbers so they cannot drift again.

## Alternatives considered

**Rely on the tool description alone instead of the injected policy.** Rejected by the reproduction: the tool was registered and callable the whole time, and the model still answered in prose. Guidance that the write is mandatory belongs in the always-injected policy, not in a description the model may never read.

**Let extraction fire on every signal.** Rejected: an LLM call per message is a cost the threshold exists to bound. The strong/weak split keeps the funnel cheap for ordinary chatter while making an explicit request act immediately.

**Gate destructive verbs by refusing them in confirm mode.** Rejected: refusing tells the model "no" without telling the human "this was requested", and the request is exactly what the reviewer needs to see. A removal proposal carries the entry's content, so adopting it is an informed decision.

**Count LLM calls with a module-level counter.** Rejected: two sessions draining concurrently would misattribute calls. The counter travels with the run as an optional parameter, so it is per-run by construction.

**Keep hits in the audit table and raise the cap.** Rejected: it scales the noise instead of removing it. A hit is a reading signal; the audit table's job is mutations with before/after content.

**Put the create form behind a confirm dialog.** Rejected: the form is a human action on a human surface, and the scanner plus the queue already gate anything risky. One extra click would only teach people to click through.

## Consequences

- Asking the assistant to remember something now writes it in that turn; one explicit request triggers extraction on its own, and corrections land as the corrected fact.
- `confirmBeforeWrite` finally matches its promise for the whole tool surface. Two consequences to expect: a model-issued removal now requires a human, and the queue can carry non-content proposals (their rows render the target entry's content).
- The dashboard distinguishes activity from mutation, and a silent background failure names itself.
- `markHits` no longer grows the audit table; existing installs keep their old hit records until the cap trims them (no migration).
- Decay and eviction agree on what "recent" means, so edited or echoed entries survive their window.
- Costs: the policy block grew by ~5 lines of injected text (≈60 tokens), each proposal row carries one more optional field, and the client learned two RPCs (`add`, `auditLog`) plus two new request fields.

## Testing

`npm run build` green; `npm run test` **1136 passed / 6 skipped** (`judge-real-api` self-skips without `DEEPSEEK_API_KEY`). New coverage: `tests/decay-clock.spec.ts` (activity clock, decay and eviction ordering), the governance-parity block in `tests/tools-confirm-and-window.spec.ts` (remove/forget/pin/unpin queue, redacted removal proposal for blocked content, and direct mutation on both settings), `tests/suggestions.spec.ts` (`(targetEntryId, action)` dedup separation, `'ui'` removal audit, and SQLite column migration), `tests/remote-service.spec.ts` (`suggestAdopt` lifecycle round-trip and UI deletion audit), the drain/budget block in `tests/review-hot-reload.spec.ts` (one strong candidate drains below threshold, a weak one waits, two calls charge two units, a failed call charges none), the signal-class block in `tests/accumulator.spec.ts` (strength, preference class, correction context), and the jsdom additions in `tests/memory-section.client.spec.tsx` (counters and failures panels, audit tab load + filter reload + mutation refresh + race protection, non-editable lifecycle proposals, create form write and host rejection display). Live: an isolated `dsh web` profile carrying this bundle renders the fourth tab, the counters, the audit filters, and writes a real entry through the form in headless Chrome.
