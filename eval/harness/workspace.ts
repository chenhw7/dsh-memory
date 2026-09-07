/**
 * The eval workspace fixture repository (the corpus decision answering the
 * 2026-09-07 findings): a scenario that pins a workspace template gets a
 * bounded, premise-consistent repository materialized into its throwaway
 * home, and the child session's cwd becomes that repo — so planting
 * dialogues that address "this repository" resolve to the fixture instead
 * of escaping to the host disk (the non-terminating exploration loops), and
 * no host file can falsify a scenario's planted premises (the
 * counterfactual-premise collision).
 *
 * The template ships as static content under
 * `eval/harness/workspace-templates/<name>/` (the same versioned-content
 * discipline as the profile template); the materializer copies it, gives it
 * a one-commit git history under a pinned identity, and leaves exactly one
 * uncommitted change so a dialogue's "commit this change" has a referent.
 * Materialization is idempotent per home: the plant chain opens its second
 * handle over the same directory the first handle (or the real model's
 * edits) left behind.
 *
 * @module eval/harness/workspace
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkspaceTemplate } from '../schema.ts'

/** The static template tree, resolved next to this module (like the profile template). */
const TEMPLATE_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'workspace-templates')

/**
 * The fixture history's pinned identity (the child home's own
 * `materializeChildHome` writes the same pair into `~/.gitconfig`; the
 * materializer runs in the eval process, whose global git config must not
 * leak into the fixture's history).
 */
const GIT_IDENTITY = ['-c', 'user.name=dsh-eval', '-c', 'user.email=dsh-eval@localhost'] as const

/**
 * The deterministic pending change written after the initial commit: one
 * untracked document, so a dialogue's "commit this change" has a referent
 * and `git status` shows exactly one entry. A template-independent path —
 * every workspace template can carry a docs/ directory.
 */
const PENDING_CHANGE_FILE = 'docs/next-steps.md'
const PENDING_CHANGE = `# Next steps

- Wire the detail-cache warmup into startup.
- Fold the pending review notes into the changelog draft.
`

/** Every workspace template's directory (the spec asserts each declared name ships one). */
export function workspaceTemplateNames(): readonly WorkspaceTemplate[] {
  return readdirSync(TEMPLATE_ROOT).filter(name => statSync(join(TEMPLATE_ROOT, name)).isDirectory()) as WorkspaceTemplate[]
}

/**
 * Materialize the fixture repo for one scenario home and return the child
 * session's cwd. Loud on any failure (a missing template dir, a git error):
 * a silently missing workspace would quietly reintroduce the host-disk
 * escape the fixture exists to close.
 * @param dshHome - the throwaway harness home.
 * @param template - the scenario's pinned template name.
 */
export function materializeWorkspace(dshHome: string, template: WorkspaceTemplate): string {
  const dir = join(dshHome, 'workspace', template)
  if (existsSync(join(dir, '.git'))) return dir
  cpSync(join(TEMPLATE_ROOT, template), dir, { recursive: true })
  git(dir, ['init', '--initial-branch=main'])
  git(dir, [...GIT_IDENTITY, 'add', '--all'])
  git(dir, [...GIT_IDENTITY, 'commit', '--message', 'chore: initial import'])
  mkdirSync(dirname(join(dir, PENDING_CHANGE_FILE)), { recursive: true })
  writeFileSync(join(dir, PENDING_CHANGE_FILE), PENDING_CHANGE)
  return dir
}

/** Run one git command in the fixture; a non-zero exit throws (fail loud). */
function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
}
