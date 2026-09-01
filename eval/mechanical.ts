/**
 * Mechanical recall metrics — eval/rubric/recall-v1.md, "Mechanical item":
 * standing hit, noise ratio and injection cost are computed by the harness
 * in code; the judge never outputs them. Pure functions over the assembled
 * system prompt, no I/O and no plugin imports — the build under test is a
 * variable, so fence shapes are matched structurally (entry lines are bullets
 * or scope-prefixed index lines), never by quoting the current plugin's
 * framing text.
 *
 * @module eval/mechanical
 */

/** Fence tags that carry memory material in the opening system prompt. */
export const MEMORY_FENCE_TAGS = ['memory-context', 'memory-index', 'project-notes'] as const
export type MemoryFenceTag = (typeof MEMORY_FENCE_TAGS)[number]

/** One extracted memory-bearing fence (body excludes the tags). */
export interface MemoryFence {
  readonly tag: MemoryFenceTag
  readonly body: string
}

/**
 * Extract the memory-bearing fences from a system prompt in the order they
 * appear (first occurrence per tag). Content that tried to forge a closer is
 * neutralized by the plugin (`</memory-index>` → `<\/memory-index>`), so the
 * non-greedy scan cannot end inside stored content.
 */
export function parseMemoryFences(systemPrompt: string): MemoryFence[] {
  const found: Array<{ tag: MemoryFenceTag; start: number; body: string }> = []
  for (const tag of MEMORY_FENCE_TAGS) {
    const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(systemPrompt)
    if (match?.[1] !== undefined) found.push({ tag, start: match.index, body: match[1] })
  }
  return found.sort((a, b) => a.start - b.start).map(({ tag, body }) => ({ tag, body }))
}

/**
 * The verbatim `injectedMemory` input of the recall rubric: the
 * memory-bearing fence blocks (tags included, framing policy text excluded),
 * joined with a blank line. Empty string when nothing was injected.
 */
export function injectedMemoryText(systemPrompt: string): string {
  return parseMemoryFences(systemPrompt)
    .map(fence => `<${fence.tag}>\n${fence.body}\n</${fence.tag}>`)
    .join('\n\n')
}

/**
 * The injected entry lines an entry-level judgment runs over: content
 * bullets (`full` mode, project-notes) and scope-prefixed index lines
 * (`index` mode). Framing notes, scope headings, truncation footers and
 * roll-up lines are boilerplate, not entries.
 */
export function injectedEntryLines(systemPrompt: string): string[] {
  const lines: string[] = []
  for (const fence of parseMemoryFences(systemPrompt)) {
    for (const raw of fence.body.split('\n')) {
      const line = raw.trim()
      if (line.startsWith('- ') || /^(?:global|project|user)(?:\/[a-z0-9-]+)?\s*·\s/.test(line)) {
        lines.push(line)
      }
    }
  }
  return lines
}

/** The text a fact is matched by: statement content plus its summary. */
export interface FactText {
  readonly content: string
  readonly summary?: string
}

/**
 * English function words that never decide a match (rubric: "pure function
 * words never decide a match"). Deliberately small — content words stay in.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'its',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'done', 'has', 'have', 'had',
  'i', 'you', 'he', 'she', 'we', 'they', 'them', 'their', 'my', 'your', 'our', 'me', 'him', 'her', 'us',
  'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'to', 'into', 'onto', 'about', 'as', 'if',
  'and', 'or', 'but', 'nor', 'not', 'no', 'so', 'then', 'than', 'when', 'while',
  'before', 'after', 'since', 'until', 'because', 'though', 'although', 'however',
  'also', 'too', 'very', 'just', 'only', 'must', 'should', 'shall', 'will',
  'would', 'can', 'could', 'may', 'might', 'use', 'used', 'using',
])

/**
 * Normalize one ASCII token so morphological plurals collapse onto their
 * stem (`tests` → `test`); deeper morphology is out of scope for v0.
 */
function normalizeAsciiToken(token: string): string {
  if (token.length >= 4 && token.endsWith('s')
    && !token.endsWith('ss') && !token.endsWith('us') && !token.endsWith('is')) {
    return token.slice(0, -1)
  }
  return token
}

/**
 * Distinctive tokens of a text: lowercase ASCII alnum runs (function words
 * dropped, length ≥ 2 unless numeric) plus CJK character bigrams (a lone CJK
 * character stands alone). Identifiers split on punctuation, so
 * `pnpm-lock.yaml` yields `pnpm`, `lock`, `yaml`.
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const lowered = text.toLowerCase()
  for (const match of lowered.matchAll(/[a-z0-9]+/g)) {
    const raw = match[0] ?? ''
    if (raw.length < 2 && !/\d/.test(raw)) continue
    const token = normalizeAsciiToken(raw)
    if (STOPWORDS.has(token)) continue
    tokens.add(token)
  }
  for (const match of lowered.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0] ?? ''
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2))
  }
  return tokens
}

/** ASCII tokens (tool names, numbers, identifiers) decide close calls; CJK bigrams do not. */
function isAsciiToken(token: string): boolean {
  return /^[a-z0-9]+$/.test(token)
}

/** Whether a fact token occurs in a line's token set, allowing morphological/identifier prefixes. */
function tokenPresent(token: string, lineTokens: ReadonlySet<string>): boolean {
  if (lineTokens.has(token)) return true
  if (token.length < 4) return false
  for (const candidate of lineTokens) {
    if (candidate.length >= 4 && (candidate.startsWith(token) || token.startsWith(candidate))) return true
  }
  return false
}

/** Minimum length for a verbatim-containment hit; shorter texts fall through to the token rule. */
const VERBATIM_MIN_CHARS = 4

/** Whether two facts describe the same statement (content plus summary). */
function sameFactText(a: FactText, b: FactText): boolean {
  return a.content === b.content && (a.summary ?? '') === (b.summary ?? '')
}

/**
 * Whether one fact's text (content plus summary) surfaces in ONE injected
 * entry or index line — the PAIR-level rule, no sibling context. Verbatim
 * surface first (the index line shows the summary or an 80-character content
 * prefix verbatim); otherwise the token rule: at least three shared tokens,
 * or two when one of them is an ASCII token (identifier, number, tool name) —
 * shared CJK bigrams alone are too weak. Line-level only: same-topic
 * distractor lines can satisfy it (see {@link factSurfacesInLines}).
 */
export function factMatchesLine(fact: FactText, line: string): boolean {
  for (const text of [fact.content, fact.summary]) {
    const trimmed = text?.trim() ?? ''
    if (trimmed.length >= VERBATIM_MIN_CHARS && line.includes(trimmed)) return true
  }
  const factTokens = tokenize(`${fact.content}\n${fact.summary ?? ''}`)
  if (factTokens.size === 0) return false
  const lineTokens = tokenize(line)
  let present = 0
  let anchored = false
  for (const token of factTokens) {
    if (!tokenPresent(token, lineTokens)) continue
    present += 1
    if (isAsciiToken(token)) anchored = true
  }
  return present >= 3 || (present >= 2 && anchored)
}

/**
 * The fact's DISTINCTIVE tokens: its tokens minus every token carried by a
 * sibling fact statement of the same scenario. The corpus deliberately seeds
 * same-topic distractor entries, so plain overlap cannot tell "the entry is
 * about this fact" from "a neighbor entry shares its vocabulary" — and the
 * fence may hold ONLY the distractor. The contrast set is therefore the
 * scenario's other fact statements, not the fence contents.
 */
export function distinctiveTokens(fact: FactText, siblings: readonly FactText[]): Set<string> {
  const own = tokenize(`${fact.content}\n${fact.summary ?? ''}`)
  const shared = new Set<string>()
  for (const sibling of siblings) {
    for (const token of tokenize(`${sibling.content}\n${sibling.summary ?? ''}`)) shared.add(token)
  }
  return new Set([...own].filter(token => !shared.has(token)))
}

/**
 * Whether one fact surfaces in the injected entry lines. Verbatim surface
 * first (the index line shows the summary or an 80-character content prefix
 * verbatim). Otherwise the fact's DISTINCTIVE tokens
 * ({@link distinctiveTokens}; recall rubric v1 "standing hit": the fact's
 * distinctive tokens occur within one injected entry or index line) must
 * reach one line: at least two of them, or one when it is an ASCII anchor
 * (identifier, number, tool name). When a fact shares its entire vocabulary
 * with its siblings (degenerate corpus case) distinctiveness cannot decide
 * and the pair rule ({@link factMatchesLine}) falls back to deciding.
 */
function factSurfacesInLines(fact: FactText, lines: readonly string[], siblings: readonly FactText[]): boolean {
  for (const text of [fact.content, fact.summary]) {
    const trimmed = text?.trim() ?? ''
    if (trimmed.length >= VERBATIM_MIN_CHARS && lines.some(line => line.includes(trimmed))) return true
  }
  const distinctive = distinctiveTokens(fact, siblings)
  if (distinctive.size === 0) return lines.some(line => factMatchesLine(fact, line))
  for (const line of lines) {
    const lineTokens = tokenize(line)
    let present = 0
    let anchored = false
    for (const token of distinctive) {
      if (!tokenPresent(token, lineTokens)) continue
      present += 1
      if (isAsciiToken(token)) anchored = true
    }
    if (present >= 2 || (present >= 1 && anchored)) return true
  }
  return false
}

/** Sibling facts of one fact within the scenario's full fact list (by content, not identity). */
function siblingsOf(fact: FactText, allFacts: readonly FactText[]): FactText[] {
  return allFacts.filter(other => !sameFactText(other, fact))
}

/**
 * Standing hit for ONE required fact: does it surface in any injected entry
 * line of the opening system prompt? `allFacts` is the scenario's full fact
 * list (the same-topic distractors included) — the contrast set that decides
 * which of the fact's tokens are distinctive; defaults to the fact alone.
 */
export function factStandingHit(fact: FactText, systemPrompt: string, allFacts: readonly FactText[] = [fact]): boolean {
  const lines = injectedEntryLines(systemPrompt)
  return factSurfacesInLines(fact, lines, siblingsOf(fact, allFacts))
}

/**
 * Mechanical item — standing hit (recall rubric v1). Every required fact
 * must surface in the injected memory material. `allFacts` is the scenario's
 * full fact list (distractors included) providing each fact's sibling
 * context; defaults to the required facts themselves. `null` when the
 * question names no required facts (negative questions — nothing may hit) or
 * no system prompt was captured.
 */
export function standingHit(
  requiredFacts: readonly FactText[],
  systemPrompt: string | undefined,
  allFacts: readonly FactText[] = requiredFacts,
): boolean | null {
  if (requiredFacts.length === 0 || systemPrompt === undefined) return null
  return requiredFacts.every(fact => factSurfacesInLines(fact, injectedEntryLines(systemPrompt), siblingsOf(fact, allFacts)))
}

/**
 * Mechanical item — noise ratio (recall rubric v1): the share of injected
 * entry lines that carry NONE of the question's required facts, by the same
 * distinctive-token test (`allFacts` as in {@link standingHit}). `null` when
 * there are no required facts (negative questions) or no entry lines to
 * weigh.
 */
export function noiseRatio(
  requiredFacts: readonly FactText[],
  systemPrompt: string | undefined,
  allFacts: readonly FactText[] = requiredFacts,
): number | null {
  if (requiredFacts.length === 0 || systemPrompt === undefined) return null
  const lines = injectedEntryLines(systemPrompt)
  if (lines.length === 0) return null
  const related = lines
    .filter(line => requiredFacts.some(fact => factSurfacesInLines(fact, [line], siblingsOf(fact, allFacts))))
    .length
  return (lines.length - related) / lines.length
}

/** Mechanical item — injection cost (recall rubric v1): characters and ≈tokens. */
export interface InjectionCost {
  readonly chars: number
  readonly tokens: number
}

/**
 * Characters and ≈tokens (`ceil(chars / 4)`) of the injected memory-bearing
 * fence blocks of the session. No fences (e.g. memory mode `off`) → zero
 * cost; a missing system prompt is the caller's `undefined` case, not 0.
 */
export function injectionCost(systemPrompt: string | undefined): InjectionCost | null {
  if (systemPrompt === undefined) return null
  const chars = injectedMemoryText(systemPrompt).length
  return { chars, tokens: Math.ceil(chars / 4) }
}
