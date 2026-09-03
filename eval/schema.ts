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

/**
 * The register axis of the noise slice (noise-v0): `noisy` scenarios carry
 * authored long/noisy turns (noise is a controlled variable, never injected at
 * runtime); `clean` is the default when the field is absent. The report adds
 * a `register` slice only for runs whose scenarios carry the field.
 */
export const registerSchema = z.enum(['clean', 'noisy'])
export type EvalRegister = z.infer<typeof registerSchema>

/**
 * Per-planted-fact metadata (noise slice). Fact ids are declared on the turns
 * (`planted`); this table carries the optional metadata for the facts that
 * need it. Facts without an entry keep the plain materialization: the whole
 * home turn is their statement.
 */
export const plantFactSchema = z.strictObject({
  /** The planted fact id (must appear in one of the scenario turns' `planted` lists). */
  id: z.string().min(1),
  /**
   * Normalized clean excerpt of the planted fact: the judge's ground truth
   * AND the mechanical layer's fact text (replacing the whole dump — a fact
   * buried mid-turn must not score its 150–600 character home utterance).
   */
  factText: z.string().min(1).optional(),
  /**
   * Anchor tokens (tool names, numbers, identifiers, paths) for the spec lint:
   * every anchor must appear verbatim in the fact's materialized home turn.
   * Anchor corruption is a guaranteed mechanical false miss (the extraction
   * normalizes, the materialized statement does not).
   */
  anchors: z.array(z.string().min(1)).optional(),
  /** Scope ground truth (audit P0#2): the scope the entry must be stored under; the storage rubric v2 dim 2 scores against it when present. */
  expectedScope: z.enum(['global', 'project', 'user']).optional(),
  /** Category ground truth; the storage rubric v2 dim 2 scores against it when present. */
  expectedCategory: categorySchema.optional(),
})
export type EvalPlantFact = z.infer<typeof plantFactSchema>

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

/**
 * The long/difficult noise patterns the noise slice covers (declared per
 * scenario, like the turn `signals`): the dataset spec floors assert the
 * slice's union covers all four, so the pattern is a controlled, checked
 * variable rather than an anecdotal property of the prose.
 */
export const noisePatternSchema = z.enum([
  'context-dump',
  'voice-input',
  'self-correction',
  'topic-drift',
])
export type EvalNoisePattern = z.infer<typeof noisePatternSchema>

export const scenarioSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['plant', 'seed']),
  domain: z.enum(['programming', 'daily-work', 'life']),
  language: z.enum(['zh', 'en', 'mixed']),
  /** Register axis of the noise slice; absent = the axis is unreported (clean corpus). */
  register: registerSchema.optional(),
  /** Declared noise patterns (noise slice authoring contract); the spec lint checks slice coverage. */
  patterns: z.array(noisePatternSchema).optional(),
  turns: z.array(turnSchema).optional(),
  seedEntries: z.array(seedEntrySchema).optional(),
  /** Per-planted-fact metadata (noise slice); see {@link plantFactSchema}. */
  plantFacts: z.array(plantFactSchema).optional(),
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
 * per the rubric Inputs rule (eval/rubric/*-v2.md): one home per fact id —
 * a plant fact quotes the user message of the FIRST turn whose `planted`
 * list carries the id, UNLESS the scenario's `plantFacts` table carries a
 * `factText` for the id, in which case the clean excerpt is the statement
 * (noise slice: the whole dump must not be the ground truth); a seed fact
 * quotes its `seedEntries[].content`. Plant turns win over seed entries when
 * an id (unexpectedly) has both.
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
    const factMeta = new Map((scenario.plantFacts ?? []).map(fact => [fact.id, fact]))
    for (const turn of scenario.turns ?? []) {
      for (const factId of turn.planted ?? []) {
        if (homes.has(factId)) continue
        // A plantFact factText replaces the whole dump as the statement;
        // facts without the field keep the current materialization.
        homes.set(factId, { statement: factMeta.get(factId)?.factText ?? turn.user })
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
