/**
 * System-prompt memory context injection and the `memory` settings namespace.
 *
 * This function plugin contributes one `memory` system-prompt section at order
 * 90 (before tool guidance at 100–199). On `session/created` it reads a frozen
 * snapshot of recalled memory from the optional `ctx.memory` store (global,
 * project, and user scopes) and freezes it per session so a running session
 * reuses the same recalled content across steps, preserving KV-cache prefix
 * stability. The section text is rebuilt at each assembly from the live
 * settings mode and the session's frozen snapshot.
 *
 * The `memory` settings namespace is registered through `ctx.settings` so the
 * frontend settings UI auto-renders a form; `applies: 'live'` means a mode
 * change takes effect on the next assembly without a restart.
 *
 * @module @chenhw7/dsh-memory/context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { MemoryEntry, MemoryScope } from '../types.ts'
import type { MemoryStore } from '../index.ts'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: resolves the `systemPrompt` service and the `AssembleContext`
// slot the section text provider receives.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: merges the `agent` field into `AssembleContext` so the section
// text provider can recover the session whose frozen snapshot it reads.
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { buildMemorySectionText, renderMemoryIndex, type MemoryMode, type IndexEntry } from './policy.ts'

export { buildMemorySectionText, renderMemoryIndex, MEMORY_POLICY_TEXT, MEMORY_CONTEXT_NOTE } from './policy.ts'
export type { MemoryMode, IndexEntry } from './policy.ts'

/** Cordis plugin name. */
export const name = 'memory-context'

/** The prompt registry is required; settings and memory are optional. */
export const inject = ['systemPrompt']

/** The settings namespace this plugin owns. */
const NS = settingsNamespace('memory')

const DEFAULT_MEMORY_MODE: MemoryMode = 'policy-only'
const DEFAULT_REVIEW_ENABLED = true
const DEFAULT_REVIEW_CANDIDATE_THRESHOLD = 10
const DEFAULT_FLUSH_ON_COMPACTION = true
const DEFAULT_FLUSH_ON_DISPOSE = true
const DEFAULT_MEMORY_CHAR_LIMIT = 5000

/** Per-session frozen memory state: the full-content snapshot and the index snapshot. */
interface FrozenSnapshot {
  readonly content: string
  readonly index: string
}

/** The `memory` system-prompt section name. */
const SECTION_NAME = 'memory'
/** Section order: before tool guidance (100–199). */
const SECTION_ORDER = 90
/** Scopes read into the frozen per-session memory snapshot, in render order. */
const SNAPSHOT_SCOPES: readonly MemoryScope[] = ['global', 'project', 'user']

/**
 * The `memory` settings-namespace shape, validated by the same-named
 * schemastery schema and doubling as the plugin's `cordis.yml` config. Every
 * field is optional in yml; the composition entry supplies the `base` layer
 * and the user settings document overlays it.
 */
export interface MemoryConfig {
  /** How recalled memory reaches the system prompt; defaults to `policy-only`. */
  memoryMode: MemoryMode
  /** User-supplied custom policy text, used only when `memoryMode` is `custom`. */
  memoryPolicyCustomText?: string
  /** Whether the memory review function plugin is active; defaults to `true`. */
  reviewEnabled: boolean
  /** Candidate threshold for the memory review pass; defaults to `10`. */
  reviewCandidateThreshold: number
  /** Flush pending memory writes on compaction; defaults to `true`. */
  flushOnCompaction: boolean
  /** Flush pending memory writes on session dispose; defaults to `true`. */
  flushOnDispose: boolean
  /** Character budget for the frozen memory content snapshot; defaults to `5000`. */
  memoryCharLimit: number
}

/** Runtime schema for the `memory` settings namespace and plugin config. */
export const Config: z<MemoryConfig> = z.object({
  memoryMode: z.union(['full', 'policy-only', 'custom', 'off', 'index'] as const).default(DEFAULT_MEMORY_MODE),
  memoryPolicyCustomText: z.string(),
  reviewEnabled: z.boolean().default(DEFAULT_REVIEW_ENABLED),
  reviewCandidateThreshold: z.number().step(1).min(0).default(DEFAULT_REVIEW_CANDIDATE_THRESHOLD),
  flushOnCompaction: z.boolean().default(DEFAULT_FLUSH_ON_COMPACTION),
  flushOnDispose: z.boolean().default(DEFAULT_FLUSH_ON_DISPOSE),
  memoryCharLimit: z.number().step(1).min(0).default(DEFAULT_MEMORY_CHAR_LIMIT),
})

/** Render one scope's entries as a bulleted list under a `## <scope>` heading. */
function renderScope(scope: MemoryScope, entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map(entry => `- ${entry.content}`)
  return `## ${scope}\n${lines.join('\n')}`
}

/**
 * Read a frozen memory-content snapshot from the store across the global,
 * project, and user scopes, joined and truncated to the character budget.
 * @param memory - the live memory store.
 * @param charLimit - character budget; `0` yields no content.
 * @returns the rendered snapshot text, possibly truncated.
 */
export function readMemorySnapshot(memory: MemoryStore, charLimit: number): string {
  if (charLimit <= 0) return ''
  const parts: string[] = []
  for (const scope of SNAPSHOT_SCOPES) {
    const rendered = renderScope(scope, memory.list(scope))
    if (rendered.length > 0) parts.push(rendered)
  }
  let text = parts.join('\n\n')
  if (text.length > charLimit) {
    text = `${text.slice(0, charLimit)}\n…(memory truncated at ${charLimit} characters)`
  }
  return text
}

/**
 * Read a frozen memory-index snapshot from the store: one existence line per
 * entry, ordered by relevance, with category roll-up when the budget is
 * exhausted. The index size grows with the number of categories, not entries.
 * @param memory - the live memory store.
 * @param charLimit - character budget; `0` yields no index.
 * @returns the rendered index text, possibly truncated with roll-up lines.
 */
export function readMemoryIndex(memory: MemoryStore, charLimit: number): string {
  if (charLimit <= 0) return ''
  const all = memory.list()
  const entries: IndexEntry[] = all.map(entry => ({
    id: entry.id as string,
    scope: entry.scope,
    ...entry.category !== undefined ? { category: entry.category } : {},
    ...entry.projectName !== undefined ? { projectName: entry.projectName } : {},
    content: entry.content,
    updatedAt: entry.updatedAt,
  }))
  return renderMemoryIndex(entries, charLimit)
}

/**
 * Register the `memory` settings namespace and the `memory` system-prompt
 * section. The section text is a function evaluated at each assembly: it reads
 * the live settings mode and the session's frozen memory snapshot, so a
 * settings change takes effect on the next assembly while the recalled
 * content stays frozen for the session.
 * @param ctx - Cordis context carrying the prompt registry.
 * @param config - resolved plugin entry config, used as the settings `base`.
 */
export function apply(ctx: Context, config: MemoryConfig): void {
  // Source thunk for the current resolved settings: the settings scope while
  // one is attached, the composition entry otherwise. Reassigned by
  // `installSettingsSection` on attach and detach.
  let current = (): MemoryConfig => config

  // Per-session frozen memory snapshots (content + index), read once at session/created.
  const sessionMemory = new WeakMap<Session, FrozenSnapshot>()

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    // The section text provider reads settings live at each assembly, so a
    // committed change is picked up without re-judging registration-level facts.
    onChange: () => {},
  })

  ctx.on('session/created', (session: Session) => {
    const memory = ctx.get('memory')
    if (memory === undefined) {
      sessionMemory.set(session, { content: '', index: '' })
      return
    }
    const charLimit = current().memoryCharLimit
    sessionMemory.set(session, {
      content: readMemorySnapshot(memory, charLimit),
      index: readMemoryIndex(memory, charLimit),
    })
  }, { global: true })

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context: AssembleContext): string => {
      const settings = current()
      const session = context.agent?.session
      const snapshot = session === undefined ? undefined : sessionMemory.get(session)
      const memoryContent = snapshot?.content ?? ''
      const indexContent = snapshot?.index ?? ''
      return buildMemorySectionText(settings.memoryMode, settings.memoryPolicyCustomText, memoryContent, indexContent)
    },
  }), 'memory-context.section()')
}
