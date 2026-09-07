/**
 * The detail-page cache. Invalidation rides the write path: every write
 * drops the affected key synchronously before the new value lands —
 * nothing in this layer expires on a TTL.
 */
export class DetailCache {
  private readonly store = new Map<string, unknown>()

  /**
   * The build stamp embedded in the cdn-edge cache key: every release
   * changes it, so the edge layer refreshes as a whole and no entry needs
   * per-key clearing.
   */
  readonly buildHash: string

  constructor(buildHash: string) {
    this.buildHash = buildHash
  }

  /** The cdn-edge cache key for one detail page (build-stamped). */
  edgeKey(id: string): string {
    return `detail:${id}:${this.buildHash}`
  }

  get(id: string): unknown {
    return this.store.get(id)
  }

  /** Write path: invalidate first, then land the new value. */
  put(id: string, value: unknown): void {
    this.store.delete(id)
    this.store.set(id, value)
  }
}
