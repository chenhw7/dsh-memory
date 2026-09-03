/**
 * Unit coverage for the eval instrument config (`eval.yaml`): the per-turn
 * budget's section parsing, the three-layer resolution, and the boot budget
 * verdict. Every load pins `$DSH_EVAL_CONFIG` at a throwaway file via the
 * explicit env argument — the eval process's own candidate chain is never
 * touched.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TURN_TOOL_CALLS, DEFAULT_TURN_WALL_SECONDS, loadEvalYamlTurnBudget, resolveTurnBudget } from '../eval/eval-config.ts'
import { turnBudgetBreach } from '../eval/boot.ts'

/** One throwaway directory removed after each case. */
const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Write one eval config document and pin it as the sole candidate. */
function configWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-spec-config-'))
  tempDirs.push(dir)
  const path = join(dir, 'eval.yaml')
  writeFileSync(path, `${body}\n`)
  return path
}

const envOf = (path: string): NodeJS.ProcessEnv => ({ DSH_EVAL_CONFIG: path })

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('loadEvalYamlTurnBudget', () => {
  it('reads both fields from a present section', () => {
    const path = configWith('judge:\n  baseURL: http://x/v1\n  apiKey: k\n  model: m\nturnBudget:\n  wallSeconds: 120\n  toolCalls: 16')
    expect(loadEvalYamlTurnBudget(envOf(path))).toEqual({ wallSeconds: 120, toolCalls: 16 })
  })

  it('returns null when the file is absent, empty, or carries no turnBudget section', () => {
    expect(loadEvalYamlTurnBudget(envOf(join(tmpdir(), 'dsh-eval-spec-no-such-eval-yaml')))).toBeNull()
    expect(loadEvalYamlTurnBudget(envOf(configWith('')))).toBeNull()
    expect(loadEvalYamlTurnBudget(envOf(configWith('judge:\n  baseURL: http://x\n  apiKey: k\n  model: m')))).toBeNull()
  })

  it('accepts 0 as an explicit per-dimension off', () => {
    const path = configWith('turnBudget:\n  wallSeconds: 0\n  toolCalls: 0')
    expect(loadEvalYamlTurnBudget(envOf(path))).toEqual({ wallSeconds: 0, toolCalls: 0 })
  })

  it('fails loud on a half-pasted, unknown-field, or invalid-value section', () => {
    const half = configWith('turnBudget:\n  wallSeconds: 120')
    expect(() => loadEvalYamlTurnBudget(envOf(half))).toThrow(/needs both wallSeconds and toolCalls/)
    const unknown = configWith('turnBudget:\n  wallSeconds: 120\n  toolCalls: 32\n  maxSteps: 9')
    expect(() => loadEvalYamlTurnBudget(envOf(unknown))).toThrow(/unknown field\(s\)/)
    const negative = configWith('turnBudget:\n  wallSeconds: -1\n  toolCalls: 32')
    expect(() => loadEvalYamlTurnBudget(envOf(negative))).toThrow(/turnBudget\.wallSeconds/)
    const float = configWith('turnBudget:\n  wallSeconds: 1.5\n  toolCalls: 32')
    expect(() => loadEvalYamlTurnBudget(envOf(float))).toThrow(/turnBudget\.wallSeconds/)
    const scalar = configWith('turnBudget: 180')
    expect(() => loadEvalYamlTurnBudget(envOf(scalar))).toThrow(/must be a mapping/)
  })
})

describe('resolveTurnBudget', () => {
  it('prefers explicit flags per dimension, then the file section, then the defaults', () => {
    expect(resolveTurnBudget({}, null)).toEqual({ wallSeconds: DEFAULT_TURN_WALL_SECONDS, toolCalls: DEFAULT_TURN_TOOL_CALLS })
    expect(resolveTurnBudget({}, { wallSeconds: 60, toolCalls: 8 })).toEqual({ wallSeconds: 60, toolCalls: 8 })
    expect(resolveTurnBudget({ wallSeconds: 30 }, { wallSeconds: 60, toolCalls: 8 })).toEqual({ wallSeconds: 30, toolCalls: 8 })
    // An explicit 0 (cap off) wins the same way a positive value does.
    expect(resolveTurnBudget({ toolCalls: 0 }, { wallSeconds: 60, toolCalls: 8 })).toEqual({ wallSeconds: 60, toolCalls: 0 })
    expect(resolveTurnBudget({ wallSeconds: 0, toolCalls: 0 }, null)).toEqual({ wallSeconds: 0, toolCalls: 0 })
  })
})

describe('turnBudgetBreach', () => {
  const budget = { wallSeconds: 180, toolCalls: 32 }

  it('is null while both dimensions are within budget', () => {
    expect(turnBudgetBreach(0, 0, budget)).toBeNull()
    expect(turnBudgetBreach(180_000, 32, budget)).toBeNull()
    expect(turnBudgetBreach(1000, 32, budget)).toBeNull()
  })

  it('reports a wall breach with the observed and allowed seconds', () => {
    expect(turnBudgetBreach(181_000, 3, budget)).toBe('wall 181s > 180s')
  })

  it('reports a tool-call breach with the observed and allowed counts', () => {
    expect(turnBudgetBreach(1000, 33, budget)).toBe('toolCalls 33 > 32')
  })

  it('disables a dimension set to 0', () => {
    expect(turnBudgetBreach(10_000_000, 999, { wallSeconds: 0, toolCalls: 0 })).toBeNull()
    expect(turnBudgetBreach(10_000_000, 3, { wallSeconds: 0, toolCalls: 32 })).toBeNull()
    expect(turnBudgetBreach(1000, 999, { wallSeconds: 180, toolCalls: 0 })).toBeNull()
  })
})
