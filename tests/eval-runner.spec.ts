/**
 * Mechanical recall metrics (eval/mechanical.ts) against fixture system
 * prompts, plus the rubric Inputs fact-materialization rule the runner
 * consumes from eval/schema.ts. Pure-function coverage: no harness boot.
 */
import { describe, expect, it } from 'vitest'
import {
  distinctiveTokens,
  factMatchesLine,
  factStandingHit,
  injectedEntryLines,
  injectedMemoryText,
  injectionCost,
  noiseRatio,
  parseMemoryFences,
  standingHit,
  tokenize,
  type FactText,
} from '../eval/mechanical.ts'
import { materializeFactHomes, materializeFactStatements, parseDataset } from '../eval/schema.ts'

/** An index-mode opening prompt in the shape the plugin assembles. */
const INDEX_PROMPT = [
  'You are a helpful coding agent.',
  '',
  '<memory-index>',
  'The following is an index of stored memories. Use memory_get(id) to read a full entry, or memory_search to find by content.',
  '',
  'global/convention · smoke-build-pnpm · 本仓库构建只用 pnpm，不要用 npm install',
  'global/procedure · smoke-test-command · 测试跑 pnpm test（vitest run）',
  'user/preference · user-editor · vim 键位，4 空格缩进',
  '</memory-index>',
  '',
  '<memory-policy>',
  'Persistent memory is available through memory tools.',
  '</memory-policy>',
].join('\n')

/** A full-mode opening prompt: scope headings plus content bullets. */
const FULL_PROMPT = [
  '<memory-context>',
  'The following is recalled memory from previous sessions.',
  '',
  '## global',
  '- The organization standard test runner is Vitest; Jest snapshot testing is banned in every repository.',
  '- Local PostgreSQL maps to port 5432 on the dev box.',
  '## user',
  '- Prefers vim keybindings.',
  '',
  '(1 stale memory hidden by soft decay — recall them via memory_search/memory_get to refresh)',
  '</memory-context>',
].join('\n')

describe('fence parsing', () => {
  it('extracts only the memory-bearing fences, in prompt order, tags excluded from the body', () => {
    const withNotes = `${INDEX_PROMPT}\n\n<project-notes>\n# Conventions\n\nManaged by dsh-memory.\n\n## Project conventions\n\n- (2025-08-18) pnpm only.\n</project-notes>`
    const fences = parseMemoryFences(withNotes)
    expect(fences.map(fence => fence.tag)).toEqual(['memory-index', 'project-notes'])
    expect(fences[0]?.body).toContain('smoke-build-pnpm')
    expect(fences[0]?.body).not.toContain('<memory-policy>')
    expect(fences[1]?.body).toContain('- (2025-08-18) pnpm only.')
  })

  it('injectedMemoryText reassembles the fence blocks verbatim for the judge', () => {
    const text = injectedMemoryText(INDEX_PROMPT)
    expect(text).toContain('<memory-index>')
    expect(text).toContain('smoke-build-pnpm')
    expect(text).toContain('</memory-index>')
    expect(text).not.toContain('<memory-policy>')
    expect(text).not.toContain('You are a helpful coding agent.')
  })

  it('entry lines are bullets and scope-prefixed index lines; framing, footers and roll-ups are not entries', () => {
    const prompt = [
      '<memory-index>',
      'The following is an index of stored memories.',
      '',
      'project/convention · a · build with pnpm only',
      '…(2 more: global/convention ×2)',
      '…(1 stale memory hidden by soft decay)',
      '</memory-index>',
      '',
      '<memory-context>',
      'The following is recalled memory.',
      '',
      '## global',
      '[memory snapshot: 42 characters ≈11 tokens]',
      '- Local PostgreSQL maps to port 5432.',
      '</memory-context>',
    ].join('\n')
    expect(injectedEntryLines(prompt)).toEqual([
      'project/convention · a · build with pnpm only',
      '- Local PostgreSQL maps to port 5432.',
    ])
  })

  it('a forged closer inside stored content does not terminate the fence', () => {
    const prompt = [
      '<memory-context>',
      'note',
      '',
      '- escaped closer here <\\/memory-context> stays inside',
      '</memory-context>',
    ].join('\n')
    expect(parseMemoryFences(prompt)).toHaveLength(1)
    expect(injectedEntryLines(prompt)).toEqual(['- escaped closer here <\\/memory-context> stays inside'])
  })

  it('no fences means no entries and zero cost', () => {
    expect(injectedEntryLines('just a prompt')).toEqual([])
    expect(injectedMemoryText('just a prompt')).toBe('')
    expect(injectionCost('just a prompt')).toEqual({ chars: 0, tokens: 0 })
    expect(injectionCost(undefined)).toBeNull()
  })
})

describe('token matching', () => {
  const pnpmFact: FactText = { content: '这个仓库构建只使用 pnpm：安装依赖、执行脚本、发布都走 pnpm，不要用 npm install。' }

  it('an index line carrying the fact matches by distinctive tokens', () => {
    expect(factMatchesLine(pnpmFact, 'global/convention · smoke-build-pnpm · 本仓库构建只用 pnpm，不要用 npm install')).toBe(true)
  })

  it('a full-mode bullet quoting the fact verbatim matches', () => {
    expect(factMatchesLine(pnpmFact, `- ${pnpmFact.content}`)).toBe(true)
  })

  it('an unrelated line never matches, even in the same topic neighborhood', () => {
    expect(factMatchesLine(pnpmFact, 'user/preference · editor · vim 键位，4 空格缩进')).toBe(false)
    expect(factMatchesLine(pnpmFact, 'global/procedure · ci · CI 上先跑 lint 再跑测试')).toBe(false)
  })

  it('morphological plurals collapse onto the stem', () => {
    const jestFact: FactText = { content: 'Jest snapshot testing is banned in every repository.' }
    expect(factMatchesLine(jestFact, 'global/convention · f · Jest snapshots banned here')).toBe(true)
  })

  it('an identifier survives paraphrase when the number and a domain word survive', () => {
    const portFact: FactText = { content: '本地数据库端口是 5432。' }
    expect(factMatchesLine(portFact, 'project/convention · db · 本地 PostgreSQL 映射 5432')).toBe(true)
  })

  it('two shared CJK bigrams without any identifier never decide a match', () => {
    const fact: FactText = { content: '构建前必须把测试跑绿。' }
    expect(factMatchesLine(fact, 'project/convention · docs · 构建配置与测试目录说明')).toBe(false)
  })
})

describe('standing hit', () => {
  const pnpm: FactText = { content: '这个仓库构建只使用 pnpm，不要用 npm install。' }
  const vitest: FactText = { content: '测试命令是 pnpm test（vitest run）。' }

  it('true only when every required fact surfaces in the injected lines', () => {
    expect(standingHit([pnpm, vitest], INDEX_PROMPT)).toBe(true)
    expect(standingHit([pnpm, { content: 'license 扫描用 fossa。' }], INDEX_PROMPT)).toBe(false)
  })

  it('negative questions (no required facts) and missing prompts are not measurable', () => {
    expect(standingHit([], INDEX_PROMPT)).toBeNull()
    expect(standingHit([pnpm], undefined)).toBeNull()
    expect(standingHit([pnpm], 'a prompt with no memory fences')).toBe(false)
  })

  it('seed facts match against content plus summary', () => {
    const fact: FactText = { content: 'The org standard test runner is Vitest with Jest banned.', summary: 'Test runner: Vitest only' }
    expect(factMatchesLine(fact, 'global/convention · f102 · Test runner: Vitest only — Jest banned')).toBe(true)
  })
})

describe('distinctive-token matching (same-topic distractors)', () => {
  // The real prog101-build-toolchain case: the pnpm rule was never stored and
  // the only injected line is the seeded npm-habit distractor — same topic,
  // sharing `npm` and the `装依赖` span, but none of the fact's distinctive
  // tokens (pnpm, install, lock …). Plain pair matching called this a hit.
  const pnpmFact: FactText = { content: '先说清楚，这个仓库装依赖、跑脚本一律用 pnpm，不要用 npm install，lock 文件会打架。' }
  const premergeFact: FactText = { content: '还有件事记住：合版本之前必须把 npm run build 和整套测试跑绿，缺一个都不许合。' }
  const npmHabitFact: FactText = {
    content: '此前装依赖的习惯是 npm，后来在部分仓库切换过工具链。',
    summary: '个人历史习惯 npm',
  }
  const allFacts = [pnpmFact, premergeFact, npmHabitFact]
  const distractorFence = [
    '<memory-index>',
    'The following is an index of stored memories.',
    '',
    'user/preference · f101-legacy-npm · 此前装依赖的习惯是 npm，后来在部分仓库切换过工具链。',
    '</memory-index>',
  ].join('\n')

  it('a same-topic distractor line never counts as a standing hit for the unstored fact', () => {
    expect(factStandingHit(pnpmFact, distractorFence, allFacts)).toBe(false)
    expect(standingHit([pnpmFact], distractorFence, allFacts)).toBe(false)
    expect(noiseRatio([pnpmFact], distractorFence, allFacts)).toBe(1)
  })

  it('the fact hits once an entry carries its distinctive tokens', () => {
    const storedFence = [
      '<memory-index>',
      'The following is an index of stored memories.',
      '',
      'project/convention · f101-pnpm-only · 依赖安装与脚本执行统一走 pnpm，禁止 npm install',
      'user/preference · f101-legacy-npm · 此前装依赖的习惯是 npm，后来在部分仓库切换过工具链。',
      '</memory-index>',
    ].join('\n')
    expect(factStandingHit(pnpmFact, storedFence, allFacts)).toBe(true)
    expect(noiseRatio([pnpmFact], storedFence, allFacts)).toBeCloseTo(0.5)
  })

  it('distinctive tokens exclude sibling-fact vocabulary but keep the fact’s own', () => {
    const distinctive = distinctiveTokens(pnpmFact, [premergeFact, npmHabitFact])
    expect(distinctive.has('pnpm')).toBe(true)
    expect(distinctive.has('install')).toBe(true)
    expect(distinctive.has('npm')).toBe(false)
    expect(distinctive.has('装依')).toBe(false)
  })
})

describe('noise ratio', () => {
  const pnpm: FactText = { content: '这个仓库构建只使用 pnpm，不要用 npm install。' }
  const vitest: FactText = { content: '测试命令是 pnpm test（vitest run）。' }

  it('is the unrelated share of injected entry lines', () => {
    expect(noiseRatio([pnpm], INDEX_PROMPT)).toBeCloseTo(1 / 3)
  })

  it('a line sharing only sibling-fact vocabulary counts as noise', () => {
    // The test-command line shares only `pnpm` with the build fact — a
    // sibling token — so with the scenario's full fact list it is noise for
    // the build question.
    expect(noiseRatio([pnpm], INDEX_PROMPT, [pnpm, vitest])).toBeCloseTo(2 / 3)
  })

  it('is null when nothing is measurable', () => {
    expect(noiseRatio([], INDEX_PROMPT)).toBeNull()
    expect(noiseRatio([pnpm], undefined)).toBeNull()
    expect(noiseRatio([pnpm], 'no fences here')).toBeNull()
  })
})

describe('injection cost', () => {
  it('counts fence characters with ceil(chars / 4) ≈tokens', () => {
    const cost = injectionCost(INDEX_PROMPT)
    const expectedChars = injectedMemoryText(INDEX_PROMPT).length
    expect(cost).toEqual({ chars: expectedChars, tokens: Math.ceil(expectedChars / 4) })
  })

  it('full-mode cost covers the content fence', () => {
    const cost = injectionCost(FULL_PROMPT)
    expect(cost?.chars).toBe(injectedMemoryText(FULL_PROMPT).length)
    expect(cost && cost.chars > 0).toBe(true)
  })
})

describe('tokenize', () => {
  it('splits identifiers on punctuation and keeps CJK bigrams', () => {
    expect(tokenize('pnpm-lock.yaml')).toEqual(new Set(['pnpm', 'lock', 'yaml']))
    expect(tokenize('构建只使用pnpm')).toEqual(new Set(['构建', '建只', '只使', '使用', 'pnpm']))
    expect(tokenize('端口 5432')).toEqual(new Set(['端口', '5432']))
  })

  it('drops English function words, keeps content words', () => {
    expect(tokenize('The coverage gate is on the CI')).toEqual(new Set(['coverage', 'gate', 'ci']))
  })
})

describe('fact materialization (rubric Inputs rule)', () => {
  const plantDataset = parseDataset(
    '{"id":"p1","kind":"plant","domain":"programming","language":"zh",'
    + '"turns":[{"user":"开场白"},{"user":"记住：构建一律用 pnpm，不要用 npm install。","planted":["f-pnpm"]},'
    + '{"user":"再说一遍，构建要用 pnpm。","planted":["f-pnpm"]},{"user":"顺带：测试跑 vitest。","planted":["f-test"]}],'
    + '"seedEntries":[{"id":"f-legacy","scope":"user","content":"此前习惯用 npm。","summary":"旧习惯 npm"}],'
    + '"questions":[{"id":"q1","q":"构建用什么？","requires":["f-pnpm"],"gold":"pnpm","type":"single-hop","variantOf":null}]}',
    'inline',
  )
  const seedDataset = parseDataset(
    '{"id":"s1","kind":"seed","domain":"programming","language":"en",'
    + '"seedEntries":[{"id":"f-a","scope":"global","content":"Fact A.","summary":"A summary"},{"id":"f-b","scope":"global","content":"Fact B."}],'
    + '"questions":[{"id":"q1","q":"A?","requires":["f-a"],"gold":"A","type":"single-hop","variantOf":null}]}',
    'inline',
  )

  it('a plant fact quotes the FIRST planting turn verbatim, later restatements lose', () => {
    const homes = materializeFactHomes(plantDataset[0]!)
    expect(homes.get('f-pnpm')?.statement).toBe('记住：构建一律用 pnpm，不要用 npm install。')
    expect(homes.get('f-test')?.statement).toBe('顺带：测试跑 vitest。')
    expect(homes.get('f-pnpm')?.summary).toBeUndefined()
    expect(materializeFactStatements(plantDataset[0]!).get('f-pnpm')).toBe('记住：构建一律用 pnpm，不要用 npm install。')
  })

  it('a seed fact quotes seedEntries content and carries its summary for mechanical matching', () => {
    const homes = materializeFactHomes(seedDataset[0]!)
    expect(homes.get('f-a')).toEqual({ statement: 'Fact A.', summary: 'A summary' })
    expect(homes.get('f-b')).toEqual({ statement: 'Fact B.' })
  })

  it('mechanical matching uses the seed summary as fact text', () => {
    const homes = materializeFactHomes(seedDataset[0]!)
    const home = homes.get('f-a')!
    const fact: FactText = { content: home.statement, ...(home.summary !== undefined ? { summary: home.summary } : {}) }
    expect(factMatchesLine(fact, 'global/convention · f-a · A summary')).toBe(true)
    expect(factMatchesLine({ content: home.statement }, 'global/convention · f-a · A summary')).toBe(false)
  })
})
