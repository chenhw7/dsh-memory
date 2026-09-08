/**
 * `@chenhw7/dsh-memory/identity`: the identity-layer service (TECH_DESIGN
 * §7.10). The two self-documents — the agent's character (SOUL.md) and its
 * working profile of the human user (USER.md) — live in the memory store's
 * `identity` table and inject as their own system-prompt sections; this
 * module owns seeding and the read-side snapshot.
 *
 * Seeding is seed-once: a missing document is seeded on the first snapshot
 * (builtin text, or the `identitySeedDir` override), the content is served
 * for THAT session's prompt while the durable write lands fire-and-forget,
 * and the plugin never overwrites an existing document again. A configured
 * seed directory is validated loudly at load; per-file problems at seed time
 * degrade to the builtin seed with a reported failure (observable, never a
 * broken session).
 *
 * @module @chenhw7/dsh-memory/identity
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges the `settings` service (SettingsProvider) into the Context
// so `ctx.settings` types in this module.
import type {} from '@deepseek-ai/dsh-settings'
import { existsSync } from 'node:fs'
import type { MemoryStore } from '../index.ts'
import type { IdentityKind } from '../types.ts'
import { resolveIdentitySettings, type IdentitySettings } from './settings.ts'
import { builtinSeed, readSeedFile, seedFilePath, SEED_VERSION } from './seeds.ts'

export { resolveIdentitySettings, DEFAULT_IDENTITY_ENABLED, DEFAULT_IDENTITY_SEED_DIR, DEFAULT_SOUL_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT } from './settings.ts'
export { SOUL_SEED, USER_SEED, SEED_VERSION, validateSeedDir } from './seeds.ts'
export type { IdentitySettings } from './settings.ts'

/** Cordis plugin name. */
export const name = 'memory-identity'

/** Nothing is required: `memory` and `settings` are accessed optionally. */
export const inject: string[] = []

/** The settings namespace owned by `memory-context`, read here defensively. */
const MEMORY_NS = 'memory'

/**
 * The raw (unbudgeted) contents of the two identity documents for one
 * snapshot. Empty strings mean "nothing to inject" (disabled, no store, or
 * not yet written) — budgets are applied by `memory-context` at section
 * assembly, the notes-section precedent.
 */
export interface IdentitySnapshot {
  /** The agent's character document (SOUL.md); empty when absent. */
  readonly soul: string
  /** The working profile of the human user (USER.md); empty when absent. */
  readonly user: string
}

/** The empty snapshot (identity disabled, no store, or snapshot failure). */
export const EMPTY_IDENTITY: IdentitySnapshot = { soul: '', user: '' }

/**
 * The identity service, registered on `ctx.identity` by this plugin. Consumers
 * (`memory-context`) read the per-session snapshot through it. Pure read side
 * — the seeding write is fire-and-forget and never throws into the caller.
 */
export abstract class IdentityService {
  constructor() {
    if (new.target === IdentityService) {
      throw new TypeError('IdentityService is abstract and cannot be instantiated directly')
    }
  }

  /**
   * The current identity snapshot. When a document has never been written,
   * its SEED content is served (so the first session's prompt is complete)
   * while the durable seed write is kicked fire-and-forget. Budgets are NOT
   * applied here — the consumer owns the injection budget.
   * @returns the raw document contents; empty strings when disabled or unavailable.
   */
  abstract snapshotFor(): IdentitySnapshot
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    identity: IdentityService
  }
}

/** The default service implementation. All failures are swallowed by design. */
class IdentityServiceImpl extends IdentityService {
  private readonly ctx: Context
  private readonly settings: () => IdentitySettings
  /** Kinds whose seed write this process already kicked (one seed write per boot per kind). */
  private readonly seedInFlight = new Set<IdentityKind>()

  constructor(ctx: Context, settings: () => IdentitySettings) {
    super()
    this.ctx = ctx
    this.settings = settings
  }

  override snapshotFor(): IdentitySnapshot {
    try {
      const settings = this.settings()
      if (!settings.identityEnabled) return EMPTY_IDENTITY
      const memory = this.ctx.get('memory')
      if (memory === undefined) return EMPTY_IDENTITY
      return {
        soul: this.documentFor('soul', memory, settings),
        user: this.documentFor('user', memory, settings),
      }
    } catch (error) {
      this.ctx.get('memory')?.reportFailure('identity-snapshot', error)
      return EMPTY_IDENTITY
    }
  }

  /**
   * One document's current content: the stored record when present, else the
   * seed (served synchronously for THIS session while the durable seed write
   * lands fire-and-forget — one kick per kind per process).
   */
  private documentFor(kind: IdentityKind, memory: MemoryStore, settings: IdentitySettings): string {
    const record = memory.getIdentity(kind)
    if (record !== undefined) return record.content
    const seed = this.loadSeed(kind, settings, memory)
    if (!this.seedInFlight.has(kind)) {
      this.seedInFlight.add(kind)
      void memory.updateIdentity(kind, seed, { source: 'seed', seedVersion: SEED_VERSION })
        .catch((error: unknown) => { memory.reportFailure('identity-seed', error) })
    }
    return seed
  }

  /**
   * The seed content for one kind: the `identitySeedDir` override when
   * configured and present, else the builtin. A missing override file falls
   * back with a reported failure (a typo'd file name must be observable, not
   * a silent builtin); an invalid one falls back the same way after the
   * load-time gate already rejected it once.
   */
  private loadSeed(kind: IdentityKind, settings: IdentitySettings, memory: MemoryStore): string {
    const seedDir = settings.identitySeedDir
    if (seedDir.trim().length === 0) return builtinSeed(kind)
    const file = seedFilePath(seedDir, kind)
    if (!existsSync(file)) {
      memory.reportFailure('identity-seed', new Error(`seed file ${file} not found — using the builtin seed`))
      return builtinSeed(kind)
    }
    try {
      return readSeedFile(file)
    } catch (error) {
      memory.reportFailure('identity-seed', error)
      return builtinSeed(kind)
    }
  }
}

/**
 * Install the memory-identity plugin: register the `identity` service.
 *
 * Load-time validation of a configured seed directory is NOT here: cordis
 * swallows throws from `ctx.inject` callbacks (verified against the installed
 * runtime), so the loud gate lives in `memory-context`'s apply — the owner of
 * the `memory` namespace validates its composition-layer config before
 * mounting. Settings-overlay changes made live through the UI take the
 * observable path instead: the service reports the failure and falls back to
 * the builtin seed (`health().backgroundFailures` carries it).
 * @param ctx - Cordis context.
 */
export function apply(ctx: Context): void {
  // Cross-namespace live reads MUST ride ctx.inject: cordis service
  // properties throw `cannot get property "settings" without inject` on a
  // fiber that has not injected the service (the tool plugin's precedent),
  // and a plain try/catch would swallow that into the disabled default.
  let readSettings = (): IdentitySettings => resolveIdentitySettings(undefined)
  ctx.inject(['settings'], (sctx) => {
    readSettings = (): IdentitySettings => {
      try {
        return resolveIdentitySettings(sctx.settings.get(MEMORY_NS))
      } catch {
        // Namespace not registered yet (or the provider tore down) — the
        // disabled default stands until it registers.
        return resolveIdentitySettings(undefined)
      }
    }
  })
  // The stable indirection re-reads the variable per call — the inject
  // callback reassigns it after the settings service attaches (the tool
  // plugin's `defaultLimit` pattern); passing `readSettings` directly would
  // freeze the pre-attach fallback into the service forever.
  ctx.provide('identity', new IdentityServiceImpl(ctx, () => readSettings()))
}
