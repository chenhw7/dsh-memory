/**
 * Runtime schema for the eval scenario corpus (`eval/datasets/*.jsonl`).
 *
 * Single home of the corpus contract: the field names here are the runner's
 * input contract, `tests/eval-dataset.spec.ts` imports this schema for its
 * corpus gates, and dataset loading goes through {@link parseDataset}. One
 * semantic convention is deliberately NOT structural: a `negative` question's
 * empty `requires` array means "the fact was never stated anywhere", not
 * "matches everything".
 *
 * @module eval/schema
 */

import { z } from 'zod'

/** The seven experience categories the store's extraction can emit. */
export const categorySchema = z.enum([
  'failure',
  'correction',
  'insight',
  'preference',
  'convention',
  'tool-quirk',
  'procedure',
])
export type EvalCategory = z.infer<typeof categorySchema>

export const turnSchema = z.strictObject({
  user: z.string().min(1),
  assistant: z.string().min(1).optional(),
  planted: z.array(z.string().min(1)).optional(),
  signals: z.array(z.string().min(1)).optional(),
})
export type EvalTurn = z.infer<typeof turnSchema>

export const seedEntrySchema = z.strictObject({
  id: z.string().min(1),
  scope: z.enum(['global', 'project', 'user']),
  category: categorySchema.optional(),
  content: z.string().min(1),
  summary: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
})
export type EvalSeedEntry = z.infer<typeof seedEntrySchema>

export const questionSchema = z.strictObject({
  id: z.string().min(1),
  q: z.string().min(1),
  requires: z.array(z.string().min(1)),
  gold: z.string().min(1),
  type: z.enum(['single-hop', 'multi-hop', 'paraphrase', 'negative']),
  variantOf: z.string().nullable().optional(),
})
export type EvalQuestion = z.infer<typeof questionSchema>

export const scenarioSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['plant', 'seed']),
  domain: z.enum(['programming', 'daily-work', 'life']),
  language: z.enum(['zh', 'en', 'mixed']),
  turns: z.array(turnSchema).optional(),
  seedEntries: z.array(seedEntrySchema).optional(),
  questions: z.array(questionSchema).min(1),
})
export type EvalScenario = z.infer<typeof scenarioSchema>

/**
 * Parse one JSONL line into a scenario.
 * @param line - the raw line text (JSON).
 * @param where - human-readable location (`<file>: line N`) for the error.
 * @throws when the line is not JSON or violates {@link scenarioSchema}.
 */
export function parseScenarioLine(line: string, where: string): EvalScenario {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch (error) {
    throw new Error(`eval dataset ${where}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = scenarioSchema.safeParse(json)
  if (!parsed.success) {
    const detail = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new Error(`eval dataset ${where}: schema violation: ${detail}`)
  }
  return parsed.data
}

/**
 * Parse a whole JSONL dataset document. A single trailing newline is
 * expected; a blank line anywhere else fails loud (misconfiguration fails
 * loud — a silently skipped scenario would deflate the measurement).
 * @param text - the raw file content.
 * @param source - file path for error messages only.
 * @throws on any invalid line.
 */
export function parseDataset(text: string, source: string): EvalScenario[] {
  const physicalLines = text.split('\n')
  if (physicalLines[physicalLines.length - 1] === '') physicalLines.pop()
  return physicalLines.map((line, index) => {
    if (line.trim().length === 0) {
      throw new Error(`eval dataset ${source}: line ${index + 1}: blank line`)
    }
    return parseScenarioLine(line, `${source}: line ${index + 1}`)
  })
}

/**
 * Materialize the verbatim statement home for every fact id of a scenario,
 * per the rubric Inputs rule (eval/rubric/*-v1.md): one home per fact id —
 * a plant fact quotes the user message of the FIRST turn whose `planted`
 * list carries the id; a seed fact quotes its `seedEntries[].content`.
 * Plant turns win over seed entries when an id (unexpectedly) has both.
 */
export function materializeFactStatements(scenario: EvalScenario): Map<string, string> {
  const homes = new Map<string, string>()
  for (const [id, home] of materializeFactHomes(scenario)) homes.set(id, home.statement)
  return homes
}

/** One fact's verbatim materialization: the statement plus a seed summary when one exists. */
export interface FactHome {
  readonly statement: string
  readonly summary?: string
}

/**
 * {@link materializeFactStatements} keeping the seed summary: mechanical
 * matching scores a seeded fact against content plus summary (recall rubric,
 * "standing hit"); judged statements stay content-only.
 */
export function materializeFactHomes(scenario: EvalScenario): Map<string, FactHome> {
  const homes = new Map<string, FactHome>()
  if (scenario.kind === 'plant') {
    for (const turn of scenario.turns ?? []) {
      for (const factId of turn.planted ?? []) {
        if (!homes.has(factId)) homes.set(factId, { statement: turn.user })
      }
    }
  }
  for (const entry of scenario.seedEntries ?? []) {
    if (!homes.has(entry.id)) {
      homes.set(entry.id, {
        statement: entry.content,
        ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
      })
    }
  }
  return homes
}
