/**
 * `@chenhw7/dsh-memory/notes`: the project-notes exporter (docs/PROJECT_NOTES.zh-CN.md).
 * A function plugin that renders habit/convention/pitfall entries from the
 * memory store into in-repo markdown files (`docs/agent-memory/` by default)
 * and maintains an AGENTS.md pointer block.
 *
 * The store is the source of truth; the files are a read-only rendered view.
 * Rendering is synchronous from the store's in-memory state — the same text
 * that is persisted (async, atomic) is also what `memory-context` freezes
 * into its per-session prompt snapshot, so prompt and files can never drift.
 * Persistence is skipped when nothing changed since the last render.
 *
 * @module @chenhw7/dsh-memory/notes
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scanContent } from '../scanner.ts'
import type { MemoryStore } from '../index.ts'
import { isRenderedEntry } from './scope.ts'
import { renderConventions, renderPitfalls } from './render.ts'
import { ensureAgentsPointer, writeFileAtomic, writeNotesFile, DriftError } from './writer.ts'
import { resolveNotesSettings, resolveNotesDir, type NotesSettings } from './settings.ts'

export { isRenderedEntry } from './scope.ts'
export { renderConventions, renderPitfalls } from './render.ts'
export { ensureAgentsPointer, writeFileAtomic, writeNotesFile, DriftError, agentsPointerBlock, AGENTS_POINTER_BEGIN, AGENTS_POINTER_END } from './writer.ts'
export { resolveNotesSettings, DEFAULT_NOTES_ENABLED, DEFAULT_NOTES_DIR, DEFAULT_NOTES_CHAR_LIMIT, DEFAULT_NOTES_AGENTS_POINTER, DEFAULT_NOTES_MAX_ENTRIES_PER_FILE } from './settings.ts'
export type { NotesSettings } from './settings.ts'

/** Cordis plugin name. */
export const name = 'memory-notes'

/** Nothing is required: `memory` and `settings` are accessed optionally. */
export const inject: string[] = []

/** The settings namespace owned by `memory-context`, read here defensively. */
const MEMORY_NS = settingsNamespace('memory')

/** Debounce window for activity-triggered re-renders, in milliseconds. */
const RENDER_DEBOUNCE_MS = 2_000

/**
 * Frozen project-notes content for one project root: the rendered file texts.
 * Empty strings mean "nothing to inject" (disabled or no store); without a cwd
 * the project-scope slice is absent but the global/user slices still render.
 */
export interface ProjectNotesSnapshot {
  /** Rendered CONVENTIONS.md content (possibly only the header). */
  readonly conventions: string
  /** Rendered PITFALLS.md content (possibly only the header). */
  readonly pitfalls: string
}

/** The empty snapshot. */
const EMPTY_SNAPSHOT: ProjectNotesSnapshot = { conventions: '', pitfalls: '' }

/**
 * The project-notes service, registered on `ctx.projectNotes` by this plugin.
 * Consumers (memory-context and this plugin's own handlers) reconcile and
 * read through it.
 */
export abstract class ProjectNotesService {
  constructor() {
    if (new.target === ProjectNotesService) {
      throw new TypeError('ProjectNotesService is abstract and cannot be instantiated directly')
    }
  }

  /**
   * Reconcile and return the notes snapshot for a project root: renders from
   * the store synchronously and fires the async atomic writes. Idempotent —
   * unchanged content does not rewrite the files. An undefined `cwd` means
   * "no current project": project-scope entries drop out of the snapshot and
   * nothing is persisted, but the global/user slices still render.
   * @param cwd - the session working directory (project root), or undefined.
   * @returns the rendered snapshot; empty strings when disabled or unavailable.
   */
  abstract snapshotFor(cwd: string | undefined): ProjectNotesSnapshot
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    projectNotes: ProjectNotesService
  }
}

/** Infer the project name from a working-directory path (cwd basename). */
function projectNameOf(cwd: string): string | undefined {
  const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return base !== undefined && base.length > 0 ? base : undefined
}

/** The default service implementation. All failures are swallowed by design. */
class ProjectNotesServiceImpl extends ProjectNotesService {
  private readonly ctx: Context
  private readonly settings: () => NotesSettings
  /** Last persisted file texts per notes dir, for skip-if-unchanged and drift detection. */
  private readonly persisted = new Map<string, ProjectNotesSnapshot>()
  /** Set to true when a drift error was already reported for this dir (log-once). */
  private readonly driftReported = new Set<string>()
  /** Last store health timestamp already rendered, for the dirty check. */
  private renderedHealthTs: number | undefined
  /** notesDir values already reported as escaping the project root (log-once). */
  private readonly traversalReported = new Set<string>()
  /** Debounce timer for activity-triggered re-renders. */
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(ctx: Context, settings: () => NotesSettings) {
    super()
    this.ctx = ctx
    this.settings = settings
  }

  override snapshotFor(cwd: string | undefined): ProjectNotesSnapshot {
    try {
      const settings = this.settings()
      const memory: MemoryStore | undefined = this.ctx.get('memory')
      if (!settings.notesEnabled || memory === undefined) {
        return EMPTY_SNAPSHOT
      }
      // No cwd → there is no current project, so project-scope entries drop
      // out, but the global/user slices still render; persistence is skipped
      // (there is no project root to write the files into).
      const projectName = cwd === undefined || cwd.length === 0 ? undefined : projectNameOf(cwd)
      const conventions: import('../types.ts').MemoryEntry[] = []
      const pitfalls: import('../types.ts').MemoryEntry[] = []
      for (const entry of memory.list()) {
        // Load-time guard: entries that fail the scanner never reach the
        // exported files (which feed both git and future injections). Unlike
        // the prompt surfaces there is no placeholder here — an omitted
        // section entry is simply absent; the store keeps the original for
        // user inspection and removal.
        if (!scanContent(entry.content).allowed) continue
        // Soft-decayed entries drop out of every standing view, files included.
        if (entry.staleSince !== undefined) continue
        const kind = isRenderedEntry(entry, projectName)
        if (kind === 'conventions') conventions.push(entry)
        else if (kind === 'pitfalls') pitfalls.push(entry)
      }
      const snapshot: ProjectNotesSnapshot = {
        conventions: renderConventions(conventions, settings.notesMaxEntriesPerFile),
        pitfalls: renderPitfalls(pitfalls, settings.notesMaxEntriesPerFile),
      }
      if (cwd !== undefined && cwd.length > 0) this.persist(cwd, snapshot, settings)
      this.renderedHealthTs = memory.health().lastActivityTs
      return snapshot
    } catch {
      return EMPTY_SNAPSHOT
    }
  }

  /** Render + persist only when the store changed since the last render. */
  reconcileIfStale(cwd: string | undefined): void {
    const memory: MemoryStore | undefined = this.ctx.get('memory')
    if (memory === undefined) return
    const ts = memory.health().lastActivityTs
    if (ts === undefined || ts === this.renderedHealthTs) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      try {
        this.snapshotFor(cwd)
      } catch {
        // Best-effort: a re-render failure never propagates.
      }
    }, RENDER_DEBOUNCE_MS)
  }

  /** Persist the snapshot atomically when it differs from the last write. */
  private persist(cwd: string, snapshot: ProjectNotesSnapshot, settings: NotesSettings): void {
    const dir = resolveNotesDir(cwd, settings.notesDir)
    if (dir === undefined) {
      // Containment: an escaping notesDir must never direct writes outside
      // the project. Rendered snapshots keep flowing to the prompt; only the
      // file persistence is skipped.
      if (!this.traversalReported.has(settings.notesDir)) {
        this.traversalReported.add(settings.notesDir)
        console.warn(`[dsh-memory] notesDir "${settings.notesDir}" resolves outside the project root; skipping notes persistence for it.`)
      }
      return
    }
    const previous = this.persisted.get(dir)
    if (previous !== undefined && previous.conventions === snapshot.conventions && previous.pitfalls === snapshot.pitfalls) {
      return
    }
    void (async () => {
      try {
        await writeNotesFile(path.join(dir, 'CONVENTIONS.md'), snapshot.conventions, previous?.conventions)
        await writeNotesFile(path.join(dir, 'PITFALLS.md'), snapshot.pitfalls, previous?.pitfalls)
        if (settings.notesAgentsPointer) {
          await ensureAgentsPointer(path.join(cwd, 'AGENTS.md'), settings.notesDir)
        }
        // Only after a successful write: record this snapshot as the drift
        // baseline so the next write can detect external modifications.
        this.persisted.set(dir, snapshot)
      } catch (error) {
        if (error instanceof DriftError) {
          // Drift: external modification was backed up to `.bak.<ts>`;
          // the store remains the source of truth and the in-memory
          // snapshot continues to be served. Update the baseline to the
          // drifted on-disk content so the NEXT persist attempt can write
          // fresh content (the drift has been "absorbed" as the new base).
          try {
            const { readFile } = await import('node:fs/promises')
            const driftedConventions = await readFile(path.join(dir, 'CONVENTIONS.md'), 'utf8').catch(() => undefined)
            const driftedPitfalls = await readFile(path.join(dir, 'PITFALLS.md'), 'utf8').catch(() => undefined)
            if (driftedConventions !== undefined || driftedPitfalls !== undefined) {
              this.persisted.set(dir, {
                conventions: driftedConventions ?? previous?.conventions ?? '',
                pitfalls: driftedPitfalls ?? previous?.pitfalls ?? '',
              })
            }
          } catch { /* best-effort */ }
          // Report once per notes dir so the log is not spammed on every
          // reconcile cycle; the user should reconcile the .bak file.
          if (!this.driftReported.has(dir)) {
            this.driftReported.add(dir)
            console.warn(`[dsh-memory] ${error.message}. The in-memory snapshot continues to be served; resolve the drift by reviewing the .bak file and re-saving via memory tools.`)
          }
          return
        }
        // Best-effort: persistence failures never surface to the session.
      }
    })()
  }
}

/**
 * Install the memory-notes plugin: register the `projectNotes` service and
 * the reconcile triggers (`agent/pre-step` dirty check; `memory-context`
 * additionally reconciles on `session/created` via the service itself).
 * @param ctx - Cordis context.
 */
export function apply(ctx: Context): void {
  const settings = (): NotesSettings => {
    try {
      return resolveNotesSettings(ctx.settings.get(MEMORY_NS))
    } catch {
      return resolveNotesSettings(undefined)
    }
  }
  const service = new ProjectNotesServiceImpl(ctx, settings)
  ctx.provide('projectNotes', service)

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      service.reconcileIfStale(agent.session.header?.cwd)
    } catch {
      // Best-effort: never block the step.
    }
    return next()
  })
}
