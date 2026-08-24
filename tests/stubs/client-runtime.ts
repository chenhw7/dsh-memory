/**
 * Minimal test double for `@deepseek-ai/dsh-client-runtime/client`. The
 * published package ships as a browser `window.__ModuleLoader__` bundle that
 * Node/jsdom cannot import, so the jsdom suite aliases this stub in its place
 * (vitest.config.ts resolve.alias). Only what the memory section consumes is
 * provided — createSnapshotStore with the engine's sync-flush contract:
 * getSnapshot / subscribe / wholesale set.
 */

/** Writable observable snapshot source (the SnapshotStore data face). */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
  /** Replace the state wholesale and notify subscribers synchronously. */
  set(next: T): void
}

/**
 * Create a snapshot store with the same observable contract as the runtime
 * engine's default ('sync') flush: N changes inside one tick notify N times,
 * and every notification observes the latest state.
 * @param init - initial state.
 */
export function createSnapshotStore<T>(init: T): SnapshotStore<T> {
  let state = init
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void): () => void {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set(next: T): void {
      state = next
      for (const fn of [...listeners]) fn()
    },
  }
}
