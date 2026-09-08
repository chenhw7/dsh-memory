/**
 * Defaults and the read-side view for the identity keys of the `memory`
 * settings namespace. Both consumers pull from here so defaults cannot drift:
 * `memory-context`'s Config schema (schema `.default()` values → settings UI
 * ownership) and the `memory-identity` plugin (defensive reads of the raw
 * namespace value via `ctx.settings.get`).
 *
 * @module @chenhw7/dsh-memory/identity/settings
 */

/** Whether the identity layer (soul / user-profile sections) is enabled. Opt-in: default off. */
export const DEFAULT_IDENTITY_ENABLED = false
/** Character budget for the injected soul section. */
export const DEFAULT_SOUL_CHAR_LIMIT = 2000
/** Character budget for the injected user-profile section. */
export const DEFAULT_USER_CHAR_LIMIT = 3000
/** Placeholder for "no seed directory configured" (the builtin seeds are used). */
export const DEFAULT_IDENTITY_SEED_DIR = ''

/** The identity slice of the `memory` settings namespace, fully resolved. */
export interface IdentitySettings {
  readonly identityEnabled: boolean
  readonly identitySeedDir: string
}

/**
 * Resolve the identity settings from an untyped namespace value (defaults for
 * anything absent or mistyped). The character budgets are not resolved here —
 * `memory-context` applies them at section assembly (the notes-section
 * precedent), not in the identity service.
 * @param value - the raw `memory` namespace value (`ctx.settings.get` returns `unknown`).
 * @returns the fully-resolved identity settings.
 */
export function resolveIdentitySettings(value: unknown): IdentitySettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    identityEnabled: typeof v.identityEnabled === 'boolean' ? v.identityEnabled : DEFAULT_IDENTITY_ENABLED,
    identitySeedDir: typeof v.identitySeedDir === 'string' ? v.identitySeedDir : DEFAULT_IDENTITY_SEED_DIR,
  }
}
