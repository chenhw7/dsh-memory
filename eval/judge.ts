/**
 * Rubric-driven LLM judge for the eval suite: the storage and recall judges
 * whose system prompt is the verbatim text of the versioned rubric files
 * (eval/rubric/storage-v2.md, eval/rubric/recall-v2.md — the single normative
 * source for the scales, the Inputs shape, and the strict-JSON output
 * protocol; see .agents/notes/implemented/testing/
 * 2026-09-01-harness-eval-suite.md, "Scoring rubric" / "Judge protocol").
 * The v1 rubrics stay in the tree as the frozen scale historical reports
 * were stamped with — scores from different rubric versions are never
 * compared.
 *
 * Judge protocol as pinned there: temperature 0, one user JSON object per
 * call assembled per the rubric's Inputs section, one re-judge on parse
 * failure (the raw reply is echoed back with a corrective turn), then the
 * item is recorded as `invalid` — never thrown, never swallowed. The
 * mechanical items (standing hit, noise ratio, injection cost) live in
 * eval/mechanical.ts and are deliberately absent here.
 *
 * The judge talks to any OpenAI-compatible chat-completions endpoint with a
 * bare fetch (the tests/judge-real-api.spec.ts pattern); the endpoint comes
 * from a {@link JudgeConfig} the caller owns, so loopback targets like the
 * eval fake LLM (eval/harness/fake-llm.ts) are first-class — no SSRF gate is
 * applied here, unlike the real-API spec whose endpoint is untrusted env.
 *
 * @module eval/judge
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { loadEvalYamlJudge } from './eval-config.ts'

/** Rubric directory resolved next to this module (eval/rubric). */
export const DEFAULT_RUBRIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'rubric')

/** DeepSeek's OpenAI-compatible endpoint, used when only DEEPSEEK_* env is set. */
export const DEEPSEEK_OFFICIAL_BASE_URL = 'https://api.deepseek.com'

/** Judge model id assumed for the DEEPSEEK credential fallback. */
export const DEEPSEEK_JUDGE_FALLBACK_MODEL = 'deepseek-chat'

const STORAGE_RUBRIC_FILE = 'storage-v2.md'
const RECALL_RUBRIC_FILE = 'recall-v2.md'
const VERSION_LINE_RE = /^Rubric version: (\d+)\s*$/

/** Endpoint credentials and model id of one judge instrument. */
export interface JudgeConfig {
  /** OpenAI-compatible base URL including the version namespace, e.g. `http://127.0.0.1:<port>/v1`. */
  baseUrl: string
  apiKey: string
  model: string
  /** Reasoning effort sent as the wire `reasoning_effort` param; absent = model default. */
  reasoningEffort?: string
}

/**
 * Minimal stored-entry projection the storage rubric judges — the fields the
 * rubric's `entry` / `storeBefore` / `siblings` inputs read. Structural
 * subset of the memory.json entries table (`MemoryEntry` in src/types.ts):
 * id, scope, category, summary, content, projectName; timestamps, audit and
 * decay bookkeeping are never judged and are dropped here.
 */
export interface StoredEntry {
  id: string
  scope: 'global' | 'project' | 'user'
  category?: string | undefined
  summary?: string | undefined
  content: string
  /** Required by the rubric's scope rule for `project` entries; absent otherwise. */
  projectName?: string | undefined
}

/**
 * A stored entry the session wrote or updated — the unit the storage judge
 * scores. `updated` marks the medium-diff case (rubric v2): the id was in
 * `storeBefore` and at least one of content/scope/category/summary changed,
 * so the entry enters the judge flagged rather than disappearing into the
 * "nothing written" blind spot. Written entries leave it absent.
 */
export interface JudgedStoredEntry extends StoredEntry {
  /** True when the entry pre-existed and was updated in-session (absent for new writes). */
  readonly updated?: boolean
}

/** One planted fact, statement materialized by the runner per the rubric's rule. */
export interface PlantedFact {
  id: string
  /** The runner-materialized statement (a `plantFacts[].factText` excerpt when present, else the whole home turn). */
  statement: string
  /** Scenario-pinned scope ground truth (rubric v2 dim 2); absent = the judge infers from the routing rules. */
  expectedScope?: 'global' | 'project' | 'user' | undefined
  /** Scenario-pinned category ground truth (rubric v2 dim 2); absent = the judge infers. */
  expectedCategory?: string | undefined
}

/** Verdict on one stored entry against the planted facts (storage rubric v2 protocol). */
export interface StorageVerdict {
  entryId: string
  plantedId: string | null
  contentFidelity: number
  scopeAndCategory: number
  retrievability: number
  mergeBehavior: number
  total: number
  evidence: string
  /**
   * True when the judge reply failed strict parsing twice (initial + the
   * protocol's single re-judge). Zero placeholder scores; the report must
   * exclude invalid verdicts from score aggregates and count them separately.
   */
  invalid?: boolean
  /** Parse-failure reason of the last attempt, for the report's invalid count. */
  invalidReason?: string
}

/** Verdict on one follow-up question (recall rubric v2 protocol, judged items only). */
export interface RecallVerdict {
  injectionQuality: number | null
  answerCorrectness: number | null
  evidence: string
  /** Same contract as {@link StorageVerdict.invalid}; both scores are `null`. */
  invalid?: boolean
  invalidReason?: string
}

/** Input for {@link judgeStorage}. */
export interface JudgeStorageInput {
  /** Planted facts of the scenario; `statement` is the runner-materialized ground truth. */
  plants: PlantedFact[]
  /** Entries that existed before the session. */
  storeBefore: StoredEntry[]
  /** Entries written or updated during the same session (the entry under review is filtered out per call). */
  siblings: JudgedStoredEntry[]
  /** Entries written or updated by the session — one judge call each. */
  entriesAfter: JudgedStoredEntry[]
  /** For the report only; the rubric never scores it. */
  scenarioId?: string | undefined
}

/** The follow-up question one {@link judgeRecall} call scores. */
export interface RecallQuestion {
  /** Question text. */
  q: string
  /** Corpus question type: `single-hop` | `multi-hop` | `paraphrase` | `negative`. */
  type: string
  /** Gold answer (for negative questions: the correct-absence description). */
  gold: string
}

/** Input for {@link judgeRecall}. */
export interface JudgeRecallInput {
  question: RecallQuestion
  /** Canonical statements the question needs (empty for negative questions). */
  requiredFacts: PlantedFact[]
  /**
   * Verbatim text of the memory-bearing sections of the follow-up session's
   * opening system prompt — the rubric's `injectedMemory` input.
   */
  systemPrompt: string
  /** The model's final answer; `null` in mock-model runs (rubric: ABSENT). */
  answer: string | null
  /** For the report only. */
  scenarioId?: string | undefined
  /** For the report only. */
  questionId?: string | undefined
}

/** The rubric's evidence cap ("at most 40 characters"), enforced on the protocol JSON. */
const EVIDENCE_MAX_CHARS = 40

/** Declare a 0..`max` integer score field. */
function scoreOf(max: number): ZodType<number> {
  return zod.number().int().min(0).max(max)
}

/** Rubric protocol JSON for one storage verdict, as the judge must emit it. */
const storageVerdictSchema = zod.strictObject({
  plantedId: zod.string().nullable(),
  contentFidelity: scoreOf(2),
  scopeAndCategory: scoreOf(2),
  retrievability: scoreOf(2),
  mergeBehavior: scoreOf(2),
  evidence: zod.string().min(1).max(EVIDENCE_MAX_CHARS),
  total: zod.number().int().min(0).max(8),
})

/** Rubric protocol JSON for one recall verdict. `answerCorrectness` is null when no answer was provided. */
const recallVerdictSchema = zod.strictObject({
  injectionQuality: scoreOf(3),
  answerCorrectness: zod.union([scoreOf(2), zod.null()]),
  evidence: zod.string().min(1).max(EVIDENCE_MAX_CHARS),
})

/** Parse the leading "Rubric version: <N>" line of one rubric file; fail loud otherwise. */
function rubricVersion(dir: string, file: string): string {
  const text = readFileSync(join(dir, file), 'utf8')
  const firstLine = text.split('\n')[0] ?? ''
  const version = VERSION_LINE_RE.exec(firstLine)?.[1]
  if (version === undefined) {
    throw new Error(`eval judge: rubric ${file} must open with a "Rubric version: <N>" line, got ${JSON.stringify(firstLine)}`)
  }
  return version
}

/**
 * Stamp the rubric versions a run used, parsed from the first line of the
 * rubric files in `rubricDir` (storage-v2.md / recall-v2.md). Scores from
 * different rubric versions are never compared — every report stamps these.
 * @throws when a rubric file is missing or its first line is not the version stamp.
 */
export function loadRubricVersions(rubricDir: string): { storage: string; recall: string } {
  return {
    storage: rubricVersion(rubricDir, STORAGE_RUBRIC_FILE),
    recall: rubricVersion(rubricDir, RECALL_RUBRIC_FILE),
  }
}

/** Read one rubric file from the default directory as the judge's system prompt. */
function readRubricText(file: string): string {
  return readFileSync(join(DEFAULT_RUBRIC_DIR, file), 'utf8')
}

/**
 * Resolve the judge configuration: the explicit EVAL_JUDGE_* environment
 * triple wins; next the deployment home's `eval.yaml` `judge:` section (the
 * operator-pasted instrument, see eval/eval-config.ts); when neither is
 * present the deployment's DEEPSEEK credentials are used instead
 * (DEEPSEEK_BASE_URL, else DeepSeek official; model `deepseek-chat`); with no
 * key at all, `null` — the caller skips judged scoring instead of
 * half-configuring an instrument. Empty values count as absent. A present
 * eval.yaml judge section is required to be complete: a half-pasted instrument
 * fails loud rather than silently skipping.
 */
export function judgeFromEnv(): JudgeConfig | null {
  const readEnv = (name: string): string | undefined => {
    const value = process.env[name]
    return value !== undefined && value.length > 0 ? value : undefined
  }
  const evalBase = readEnv('EVAL_JUDGE_BASE_URL')
  const evalKey = readEnv('EVAL_JUDGE_API_KEY')
  const evalModel = readEnv('EVAL_JUDGE_MODEL')
  if (evalBase !== undefined && evalKey !== undefined && evalModel !== undefined) {
    return { baseUrl: evalBase, apiKey: evalKey, model: evalModel }
  }
  const yamlJudge = loadEvalYamlJudge()
  if (yamlJudge !== null) return yamlJudge
  const deepseekKey = readEnv('DEEPSEEK_API_KEY')
  if (deepseekKey === undefined) return null
  return {
    baseUrl: readEnv('DEEPSEEK_BASE_URL') ?? DEEPSEEK_OFFICIAL_BASE_URL,
    apiKey: deepseekKey,
    model: readEnv('DEEPSEEK_MODEL') ?? DEEPSEEK_JUDGE_FALLBACK_MODEL,
  }
}

/** One OpenAI chat message of the judge conversation. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Turn a base URL into the chat-completions endpoint; garbage fails loud here, not at fetch. */
function chatCompletionsEndpoint(baseUrl: string): URL {
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`eval judge: baseUrl must be an http(s) URL, got ${JSON.stringify(baseUrl)}`)
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`
  return url
}

/**
 * One judge HTTP call's hard bound. A judge endpoint that accepts the request
 * and never answers would otherwise hang the whole scenario — the fuyao-work
 * hang observed on 2026-09-02 stalled a full run past its scenarios. The
 * budget is per call, not per verdict; the re-judge gets its own.
 */
const JUDGE_CALL_TIMEOUT_MS = 120_000

/** Call the judge model once; returns the reply text. Infrastructure failures throw loud. */
async function callJudgeModel(judge: JudgeConfig, messages: readonly ChatMessage[]): Promise<string> {
  const response = await fetch(chatCompletionsEndpoint(judge.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${judge.apiKey}`,
    },
    body: JSON.stringify({
      model: judge.model,
      messages,
      temperature: 0,
      // openai-completions endpoints (the fuyao gateway among them) take the
      // thinking strength here; the value is the wire form the endpoint accepts.
      ...(judge.reasoningEffort !== undefined ? { reasoning_effort: judge.reasoningEffort } : {}),
    }),
    signal: AbortSignal.timeout(JUDGE_CALL_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`eval judge: chat completions returned ${String(response.status)}: ${(await response.text()).slice(0, 200)}`)
  }
  const payload = await response.json() as { choices?: ReadonlyArray<{ message?: { content?: unknown } }> }
  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error(`eval judge: chat completions response carried no message content: ${JSON.stringify(payload).slice(0, 200)}`)
  }
  return content
}

/** Parse attempts per judged call: the initial one plus the protocol's single re-judge. */
const VERDICT_ATTEMPTS = 2

const RETRY_INSTRUCTION =
  'Your previous reply was not the strict protocol JSON. Reply again with EXACTLY ONE JSON object '
  + 'and nothing else — no markdown fence, no prose before or after, no trailing commentary.'

/**
 * One judged call with the protocol's single re-judge: the reply must parse
 * as JSON and satisfy the rubric schema; on failure the raw reply is echoed
 * back as an assistant turn followed by a corrective user turn, once. A
 * protocol failure never throws — it surfaces as `{ ok: false, reason }` so
 * the item can be recorded invalid.
 */
async function requestVerdict<T>(judge: JudgeConfig, system: string, user: string, schema: ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  let reason = ''
  for (let attempt = 1; attempt <= VERDICT_ATTEMPTS; attempt++) {
    const raw = await callJudgeModel(judge, messages)
    try {
      return { ok: true, value: schema.parse(JSON.parse(raw)) }
    } catch (error) {
      // Malformed JSON or a schema violation — the protocol's retry path, not
      // a crash: the reason rides into the corrective turn and, on a second
      // failure, into the recorded invalid verdict.
      reason = error instanceof Error ? error.message : String(error)
    }
    if (attempt < VERDICT_ATTEMPTS) {
      messages.push(
        { role: 'assistant', content: raw },
        { role: 'user', content: `${RETRY_INSTRUCTION}\nParse error: ${reason.slice(0, 300)}` },
      )
    }
  }
  return { ok: false, reason }
}

/** Cap an invalid reason so a verdict stays one line in reports. */
function invalidReason(reason: string): string {
  return reason.slice(0, 500)
}

/** Project a stored entry to the rubric's `entry` JSON (absent optionals stay absent). */
function entryJson(entry: JudgedStoredEntry): Record<string, unknown> {
  return {
    id: entry.id,
    scope: entry.scope,
    ...(entry.category !== undefined ? { category: entry.category } : {}),
    ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
    content: entry.content,
    ...(entry.projectName !== undefined ? { projectName: entry.projectName } : {}),
    // The medium-diff flag: present only for in-session updates (rubric v2
    // Inputs), so a new write's entry JSON is byte-identical to the v1 shape.
    ...(entry.updated === true ? { updated: true } : {}),
  }
}

/** Project a planted fact to the rubric's `plantedFacts` row (absent optionals stay absent). */
function plantedFactJson(fact: PlantedFact): Record<string, unknown> {
  return {
    id: fact.id,
    statement: fact.statement,
    ...(fact.expectedScope !== undefined ? { expectedScope: fact.expectedScope } : {}),
    ...(fact.expectedCategory !== undefined ? { expectedCategory: fact.expectedCategory } : {}),
  }
}

/** The invalid placeholder recorded for an entry whose judging failed the protocol twice. */
function invalidStorageVerdict(entryId: string, reason: string): StorageVerdict {
  return {
    entryId,
    plantedId: null,
    contentFidelity: 0,
    scopeAndCategory: 0,
    retrievability: 0,
    mergeBehavior: 0,
    total: 0,
    evidence: '',
    invalid: true,
    invalidReason: invalidReason(reason),
  }
}

/**
 * Score every entry the session wrote or updated against the planted facts,
 * one judge call per entry (sequential — the captured-request log stays
 * readable and a judge endpoint sees a polite request rate). Each user
 * message is one JSON object per the storage rubric's Inputs section;
 * `siblings` excludes the entry under review, as the rubric defines them.
 */
export async function judgeStorage(input: JudgeStorageInput, judge: JudgeConfig): Promise<StorageVerdict[]> {
  const system = readRubricText(STORAGE_RUBRIC_FILE)
  const verdicts: StorageVerdict[] = []
  for (const entry of input.entriesAfter) {
    const user = JSON.stringify({
      scenarioId: input.scenarioId ?? null,
      plantedFacts: input.plants.map(plantedFactJson),
      entry: entryJson(entry),
      storeBefore: input.storeBefore,
      siblings: input.siblings.filter(sibling => sibling.id !== entry.id),
    })
    const result = await requestVerdict(judge, system, user, storageVerdictSchema)
    if (result.ok) {
      verdicts.push({
        entryId: entry.id,
        plantedId: result.value.plantedId,
        contentFidelity: result.value.contentFidelity,
        scopeAndCategory: result.value.scopeAndCategory,
        retrievability: result.value.retrievability,
        mergeBehavior: result.value.mergeBehavior,
        total: result.value.total,
        evidence: result.value.evidence,
      })
    } else {
      verdicts.push(invalidStorageVerdict(entry.id, result.reason))
    }
  }
  return verdicts
}

/**
 * Score one follow-up question: injection quality always, answer correctness
 * only when an answer was provided. The user JSON carries the question, its
 * gold answer, the question type, the required facts, and the injected
 * memory, per the recall rubric's Inputs. With `answer: null` (mock-model
 * runs) the rubric's answer input is ABSENT from the user JSON and the
 * returned `answerCorrectness` is forced to `null` — the caller's absence is
 * authoritative, the model's echo is never trusted for a field it was not
 * given.
 */
export async function judgeRecall(input: JudgeRecallInput, judge: JudgeConfig): Promise<RecallVerdict> {
  const system = readRubricText(RECALL_RUBRIC_FILE)
  const user = JSON.stringify({
    scenarioId: input.scenarioId ?? null,
    questionId: input.questionId ?? null,
    question: input.question.q,
    questionType: input.question.type,
    // The gold answer rides beside the question: the recall rubric scores
    // answerCorrectness "correct against gold" and anchors its negative
    // tiers on it.
    gold: input.question.gold,
    requiredFacts: input.requiredFacts,
    injectedMemory: input.systemPrompt,
    ...(input.answer !== null ? { answer: input.answer } : {}),
  })
  const result = await requestVerdict(judge, system, user, recallVerdictSchema)
  if (!result.ok) {
    return {
      injectionQuality: null,
      answerCorrectness: null,
      evidence: '',
      invalid: true,
      invalidReason: invalidReason(result.reason),
    }
  }
  return {
    injectionQuality: result.value.injectionQuality,
    answerCorrectness: input.answer === null ? null : result.value.answerCorrectness,
    evidence: result.value.evidence,
  }
}
