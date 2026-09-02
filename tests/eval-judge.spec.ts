/**
 * Unit coverage for the eval LLM judge (eval/judge.ts), exercised against the
 * eval fake LLM (eval/harness/fake-llm.ts) — no real API in this lane:
 * verdict parsing for both rubrics, the single re-judge and the invalid
 * record, the absent-answer rule, the env gating matrix, and the rubric
 * version stamp parsing. The mechanical items live in eval/mechanical.ts and
 * are deliberately not covered here.
 *
 * Isolation follows dsh-ci-test-reliability: servers and temp dirs are
 * registered for teardown at acquisition; the judgeFromEnv matrix mutates
 * only its own env keys and restores the captured state (absent stays absent).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEEPSEEK_JUDGE_FALLBACK_MODEL,
  DEEPSEEK_OFFICIAL_BASE_URL,
  judgeFromEnv,
  judgeRecall,
  judgeStorage,
  loadRubricVersions,
  type JudgeConfig,
  type StoredEntry,
} from '../eval/judge.ts'
import { DEFAULT_FAKE_LLM_API_KEY, startFakeLlmServer, type FakeLlmServer, type StartFakeLlmServerOptions } from '../eval/harness/fake-llm.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUBRIC_DIR = join(ROOT, 'eval', 'rubric')
const storageRubric = readFileSync(join(RUBRIC_DIR, 'storage-v1.md'), 'utf8')
const recallRubric = readFileSync(join(RUBRIC_DIR, 'recall-v1.md'), 'utf8')

/** Servers started by the current case; stopped in afterEach even on failure. */
const running: FakeLlmServer[] = []
const tempDirs: string[] = []

async function start(options: StartFakeLlmServerOptions): Promise<FakeLlmServer> {
  const server = await startFakeLlmServer(options)
  running.push(server)
  return server
}

/** A judge config pointed at `server`, using the fake's default bearer key. */
function judgeFor(server: FakeLlmServer): JudgeConfig {
  return { baseUrl: server.baseUrl, apiKey: DEFAULT_FAKE_LLM_API_KEY, model: 'fake-judge-model' }
}

/** Parse a captured request body into the OpenAI payload the judge sent. */
function payloadOf(server: FakeLlmServer, index: number): { model: string; temperature: number; messages: Array<{ role: string; content: string }> } {
  const record = server.requests[index]
  if (record === undefined) throw new Error(`no captured request at index ${String(index)}`)
  return JSON.parse(record.body)
}

afterEach(async () => {
  for (const server of running.splice(0)) {
    await server.stop()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const plants = [{ id: 'f101-pnpm-only', statement: '这个仓库装依赖、跑脚本一律用 pnpm，不要用 npm install，lock 文件会打架。' }]

function storedEntry(overrides: Partial<StoredEntry> & { id: string }): StoredEntry {
  return {
    scope: 'project',
    content: '依赖安装与脚本执行统一走 pnpm，禁止 npm install',
    ...overrides,
  }
}

const validStorageReply = JSON.stringify({
  plantedId: 'f101-pnpm-only',
  contentFidelity: 2,
  scopeAndCategory: 1,
  retrievability: 2,
  mergeBehavior: 2,
  evidence: '统一走 pnpm，禁止 npm install',
  total: 7,
})

describe('judgeStorage', () => {
  it('scores each entry with one call, against the storage rubric verbatim', async () => {
    const server = await start({ defaultReply: validStorageReply })
    const verdicts = await judgeStorage(
      {
        scenarioId: 'prog101-build-toolchain',
        plants,
        storeBefore: [storedEntry({ id: 'mem-old', content: '此前装依赖的习惯是 npm' })],
        siblings: [
          storedEntry({ id: 'mem-101' }),
          storedEntry({ id: 'mem-102', content: '用户在东京办公', scope: 'user' }),
        ],
        entriesAfter: [storedEntry({ id: 'mem-101' }), storedEntry({ id: 'mem-102', content: '用户在东京办公', scope: 'user' })],
      },
      judgeFor(server),
    )
    expect(verdicts).toHaveLength(2)
    expect(verdicts[0]).toEqual({
      entryId: 'mem-101',
      plantedId: 'f101-pnpm-only',
      contentFidelity: 2,
      scopeAndCategory: 1,
      retrievability: 2,
      mergeBehavior: 2,
      total: 7,
      evidence: '统一走 pnpm，禁止 npm install',
    })
    expect(verdicts[1]?.entryId).toBe('mem-102')

    expect(server.requests).toHaveLength(2)
    const payload = payloadOf(server, 0)
    expect(payload.model).toBe('fake-judge-model')
    expect(payload.temperature).toBe(0)
    expect(payload.messages[0]?.role).toBe('system')
    expect(payload.messages[0]?.content).toBe(storageRubric)
    const input = JSON.parse(payload.messages[1]?.content ?? '') as Record<string, unknown>
    expect(input['scenarioId']).toBe('prog101-build-toolchain')
    expect(input['plantedFacts']).toEqual(plants)
    expect(input['storeBefore']).toEqual([expect.objectContaining({ id: 'mem-old' })])
    expect((input['entry'] as Record<string, unknown>)['id']).toBe('mem-101')
    expect(input['siblings']).toEqual([expect.objectContaining({ id: 'mem-102' })])
  })

  it('sends rubric-visible optional entry fields only when present', async () => {
    const server = await start({ defaultReply: validStorageReply })
    await judgeStorage(
      {
        plants,
        storeBefore: [],
        siblings: [],
        entriesAfter: [
          storedEntry({ id: 'mem-101', category: 'convention', summary: '包管理器约定', projectName: 'api-gateway' }),
          storedEntry({ id: 'mem-102', content: '没有类别的条目', scope: 'user', category: undefined, summary: undefined, projectName: undefined }),
        ],
      },
      judgeFor(server),
    )
    const withOptionals = JSON.parse(payloadOf(server, 0).messages[1]?.content ?? '') as { entry: Record<string, unknown> }
    expect(withOptionals.entry).toEqual({
      id: 'mem-101',
      scope: 'project',
      category: 'convention',
      summary: '包管理器约定',
      content: '依赖安装与脚本执行统一走 pnpm，禁止 npm install',
      projectName: 'api-gateway',
    })
    const bare = JSON.parse(payloadOf(server, 1).messages[1]?.content ?? '') as { entry: Record<string, unknown> }
    expect(bare.entry).toEqual({ id: 'mem-102', scope: 'user', content: '没有类别的条目' })
  })

  it('re-judges once on malformed JSON, then records the entry invalid', async () => {
    const server = await start({ defaultReply: 'this is not the protocol json' })
    const verdicts = await judgeStorage(
      { plants, storeBefore: [], siblings: [], entriesAfter: [storedEntry({ id: 'mem-101' })] },
      judgeFor(server),
    )
    expect(server.requests).toHaveLength(2)
    expect(verdicts).toEqual([{
      entryId: 'mem-101',
      plantedId: null,
      contentFidelity: 0,
      scopeAndCategory: 0,
      retrievability: 0,
      mergeBehavior: 0,
      total: 0,
      evidence: '',
      invalid: true,
      invalidReason: expect.stringMatching(/Unexpected token/),
    }])
    // The re-judge echoes the raw failure back and asks for strict JSON again.
    const retry = payloadOf(server, 1)
    expect(retry.messages).toHaveLength(4)
    expect(retry.messages[2]).toEqual({ role: 'assistant', content: 'this is not the protocol json' })
    expect(retry.messages[3]?.role).toBe('user')
    expect(retry.messages[3]?.content).toContain('EXACTLY ONE JSON object')
  })

  it('rejects schema violations (evidence over the rubric cap) as invalid after the retry', async () => {
    const server = await start({
      defaultReply: JSON.stringify({ ...JSON.parse(validStorageReply), evidence: 'x'.repeat(41) }),
    })
    const verdicts = await judgeStorage(
      { plants, storeBefore: [], siblings: [], entriesAfter: [storedEntry({ id: 'mem-101' })] },
      judgeFor(server),
    )
    expect(server.requests).toHaveLength(2)
    expect(verdicts[0]?.invalid).toBe(true)
    expect(verdicts[0]?.invalidReason).toContain('evidence')
  })

  it('succeeds on the re-judge when the scripted first reply fails to parse', async () => {
    let firstCall = true
    const server = await start({
      routes: [{
        match: () => {
          if (!firstCall) return false
          firstCall = false
          return true
        },
        reply: '{"plantedId": broken',
      }],
      defaultReply: validStorageReply,
    })
    const verdicts = await judgeStorage(
      { plants, storeBefore: [], siblings: [], entriesAfter: [storedEntry({ id: 'mem-101' })] },
      judgeFor(server),
    )
    expect(server.requests).toHaveLength(2)
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]?.invalid).toBeUndefined()
    expect(verdicts[0]?.total).toBe(7)
  })

  it('fails loud on an unreachable or rejecting judge endpoint', async () => {
    const server = await start({ defaultReply: validStorageReply, apiKey: 'expected-key' })
    await expect(judgeStorage(
      { plants, storeBefore: [], siblings: [], entriesAfter: [storedEntry({ id: 'mem-101' })] },
      { baseUrl: server.baseUrl, apiKey: 'wrong-key', model: 'fake-judge-model' },
    )).rejects.toThrow(/401/)
    await expect(judgeStorage(
      { plants, storeBefore: [], siblings: [], entriesAfter: [storedEntry({ id: 'mem-101' })] },
      { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' },
    )).rejects.toThrow()
  })

  it('returns no verdicts for a session that wrote nothing', async () => {
    const server = await start({ defaultReply: validStorageReply })
    const verdicts = await judgeStorage({ plants, storeBefore: [], siblings: [], entriesAfter: [] }, judgeFor(server))
    expect(verdicts).toEqual([])
    expect(server.requests).toHaveLength(0)
  })
})

describe('judgeRecall', () => {
  const question = { q: '这个仓库装依赖用什么包管理器？', type: 'single-hop', gold: 'pnpm；明确不要用 npm install' }
  const systemPrompt = '<memory-section>\nproject/convention · 依赖安装与脚本执行统一走 pnpm，禁止 npm install\n</memory-section>'

  it('scores injection quality and answer correctness against the recall rubric verbatim', async () => {
    const server = await start({
      defaultReply: JSON.stringify({ injectionQuality: 2, answerCorrectness: 1, evidence: '统一走 pnpm' }),
    })
    const verdict = await judgeRecall(
      {
        scenarioId: 'prog101-build-toolchain',
        questionId: 'q101-1',
        question,
        requiredFacts: plants,
        systemPrompt,
        answer: '这个仓库用 pnpm，不要用 npm install。',
      },
      judgeFor(server),
    )
    expect(verdict).toEqual({ injectionQuality: 2, answerCorrectness: 1, evidence: '统一走 pnpm' })

    expect(server.requests).toHaveLength(1)
    const payload = payloadOf(server, 0)
    expect(payload.temperature).toBe(0)
    expect(payload.messages[0]?.content).toBe(recallRubric)
    const input = JSON.parse(payload.messages[1]?.content ?? '') as Record<string, unknown>
    expect(input['question']).toBe(question.q)
    expect(input['questionType']).toBe('single-hop')
    expect(input['gold']).toBe(question.gold)
    expect(input['requiredFacts']).toEqual(plants)
    expect(input['injectedMemory']).toBe(systemPrompt)
    expect(input['answer']).toBe('这个仓库用 pnpm，不要用 npm install。')
    expect(input['questionId']).toBe('q101-1')
  })

  it('omits the answer input and forces answerCorrectness to null when no answer exists', async () => {
    const server = await start({
      // The model misbehaves by echoing a score for the answer it never saw.
      defaultReply: JSON.stringify({ injectionQuality: 3, answerCorrectness: 2, evidence: '存在行在' }),
    })
    const verdict = await judgeRecall(
      { question, requiredFacts: plants, systemPrompt, answer: null },
      judgeFor(server),
    )
    expect(verdict).toEqual({ injectionQuality: 3, answerCorrectness: null, evidence: '存在行在' })
    const input = JSON.parse(payloadOf(server, 0).messages[1]?.content ?? '') as Record<string, unknown>
    expect('answer' in input).toBe(false)
    // The gold answer rides beside the question even when the answer is absent.
    expect(input['gold']).toBe(question.gold)
  })

  it('records an invalid verdict with null scores when the protocol fails twice', async () => {
    const server = await start({ defaultReply: '```json\n{"injectionQuality":3}\n```' })
    const verdict = await judgeRecall(
      { question, requiredFacts: [], systemPrompt: '', answer: null },
      judgeFor(server),
    )
    expect(server.requests).toHaveLength(2)
    expect(verdict).toEqual({
      injectionQuality: null,
      answerCorrectness: null,
      evidence: '',
      invalid: true,
      invalidReason: expect.any(String),
    })
  })
})

describe('judgeFromEnv', () => {
  const ENV_KEYS = [
    'EVAL_JUDGE_BASE_URL',
    'EVAL_JUDGE_API_KEY',
    'EVAL_JUDGE_MODEL',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
    'DEEPSEEK_MODEL',
    'DSH_HOME',
    'DSH_EVAL_CONFIG',
    'FUYAO_API_KEY',
  ] as const

  let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

  afterEach(() => {
    for (const name of ENV_KEYS) {
      const value = saved[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
    saved = {}
    for (const name of ENV_KEYS) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    for (const [name, value] of Object.entries(values)) {
      process.env[name] = value
    }
    // judgeFromEnv reads the eval config candidates (project root, deployment
    // home) — pin the explicit pointer at a nonexistent scratch path so no case
    // sees the real machine's eval.yaml; yaml-chain cases set their own
    // DSH_EVAL_CONFIG fixture explicitly.
    if (process.env['DSH_EVAL_CONFIG'] === undefined) {
      process.env['DSH_EVAL_CONFIG'] = join(scratchHome(), 'eval.yaml')
    }
  }

  /** One scratch dir for a config fixture; returns the file path to write. */
  function scratchHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'eval-judge-home-'))
    tempDirs.push(home)
    return home
  }

  /** Write one scratch eval config and return its path (for DSH_EVAL_CONFIG). */
  function scratchFile(evalYaml: string): string {
    const path = join(scratchHome(), 'eval.yaml')
    writeFileSync(path, evalYaml)
    return path
  }

  it('prefers a complete EVAL_JUDGE_* triple over the DEEPSEEK credentials', () => {
    withEnv({
      EVAL_JUDGE_BASE_URL: 'http://127.0.0.1:9999/v1',
      EVAL_JUDGE_API_KEY: 'eval-key',
      EVAL_JUDGE_MODEL: 'judge-x',
      DEEPSEEK_API_KEY: 'sk-deepseek',
      DEEPSEEK_BASE_URL: 'https://gateway.example/v1',
    })
    expect(judgeFromEnv()).toEqual({ baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'eval-key', model: 'judge-x' })
  })

  it('falls back to the DEEPSEEK credentials when any EVAL_JUDGE_* var is missing', () => {
    withEnv({
      EVAL_JUDGE_BASE_URL: 'http://127.0.0.1:9999/v1',
      EVAL_JUDGE_API_KEY: 'eval-key',
      DEEPSEEK_API_KEY: 'sk-deepseek',
      DEEPSEEK_BASE_URL: 'https://gateway.example/v1',
      DEEPSEEK_MODEL: 'deepseek-reasoner',
    })
    expect(judgeFromEnv()).toEqual({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'sk-deepseek',
      model: 'deepseek-reasoner',
    })
  })

  it('falls back to DeepSeek official defaults when only the key is set', () => {
    withEnv({ DEEPSEEK_API_KEY: 'sk-deepseek' })
    expect(judgeFromEnv()).toEqual({
      baseUrl: DEEPSEEK_OFFICIAL_BASE_URL,
      apiKey: 'sk-deepseek',
      model: DEEPSEEK_JUDGE_FALLBACK_MODEL,
    })
  })

  it('falls back to the eval.yaml judge section when the env triple is partial', () => {
    withEnv({
      EVAL_JUDGE_BASE_URL: 'http://127.0.0.1:9999/v1',
      DSH_EVAL_CONFIG: scratchFile('judge:\n  baseURL: http://yaml-judge/v1\n  apiKey: yaml-key\n  model: judge-yaml\n  reasoningEffort: high\n'),
    })
    expect(judgeFromEnv()).toEqual({ baseUrl: 'http://yaml-judge/v1', apiKey: 'yaml-key', model: 'judge-yaml', reasoningEffort: 'high' })
  })

  it('the eval.yaml judge section wins over the DEEPSEEK fallback', () => {
    withEnv({
      DEEPSEEK_API_KEY: 'deepseek-key',
      DSH_EVAL_CONFIG: scratchFile('judge:\n  baseURL: http://yaml-judge/v1\n  apiKey: yaml-key\n  model: judge-yaml\n'),
    })
    expect(judgeFromEnv()).toEqual({ baseUrl: 'http://yaml-judge/v1', apiKey: 'yaml-key', model: 'judge-yaml' })
  })

  it('resolves judge.apiKeyEnv from the eval process environment', () => {
    withEnv({
      FUYAO_API_KEY: 'resolved-key',
      DSH_EVAL_CONFIG: scratchFile('judge:\n  baseURL: http://yaml-judge/v1\n  apiKeyEnv: FUYAO_API_KEY\n  model: judge-yaml\n'),
    })
    expect(judgeFromEnv()).toEqual({ baseUrl: 'http://yaml-judge/v1', apiKey: 'resolved-key', model: 'judge-yaml' })
  })

  it('fails loud on an incomplete eval.yaml judge section (half-pasted instrument)', () => {
    withEnv({
      DSH_EVAL_CONFIG: scratchFile('judge:\n  baseURL: http://yaml-judge/v1\n  apiKey: \"\"\n  model: judge-yaml\n'),
    })
    expect(() => judgeFromEnv()).toThrow(/judge.apiKey .* is empty/)
  })

  it('returns null when the EVAL_JUDGE_* triple is partial and no DEEPSEEK key exists', () => {
    withEnv({ EVAL_JUDGE_BASE_URL: 'http://127.0.0.1:9999/v1', EVAL_JUDGE_API_KEY: 'eval-key' })
    expect(judgeFromEnv()).toBeNull()
    withEnv({})
    expect(judgeFromEnv()).toBeNull()
  })

  it('treats empty env values as absent', () => {
    withEnv({ EVAL_JUDGE_BASE_URL: '', EVAL_JUDGE_API_KEY: 'eval-key', EVAL_JUDGE_MODEL: 'judge-x' })
    expect(judgeFromEnv()).toBeNull()
  })
})

describe('loadRubricVersions', () => {
  it('parses the version stamp of the real rubric files', () => {
    expect(loadRubricVersions(RUBRIC_DIR)).toEqual({ storage: '1', recall: '1' })
  })

  it('fails loud on a missing rubric directory', () => {
    expect(() => loadRubricVersions(join(ROOT, 'eval', 'rubric-does-not-exist'))).toThrow(/ENOENT/)
  })

  it('fails loud when the first line is not the version stamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-judge-rubric-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'storage-v1.md'), 'no version line here\n')
    writeFileSync(join(dir, 'recall-v1.md'), 'Rubric version: 3\n')
    expect(() => loadRubricVersions(dir)).toThrow(/storage-v1\.md/)
  })
})
