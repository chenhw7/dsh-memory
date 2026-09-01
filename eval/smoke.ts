/**
 * M0 smoke: prove the real-harness chain end to end.
 *
 * `npm run build` (plugin lib/) → throwaway `$DSH_HOME` → pre-write the seeded
 * `storages/memory.json` (v0 medium) → boot the harness under the mock model
 * with the eval profile → drive the scenario's two questions as two prompts →
 * assert the seeded facts surfaced inside the assembled system prompt's
 * `<memory-index>` fence → quiesce → dispose → assert the seeds survive on the
 * medium. Prints PASS/FAIL with evidence (the injected fence fragment and a
 * memory.json summary) and exits non-zero on failure. No report files: the
 * console output IS the M0 evidence.
 *
 * @module eval/smoke
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHarness, type TurnResult } from './boot.ts'
import { waitForQuiesce } from './harness/quiesce.ts'
import { readStoredEntries, seedMemoryMedium, type SeedEntryInput } from './harness/seed-media.ts'

/** Absolute plugin package root (the build directory under test). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The pinned smoke scenario (kind "seed"). The dataset file is a wire
 * boundary: `scope` is validated at load (below), not trusted from the cast.
 */
interface SmokeScenario {
  id: string
  kind: string
  domain: string
  language: string
  seedEntries?: Array<{
    id: string
    scope: 'global' | 'project' | 'user'
    category?: string
    content: string
    summary?: string
  }>
  questions: Array<{ id: string; q: string; requires: string[]; gold: string; type: string; variantOf?: string | null }>
}

/** Load and shape-check the smoke dataset (one line). */
function loadSmokeScenario(): SmokeScenario {
  const file = join(REPO_ROOT, 'eval', 'datasets', 'smoke.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0)
  if (lines.length !== 1) {
    throw new Error(`eval smoke: ${file} must hold exactly one scenario line, got ${String(lines.length)}`)
  }
  const scenario = JSON.parse(lines[0]!) as SmokeScenario
  if (scenario.kind !== 'seed' || (scenario.seedEntries?.length ?? 0) === 0 || scenario.questions.length < 1) {
    throw new Error(`eval smoke: scenario ${scenario.id} is not a seeded, question-bearing scenario`)
  }
  for (const seed of scenario.seedEntries ?? []) {
    if (seed.scope !== 'global' && seed.scope !== 'project' && seed.scope !== 'user') {
      throw new Error(`eval smoke: seed ${seed.id} has invalid scope ${JSON.stringify(seed.scope)}`)
    }
  }
  return scenario
}

/**
 * Ensure the plugin build exists. `lib/` is the BUILD UNDER TEST — the A/B
 * variable of the whole suite, not eval runtime state: the suite measures
 * whatever `lib/` holds when this runs. The auto-build here is only a
 * convenience so `npm run eval:smoke` works from a clean checkout; it never
 * rebuilds an existing `lib/` (a stale one is the caller's explicit choice,
 * e.g. a baseline for A/B), so a run that must measure fresh code starts
 * from `npm run build`.
 */
function ensurePluginBuild(): void {
  if (existsSync(join(REPO_ROOT, 'lib', 'index.js'))) return
  process.stdout.write('eval smoke: lib/ missing — running `npm run build` first\n')
  const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' })
  if (build.status !== 0) throw new Error(`eval smoke: npm run build failed with status ${String(build.status)}`)
}

/** Extract the `<memory-index>` fence body from a system prompt. */
function memoryIndexFence(systemPrompt: string): string | undefined {
  const match = /<memory-index>\n([\s\S]*?)\n<\/memory-index>/.exec(systemPrompt)
  return match?.[1]
}

/** One assertion failure (collected, reported together). */
const failures: string[] = []

function expect(condition: boolean, message: string): void {
  if (!condition) failures.push(message)
}

/** Short evidence rendering of one medium on disk (single source: seed-media's reader). */
function mediumSummary(dshHome: string): string {
  const { entries } = readStoredEntries(dshHome)
  return entries.length === 0
    ? '(no entries)'
    : entries.map(entry =>
        `- ${entry.id} [${entry.scope}/${entry.category ?? '-'}]: ${entry.content.slice(0, 60)}…`).join('\n')
}

async function main(): Promise<void> {
  const scenario = loadSmokeScenario()
  ensurePluginBuild()
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-eval-smoke-'))
  // Single-source v0 medium pre-write (eval/harness/seed-media.ts): the seeds
  // carry that file's fixed SEED_TIMESTAMP, so smoke cannot drift from the
  // runner's seeding shape.
  seedMemoryMedium(dshHome, (scenario.seedEntries ?? []).map(seed => ({
    id: seed.id,
    scope: seed.scope,
    ...(seed.category !== undefined ? { category: seed.category } : {}),
    content: seed.content,
    ...(seed.summary !== undefined ? { summary: seed.summary } : {}),
  } as SeedEntryInput)))
  process.stdout.write(`eval smoke: scenario ${scenario.id}; DSH_HOME ${dshHome}\n`)

  let handle: Awaited<ReturnType<typeof startHarness>> | undefined
  try {
    handle = await startHarness({
      buildDir: REPO_ROOT,
      dshHome,
      profileName: 'eval-smoke',
      model: { mode: 'mock' },
    })

    const turns: TurnResult[] = []
    for (const question of scenario.questions) {
      const turn = await handle.prompt(question.q)
      turns.push(turn)
      process.stdout.write(`eval smoke: turn "${question.q}" -> final ${JSON.stringify(turn.finalText.slice(0, 80))}, `
        + `toolCalls=${String(turn.toolCalls.length)}, systemPrompt ${turn.systemPrompt === undefined ? 'absent' : `${String(turn.systemPrompt.length)} chars`}\n`)
    }

    await waitForQuiesce(dshHome, 30_000)
    await handle.dispose()

    // ── assertions ──────────────────────────────────────────────────────────
    const turn1 = turns[0]
    if (turn1?.systemPrompt === undefined) {
      expect(false, 'no system prompt captured from turn 1 (request/header event missing)')
    } else {
      const fence = memoryIndexFence(turn1.systemPrompt)
      expect(fence !== undefined, 'turn 1 system prompt carries no <memory-index> fence')
      for (const seed of scenario.seedEntries ?? []) {
        const needle = seed.summary ?? seed.content
        expect(fence !== undefined && fence.includes(needle),
          `seed fact ${JSON.stringify(needle)} missing from the <memory-index> fence`)
      }
      if (fence !== undefined) {
        process.stdout.write(`\n[eval smoke] injected <memory-index> fence:\n${fence}\n`)
      }
    }
    process.stdout.write(`\n[eval smoke] memory.json after the run:\n${mediumSummary(dshHome)}\n`)
    const storedIds = new Set(readStoredEntries(dshHome).entries.map(entry => entry.id))
    for (const seed of scenario.seedEntries ?? []) {
      expect(storedIds.has(seed.id), `seed entry ${seed.id} vanished from the medium after the run`)
    }
  } catch (error) {
    failures.push(`run failure: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    // A mid-run throw leaves the runtime up; dispose is the loud cleanup.
    await handle?.dispose().catch((cleanupError: unknown) => {
      failures.push(`dispose failure: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
    })
  }

  if (failures.length > 0) {
    process.stdout.write(`\nFAIL (${scenario.id}) — ${String(failures.length)} failure(s), DSH_HOME kept for debugging:\n`)
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
    process.exitCode = 1
    return
  }
  // Evidence is printed above; the throwaway home only exists for it.
  rmSync(dshHome, { recursive: true, force: true })
  process.stdout.write(`\nPASS (${scenario.id})\n`)
}

await main()
