/**
 * The `memory-identity` entry's settings: its `Config` schema and the
 * resolved view the identity service publishes.
 *
 * One home for every default, shared by the entry schema (the identity card
 * writes it) and the resolver, so the composition layer, the card, and the
 * service cannot drift.
 *
 * @module @chenhw7/dsh-memory/identity/settings
 */

import z from '@deepseek-ai/schemastery'

/** Whether the identity layer (soul / user-profile sections) is enabled. Opt-in: default off. */
export const DEFAULT_IDENTITY_ENABLED = false
/** Character budget for the injected soul section. */
export const DEFAULT_SOUL_CHAR_LIMIT = 2000
/** Character budget for the injected user-profile section. */
export const DEFAULT_USER_CHAR_LIMIT = 3000
/** Placeholder for "no seed directory configured" (the builtin seeds are used). */
export const DEFAULT_IDENTITY_SEED_DIR = ''

/** The `memory-identity` entry settings, fully resolved. */
export interface IdentitySettings {
  readonly identityEnabled: boolean
  /** Character budget for the injected soul section. */
  readonly soulCharLimit: number
  /** Character budget for the injected user-profile section. */
  readonly userCharLimit: number
  readonly identitySeedDir: string
}

/** Schema fields for the `memory-identity` entry (the identity card's form). */
export const IDENTITY_FIELDS = {
  identityEnabled: z.boolean().default(DEFAULT_IDENTITY_ENABLED),
  soulCharLimit: z.number().step(1).min(0).default(DEFAULT_SOUL_CHAR_LIMIT),
  userCharLimit: z.number().step(1).min(0).default(DEFAULT_USER_CHAR_LIMIT),
  identitySeedDir: z.string(),
}

/** The builtin values, used when no identity entry is composed. */
export const DEFAULT_IDENTITY_SETTINGS: IdentitySettings = {
  identityEnabled: DEFAULT_IDENTITY_ENABLED,
  soulCharLimit: DEFAULT_SOUL_CHAR_LIMIT,
  userCharLimit: DEFAULT_USER_CHAR_LIMIT,
  identitySeedDir: DEFAULT_IDENTITY_SEED_DIR,
}

/**
 * Resolve the identity settings, materializing every default. Accepts a
 * partial value so a unit test or a direct `apply` call lands on the same
 * footing as the loader-validated entry config.
 * @param value - the entry config, possibly partial or absent.
 * @returns the fully-resolved identity settings.
 */
export function resolveIdentitySettings(value: Partial<IdentitySettings> | undefined): IdentitySettings {
  return {
    identityEnabled: value?.identityEnabled ?? DEFAULT_IDENTITY_ENABLED,
    soulCharLimit: value?.soulCharLimit ?? DEFAULT_SOUL_CHAR_LIMIT,
    userCharLimit: value?.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT,
    identitySeedDir: value?.identitySeedDir ?? DEFAULT_IDENTITY_SEED_DIR,
  }
}
