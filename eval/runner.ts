/**
 * Scenario executor for the eval suite: runs each corpus scenario against a
 * throwaway `$DSH_HOME` and one plugin build, collecting the raw per-question
 * outcomes (mechanical metrics always; judged metrics when a judge is
 * supplied). Pure orchestration over eval/boot — no dataset parsing (CLI) and
 * no aggregation (report).
 *
 * Two scenario chains:
 * - seed (M1): pre-write the store → one session asks every question → the
 *   opening system prompt IS the standing-injection surface.
 * - plant (M2): session 1 plays the dialogue turns → dispose → quiesce →
 *   read the medium (storage measurement) → session 2 re-opens on the SAME
 *   dshHome (a NEW handle — the KV-cache session contract) → questions.
 *
 * @module eval/runner
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHarness, type HarnessHandle, type HarnessModelOptions, type TurnBudget, type TurnResult } from './boot.ts'
import { waitForQuiesce } from './harness/quiesce.ts'
import { readStoredEntries, seedMemoryMedium, type SeedEntryInput, type StoredEntry } from './harness/seed-media.ts'
import {
  factStandingHit,
  injectedMemoryText,
  injectionCost,
  noiseRatio,
  parseMemoryFences,
  standingHit,
  type FactText,
} from './mechanical.ts'
import { materializeFactHomes, type EvalQuestion, type EvalScenario, type FactHome } from './schema.ts'
import {
  DEFAULT_RUBRIC_DIR,
  judgeRecall,
  judgeStorage,
  loadRubricVersions as loadJudgeRubricVersions,
  type JudgeConfig,
  type JudgedStoredEntry,
  type PlantedFact,
} from './judge.ts'
import type {
  EffectiveMemoryMode,
  QuestionResult,
  ScenarioResult,
  StorageResult,
} from './report.ts'

/** Options for one eval run (one dataset pass over one build). */
export interface RunOptions {
  /** Plugin build under test: directory holding the built package.json + lib/. */
  readonly buildDir: string
  /** Model route; `external` injects a caller-supplied OpenAI-compatible endpoint. */
  readonly mode: 'mock' | 'real' | 'external'
  /**
   * Provider + model id for the initialize handshake (`real`/`external`);
   * `undefined` keeps the boot defaults. A non-DeepSeek provider is a pi-ai
   * route: `real` only, with the deployment's `llm-pi-ai` settings section
   * carried alongside.
   */
  readonly model?: string
  /** Provider route for the handshake (default `deepseek-official`). */
  readonly provider?: string
  /**
   * Rendered `llm-pi-ai:` settings section mirroring the deployment's provider
   * profiles into the throwaway home; required when `provider` is non-DeepSeek.
   */
  readonly piAiSection?: string
  /** Deployment home (the route's settings source); real mode points the child's
   * credentials row at its managed credentials document. */
  readonly deploymentHome?: string
  /** The mirrored profiles' `apiKeyEnv` reference names, for the boot preflight. */
  readonly credentialEnvRefs?: readonly string[]
  /** Thinking strength for the model under test (the deployment's declared default). */
  readonly reasoningEffort?: string
  /** `external` only: endpoint base for `DEEPSEEK_BASE_URL`. */
  readonly baseUrl?: string
  /** `external` only: key for `DEEPSEEK_API_KEY` (default `eval-fake-key`). */
  readonly apiKey?: string
  /** Injection-mode axis (default `index`), applied via configPatches. */
  readonly memoryMode: 'index' | 'full'
  /** Control group: memory injection `off`; overrides `memoryMode`. */
  readonly noMemory: boolean
  /** Rubric judge; `null` records every judged metric as skipped. */
  readonly judge: JudgeConfig | null
  /** Max scenarios in flight (default 4); each gets its own mkdtemp home. */
  readonly concurrency: number
  /** Quiesce bound per await point in ms (default 30_000). */
  readonly quiesceTimeoutMs?: number
  /**
   * Per-turn work budget (resolved by the CLI: flag > eval.yaml > defaults);
   * `null` = unbounded. A breach fails the owning scenario loud.
   */
  readonly turnBudget: TurnBudget | null
  /** Progress hook: called once per scenario as it completes (order = completion order). */
  readonly onResult?: (result: ScenarioResult) => void
}

/** One completed dataset pass. */
export interface RunOutcome {
  readonly results: ScenarioResult[]
  readonly memoryMode: EffectiveMemoryMode
  readonly rubricVersions: { readonly storage: string; readonly recall: string }
  /** Judge identity stamped into the report; `null` when skipped. */
  readonly judge: { readonly model: string; readonly baseUrl: string } | null
}

/** The effective injection mode for a run (the `off` control wins). */
export function effectiveMemoryMode(options: Pick<RunOptions, 'memoryMode' | 'noMemory'>): EffectiveMemoryMode {
  return options.noMemory ? 'off' : options.memoryMode
}

/**
 * The memory-context config overlay for one run. An overlay row REPLACES the
 * pinned row's config, so the pins that keep the measurement clean are
 * restated here — without them the omitted knobs would fall back to factory
 * defaults (decay 30d would soft-decay seeded entries mid-run) and blur runs.
 */
export function memoryModePatch(mode: EffectiveMemoryMode): Record<string, unknown> {
  return {
    id: 'memory-context',
    config: {
      memoryMode: mode,
      decayDays: 0,
      notesEnabled: false,
      autoRecallEnabled: false,
    },
  }
}

/**
 * {@link waitForQuiesce} with an event-loop keepalive: the quiesce poll runs
 * on unref'd timers, so once every harness handle is disposed (no child, no
 * mock server) the eval process's loop would drain mid-poll and kill the run
 * with an unsettled await. A ref'd interval holds the loop until the wait
 * settles.
 */
async function quiesceSettled(dshHome: string, timeoutMs: number): Promise<void> {
  const keepalive = setInterval(() => {}, 1_000)
  try {
    await waitForQuiesce(dshHome, timeoutMs)
  } finally {
    clearInterval(keepalive)
  }
}

/** Run every scenario (bounded concurrency), preserving dataset order. */
export async function runScenarios(scenarios: readonly EvalScenario[], options: RunOptions): Promise<RunOutcome> {
  const results = await mapPool(
    scenarios,
    Math.max(1, Math.floor(options.concurrency)),
    async (scenario) => {
      const result = await runScenario(scenario, options)
      options.onResult?.(result)
      return result
    },
  )
  return {
    results,
    memoryMode: effectiveMemoryMode(options),
    rubricVersions: loadRubricVersions(),
    judge: options.judge === null ? null : { model: options.judge.model, baseUrl: options.judge.baseUrl },
  }
}

/** Per-scenario wiring shared by both chains; the runner owns handle disposal. */
interface ScenarioContext {
  readonly dshHome: string
  readonly quiesceMs: number
  readonly openHandle: () => Promise<HarnessHandle>
  readonly disposeHandle: (handle: HarnessHandle) => Promise<void>
  readonly options: RunOptions
}

async function runScenario(scenario: EvalScenario, options: RunOptions): Promise<ScenarioResult> {
  const startedAt = Date.now()
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-eval-run-'))
  const memoryMode = effectiveMemoryMode(options)
  const base = {
    scenarioId: scenario.id,
    kind: scenario.kind,
    domain: scenario.domain,
    language: scenario.language,
    memoryMode,
  }

  const handles: HarnessHandle[] = []
  const disposed = new Set<HarnessHandle>()
  const disposeHandle = async (handle: HarnessHandle): Promise<void> => {
    if (disposed.has(handle)) return
    disposed.add(handle)
    await handle.dispose()
  }
  const disposeAll = async (): Promise<void> => {
    for (const handle of handles) await disposeHandle(handle)
  }
  const context: ScenarioContext = {
    dshHome,
    quiesceMs: options.quiesceTimeoutMs ?? 30_000,
    openHandle: async () => {
      const handle = await startHarness({
        buildDir: options.buildDir,
        dshHome,
        model: modelOptions(options),
        configPatches: [memoryModePatch(memoryMode)],
        ...(options.turnBudget !== null ? { turnBudget: options.turnBudget } : {}),
      })
      handles.push(handle)
      return handle
    },
    disposeHandle,
    options,
  }

  // Collected incrementally so a mid-scenario failure still reports the
  // questions that did complete.
  const questions: QuestionResult[] = []
  try {
    let storeBefore: StoredEntry[] = []
    const seeds: SeedEntryInput[] = scenario.seedEntries ?? []
    if (seeds.length > 0) {
      seedMemoryMedium(dshHome, seeds)
      storeBefore = readStoredEntries(dshHome).entries
    }

    const outcome = scenario.kind === 'plant'
      ? await runPlantScenario(scenario, context, storeBefore, questions)
      : await runSeedScenario(scenario, context, questions)

    await disposeAll()
    // The final medium read waits out any late dispose flush so the A/B
    // equality layer never races a write.
    await quiesceSettled(dshHome, context.quiesceMs)
    const mediumAfter = readStoredEntries(dshHome)
    rmSync(dshHome, { recursive: true, force: true })

    return {
      ...base,
      systemPromptCaptured: outcome.systemPrompt !== undefined,
      fenceTags: outcome.systemPrompt === undefined
        ? []
        : parseMemoryFences(outcome.systemPrompt).map(fence => fence.tag),
      injection: injectionCost(outcome.systemPrompt),
      questions,
      storage: outcome.storage,
      mediumAfter: { entryCount: mediumAfter.entryCount, auditSeq: mediumAfter.maxAuditSeq },
      error: null,
      keptHome: null,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    try {
      await disposeAll()
    } catch (disposeError) {
      // The scenario already failed; a failed teardown is recorded, not raised.
      message += `; teardown also failed: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`
    }
    return {
      ...base,
      systemPromptCaptured: false,
      fenceTags: [],
      injection: null,
      questions,
      storage: null,
      mediumAfter: null,
      error: message,
      keptHome: dshHome,
      durationMs: Date.now() - startedAt,
    }
  }
}

/** The follow-up session's standing prompt plus the plant storage readout. */
interface ChainOutcome {
  readonly systemPrompt: string | undefined
  readonly storage: StorageResult | null
}

/** Seed (M1): one session over the pre-written store; every question is one prompt. */
async function runSeedScenario(
  scenario: EvalScenario,
  context: ScenarioContext,
  questions: QuestionResult[],
): Promise<ChainOutcome> {
  const homes = materializeFactHomes(scenario)
  const handle = await context.openHandle()
  let systemPrompt: string | undefined
  for (const question of scenario.questions) {
    const turn = await handle.prompt(question.q)
    if (turn.systemPrompt !== undefined && systemPrompt === undefined) systemPrompt = turn.systemPrompt
    questions.push(await judgedQuestionResult(question, homes, turn, context.options, systemPrompt, scenario.id))
  }
  return { systemPrompt, storage: null }
}

/**
 * Plant (M2): session 1 plays the dialogue; dispose triggers the flush;
 * quiesce bounds it; the settled medium is the storage measurement; session 2
 * re-opens on the SAME dshHome with a fresh handle (fresh memory snapshot)
 * and answers the questions.
 */
async function runPlantScenario(
  scenario: EvalScenario,
  context: ScenarioContext,
  storeBefore: StoredEntry[],
  questions: QuestionResult[],
): Promise<ChainOutcome> {
  const homes = materializeFactHomes(scenario)

  const handle1 = await context.openHandle()
  for (const turn of scenario.turns ?? []) {
    await handle1.prompt(turn.user)
  }
  await context.disposeHandle(handle1)
  await quiesceSettled(context.dshHome, context.quiesceMs)
  const after = readStoredEntries(context.dshHome)

  const handle2 = await context.openHandle()
  let systemPrompt: string | undefined
  for (const question of scenario.questions) {
    const turn = await handle2.prompt(question.q)
    if (turn.systemPrompt !== undefined && systemPrompt === undefined) systemPrompt = turn.systemPrompt
    questions.push(await judgedQuestionResult(question, homes, turn, context.options, systemPrompt, scenario.id))
  }

  // Planted facts trace to their FIRST planting turn's user message, verbatim.
  const plants: PlantedFact[] = []
  for (const turn of scenario.turns ?? []) {
    for (const factId of turn.planted ?? []) {
      if (!plants.some(plant => plant.id === factId)) plants.push({ id: factId, statement: turn.user })
    }
  }
  // The medium diff (rubric v2 basis): written = ids absent from storeBefore;
  // updated = pre-existing ids with any content/scope/category/summary change.
  // An update keeps its id, so under the v1 written-only basis it was neither
  // judged nor counted in precision — the audit's P0#1.
  const beforeById = new Map(storeBefore.map(entry => [entry.id, entry]))
  const written = after.entries.filter(entry => !beforeById.has(entry.id))
  const updated = after.entries.filter(entry => mediumDiff(beforeById.get(entry.id), entry))
  let storage: StorageResult = {
    entryCount: after.entryCount,
    auditSeq: after.maxAuditSeq,
    writtenIds: written.map(entry => entry.id),
    updatedIds: updated.map(entry => entry.id),
    verdicts: null,
    judgeError: null,
  }
  if (context.options.judge !== null) {
    try {
      const touched: JudgedStoredEntry[] = [
        ...written,
        ...updated.map(entry => ({ ...entry, updated: true })),
      ]
      const verdicts = await judgeStorage(
        {
          plants,
          storeBefore,
          siblings: touched,
          // judge.ts contract: entries the session wrote OR updated, one judge
          // call each — untouched storeBefore entries are not re-judged.
          entriesAfter: touched,
          scenarioId: scenario.id,
        },
        context.options.judge,
      )
      storage = { ...storage, verdicts }
    } catch (error) {
      // Judged metrics degrade to skipped, never silently to zero.
      storage = { ...storage, judgeError: error instanceof Error ? error.message : String(error) }
    }
  }
  return { systemPrompt, storage }
}

/**
 * The rubric v2 medium-diff basis: a pre-existing entry counts as updated when
 * any of content/scope/category/summary differs. `projectName` and the
 * timestamps are bookkeeping the judge never sees and do not mark an update.
 */
function mediumDiff(before: StoredEntry | undefined, after: StoredEntry): boolean {
  if (before === undefined) return false
  return before.content !== after.content
    || before.scope !== after.scope
    || (before.category ?? '') !== (after.category ?? '')
    || (before.summary ?? '') !== (after.summary ?? '')
}

/**
 * Build one question's result: mechanical metrics from the captured system
 * prompt, then the recall judge when one is configured. In mock runs the
 * answer stays `null` (recall rubric: answerCorrectness is real-model-only).
 */
async function judgedQuestionResult(
  question: EvalQuestion,
  homes: Map<string, FactHome>,
  turn: TurnResult,
  options: RunOptions,
  systemPrompt: string | undefined,
  scenarioId: string,
): Promise<QuestionResult> {
  const facts = requiredFactsOf(question, homes)
  // Every scenario fact (distractors included) is the sibling context that
  // decides which tokens are distinctive for matching.
  const allFacts: FactText[] = [...homes.values()].map(home => ({
    content: home.statement,
    ...(home.summary !== undefined ? { summary: home.summary } : {}),
  }))
  const answer = options.mode === 'mock' || turn.finalText.length === 0 ? null : turn.finalText
  const result: QuestionResult = {
    questionId: question.id,
    type: question.type,
    requires: question.requires,
    standingHit: standingHit(facts, systemPrompt, allFacts),
    factHits: systemPrompt === undefined ? null : facts.map(fact => factStandingHit(fact, systemPrompt, allFacts)),
    noiseRatio: noiseRatio(facts, systemPrompt, allFacts),
    expectedStandingHit: question.type !== 'negative',
    answer,
    injectionQuality: null,
    answerCorrectness: null,
    judgeError: null,
    judgeInvalidReason: null,
  }
  if (options.judge === null) return result
  try {
    const verdict = await judgeRecall(
      {
        question: { q: question.q, type: question.type, gold: question.gold },
        requiredFacts: question.requires.map(id => ({ id, statement: statementOf(homes, id) })),
        // Rubric Inputs take the memory-bearing sections (injectedMemory),
        // not the whole prompt — fences are extracted with tags intact.
        systemPrompt: systemPrompt === undefined ? '' : injectedMemoryText(systemPrompt),
        answer,
        scenarioId,
        questionId: question.id,
      },
      options.judge,
    )
    if (verdict.invalid === true) {
      // Judge protocol failure: scores stay null (skipped), the reason is recorded.
      return { ...result, judgeInvalidReason: verdict.invalidReason ?? 'invalid judge verdict' }
    }
    return { ...result, injectionQuality: verdict.injectionQuality, answerCorrectness: verdict.answerCorrectness }
  } catch (error) {
    // A judge failure is recorded per question (skipped), not raised.
    return { ...result, judgeError: error instanceof Error ? error.message : String(error) }
  }
}

/** The required facts of one question as mechanical matching sees them. */
function requiredFactsOf(question: EvalQuestion, homes: Map<string, FactHome>): FactText[] {
  return question.requires.map((id) => {
    const home = homes.get(id)
    if (home === undefined) return { content: statementOf(homes, id) }
    return { content: home.statement, ...(home.summary !== undefined ? { summary: home.summary } : {}) }
  })
}

function statementOf(homes: Map<string, FactHome>, factId: string): string {
  const statement = homes.get(factId)?.statement
  if (statement === undefined) {
    // The corpus spec gates this; reaching here means a broken dataset slipped through.
    throw new Error(`eval runner: fact ${factId} has no materialization home (neither planted turn nor seed entry)`)
  }
  return statement
}

/** Map `mode` onto the boot model options (baseUrl/apiKey are external-only). */
function modelOptions(options: RunOptions): HarnessModelOptions {
  return {
    mode: options.mode,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.piAiSection !== undefined ? { piAiSection: options.piAiSection } : {}),
    ...(options.deploymentHome !== undefined ? { deploymentHome: options.deploymentHome } : {}),
    ...(options.credentialEnvRefs !== undefined ? { credentialEnvRefs: options.credentialEnvRefs } : {}),
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  }
}

/** Read the rubric version stamps a report must carry (fail loud when absent). */
export function loadRubricVersions(): { storage: string; recall: string } {
  return loadJudgeRubricVersions(DEFAULT_RUBRIC_DIR)
}

/** Bounded-concurrency map preserving input order (single-threaded event loop). */
async function mapPool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await run(item)
    }
  })
  await Promise.all(workers)
  return results
}
