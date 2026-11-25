/**
 * The message-source kinds this package declares into the host's
 * merge-extensible `MessageSourceMap`.
 *
 * The host has no shared catch-all `plugin` source: each producer names its
 * own kind in its own module, and consumers fall through kinds they do not
 * know. One home for both of this package's producers, so the plugin modules
 * and the extraction call sites cannot drift.
 *
 * @module @chenhw7/dsh-memory/sources
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Memory context injected at the step tail: the one-time digest inventory
     * and the per-step recall fence. A later fence supersedes the previous
     * round's set, which is what `snapshot` declares.
     */
    'memory-context': { kind: 'memory-context' } & ContextFormed
    /** One-shot extraction prompts this package sends to the model; never part of a session surface. */
    'memory-review': { kind: 'memory-review' } & ContextFormed
  }
}

/** Source of the step-tail memory message (digest inventory + recall fence). */
export const MEMORY_CONTEXT_SOURCE = { kind: 'memory-context' } as const

/** Source of a memory-review extraction prompt. */
export const MEMORY_REVIEW_SOURCE = { kind: 'memory-review' } as const
