/**
 * Pure types of the long-term memory domain: the MemoryEntry record,
 * MemoryStore service interface, memory/* session events, and content
 * scanner result types. Free of host-side imports so client aggregates and
 * the storage provider can consume the vocabulary without dragging the service.
 *
 * @module @chenhw7/dsh-memory/types
 */

/** MemoryId and AuditId are imported from ./brand.ts for use in type positions below. */
import type { MemoryId, AuditId } from './brand.ts'
/** Re-exported so the tool and review modules can import the full vocabulary from this module. */
export type { MemoryId, AuditId }

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
export type AuditSource = 'tool' | 'review' | 'flush' | 'ui'

/** The operation kind recorded in one audit entry. */
export type AuditOp = 'add' | 'update' | 'remove'

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
}

/** Input for creating a new memory entry. */
export interface AddMemoryInput {
  /** Which scope this memory belongs to. */
  readonly scope: MemoryScope
  /** Categorized lesson type; optional. */
  readonly category?: MemoryCategory | undefined
  /** Human-readable memory content. */
  readonly content: string
  /** Project name; required when scope is `project`. */
  readonly projectName?: string | undefined
  /** Provenance tag for the audit trail; defaults to `'tool'` when omitted. */
  readonly source?: AuditSource | undefined
  /** Session id for the audit trail; omitted by tool writes that lack a session handle. */
  readonly sessionId?: string | undefined
}

/** Input for updating an existing memory entry. */
export interface UpdateMemoryInput {
  /** New content; at least one updatable field must be present. */
  readonly content?: string
  /** New category; optional. */
  readonly category?: MemoryCategory | undefined
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
  /** Substring search over entry content (case-insensitive). */
  readonly query?: string
  /** Maximum results to return. */
  readonly limit?: number
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
  /** First ~100 chars of the mutated content, scanner-clean. */
  readonly contentPreview: string
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
  }
}
