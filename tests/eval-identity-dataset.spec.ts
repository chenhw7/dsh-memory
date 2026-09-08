/**
 * The identity eval slice (eval/datasets/identity-v0.jsonl): corpus gates plus
 * the slice's mechanical surfaces. The three scenarios pin the identity
 * layer's measurable behaviors — persona voice present with explicit-
 * instruction precedence, profile recall from the user document, and the
 * anti-echo contract. In the mock lane the deterministic measurements are
 * the injection surface (soul/user-profile fences + chars, on vs off); the
 * echo scenario's live prefilter contrast (identity on → restatements drop;
 * off → they store) needs a scripted extraction reply (the noise-pilot
 * lane's route table) or a real-model judged run — the prefilter itself is
 * pinned by extract.spec fixtures, and the pilot-lane evidence is a recorded
 * gap in the identity-layer Agent Note.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDataset, type EvalScenario } from '../eval/schema.ts'
import { scanContent } from '../src/scanner.ts'
import { buildIdentityTables, buildSeedMedium } from '../eval/harness/seed-media.ts'
import { memoryModePatch, type RunOptions } from '../eval/runner.ts'
import { parseMemoryFences } from '../eval/mechanical.ts'

const DATASET = join(import.meta.dirname, '..', 'eval', 'datasets', 'identity-v0.jsonl')

const scenarios: readonly EvalScenario[] = parseDataset(readFileSync(DATASET, 'utf8'), 'identity-v0.jsonl')

/** All identity documents across the slice, for the scanner gates. */
const identityDocuments: string[] = scenarios.flatMap(scenario =>
  [scenario.identitySeed?.soul, scenario.identitySeed?.user].filter((doc): doc is string => doc !== undefined))

describe('identity-v0 slice — corpus gates', () => {
  it('holds exactly the three pinning scenarios, all zh', () => {
    expect(scenarios.map(scenario => scenario.id)).toEqual([
      'ident101-persona-voice',
      'ident102-profile-recall',
      'ident201-identity-echo',
    ])
    expect(scenarios.every(scenario => scenario.language === 'zh')).toBe(true)
  })

  it('every scenario seeds at least one identity document, and every document passes the scanner', () => {
    for (const scenario of scenarios) {
      const seed = scenario.identitySeed
      expect(seed, `${scenario.id} carries identitySeed`).toBeDefined()
      expect(seed?.soul !== undefined || seed?.user !== undefined, `${scenario.id} seeds at least one document`).toBe(true)
    }
    expect(identityDocuments.length).toBeGreaterThanOrEqual(4)
    for (const doc of identityDocuments) {
      expect(scanContent(doc).allowed, `identity document rejected by scanner: ${doc.slice(0, 40)}`).toBe(true)
    }
  })

  it('the seed scenarios probe voice, explicit-instruction precedence, and profile recall', () => {
    const voice = scenarios.find(scenario => scenario.id === 'ident101-persona-voice')!
    expect(voice.kind).toBe('seed')
    const questions = voice.questions.map(question => question.id)
    expect(questions).toContain('q1-voice')
    expect(questions).toContain('q2-yield')
    expect(questions).toContain('q3-profile')
    // The yield question must actually issue an explicit instruction — the
    // precedence contract is only measured when the turn demands the switch.
    expect(voice.questions.find(question => question.id === 'q2-yield')!.q).toMatch(/正式商务|换一种方式/)

    const profile = scenarios.find(scenario => scenario.id === 'ident102-profile-recall')!
    expect(profile.kind).toBe('seed')
    expect(profile.questions.length).toBeGreaterThanOrEqual(2)
  })

  it('the echo scenario: noisy-registered plant whose turns restate the seeded soul with extraction triggers, and nothing planted', () => {
    const echo = scenarios.find(scenario => scenario.id === 'ident201-identity-echo')!
    expect(echo.kind).toBe('plant')
    expect(echo.register).toBe('noisy')
    expect(echo.turns?.length).toBeGreaterThanOrEqual(3)
    // No planted facts: the scenario's assertion is that NOTHING gets written.
    expect(echo.turns?.every(turn => (turn.planted ?? []).length === 0)).toBe(true)
    const soul = echo.identitySeed?.soul ?? ''
    for (const turn of echo.turns ?? []) {
      // Extraction trigger (the accumulator's keyword class) so the review
      // lane actually proposes the restatement for the prefilter to drop.
      expect(turn.signals ?? []).toContain('keyword')
      // The echo premise: a distinctive clause of the seeded document appears
      // near-verbatim in the turn, so the overlap prefilter has a target.
      const sharesClause = ['先给出可运行的方案，再讨论风格', '下结论前先读代码、跑命令', '不编造引用和数据']
        .some(clause => soul.includes(clause) && turn.user.includes(clause))
      expect(sharesClause, `echo turn must restate a soul clause: ${turn.user.slice(0, 30)}`).toBe(true)
      expect(scanContent(turn.user).allowed).toBe(true)
    }
  })
})

describe('identity-v0 slice — mechanical surfaces', () => {
  it('buildIdentityTables writes version-1 records plus founding seed snapshots', () => {
    const tables = buildIdentityTables({ soul: '人格文档', user: '' })
    expect(tables.identity['soul']).toMatchObject({ kind: 'soul', content: '人格文档', version: 1, seedVersion: 1 })
    expect(tables.identity['user']).toBeUndefined()
    expect(tables.identity_history['soul#1']).toMatchObject({ kind: 'soul', version: 1, source: 'seed' })
    expect(Object.keys(tables.identity_history)).toEqual(['soul#1'])
  })

  it('buildSeedMedium carries the identity tables alongside entries; absent identity stays out', () => {
    const withIdentity = buildSeedMedium([], { user: '画像' }) as {
      tables: Record<string, Record<string, unknown>>
    }
    expect(withIdentity.tables['identity']?.['user']).toBeDefined()
    expect(withIdentity.tables['identity_history']?.['user#1']).toBeDefined()
    const without = buildSeedMedium([], undefined) as { tables: Record<string, unknown> }
    expect(without.tables['identity']).toBeUndefined()
  })

  it('parseMemoryFences extracts the soul and user-profile sections in prompt order', () => {
    const prompt = [
      'You are a coding agent.',
      '',
      '<soul>',
      'The following is your own character file.',
      '',
      '交付优先。先给出可运行的方案，再讨论风格。',
      '</soul>',
      '',
      '<user-profile>',
      'The following is your working profile of the human user.',
      '',
      '- **称呼：** 测试用户',
      '</user-profile>',
      '',
      '<memory-index>',
      'index line',
      '</memory-index>',
    ].join('\n')
    const fences = parseMemoryFences(prompt)
    expect(fences.map(fence => fence.tag)).toEqual(['soul', 'user-profile', 'memory-index'])
    expect(fences[0]!.body).toContain('交付优先')
  })

  it('memoryModePatch carries the identity axis on the memory-context overlay row', () => {
    const on = memoryModePatch('index', true) as { config: Record<string, unknown> }
    const off = memoryModePatch('index', false) as { config: Record<string, unknown> }
    expect(on.config['identityEnabled']).toBe(true)
    expect(off.config['identityEnabled']).toBe(false)
    // The other pins stand in both positions of the axis.
    expect(on.config['decayDays']).toBe(0)
    expect(off.config['decayDays']).toBe(0)
  })
})

// RunOptions carries the identity axis; the compile-time reference keeps the
// field honest against accidental renames (the CLI is the other reference).
it('RunOptions carries the identity axis', () => {
  const options: Pick<RunOptions, 'identity'> = { identity: true }
  expect(options.identity).toBe(true)
})
