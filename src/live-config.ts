/**
 * Live config reads for the entry slices this bundle resolves.
 *
 * Under the DSH 0.2 host contract a plugin's resolved config carries every
 * `volatile` field as a live ref object: the settings wire edits those fields
 * without restarting the fiber and updates the ref in place, while ordinary
 * fields stay plain values (the loader restarts the fiber to change those).
 * Every `resolve*Settings` function therefore reads through
 * {@link liveValue}, which accepts both shapes — the composed host (refs) and
 * a unit test or direct `apply` call (plain values) — so one resolver serves
 * both without duplicating defaults.
 *
 * @module @chenhw7/dsh-memory/live-config
 */

/** The live ref the host loader installs for one volatile config field. */
export interface LiveRef<T> {
  /** The current value; re-read on every call. */
  get(): T
}

/**
 * One entry's resolved config as the host hands it over: every `volatile`
 * field arrives as a live ref, every ordinary field as a plain value.
 */
export type LiveConfig<T> = { readonly [K in keyof T]: T[K] | LiveRef<T[K]> }

/**
 * Read one field that may be a live ref.
 * @param value - the plain value, the live ref, or undefined.
 * @returns the current plain value, or undefined when the field is absent.
 */
export function liveValue<T>(value: T | LiveRef<T> | undefined): T | undefined {
  if (value === null || typeof value !== 'object') return value as T | undefined
  const ref = value as LiveRef<T>
  return typeof ref.get === 'function' ? ref.get() : value as T
}
