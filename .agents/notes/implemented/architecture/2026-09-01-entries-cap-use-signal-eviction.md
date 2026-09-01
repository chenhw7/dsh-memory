# Agent Note: The entries table caps at a configurable 500 with a use-signal eviction order

Status: implemented

English | [中文](2026-09-01-entries-cap-use-signal-eviction.zh.md)

## Problem

The entries table was the only unbounded one — audit and suggestions each capped at 200, entries grew with every accepted write. A runaway extraction loop or a chatty project grew the single JSON medium without bound: every recall stamp on a 50-hit search rewrote a file that only got bigger, and the durable format's migration pressure scaled with the largest store any machine had ever accumulated. The improvement program gated this item behind `importance-signal` because an eviction order needs a use signal; that prerequisite landed, so the order is definable rather than "recency only".

## Decision

- **`entriesCap`** on the store plugin's composition Config (schemastery, default **500**), evicting back to the cap after each successful `add` — suggestion adoption trims through the same choke point; `update` and `markRecalled` never evict (they change rows, not row counts). 500 sits far above the golden fixture and integration volumes and only below the JSON medium's real pressure zone; deployments with larger stores override the row config.
- **Eviction order: pinned never → ascending `accessCount` (absent = 0) → ascending `lastRecalledAt ?? createdAt`.** Pinned rows sort last and a pinned wall terminates the pass, so the cap is a soft target: a fully pinned table is left over the cap rather than deleting protected rows.
- **Audit attribution: `remove`/`janitor`.** `AuditSource` is a fixed enum on the durable record shape; the janitor source already names system-initiated lifecycle writes, and the store's own eviction is one of those. Eviction failures propagate to the `add` caller (awaited inline, same shape as `trimSuggestions`) even though the added row landed — recorded in the method's contract comment.

## Alternatives considered

- **Cap at 200 (the audit/suggestion precedent).** Rejected: 200 entries is inside normal active-use territory for a working memory; the cap must catch runaway growth, not normal accumulation.
- **Hard eviction of pinned entries when nothing else fits.** Rejected: pin is the user's explicit "never forget" — silently deleting it breaks the flag's contract. Allowing the over-cap state surfaces the condition instead of hiding it.
- **A new `AuditSource` value for eviction.** Rejected: the source is a fixed enum in the durable record schema; extending it changes the stored shape for an internal distinction consumers never needed.

## Consequences

- The unbounded-growth risk closes at the plugin layer; the remaining pressure (single-file rewrite cost per write) is the medium's recorded trade-off, migrated only by the `per-record`/SQLite backend choice.
- Users pinning more than `entriesCap` entries see writes evicting the newest unpinned additions — surfaced by the remove audit trail, and preventable by raising the row config.
- The eviction reuses the recall metadata, so the use signal now has a consumer end to end: `accessCount` accrues at read time and decides survival at write time.
