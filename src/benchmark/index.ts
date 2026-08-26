/**
 * Recall evaluation baseline (P1-4) and injection-cost comparison (P1-8).
 *
 * A fixed golden-set fixture — 24 topically distinct entries across the three
 * scopes (English + CJK), each with one known relevant query — turns "the
 * retrieval is strong" from a structural claim into numbers: precision@k,
 * recall@k, and MRR over the shipping BM25 search, plus per-mode standing
 * injection cost (characters ≈ tokens). Any future retrieval change
 * (tokenization, weights, budgets) must run against this baseline first.
 *
 * Pure module: builds its own store-shaped searcher via a callback, so both
 * the real DomainMemoryStore (spec) and offline copies can be evaluated.
 *
 * @module @chenhw7/dsh-memory/benchmark
 */

/** One fixture entry: scope + content (+ optional summary/category). */
export interface GoldenEntry {
  /** Stable fixture id used in the golden table. */
  readonly id: string
  readonly scope: 'global' | 'project' | 'user'
  readonly content: string
  readonly summary?: string
  readonly category?: string
  /** Project name for project-scoped entries. */
  readonly projectName?: string
}

/** One golden case: a query and the entry ids a correct recall must surface. */
export interface GoldenCase {
  readonly query: string
  readonly relevant: readonly string[]
  /** Language tag for slicing the report (en / zh / mixed). */
  readonly lang: 'en' | 'zh'
}

/**
 * The fixed memory fixture. Entries are deliberately topically separated so
 * BM25 can discriminate them; several share a few decoy tokens (e.g. two
 * entries mention 端口/port) to keep precision honest.
 */
export const GOLDEN_ENTRIES: readonly GoldenEntry[] = [
  // ── global (8) ──
  { id: 'g1', scope: 'global', content: 'Prefer pnpm over npm for all package management tasks in every repository' },
  { id: 'g2', scope: 'global', content: 'The deployment targets Node 22 LTS with pure ESM modules end to end', category: 'convention' },
  { id: 'g3', scope: 'global', content: 'Vitest is the test runner; jest snapshots are banned from this organization', category: 'convention' },
  { id: 'g4', scope: 'global', content: 'Commit messages follow conventional commits with Chinese subject lines', category: 'convention' },
  { id: 'g5', scope: 'global', content: 'PostgreSQL 15 runs under docker-compose with port 5432 exposed locally' },
  { id: 'g6', scope: 'global', content: 'Redis cache uses allkeys-lru eviction with a 512mb memory cap', category: 'insight' },
  { id: 'g7', scope: 'global', content: 'Run the typecheck script before every commit; the CI gate rejects type errors', category: 'procedure' },
  { id: 'g8', scope: 'global', content: 'Feature flags are declared in the flags.json configuration file at the repo root' },
  // ── project demo-repo (8) ──
  { id: 'p1', scope: 'project', projectName: 'demo-repo', content: 'Build runs through vite; the dev server proxies api calls to localhost port 3000' },
  { id: 'p2', scope: 'project', projectName: 'demo-repo', content: 'Auth middleware loads jwt secrets from vault during service boot', category: 'procedure' },
  { id: 'p3', scope: 'project', projectName: 'demo-repo', content: 'Database migrations apply automatically when the server starts up' },
  { id: 'p4', scope: 'project', projectName: 'demo-repo', content: 'The linter forbids default exports inside lib modules here', category: 'convention' },
  { id: 'p5', scope: 'project', projectName: 'demo-repo', content: 'End-to-end tests launch headless chromium on debug port 9222' },
  { id: 'p6', scope: 'project', projectName: 'demo-repo', content: 'Gateway rate limits allow sixty requests per minute for each client key' },
  { id: 'p7', scope: 'project', projectName: 'demo-repo', content: 'Application logs flow through the structured pino pipeline with request ids' },
  { id: 'p8', scope: 'project', projectName: 'demo-repo', content: 'Frontend state management uses zustand stores with one store per domain' },  // ── user (8) ──
  { id: 'u1', scope: 'user', content: '用户偏好简洁的中文回答，先给代码再解释原理', category: 'preference' },
  { id: 'u2', scope: 'user', content: '用户习惯在提交之前手动运行完整测试套件确认无误', category: 'preference' },
  { id: 'u3', scope: 'user', content: 'The user works from Tokyo and schedules meetings in JST timezone only' },
  { id: 'u4', scope: 'user', content: 'Prefers dark theme editors and minimal interface chrome without distractions', category: 'preference' },
  { id: 'u5', scope: 'user', content: '用户要求所有项目文档一律使用中文书写，包括 README', category: 'preference' },
  { id: 'u6', scope: 'user', content: 'The user dislikes emoji anywhere in commit messages or changelogs' },
  { id: 'u7', scope: 'user', content: '用户偏好 vim 键位绑定，编辑器与终端都保持一致', category: 'preference' },
  { id: 'u8', scope: 'user', content: 'Morning standup notes are posted to the team wiki page before ten' },
]

/**
 * The golden query table: each query names exactly the entries a correct
 * search must return within the top-k. Queries mix keyword style ("redis
 * 缓存") and question style ("数据库迁移什么时候执行").
 */
export const GOLDEN_CASES: readonly GoldenCase[] = [
  { query: 'package manager preference pnpm', relevant: ['g1'], lang: 'en' },
  { query: 'node version runtime target', relevant: ['g2'], lang: 'en' },
  { query: 'test runner choice vitest jest', relevant: ['g3'], lang: 'en' },
  { query: 'commit message style convention', relevant: ['g4'], lang: 'en' },
  { query: '端口 5432 是什么数据库服务', relevant: ['g5'], lang: 'zh' },
  { query: 'redis 缓存淘汰策略 内存上限', relevant: ['g6'], lang: 'zh' },
  { query: 'typecheck 提交前检查 类型错误', relevant: ['g7'], lang: 'zh' },
  { query: 'feature flags 配置位置', relevant: ['g8'], lang: 'zh' },
  { query: 'dev server proxy api 地址', relevant: ['p1'], lang: 'en' },
  { query: 'jwt 密钥 从哪里读取 启动时', relevant: ['p2'], lang: 'zh' },
  { query: '数据库迁移 database migrations 自动执行', relevant: ['p3'], lang: 'zh' },
  { query: 'linter 默认导出 规则 lib 目录', relevant: ['p4'], lang: 'zh' },
  { query: 'e2e 浏览器 调试端口 chromium', relevant: ['p5'], lang: 'zh' },
  { query: 'rate limit 每分钟请求数 上限', relevant: ['p6'], lang: 'zh' },
  { query: '结构化日志 pino 请求 id', relevant: ['p7'], lang: 'zh' },
  { query: '前端状态管理 zustand store 划分', relevant: ['p8'], lang: 'zh' },
  { query: '中文 回答 风格 偏好', relevant: ['u1'], lang: 'zh' },
  { query: '提交之前 运行 测试 套件 习惯', relevant: ['u2'], lang: 'zh' },
  { query: 'meeting timezone tokyo schedule', relevant: ['u3'], lang: 'en' },
  { query: 'editor theme appearance preference dark', relevant: ['u4'], lang: 'en' },
  { query: '文档 语言 要求 中文 书写', relevant: ['u5'], lang: 'zh' },
  { query: 'emoji commit messages dislike', relevant: ['u6'], lang: 'en' },
  { query: 'vim 键位 编辑器 偏好', relevant: ['u7'], lang: 'zh' },
  { query: 'standup notes where posted morning wiki', relevant: ['u8'], lang: 'en' },
]

/** Minimal search face the evaluator needs (satisfied by MemoryStore.search). */
export interface Searcher {
  search(query: { query: string; limit?: number }): { entries: readonly { id: string }[]; total: number }
}

/** Per-case outcome of one evaluation pass. */
export interface CaseResult {
  readonly query: string
  readonly lang: 'en' | 'zh'
  readonly expected: readonly string[]
  /** Fixture ids of the returned top-k, in rank order. */
  readonly ranked: readonly string[]
  /** Whether every relevant id appeared within the top-k. */
  readonly hit: boolean
  /** 1/rank of the best relevant hit (0 when none). */
  readonly reciprocalRank: number
}

export interface EvalReport {
  /**
   * Success@k: fraction of cases where ALL relevant ids appear within the
   * top-k (for single-relevant cases this IS recall@k).
   */
  readonly recallAtK: number
  /** Mean fraction of the top-k slots occupied by relevant ids. */
  readonly precisionAtK: number
  /** Fraction of cases whose rank-1 result is relevant. */
  readonly precisionAtOne: number
  /** Mean reciprocal rank across cases. */
  readonly mrr: number
  readonly k: number
  readonly caseCount: number
  readonly perCase: readonly CaseResult[]
  /** Same aggregates restricted to the zh query slice. */
  readonly zh: { readonly recallAtK: number; readonly precisionAtOne: number }
  /** Same aggregates restricted to the en query slice. */
  readonly en: { readonly recallAtK: number; readonly precisionAtOne: number }
}

function sliceStats(perCase: readonly CaseResult[], k: number): { recallAtK: number; precisionAtOne: number } {
  if (perCase.length === 0) return { recallAtK: 0, precisionAtOne: 0 }
  const recallHits = perCase.filter(c => c.hit).length
  const topOneHits = perCase.filter(c => c.ranked[0] !== undefined && c.expected.includes(c.ranked[0])).length
  return {
    recallAtK: recallHits / perCase.length,
    precisionAtOne: topOneHits / perCase.length,
  }
}

/**
 * Run every golden case against `searcher` and aggregate P@k / R@k / MRR.
 * @param searcher - the search face under test (typically the real store).
 * @param k - the cut-off rank for precision/recall (default 5).
 */
export function evaluateRecall(searcher: Searcher, k: number = 5): EvalReport {
  const perCase: CaseResult[] = GOLDEN_CASES.map(golden => {
    const result = searcher.search({ query: golden.query, limit: k })
    const ranked = result.entries.map(entry => entry.id)
    const topK = ranked.slice(0, k)
    const hitCount = topK.filter(id => golden.relevant.includes(id)).length
    let reciprocalRank = 0
    for (let i = 0; i < topK.length; i++) {
      if (golden.relevant.includes(topK[i]!)) {
        reciprocalRank = 1 / (i + 1)
        break
      }
    }
    return {
      query: golden.query,
      lang: golden.lang,
      expected: [...golden.relevant],
      ranked,
      hit: hitCount === golden.relevant.length,
      reciprocalRank,
    }
  })
  return {
    ...sliceStats(perCase, k),
    // Mean top-k precision: relevant slots over k (single-relevant sets cap
    // this at 1/k — report it alongside success/MRR, not instead of them).
    precisionAtK: perCase.reduce((sum, c) => sum + c.ranked.slice(0, k).filter(id => c.expected.includes(id)).length / k, 0) / perCase.length,
    recallAtK: perCase.filter(c => c.hit).length / perCase.length,
    mrr: perCase.reduce((sum, c) => sum + c.reciprocalRank, 0) / perCase.length,
    k,
    caseCount: perCase.length,
    perCase,
    zh: sliceStats(perCase.filter(c => c.lang === 'zh'), k),
    en: sliceStats(perCase.filter(c => c.lang === 'en'), k),
  }
}

// ─── Injection cost (P1-8) ─────────────────────────────────────────────────

/** Standing injection cost of one prompt mode over the fixture store. */
export interface InjectionCost {
  readonly mode: 'policy-only' | 'index' | 'full'
  /** Rendered section characters. */
  readonly chars: number
  /** ≈tokens at the ~4-chars/token heuristic used by readMemorySnapshot. */
  readonly approxTokens: number
  /** Entry contents visible in the section (index lines count as half-hints). */
  readonly entriesRendered: number
  /** Index existence lines rendered (index mode only; 0 otherwise). */
  readonly indexLines: number
}

/**
 * Measure what each memory mode would stand-inject for a given snapshot pair.
 * The caller renders the snapshots once with the shipping helpers so this
 * module stays free of context-plugin imports.
 */
export function measureInjectionCost(
  mode: InjectionCost['mode'],
  renderedSection: string,
  opts: { entriesRendered?: number; indexLines?: number } = {},
): InjectionCost {
  return {
    mode,
    chars: renderedSection.length,
    approxTokens: Math.ceil(renderedSection.length / 4),
    entriesRendered: opts.entriesRendered ?? 0,
    indexLines: opts.indexLines ?? 0,
  }
}

/** Render one comparison row as aligned plain text (for reports/spec logs). */
export function formatCostRow(cost: InjectionCost): string {
  const pad = (value: string, width: number): string => value + ' '.repeat(Math.max(0, width - value.length))
  return `${pad(cost.mode, 14)}${pad(String(cost.chars), 10)}${pad(String(cost.approxTokens), 12)}${pad(String(cost.entriesRendered), 18)}${String(cost.indexLines)}`
}
