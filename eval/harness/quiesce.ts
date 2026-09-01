/**
 * Quiescence polling for the memory storage medium under a throwaway
 * `$DSH_HOME`: `waitForQuiesce` resolves only when `<dshHome>/storages/
 * memory.json` has held one identical snapshot (whole file content plus the
 * audit table's max `seq`) for a settle window, so a slow extraction flush or
 * dispose write fails loudly at the timeout instead of silently deflating a
 * measurement.
 *
 * The snapshot extractor is a pure export so vitest can cover the stability
 * judgment with fixture file contents.
 *
 * @module eval/harness/quiesce
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The memory storage medium path under a harness home. */
export function memoryMediumPath(dshHome: string): string {
  return join(dshHome, 'storages', 'memory.json')
}

/** One observed state of the memory medium. */
export interface MediumSnapshot {
  /** Raw file content; `''` when the file does not exist yet. */
  readonly raw: string
  /** Max audit-record `seq` on the medium; 0 when absent (pre-audit media). */
  readonly maxAuditSeq: number
  /** Entry-record count in the `entries` table. */
  readonly entryCount: number
}

/**
 * Extract the comparable snapshot from one medium file's text. Tolerates
 * pre-audit media (no `tables.audit` key) and a missing file — both read as
 * empty states; a malformed medium throws (misconfiguration fails loud).
 */
export function mediumSnapshot(raw: string): MediumSnapshot {
  if (raw.length === 0) return { raw, maxAuditSeq: 0, entryCount: 0 }
  const document = JSON.parse(raw) as {
    tables?: { entries?: Record<string, unknown>; audit?: Record<string, { seq?: number }> }
  }
  const entries = document.tables?.entries ?? {}
  const audit = document.tables?.audit ?? {}
  let maxAuditSeq = 0
  for (const record of Object.values(audit)) {
    const seq = record?.seq
    if (typeof seq === 'number' && seq > maxAuditSeq) maxAuditSeq = seq
  }
  return { raw, maxAuditSeq, entryCount: Object.keys(entries).length }
}

/** Read the current medium snapshot; a missing file is the empty state. */
export function readMediumSnapshot(dshHome: string): MediumSnapshot {
  let raw = ''
  try {
    raw = readFileSync(memoryMediumPath(dshHome), 'utf8')
  } catch (error) {
    // ENOENT is the untouched-store state (nothing written yet); any other
    // read failure is a filesystem fault and must surface.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return mediumSnapshot(raw)
}

/** Whether two snapshots describe the same settled medium state. */
export function snapshotStable(a: MediumSnapshot, b: MediumSnapshot): boolean {
  return a.raw === b.raw && a.maxAuditSeq === b.maxAuditSeq
}

/** Options for {@link waitForQuiesce}. */
export interface QuiesceOptions {
  /** Required stability window in milliseconds (default 600). */
  settleMs?: number
  /** Poll interval in milliseconds (default 200). */
  intervalMs?: number
}

/**
 * Poll the memory medium until its snapshot holds stable for `settleMs`.
 * @param dshHome - the harness home whose storage is awaited.
 * @param timeoutMs - overall bound; a timeout throws (the caller decides
 * whether the run can continue — it usually cannot).
 * @throws on timeout, or when the medium exists but is unreadable/unparsable.
 */
export async function waitForQuiesce(dshHome: string, timeoutMs: number, options: QuiesceOptions = {}): Promise<void> {
  const settleMs = options.settleMs ?? 600
  const intervalMs = options.intervalMs ?? 200
  const deadline = Date.now() + timeoutMs
  let last = readMediumSnapshot(dshHome)
  let lastChange = Date.now()
  for (;;) {
    await delay(intervalMs)
    const current = readMediumSnapshot(dshHome)
    const now = Date.now()
    if (!snapshotStable(last, current)) {
      last = current
      lastChange = now
    }
    if (now - lastChange >= settleMs) return
    if (now >= deadline) {
      throw new Error(
        `eval quiesce: memory medium at ${memoryMediumPath(dshHome)} did not settle within ${String(timeoutMs)}ms `
        + `(entries=${String(current.entryCount)}, maxAuditSeq=${String(current.maxAuditSeq)}, `
        + `bytes=${String(current.raw.length)}); a flush or dispose write is still running or the medium is stuck`,
      )
    }
  }
}

/** Sleep helper (promisified timeout with the unref pattern kept local). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}
