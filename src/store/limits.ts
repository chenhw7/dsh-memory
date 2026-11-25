/**
 * Caps shared by both storage backends. They live here rather than in the
 * aggregate store module so the SQLite backend can import the same numbers
 * without a value cycle through it.
 *
 * @module @chenhw7/dsh-memory/store/limits
 */

/**
 * Default audit-table cap. Raised from 200 once usage hits stopped writing
 * audit rows: the table now holds mutations only, so 500 records is roughly
 * the mutation history the old cap held interleaved with hit noise.
 */
export const DEFAULT_AUDIT_CAP = 500

/** Default cap on the pending-review proposal queue (one row per open proposal). */
export const DEFAULT_SUGGESTION_CAP = 200
