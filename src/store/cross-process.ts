/**
 * Cross-process single-writer detection for the memory medium.
 *
 * The host storage-json backend declares a single-writer assumption per
 * process: two DSH processes sharing one storage root each hold their own
 * in-memory authoritative state and republish the whole unit file on every
 * write, silently clobbering each other (last publisher wins). The backend's
 * double-open guard is a per-process map, so the second process opens the
 * same unit without any error — nothing in the host detects the overlap.
 *
 * This module adds detection, not locking: each boot stamps an owner record
 * into the domain's global slot and re-reads the medium periodically. A stamp
 * this boot just wrote that reads back as someone else's proves a concurrent
 * publisher; a foreign stamp seen at startup proves an earlier writer the
 * medium still remembers. Detection needs both sides to stamp — a writer
 * running a version without this guard overwrites the slot with `null` and
 * is invisible here. A foreign stamp is only a live threat when its pid is
 * still alive: `closedAt` marks a clean exit, and a dead pid marks a crashed
 * predecessor — both restart cases stay silent.
 *
 * @module @chenhw7/dsh-memory/store/cross-process
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import zod from 'zod'

/** The owner stamp one process boot writes into the memory domain's global slot. */
export interface OwnerStamp {
  pid: number
  startedAt: number
  bootId: string
  closedAt?: number
}

/** Zod schema validating a stamp at the durable boundary (rejects `null`, the "never written" sentinel). */
export const ownerStampSchema = zod.looseObject({
  pid: zod.number(),
  startedAt: zod.number(),
  bootId: zod.string(),
}) as unknown as zod.ZodType<OwnerStamp>

/**
 * Spec-level `initial` for the global slot: what {@link CrossProcessGuard.startup}
 * sees when the medium has never been claimed (empty `bootId`). Never written
 * as-is — the guard's first act replaces it with a real stamp.
 */
export const EMPTY_OWNER: OwnerStamp = { pid: 0, startedAt: 0, bootId: '' }

/**
 * Default cadence for the medium read-back probe. Lightweight by design —
 * one file read per interval, off the write path; `0` disables probing.
 */
export const DEFAULT_CROSS_PROCESS_PROBE_MS = 60_000

/** Identity of the current process boot: fresh per construction, so a restart never reads as itself. */
export function currentBootOwner(): OwnerStamp {
  return { pid: process.pid, startedAt: Date.now(), bootId: randomUUID() }
}

/**
 * Production read seam: the unit file's global slot, read straight from the
 * medium. The domain serves reads from in-memory state, which never observes
 * another process's publish — the file is the only cross-process witness.
 * @param path - Absolute path of the unit file.
 * @returns an async reader yielding the stored global, `undefined` when the
 * file is not materialized yet.
 */
export function mediumOwnerReader(path: string): () => Promise<unknown> {
  return async () => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      // Absence before the first publish is the normal empty-medium state.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    // The unit file is always a complete document (atomic whole-file publish),
    // and the stamp schema validates whatever this extracts.
    const document = JSON.parse(text) as { global?: unknown }
    return document.global
  }
}

/**
 * Production goodbye seam: stamp `closedAt` onto the unit file's global slot
 * directly on the medium. The domain write seam (`global.set`) rejects with
 * `closed` once the storage facility's unmount races our disposer — the
 * medium file is the only write path that stays valid through teardown.
 * The whole-file replacement mirrors the backend's own publish protocol
 * (temp file + rename is unnecessary here: a partial goodbye is a torn
 * stamp at worst, and the pid-dead rule already forgives a lost goodbye;
 * the atomic rename without a directory fsync keeps this free of host
 * internals).
 * @param path - Absolute path of the unit file.
 * @param bootId - This boot's stamp; the write is skipped when the medium's
 *   current owner is someone else (we were already overwritten — nothing to
 *   say goodbye to).
 * @returns an async writer, or `undefined` when the file is not materialized.
 */
export function mediumGoodbyeWriter(path: string, bootId: string): (() => Promise<void>) | undefined {
  return async () => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      // Nothing materialized = nobody can read our stamp; a no-op goodbye.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const document = JSON.parse(text) as { global?: { bootId?: string; closedAt?: number } & Record<string, unknown>; tables?: unknown }
    if (document.global?.bootId !== bootId || document.global.closedAt !== undefined) return
    document.global.closedAt = Date.now()
    await writeFile(path, JSON.stringify(document, null, 2) + '\n', 'utf8')
  }
}

/**
 * Default pid-liveness seam: a live process with that pid means a genuine
 * concurrent writer; only `ESRCH` proves absence. `EPERM` (exists, not
 * signallable) and any other probe error alert — fail toward warning, since
 * an undetected concurrent publisher is the expensive side.
 * @param pid - The foreign stamp's pid.
 * @returns whether a process with that pid is alive.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only confirmed absence stays silent: ESRCH is Node's "no such process".
    return !((error as NodeJS.ErrnoException).code === 'ESRCH')
  }
}

/** Failure-reporting seam: the store's {@link reportFailure} (counter + logger warn). */
export type FailureReporter = (site: string, error: unknown) => void

/**
 * One boot's cross-process detector. Watches the owner stamp on the medium:
 * claims it at startup, re-reads it on probes, and closes it with a goodbye
 * stamp on clean dispose. Reports a foreign live stamp at most once per boot
 * — restarts reset the flag, matching the `backgroundFailures` in-process
 * semantics.
 *
 * Misfire semantics: a foreign stamp carrying `closedAt` is a writer that
 * exited cleanly, and one whose pid is gone is a crashed predecessor —
 * neither is a concurrent publisher, so both stay silent. A live pid is a
 * genuine concurrent writer and alerts; pid reuse by an unrelated process
 * can forge this signal, which the one-warn-per-boot bound contains.
 */
export class CrossProcessGuard {
  /** Set on the first foreign-live observation; one alert per boot. */
  private alerted = false

  constructor(
    /** This boot's identity, written as the claim and compared against read-backs. */
    private readonly own: OwnerStamp,
    /** Medium read-back seam, or `undefined` when the medium path is unresolvable (probes off). */
    private readonly readOwner: (() => Promise<unknown>) | undefined,
    /** Durable write seam for the global slot (the domain's `global.set`). */
    private readonly writeOwner: (owner: OwnerStamp) => Promise<void>,
    /** Swallowed-failure channel (store `reportFailure`). */
    private readonly report: FailureReporter,
    /** Liveness seam for foreign pids; defaults to the platform `kill(pid, 0)` check. */
    private readonly isAlive: (pid: number) => boolean = pidAlive,
    /** Direct medium-file goodbye writer, or `undefined` (see {@link sayGoodbye}). */
    private readonly goodbyeWriter: (() => Promise<void>) | undefined = undefined,
  ) {}

  /**
   * Startup check + claim: judge the open-time global (the medium snapshot
   * the domain loaded), then stamp this boot as owner so later starters see
   * us. A failed claim propagates — an unwritable medium fails loud at mount.
   * @param storedGlobal - the domain's global value at open (`EMPTY_OWNER` reference when never written).
   */
  async startup(storedGlobal: unknown): Promise<void> {
    if (storedGlobal !== EMPTY_OWNER) this.judge(storedGlobal)
    await this.writeOwner({ ...this.own })
  }

  /**
   * Periodic medium read-back. Never throws; a broken read reports under
   * `owner-probe` and waits for the next tick. No-op without a reader.
   */
  async probe(): Promise<void> {
    if (this.readOwner === undefined) return
    let value: unknown
    try {
      value = await this.readOwner()
    } catch (error) {
      this.report('owner-probe', error)
      return
    }
    this.judge(value)
  }

  /**
   * Stamp `closedAt` on clean dispose so the next boot reads this writer as
   * gone instead of live. The goodbye prefers the direct medium-file writer:
   * at dispose time the storage facility's own unmount may have already
   * closed the domain (sibling fibers dispose concurrently), which would
   * reject the global-slot write with `closed`. The direct write is the
   * always-valid path. Best-effort: a failing goodbye is reported and
   * teardown continues (the pid-dead rule already keeps crashed/restarted
   * boots silent, so a lost goodbye costs nothing).
   */
  async sayGoodbye(): Promise<void> {
    if (this.goodbyeWriter !== undefined) {
      try {
        await this.goodbyeWriter()
        return
      } catch (error) {
        this.report('owner-goodbye', error)
        return
      }
    }
    try {
      await this.writeOwner({ ...this.own, closedAt: Date.now() })
    } catch (error) {
      // Fallback: without a medium path, the domain write is the only seam —
      // it may already be closed by the facility's unmount; report and let
      // teardown proceed.
      this.report('owner-goodbye', error)
    }
  }

  /**
   * Judge one medium-read value. Only a valid stamp with a foreign `bootId`,
   * no `closedAt`, and a still-alive pid is a live concurrent writer; own
   * stamps, closed writers, dead pids, and unreadable values stay silent.
   * Reports at most once per boot.
   */
  private judge(value: unknown): void {
    const parsed = ownerStampSchema.safeParse(value)
    if (!parsed.success) return
    const owner = parsed.data
    if (owner.bootId === this.own.bootId) return
    if (owner.closedAt !== undefined) return
    if (!this.isAlive(owner.pid)) return
    if (this.alerted) return
    this.alerted = true
    this.report('cross-process', new Error(
      `another live writer (pid ${owner.pid}, booted ${new Date(owner.startedAt).toISOString()})`
      + ' holds the memory medium; storage-json publishes are last-writer-wins across'
      + ' processes — stop one of the two DSH processes',
    ))
  }
}
