/**
 * The v0 memory-storage medium for eval runs: pre-writing a seeded store
 * (`seedMemoryMedium`) and reading the post-run medium back
 * (`readStoredEntries`). Shape reference is the v0 storage-json medium as
 * materialized by `tests/integration/composition.spec.ts` and the M0 smoke;
 * a malformed medium fails loud (never silently read as empty).
 *
 * @module eval/harness/seed-media
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryMediumPath } from './quiesce.ts'

/** Fixed seed timestamp (the same epoch the integration suites use). */
export const SEED_TIMESTAMP = 1_755_500_000_000

/**
 * A stored entry as read back from the medium — the shape passed to the
 * judge (rubric Inputs `entry` / `storeBefore` / `entriesAfter`) and used
 * for mechanical matching. Carries the timestamps the medium holds; audit
 * and decay bookkeeping is dropped. Optional fields are `| undefined`
 * explicitly: this boundary type is fed from parsed corpus/store JSON whose
 * optionals are `T | undefined`.
 */
export interface SeedEntryInput {
  readonly id: string
  readonly scope: 'global' | 'project' | 'user'
  readonly category?: string | undefined
  readonly content: string
  readonly summary?: string | undefined
  readonly projectName?: string | undefined
}

/**
 * A stored entry as read back from the medium: the shape passed to the judge
 * (rubric Inputs `entry` / `storeBefore` / `entriesAfter`) and used for
 * mechanical matching. The judge's own entry projection drops timestamps and
 * bookkeeping — those fields exist here only because the medium carries them;
 * unknown extra fields are dropped by the reader.
 */
export interface StoredEntry {
  readonly id: string
  readonly scope: 'global' | 'project' | 'user'
  readonly category?: string
  readonly content: string
  readonly summary?: string
  readonly projectName?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** The v0 medium document for a set of seed entries (empty store allowed). */
export function buildSeedMedium(entries: readonly SeedEntryInput[]): unknown {
  const table: Record<string, unknown> = {}
  for (const entry of entries) {
    table[entry.id] = {
      id: entry.id,
      scope: entry.scope,
      ...(entry.category !== undefined ? { category: entry.category } : {}),
      content: entry.content,
      ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
      ...(entry.projectName !== undefined ? { projectName: entry.projectName } : {}),
      createdAt: SEED_TIMESTAMP,
      updatedAt: SEED_TIMESTAMP,
    }
  }
  return {
    unit: { name: 'memory', version: 0 },
    global: null,
    tables: { entries: table },
  }
}

/**
 * Pre-write the seeded memory medium into `<dshHome>/storages/memory.json`.
 * @param dshHome - the throwaway harness home (created if needed).
 * @param entries - the seeded entries; an empty list still writes a valid
 *   empty medium so the store opens over a known state.
 */
export function seedMemoryMedium(dshHome: string, entries: readonly SeedEntryInput[]): void {
  mkdirSync(join(dshHome, 'storages'), { recursive: true })
  writeFileSync(memoryMediumPath(dshHome), `${JSON.stringify(buildSeedMedium(entries), undefined, 2)}\n`)
}

/** Read result for one medium: the entries plus the audit counter. */
export interface MediumRead {
  readonly entries: StoredEntry[]
  readonly entryCount: number
  readonly maxAuditSeq: number
}

/**
 * Read and narrow the stored entries out of `<dshHome>/storages/memory.json`.
 * A missing file is the empty store; an unparsable or shape-violating medium
 * throws with the path (misconfiguration fails loud).
 */
export function readStoredEntries(dshHome: string): MediumRead {
  const path = memoryMediumPath(dshHome)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    // ENOENT is the untouched-store state; any other read failure surfaces.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { entries: [], entryCount: 0, maxAuditSeq: 0 }
  }
  const document = JSON.parse(raw) as {
    tables?: {
      entries?: Record<string, unknown>
      audit?: Record<string, { seq?: number }>
    }
  }
  const table = document.tables?.entries ?? {}
  const entries = Object.entries(table).map(([key, value]) => narrowEntry(path, key, value))
  let maxAuditSeq = 0
  for (const record of Object.values(document.tables?.audit ?? {})) {
    const seq = record?.seq
    if (typeof seq === 'number' && seq > maxAuditSeq) maxAuditSeq = seq
  }
  return { entries, entryCount: entries.length, maxAuditSeq }
}

function narrowEntry(path: string, key: string, value: unknown): StoredEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`eval seed-media: ${path}: entry ${key} is not an object`)
  }
  const record = value as Record<string, unknown>
  const scope = record['scope']
  if (scope !== 'global' && scope !== 'project' && scope !== 'user') {
    throw new Error(`eval seed-media: ${path}: entry ${key} has invalid scope ${JSON.stringify(scope)}`)
  }
  const content = record['content']
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error(`eval seed-media: ${path}: entry ${key} has no content`)
  }
  const createdAt = record['createdAt']
  const updatedAt = record['updatedAt']
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') {
    throw new Error(`eval seed-media: ${path}: entry ${key} has non-numeric createdAt/updatedAt`)
  }
  const category = record['category']
  const summary = record['summary']
  const projectName = record['projectName']
  return {
    id: typeof record['id'] === 'string' ? record['id'] : key,
    scope,
    ...(typeof category === 'string' ? { category } : {}),
    content,
    ...(typeof summary === 'string' ? { summary } : {}),
    ...(typeof projectName === 'string' ? { projectName } : {}),
    createdAt,
    updatedAt,
  }
}
