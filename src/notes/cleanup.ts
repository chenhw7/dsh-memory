/**
 * One-time cleanup of legacy on-repo artifacts from the file-export era
 * (≤ 0.5.x): the rendered notes files and the managed AGENTS.md pointer
 * block. dsh-memory 0.6+ never writes into the user's project; this module
 * only REMOVES what earlier versions left behind, under conservative rules:
 *
 * - AGENTS.md: only the managed marker block is stripped — every byte outside
 *   the markers is preserved. When nothing but the block (plus whitespace)
 *   remains, the file is deleted: it was the pointer-only file we created.
 * - Notes directory (≤0.5.x default `docs/agent-memory`): only the files we
 *   generated — `CONVENTIONS.md`, `PITFALLS.md`, and their `.bak.<ts>` drift
 *   backups — are deleted; foreign files keep the directory alive.
 *
 * Best-effort by design: every failure is swallowed, every action is logged
 * once. Idempotent — a second run finds nothing to do. The user's
 * `.gitignore` is never touched.
 *
 * @module @chenhw7/dsh-memory/notes/cleanup
 */

import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Marker opening the managed pointer block a ≤0.5.x install wrote into AGENTS.md. */
export const AGENTS_POINTER_BEGIN = '<!-- dsh-memory:begin -->'
/** Marker closing the managed pointer block. */
export const AGENTS_POINTER_END = '<!-- dsh-memory:end -->'

/** The default notes dir location ≤0.5.x exported to (custom notesDir values are not recoverable here). */
export const LEGACY_NOTES_DIR = path.join('docs', 'agent-memory')

/** Files a ≤0.5.x install generated into the notes dir (name, not path). */
const GENERATED_FILE = /^(CONVENTIONS|PITFALLS)\.md(\.bak\.\d+)?$/

/** Host logger channel; structural subset so tests can pass a plain object. */
export interface LegacyCleanupLogger {
  info(message: string): void
  warn(message: string): void
}

/** Warn through the host logger when one best-effort cleanup op fails. */
function warnOpFailure(logger: LegacyCleanupLogger | undefined, target: string, error: unknown): void {
  logger?.warn(`dsh-memory: legacy cleanup failed on ${target}: ${String(error)}`)
}

/**
 * Strip the managed pointer block from AGENTS.md content. Everything outside
 * the markers is returned untouched; content without a complete marker pair
 * is returned unchanged.
 * @param content - the AGENTS.md text.
 * @returns the text without the managed block.
 */
export function stripAgentsPointerBlock(content: string): string {
  const begin = content.indexOf(AGENTS_POINTER_BEGIN)
  if (begin < 0) return content
  const end = content.indexOf(AGENTS_POINTER_END, begin)
  if (end < 0) return content
  return content.slice(0, begin) + content.slice(end + AGENTS_POINTER_END.length)
}

/**
 * Remove the repo artifacts a ≤0.5.x install left in one project: the managed
 * AGENTS.md pointer block and the generated files under the default notes
 * dir. Idempotent, best-effort, and chatty (one log line per action) — see
 * the module docs for the exact safety rules.
 * @param projectRoot - absolute path of the project root (session cwd).
 * @param logger - host logger channel for the per-action log lines and op failures.
 */
export async function cleanupLegacyNotesArtifacts(projectRoot: string, logger?: LegacyCleanupLogger): Promise<void> {
  await cleanupAgentsPointer(projectRoot, logger)
  await cleanupNotesDir(projectRoot, logger)
}

/** Strip (or delete) the legacy AGENTS.md pointer block in one project root. */
async function cleanupAgentsPointer(projectRoot: string, logger?: LegacyCleanupLogger): Promise<void> {
  const agentsPath = path.join(projectRoot, 'AGENTS.md')
  const existing = await readFile(agentsPath, 'utf8').catch(() => undefined)
  if (existing === undefined || !existing.includes(AGENTS_POINTER_BEGIN)) return
  const stripped = stripAgentsPointerBlock(existing)
  if (stripped.trim().length === 0) {
    await rm(agentsPath).catch((error: unknown) => { warnOpFailure(logger, agentsPath, error) })
    logger?.info('[dsh-memory] removed the pointer-only AGENTS.md left by ≤0.5.x in this project (memory is now managed in the host store + Memory UI only).')
    return
  }
  await writeFile(agentsPath, stripped, 'utf8').catch((error: unknown) => { warnOpFailure(logger, agentsPath, error) })
  logger?.info('[dsh-memory] stripped the managed dsh-memory pointer block from AGENTS.md (other content untouched).')
}

/** Delete the generated files (only those) under the legacy notes dir. */
async function cleanupNotesDir(projectRoot: string, logger?: LegacyCleanupLogger): Promise<void> {
  const notesDir = path.join(projectRoot, LEGACY_NOTES_DIR)
  const names = await readdir(notesDir).catch(() => undefined)
  if (names === undefined) return
  let removed = 0
  for (const name of names) {
    if (!GENERATED_FILE.test(name)) continue
    await rm(path.join(notesDir, name), { force: true }).catch((error: unknown) => { warnOpFailure(logger, path.join(notesDir, name), error) })
    removed++
  }
  const rest = await readdir(notesDir).catch(() => [])
  if (rest.length === 0) {
    await rm(notesDir, { recursive: true, force: true }).catch((error: unknown) => { warnOpFailure(logger, notesDir, error) })
  }
  if (removed > 0) {
    logger?.info(`[dsh-memory] removed ${removed} generated notes file(s) under ${LEGACY_NOTES_DIR}/ left by ≤0.5.x (the memory store remains the source of truth).`)
  }
}
