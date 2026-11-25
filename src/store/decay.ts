/**
 * The one activity clock the decay janitor and the entry-cap trim share.
 *
 * A memory stays alive while anything about it is recent: it was written or
 * edited (`updatedAt`), it was recalled into a prompt (`lastRecalledAt`), or
 * the assistant's answer echoed it (`lastHitAt`). Reading only
 * `lastRecalledAt ?? createdAt` — the pre-0.11 clock — decayed entries a user
 * had just edited or a model had just echoed, and evicted them before quiet
 * ones, so freshness and eviction order disagreed with the store's own
 * signal.
 *
 * @module @chenhw7/dsh-memory/store/decay
 */

/** The timestamp fields that make up an entry's activity clock. */
export interface ActivityTimestamps {
  /** When the entry was created. */
  readonly createdAt: number
  /** When the entry's content was last written or edited. */
  readonly updatedAt?: number | undefined
  /** When the entry was last injected into a prompt. */
  readonly lastRecalledAt?: number | undefined
  /** When the assistant's answer last echoed the entry. */
  readonly lastHitAt?: number | undefined
}

/**
 * The most recent activity timestamp on an entry — the value decay and
 * eviction both order by.
 * @param entry - the entry (or snapshot) whose activity to read.
 * @returns the newest of its create/edit/recall/hit timestamps.
 */
export function lastActiveTimestamp(entry: ActivityTimestamps): number {
  return Math.max(
    entry.createdAt,
    entry.updatedAt ?? 0,
    entry.lastRecalledAt ?? 0,
    entry.lastHitAt ?? 0,
  )
}
