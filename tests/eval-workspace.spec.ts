/**
 * The eval workspace fixture repo (the corpus decision answering the
 * 2026-09-07 findings): a scenario that pins a workspace template gets a
 * bounded, premise-consistent repository materialized into its throwaway
 * home, and the child session's cwd becomes that repo. This spec pins the
 * materializer's contract over BOTH shipped templates — template fidelity,
 * the pinned git identity, the one pending change a "commit this" dialogue
 * needs, idempotency across the plant chain's two handles — plus the corpus
 * schema's workspace axis.
 *
 * Real git runs in here (the materializer shells out), over mkdtemp homes
 * torn down in `finally`.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeWorkspace, workspaceTemplateNames } from '../eval/harness/workspace.ts'
import { parseScenarioLine, workspaceSchema, type WorkspaceTemplate } from '../eval/schema.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = workspaceSchema.options as readonly WorkspaceTemplate[]

/** Every file under a directory, as repo-relative sorted paths (`.git`
 * internals excluded; `.gitignore` and `.github/` are template content).
 * Recursive readdir entries are already dir-relative — do not re-relativize. */
function fileTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(name => String(name))
    .filter(name => name !== '.git' && !name.startsWith('.git/'))
    .sort()
}

function git(cwd: string, args: readonly string[]): string {
  // Strip only the trailing newline: `status --porcelain` encodes the index
  // state in a LEADING character a trim() would eat.
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).replace(/\n+$/, '')
}

/** One materialized fixture under a fresh throwaway home. */
function withFixture(template: WorkspaceTemplate, run: (dir: string, home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'dsh-eval-ws-'))
  try {
    run(materializeWorkspace(home, template), home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('workspace fixture materialization', () => {
  it('every declared template ships a directory', () => {
    for (const name of TEMPLATES) expect(workspaceTemplateNames()).toContain(name)
  })

  for (const template of TEMPLATES) {
    describe(`template ${template}`, () => {
      it('copies the template verbatim (plus the pending change) and inits a one-commit repo with the pinned identity', () => {
        withFixture(template, (dir) => {
          expect(fileTree(dir)).toEqual([...fileTree(join(ROOT, 'eval', 'harness', 'workspace-templates', template)), 'docs', 'docs/next-steps.md'].sort())
          expect(git(dir, ['rev-parse', '--is-inside-work-tree'])).toBe('true')
          expect(git(dir, ['log', '--format=%an <%ae>'])).toBe('dsh-eval <dsh-eval@localhost>')
        })
      })

      it('leaves exactly one pending change with the deterministic content', () => {
        withFixture(template, (dir) => {
          expect(git(dir, ['status', '--porcelain', '--untracked-files=all'])).toBe('?? docs/next-steps.md')
          expect(readFileSync(join(dir, 'docs/next-steps.md'), 'utf8')).toContain('Wire the detail-cache warmup into startup.')
        })
      })

      it('is idempotent: a second handle over the same home keeps the tree and history', () => {
        withFixture(template, (dir, home) => {
          const before = git(dir, ['log', '--format=%H'])
          materializeWorkspace(home, template)
          expect(git(dir, ['log', '--format=%H'])).toBe(before)
          expect(git(dir, ['status', '--porcelain', '--untracked-files=all'])).toBe('?? docs/next-steps.md')
        })
      })
    })
  }

  it('fails loud when the scenario pins an unknown template', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-eval-ws-'))
    try {
      expect(() => materializeWorkspace(home, 'no-such-template' as WorkspaceTemplate)).toThrow()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("the demo-app fixture's own test suite is green (pnpm test runs offline)", () => {
    withFixture('demo-app', (dir) => {
      // The anti-loop property the fixture exists for: the dialogue's most
      // likely command resolves green with zero dependencies installed.
      const out = execFileSync('node', ['--test', 'tests/smoke.test.mjs', 'tests/integration/flaky.spec.mjs'], {
        cwd: dir,
        encoding: 'utf8',
      })
      expect(out).toContain('# fail 0')
    })
  })
})

describe('workspace axis in the corpus schema', () => {
  it('accepts a scenario pinning a workspace', () => {
    const scenario = parseScenarioLine(
      JSON.stringify({
        id: 'ws-probe', kind: 'plant', domain: 'programming', language: 'zh',
        workspace: 'demo-app',
        turns: [{ user: '接手这个仓库了。', planted: ['f-ws'] }],
        questions: [{ id: 'q-ws', q: '这个仓库用什么装依赖？', requires: ['f-ws'], gold: 'pnpm', type: 'single-hop' }],
      }),
      'probe: line 1',
    )
    expect(scenario.workspace).toBe('demo-app')
  })

  it('rejects an unknown template name', () => {
    const row = JSON.stringify({
      id: 'ws-probe', kind: 'plant', domain: 'programming', language: 'zh',
      workspace: 'no-such-template',
      questions: [{ id: 'q-ws', q: 'q', requires: [], gold: 'g', type: 'single-hop' }],
    })
    expect(() => parseScenarioLine(row, 'probe: line 1')).toThrow(/workspace/)
  })

  it('every core-v0 row that pins a workspace is a plant scenario', () => {
    const raw = readFileSync(join(ROOT, 'eval', 'datasets', 'core-v0.jsonl'), 'utf8')
    for (const [index, line] of raw.trim().split('\n').entries()) {
      const scenario = parseScenarioLine(line, `core-v0: line ${index + 1}`)
      if (scenario.workspace !== undefined) expect(scenario.kind).toBe('plant')
    }
  })
})
