/**
 * Pure types of the long-term memory domain: the MemoryEntry record,
 * MemoryStore service interface, memory/* session events, and content
 * scanner result types. Free of host-side imports so client aggregates and
 * the storage provider can consume the vocabulary without dragging the service.
 *
 * @module @chenhw7/dsh-memory/types
 */

/** MemoryId and AuditId are imported from ./brand.ts for use in type positions below. */
import type { MemoryId, AuditId, SuggestionId } from './brand.ts'
/** Re-exported so the tool and review modules can import the full vocabulary from this module. */
export type { MemoryId, AuditId, SuggestionId }

/** The scope a memory entry belongs to. */
export type MemoryScope = 'global' | 'project' | 'user'

/** Optional category for categorized lessons and conventions. */
export type MemoryCategory =
  | 'failure'
  | 'correction'
  | 'insight'
  | 'preference'
  | 'convention'
  | 'tool-quirk'
  | 'procedure'

/** Who triggered a write to the memory store (recorded in the audit trail). */
export type AuditSource = 'tool' | 'review' | 'flush' | 'ui' | 'janitor'

/** The operation kind recorded in one audit entry. */
export type AuditOp = 'add' | 'update' | 'remove' | 'readRaw'

/** One durable memory entry. */
export interface MemoryEntry {
  /** Stable identity of this entry. */
  readonly id: MemoryId
  /** Which scope this memory belongs to. */
  readonly scope: MemoryScope
  /** Categorized lesson type; absent for plain facts and preferences. */
  readonly category?: MemoryCategory | undefined
  /** Human-readable memory content. */
  readonly content: string
  /**
   * Optional short summary for index/auto-recall rendering. Written via
   * `[summary:…]` at add time. When present, index views and the auto-recall
   * fence render this instead of a truncated content prefix, improving the
   * signal-to-noise of the existence index (evolve-style progressive disclosure).
   */
  readonly summary?: string | undefined
  /** Project name for `project`-scoped entries; absent otherwise. */
  readonly projectName?: string | undefined
  /** Unix epoch milliseconds when this entry was created. */
  readonly createdAt: number
  /** Unix epoch milliseconds when this entry was last updated. */
  readonly updatedAt: number
  /** Whether this entry is pinned (immune to decay). Defaults to false. */
  readonly pinned?: boolean | undefined
  /** Unix epoch ms when this entry was last returned by a search/get; absent if never recalled. */
  readonly lastRecalledAt?: number | undefined
  /**
   * Soft-decay stamp (§ lifecycle): epoch ms when the janitor marked this
   * `global`/`user` entry as stale (overdue without recall). Stale entries
   * drop out of injection surfaces but stay searchable and recoverable —
   * being recalled again clears the stamp. Absent on healthy entries.
   */
  readonly staleSince?: number | undefined
  /**
   * How many times this entry has been surfaced to the model through a recall
   * path (search hit, memory_get, memory_list page). Incremented by the store
   * on every recall stamp; absent (treated as 0) on entries never recalled.
   * The mechanical use-signal behind ranking and eviction — it needs no model
   * cooperation and retroactively reads as 0 for pre-existing entries.
   */
  readonly accessCount?: number | undefined
  /**
   * Model-supplied importance (1–5) from the `memory_add` `importance`
   * parameter; absent when the caller did not assess one. Search ranking and
   * the janitor's decay order weigh it, but it never overrides a recall: an
   * entry the model keeps surfacing survives through `accessCount` instead.
   */
  readonly importance?: number | undefined
  /**
   * Hard tokens extracted from the source conversation for consolidation
   * prefiltering: numbers, identifiers, tool names, repository names/paths.
   * Absent means "no anchors extracted" — the entry then matches on lexical
   * content alone. Anchors never affect retrieval ranking; their only
   * consumer is the consolidation candidate selector (shared low-frequency
   * anchors propose candidate pairs; the consolidation judge reads full text).
   */
  readonly anchors?: readonly string[] | undefined
  /**
   * Consolidation lifecycle status; absent reads as `'active'`. A
   * `'superseded'` entry has lost to a contradictory newer fact: it stays
   * visible through the tool/management surfaces (with a superseded badge)
   * but is filtered out of the injection and search surfaces. The field
   * pairs with {@link supersededBy}; supersession is terminal — no surface
   * flips an entry back to active.
   */
  readonly status?: 'active' | 'superseded' | undefined
  /**
   * The id of the entry that superseded this one, set together with
   * `status: 'superseded'` so a contradiction stays navigable. Absent on
   * active entries.
   */
  readonly supersededBy?: MemoryId | undefined
  /**
   * Usage feedback (write-path rework Step 2): how many assistant turns
   * echoed this entry's tokens/anchors after it was injected — the
   * "the model actually used this fact" signal. Absent (treated as 0) on
   * entries never hit. Deliberately independent of {@link accessCount}:
   * an injected-but-ignored entry still counts a recall (the surface ran)
   * but never a hit (the answer did not echo it). The periodic sweep's
   * selection is the only consumer; it never drives deletion (decayDays
   * remains the only forgetting knob).
   */
  readonly hitCount?: number | undefined
  /** Unix epoch ms of the most recent hit recorded by `markHits`; absent when never hit. */
  readonly lastHitAt?: number | undefined
}

/** Input for creating a new memory entry. */
export interface AddMemoryInput {
  /** Which scope this memory belongs to. */
  readonly scope: MemoryScope
  /** Categorized lesson type; optional. */
  readonly category?: MemoryCategory | undefined
  /** Human-readable memory content. */
  readonly content: string
  /**
   * Optional short summary for index/auto-recall rendering; mapped from the
   * `[summary:…]` content tag when present, or supplied directly by tools/UI.
   */
  readonly summary?: string | undefined
  /** Project name; required when scope is `project`. */
  readonly projectName?: string | undefined
  /** Provenance tag for the audit trail; defaults to `'tool'` when omitted. */
  readonly source?: AuditSource | undefined
  /** Session id for the audit trail; omitted by tool writes that lack a session handle. */
  readonly sessionId?: string | undefined
  /**
   * Model-supplied importance (1–5); optional. Clamped into range on write.
   * Absent means "not assessed", not "unimportant" — ranking treats absent
   * and mid-range alike rather than penalizing unassessed entries.
   */
  readonly importance?: number | undefined
  /**
   * Hard tokens (numbers, identifiers, tool names, repository names/paths)
   * extracted from the source conversation; stored verbatim as the entry's
   * `anchors`. Omitted when the writer extracted none.
   */
  readonly anchors?: readonly string[] | undefined
}

/** Input for updating an existing memory entry. */
export interface UpdateMemoryInput {
  /** New content; at least one updatable field must be present. */
  readonly content?: string
  /** New category; optional. */
  readonly category?: MemoryCategory | undefined
  /** New summary; optional. Pass empty string to clear. */
  readonly summary?: string | undefined
  /** New model-assessed importance (1–5, clamped); omitted keeps the stored value. */
  readonly importance?: number | undefined
  /**
   * New anchors (hard tokens from the source conversation); omitted keeps the
   * stored value. Supersession (`status`/`supersededBy`) is deliberately NOT
   * writable here: only the consolidation path flips an entry's status, and
   * that path writes through its own dedicated seam.
   */
  readonly anchors?: readonly string[] | undefined
  /** Provenance tag for the audit trail; defaults to `'tool'` when omitted. */
  readonly source?: AuditSource | undefined
  /** Session id for the audit trail; omitted by tool writes that lack a session handle. */
  readonly sessionId?: string | undefined
}

/** Filter parameters for searching memory entries. */
export interface MemorySearchQuery {
  /** Restrict to entries matching this scope. */
  readonly scope?: MemoryScope
  /** Restrict to entries matching this category. */
  readonly category?: MemoryCategory
  /** Restrict `project`-scoped entries to this project name. */
  readonly projectName?: string
  /** Relevance-ranked keyword search over entry content: case-insensitive whole-token matching, not substrings. */
  readonly query?: string
  /** Maximum results to return. */
  readonly limit?: number
  /**
   * Whether matching counts as a recall (default true): stamps
   * `lastRecalledAt` on the returned entries and revives dormant ones.
   * Read-side consumers that merely display entries — like the management
   * UI — must pass false so browsing never rewrites recall metadata.
   */
  readonly recordRecall?: boolean
}

/** Result of a content security scan. */
export interface ScanResult {
  /** Whether the content passed all checks and may be stored. */
  readonly allowed: boolean
  /** Human-readable reasons for rejection; empty when allowed. */
  readonly reasons: readonly string[]
}

/** Result of a memory add operation. */
export interface AddMemoryResult {
  /** The created entry. */
  readonly entry: MemoryEntry
}

/** Result of a memory search operation. */
export interface SearchMemoryResult {
  /** Matching entries, bounded by the query limit. */
  readonly entries: readonly MemoryEntry[]
  /** Total count of matches before the limit was applied. */
  readonly total: number
}

/** One record in the plugin-owned audit table, appended after every successful mutation. */
export interface AuditEntry {
  /** Stable identity of this audit record. */
  readonly id: AuditId
  /** Which mutation produced this record. */
  readonly op: AuditOp
  /** The memory entry id that was mutated. */
  readonly entryId: MemoryId
  /** The scope of the mutated entry. */
  readonly scope: MemoryScope
  /** Category of the mutated entry, when one was assigned. */
  readonly category?: MemoryCategory | undefined
  /** Who triggered the write. */
  readonly source: AuditSource
  /** Session id when the write came from an extraction path, absent for tool writes. */
  readonly sessionId?: string | undefined
  /** Unix epoch milliseconds when the audit record was appended. */
  readonly ts: number
  /**
   * Monotonic per-provider sequence number, assigned in append order. Breaks
   * same-millisecond timestamp ties deterministically (ids are random UUIDs).
   * Absent on records written before this field existed; ordering falls back
   * to id comparison for such records.
   */
  readonly seq?: number | undefined
  /** First ~100 chars of the mutated content, scanner-clean. */
  readonly contentPreview: string
}

/**
 * One pending proposal in the human-review queue (P1-1 optional confirm mode).
 * A suggestion is NOT a memory: it never injects, never searches, and never
 * decays — it waits for a human decision (adopt → becomes/updates an entry,
 * reject → deleted). Repeated extraction of the same proposal accumulates
 * `hits` ("frequency is signal"), which sorts the queue.
 */
export interface MemorySuggestion {
  /** Stable identity of this suggestion. */
  readonly id: SuggestionId
  /**
   * Which scope the proposed memory belongs to. For identity proposals
   * ({@link identityKind} set) this is `'global'` — the identity layer is
   * per-user global, and the field exists only for the durable row shape.
   */
  readonly scope: MemoryScope
  /** Proposed category; absent for plain facts. */
  readonly category?: MemoryCategory | undefined
  /** Proposed memory content. */
  readonly content: string
  /** Proposed short summary for index/auto-recall rendering. */
  readonly summary?: string | undefined
  /** Project name for `project`-scoped proposals; absent otherwise. */
  readonly projectName?: string | undefined
  /**
   * When set, this row is an identity-document proposal (confirm-mode
   * `identity_update`): `identityKind` names the target document, adoption
   * rewrites it through the identity write path (source `'ui'`), and the
   * entry-proposal fields above are ignored.
   */
  readonly identityKind?: IdentityKind | undefined
  /**
   * How many times this same proposal has been (re-)observed by extraction.
   * Creation sets 1; each repeat observation bumps it and refreshes
   * `lastSeenAt`. The queue renders highest-hits first.
   */
  readonly hits: number
  /** Unix epoch ms when this proposal was first observed. */
  readonly firstSeenAt: number
  /** Unix epoch ms when this proposal was last re-observed. */
  readonly lastSeenAt: number
  /**
   * When set, adopting applies `content` as an UPDATE to this existing entry
   * instead of creating a new one (P1-2 update-re-review semantics: a model
   * proposing a change to an already-confirmed entry never writes it directly;
   * the entry is touched only when a human adopts the proposal).
   */
  readonly targetEntryId?: MemoryId | undefined
  /** Provenance of the proposal (`review`, `flush`, or `tool`). */
  readonly source: AuditSource
  /** Session id when the proposal came from an extraction path. */
  readonly sessionId?: string | undefined
}

/** Input for creating or re-observing a suggestion. */
export interface AddSuggestionInput {
  readonly scope: MemoryScope
  readonly category?: MemoryCategory | undefined
  readonly content: string
  readonly summary?: string | undefined
  readonly projectName?: string | undefined
  /** Set when the proposal targets an identity document instead of an entry. */
  readonly identityKind?: IdentityKind | undefined
  /** Set when the proposal is a change to an already-confirmed entry (P1-2). */
  readonly targetEntryId?: MemoryId | undefined
  readonly source: AuditSource
  readonly sessionId?: string | undefined
}

/** Human edits applied at adoption time ("edit before adopt", evolve-style). */
export interface AdoptSuggestionOverride {
  readonly content?: string
  readonly category?: MemoryCategory | undefined
  readonly summary?: string | undefined
}

// ─── Identity documents (the identity layer) ────────────────────────────────

/** Which self-document an identity write targets (`SOUL.md` / `USER.md` are display names). */
export type IdentityKind = 'soul' | 'user'

/** Provenance of one identity-document write. */
export type IdentityWriteSource = 'seed' | 'tool' | 'ui'

/**
 * The current record of one identity document. The document is the agent's
 * self-description (`soul`) or its understanding of the human user (`user`),
 * grown through conversation writes — never a memory entry, never subject to
 * decay, consolidation, or conflict annotation.
 */
export interface IdentityRecord {
  /** Which document this is. */
  readonly kind: IdentityKind
  /** The full document text (whole-document replace semantics). */
  readonly content: string
  /**
   * Monotonic version: starts at 1, +1 on every write including reverts.
   * Paired with `kind` it forms the history-table key `${kind}#${version}`.
   */
  readonly version: number
  /** Unix epoch ms of the last write. */
  readonly updatedAt: number
  /** Which shipped seed generation first seeded this document (diagnostic; the seed never re-lands once a record exists). */
  readonly seedVersion: number
}

/**
 * One full-content version snapshot. Appended on every identity write
 * (seed, tool, revert); trimmed to the newest {@link IDENTITY_HISTORY_CAP}
 * per kind. The table IS the identity audit surface — the entry-keyed audit
 * table cannot carry identity writes.
 */
export interface IdentityHistoryRecord {
  readonly kind: IdentityKind
  /** The version this snapshot wrote. */
  readonly version: number
  /** Full content of this version. */
  readonly content: string
  /** Unix epoch ms of the write. */
  readonly ts: number
  readonly source: IdentityWriteSource
  /** Session id when the write came from an in-conversation tool call. */
  readonly sessionId?: string | undefined
}

/** Provenance for one identity-document write. */
export interface UpdateIdentityInput {
  readonly source: IdentityWriteSource
  /** Session id for tool writes that carry one. */
  readonly sessionId?: string | undefined
  /**
   * Seed generation applied when this write CREATES the record (diagnostic
   * only); ignored once the record exists.
   */
  readonly seedVersion?: number | undefined
}

/** Health snapshot of the memory store (§3.7 observability). */
export interface MemoryHealth {
  /** Total entry count. */
  readonly totalEntries: number
  /** Entry count per scope. */
  readonly byScope: { readonly global: number; readonly project: number; readonly user: number }
  /** Count of pinned entries. */
  readonly pinned: number
  /** Total audit records. */
  readonly auditRecords: number
  /** Entries currently soft-decayed (`staleSince` set) and hidden from injection. */
  readonly stale?: number | undefined
  /** Timestamp of the most recent audit record, or undefined when the audit table is empty. */
  readonly lastActivityTs?: number | undefined
  /** Timestamp of the most recent extraction-sourced audit record, or undefined. */
  readonly lastExtractionTs?: number | undefined
  /**
   * Per-site counts of failures swallowed by best-effort background paths
   * (audit append, flush, janitor, curator, judge, ...); absent when none have
   * occurred. In-process only — counts reset when the host restarts.
   */
  readonly backgroundFailures?: Readonly<Record<string, number>> | undefined
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Log-only: records that a memory entry was added. Not a SurfaceEventType
     * (no `surfaceOp`, contributes nothing to derived history). The owner
     * decides whether it belongs inside an open turn or between turns.
     */
    'memory/added': {
      /** The id of the added entry. */
      readonly id: MemoryId
      /** The scope of the added entry. */
      readonly scope: MemoryScope
      /** The content of the added entry. */
      readonly content: string
      /** Project name for project-scoped entries. */
      readonly projectName?: string
      /** Category, when one was assigned. */
      readonly category?: MemoryCategory
    }
    /**
     * Log-only: records that a memory entry was updated. Not a SurfaceEventType.
     */
    'memory/updated': {
      /** The id of the updated entry. */
      readonly id: MemoryId
      /** The new content. */
      readonly content: string
      /** The new category, when changed. */
      readonly category?: MemoryCategory
    }
    /**
     * Log-only: records that a memory entry was removed. Not a SurfaceEventType.
     */
    'memory/removed': {
      /** The id of the removed entry. */
      readonly id: MemoryId
    }
    /**
     * Log-only: records that an identity document (SOUL.md / USER.md) was
     * rewritten. Declared vocabulary only — like `memory/added`, no plugin
     * surface emits it today (tool executions carry no session handle); the
     * in-conversation announcement rides the tool result text, and the durable
     * audit surface is the identity history table. Not a SurfaceEventType.
     */
    'identity/updated': {
      /** Which document was rewritten. */
      readonly kind: IdentityKind
      /** The version the write produced. */
      readonly version: number
    }
  }
}
