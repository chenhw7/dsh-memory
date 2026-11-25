/**
 * `@chenhw7/dsh-memory/notes`: the project-notes projection
 * (TECH_DESIGN §7.4; rationale: the prompt-only Agent Note
 * .agents/notes/implemented/architecture/2026-08-31-project-notes-writes-no-repository-files.md).
 * A function plugin that renders habit/convention/pitfall entries from the
 * memory store into the `project-notes` system-prompt section. Since 0.6 it
 * writes NOTHING into the user's project — the store is the sole source of
 * truth, the Memory settings UI is the management surface, and the one-time
 * `cleanup` pass removes artifacts left by ≤0.5.x file exports.
 *
 * Rendering is synchronous from the store's in-memory state — the same text
 * `memory-context` freezes into its per-session prompt snapshot.
 *
 * @module @chenhw7/dsh-memory/notes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { scanContent } from '../scanner.ts'
import type { MemoryStore } from '../index.ts'
import { isRenderedEntry } from './scope.ts'
import z from '@deepseek-ai/schemastery'
import { renderConventions, renderPitfalls } from './render.ts'
import { cleanupLegacyNotesArtifacts } from './cleanup.ts'
import { NOTES_FIELDS, DEFAULT_NOTES_SETTINGS, resolveNotesSettings, type NotesConfigValue, type NotesSettings } from './settings.ts'

export { isRenderedEntry } from './scope.ts'
export { renderConventions, renderPitfalls } from './render.ts'
export { cleanupLegacyNotesArtifacts, stripAgentsPointerBlock, AGENTS_POINTER_BEGIN, AGENTS_POINTER_END, LEGACY_NOTES_DIR } from './cleanup.ts'
export { resolveNotesSettings, DEFAULT_NOTES_ENABLED, DEFAULT_NOTES_CONVENTIONS_CHAR_LIMIT, DEFAULT_NOTES_PITFALLS_CHAR_LIMIT, DEFAULT_NOTES_MAX_ENTRIES_PER_FILE, DEFAULT_NOTES_SETTINGS, NOTES_FIELDS } from './settings.ts'
export type { NotesSettings, NotesConfigValue } from './settings.ts'

/** Cordis plugin name. */
export const name = 'memory-notes'

/** Nothing is required: `memory` is accessed optionally. */
export const inject: string[] = []

/**
 * The `memory-notes` entry config — the form behind the Project Notes section
 * of the bundle's settings page. The entry id is also the settings namespace
 * the host addresses the entry by, so the page's section and this schema are
 * one binding.
 */
export const Config = z.object(NOTES_FIELDS)

/**
 * Frozen project-notes content for one project root: the rendered section
 * texts, injected into the system prompt. Empty strings mean "nothing to
 * inject" (disabled or no store); without a cwd the project-scope slice is
 * absent but the global/user slices still render.
 */
export interface ProjectNotesSnapshot {
  /** Rendered conventions section (possibly only the header). */
  readonly conventions: string
  /** Rendered pitfalls section (possibly only the header). */
  readonly pitfalls: string
}

/** The empty snapshot. */
const EMPTY_SNAPSHOT: ProjectNotesSnapshot = { conventions: '', pitfalls: '' }

/**
 * The project-notes service, registered on `ctx.projectNotes` by this plugin.
 * Consumers (memory-context) render and read through it. Pure — no I/O.
 */
export abstract class ProjectNotesService {
  constructor() {
    if (new.target === ProjectNotesService) {
      throw new TypeError('ProjectNotesService is abstract and cannot be instantiated directly')
    }
  }

  /**
   * Render and return the notes snapshot for a project root from the store.
   * Idempotent and side-effect free. An undefined `cwd` means "no current
   * project": project-scope entries drop out of the snapshot, but the
   * global/user slices still render. The per-kind character budgets apply
   * HERE — at render/freeze time — so a live budget change takes effect at
   * the next snapshot (session/created or compaction/end), not per assembly;
   * the section assembly's fence cap is the final defense.
   * @param cwd - the session working directory (project root), or undefined.
   * @returns the rendered snapshot; empty strings when disabled or unavailable.
   */
  abstract snapshotFor(cwd: string | undefined): ProjectNotesSnapshot

  /**
   * The resolved `memory-notes` entry settings. `memory-context` reads the
   * budgets and the enabled gate from here instead of reading a shared
   * settings namespace.
   * @returns the resolved settings, with every default materialized.
   */
  abstract settings(): NotesSettings
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
  private readonly settingsSource: () => NotesSettings

  constructor(ctx: Context, settingsSource: () => NotesSettings) {
    super()
    this.ctx = ctx
    this.settingsSource = settingsSource
  }

  override settings(): NotesSettings {
    return this.settingsSource()
  }

  override snapshotFor(cwd: string | undefined): ProjectNotesSnapshot {
    try {
      const settings = this.settingsSource()
      const memory: MemoryStore | undefined = this.ctx.get('memory')
      if (!settings.notesEnabled || memory === undefined) {
        return EMPTY_SNAPSHOT
      }
      // No cwd → there is no current project, so project-scope entries drop
      // out, but the global/user slices still render.
      const projectName = cwd === undefined || cwd.length === 0 ? undefined : projectNameOf(cwd)
      const conventions: import('../types.ts').MemoryEntry[] = []
      const pitfalls: import('../types.ts').MemoryEntry[] = []
      for (const entry of memory.list()) {
        // Load-time guard: entries that fail the scanner never reach the
        // exported section (which feeds future injections). Unlike the prompt
        // surfaces there is no placeholder here — an omitted section entry is
        // simply absent; the store keeps the original for user inspection and
        // removal.
        if (!scanContent(entry.content).allowed) continue
        // Soft-decayed entries drop out of every standing view, this one included.
        if (entry.staleSince !== undefined) continue
        const kind = isRenderedEntry(entry, projectName)
        if (kind === 'conventions') conventions.push(entry)
        else if (kind === 'pitfalls') pitfalls.push(entry)
      }
      return {
        conventions: renderConventions(conventions, settings.notesMaxEntriesPerFile, settings.notesConventionsCharLimit),
        pitfalls: renderPitfalls(pitfalls, settings.notesMaxEntriesPerFile, settings.notesPitfallsCharLimit),
      }
    } catch (error) {
      this.ctx.get('memory')?.reportFailure('notes-snapshot', error)
      return EMPTY_SNAPSHOT
    }
  }
}

/**
 * Install the memory-notes plugin: register the `projectNotes` service and
 * the one-time legacy-artifact cleanup on `session/created` (≤0.5.x wrote
 * rendered files + an AGENTS.md pointer into the repo; 0.6 removes them).
 *
 * The entry `Config` is the settings surface: the host resolves it from the
 * profile patch and re-runs this function on a change, so the service always
 * reads the live value.
 * @param ctx - Cordis context.
 * @param config - the `memory-notes` entry config.
 */
export function apply(ctx: Context, config: NotesConfigValue = DEFAULT_NOTES_SETTINGS): void {
  const settings = resolveNotesSettings(config)
  const service = new ProjectNotesServiceImpl(ctx, () => settings)
  ctx.provide('projectNotes', service)

  // One-time migration: strip the file-export artifacts a ≤0.5.x install
  // left in this project (marker-managed AGENTS.md block, generated notes
  // files). Once per project root per process; idempotent, best-effort.
  const cleanedRoots = new Set<string>()
  ctx.on('session/created', (session: Session) => {
    const cwd = session.header?.cwd
    if (cwd === undefined || cwd.length === 0 || cleanedRoots.has(cwd)) return
    cleanedRoots.add(cwd)
    void cleanupLegacyNotesArtifacts(cwd, ctx.logger).catch((error: unknown) => {
      ctx.get('memory')?.reportFailure('legacy-cleanup', error)
    })
  }, { global: true })
}
