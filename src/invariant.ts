/**
 * Package-owned invariant companion for `@chenhw7/dsh-memory`.
 *
 * In the original monorepo each sub-package carried its own invariant companion
 * to claim its package name. As a self-contained single package, one companion
 * claims the single package name. No runtime invariant is needed: the memory
 * events are log-only records between turns (no nesting relation to enforce),
 * the tools proxy to the memory service (own no event stream), the review
 * plugin writes only through the validated store, and the context section text
 * is a pure function of live settings + a frozen snapshot. This companion
 * exists to claim the package name so a future relation check can land here
 * without changing the registration surface.
 *
 * @module @chenhw7/dsh-memory/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@chenhw7/dsh-memory'

/** Cordis companion plugin name. */
export const name = 'memory-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the memory invariant companion. The memory/* events are standalone
 * log-only records between turns; unlike turn/step events they have no
 * nesting relation to enforce. The Session.append runtime already validates
 * JSON-serializability and the store validates scope/projectName before
 * appending. No additional runtime invariant is needed beyond what the store
 * and append already enforce.
 */
const install: InvariantInstaller = Object.assign((_ctx: Context, _fail: InvariantFailure) => {
  // No runtime invariant: memory/* events are standalone log-only records,
  // tools own no event stream, review writes through the validated store,
  // and context reads a frozen snapshot. This companion claims the package
  // name so a future relation check can land here without changing the
  // registration surface.
}, { inject: ['sessions'] })

/**
 * Register the memory invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
