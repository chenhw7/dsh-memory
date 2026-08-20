/**
 * @chenhw7/dsh-memory — long-term memory for the DeepSeek Harness, packaged as
 * one installable profile bundle. The package's substance is `cordis.patch.yml`
 * (declared by the `dsh.bundle.patch` manifest field); the six export sub-paths
 * carry the Service Definition, the storage provider, the model-facing tools,
 * the automatic extraction, and the system-prompt context injection.
 *
 * The root entry re-exports the shared vocabulary (types, MemoryStore,
 * scanContent) so internal modules and downstream consumers share one surface.
 *
 * @module @chenhw7/dsh-memory
 */

import { MemoryId, AuditId } from './brand.ts'
import { scanContent } from './scanner.ts'
import type {
  AddMemoryInput,
  AddMemoryResult,
  AuditEntry,
  AuditOp,
  AuditSource,
  MemoryEntry,
  MemorySearchQuery,
  SearchMemoryResult,
  UpdateMemoryInput,
} from './types.ts'

export type {
  AddMemoryInput,
  AddMemoryResult,
  AuditEntry,
  AuditOp,
  AuditSource,
  MemoryCategory,
  MemoryEntry,
  MemoryScope,
  MemorySearchQuery,
  ScanResult,
  SearchMemoryResult,
  UpdateMemoryInput,
} from './types.ts'
export { MemoryId, AuditId, scanContent }

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryStore
  }
}

/**
 * Abstract long-term memory store. Providers implement and register on
 * `ctx.memory`; the tool Consumer and review plugin call through the service.
 * Does not extend Cordis `Service` — the provider plugin owns the registration.
 */
export abstract class MemoryStore {
  /**
   * Runtime guard: direct construction of the abstract base throws. A subclass
   * calling `super()` is the only legitimate path, detected via `new.target`.
   */
  constructor() {
    if (new.target === MemoryStore) {
      throw new TypeError('MemoryStore is abstract and cannot be instantiated directly')
    }
  }

  /**
   * Add one memory entry. Implementations MUST run the content through
   * {@link scanContent} before persisting and reject content that fails.
   * @param input - The entry to add.
   * @returns the created entry with its assigned id and timestamps.
   */
  abstract add(input: AddMemoryInput): Promise<AddMemoryResult>

  /**
   * Read one entry by id.
   * @param id - The entry id.
   * @returns the entry, or `undefined` when absent.
   */
  abstract get(id: MemoryId): MemoryEntry | undefined

  /**
   * List entries, optionally filtered by scope and/or project.
   * @param scope - Optional scope filter.
   * @param projectName - Optional project name filter (only meaningful with `scope: 'project'`).
   * @returns matching entries in creation order.
   */
  abstract list(scope?: MemoryEntry['scope'], projectName?: string): readonly MemoryEntry[]

  /**
   * Update one entry's content and/or category.
   * @param id - The entry id.
   * @param input - Fields to update.
   * @returns the updated entry, or `undefined` when the id does not exist.
   */
  abstract update(id: MemoryId, input: UpdateMemoryInput): Promise<MemoryEntry | undefined>

  /**
   * Remove one entry by id.
   * @param id - The entry id.
   * @returns `true` when the entry existed and was removed, `false` when absent.
   */
  abstract remove(id: MemoryId): Promise<boolean>

  /**
   * Search entries by scope, category, project, and substring.
   * @param query - The search parameters.
   * @returns matching entries bounded by `query.limit`, plus the total match count.
   */
  abstract search(query: MemorySearchQuery): SearchMemoryResult

  /**
   * Pin one entry so it is immune to decay (§3.5). Returns the updated entry,
   * or `undefined` when the id does not exist.
   */
  abstract pin(id: MemoryId): Promise<MemoryEntry | undefined>

  /**
   * Remove the pin from one entry (§3.5). Returns the updated entry,
   * or `undefined` when the id does not exist.
   */
  abstract unpin(id: MemoryId): Promise<MemoryEntry | undefined>

  /**
   * Run the janitor pass: decay stale entries per the lifecycle policy (§3.5).
   * Pinned entries and `global`/`user`-scoped entries are never decayed.
   * `project`-scoped entries whose `lastRecalledAt` is older than the decay
   * threshold (or that have never been recalled and whose `createdAt` is older)
   * are removed. Every action is recorded in the audit store.
   * @param decayDays - entries not recalled within this many days are decayed.
   * @returns the number of entries removed.
   */
  abstract janitor(decayDays: number): Promise<number>
}

/**
 * Validate that project-scoped entries carry a projectName.
 * @param input - The add input to validate.
 * @throws when scope is `project` but no projectName is supplied.
 */
export function validateProjectScope(input: AddMemoryInput): void {
  if (input.scope === 'project' && (!input.projectName || input.projectName.trim().length === 0)) {
    throw new Error('project-scoped memory requires a projectName')
  }
}
