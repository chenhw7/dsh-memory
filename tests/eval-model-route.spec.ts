/**
 * Unit tests for the eval model-route resolution (`--model` flag, the
 * deployment home's `agent-default-model` default, and the stock fallback).
 *
 * @module tests/eval-model-route
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeEvalModelRoute, resolveEvalModel } from '../eval/model-route.ts'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** One throwaway deployment home holding a settings.yaml. */
function homeWith(settingsYaml: string): string {
  const home = mkdtempSync(join(tmpdir(), 'eval-model-route-'))
  homes.push(home)
  writeFileSync(join(home, 'settings.yaml'), settingsYaml)
  return home
}

describe('resolveEvalModel', () => {
  it('an explicit --model wins over everything', () => {
    const home = homeWith('agent-default-model:\n  provider: fuyao\n  model: fuyao-work\n')
    expect(resolveEvalModel('fuyao-coding', { DSH_HOME: home })).toEqual({
      model: 'fuyao-coding',
      source: 'flag',
    })
  })

  it('defaults to the deployment home agent-default-model when no --model', () => {
    const home = homeWith('agent-default-model:\n  provider: fuyao\n  model: fuyao-work\n  reasoningEffort: max\n')
    expect(resolveEvalModel(undefined, { DSH_HOME: home })).toEqual({
      model: 'fuyao-work',
      source: 'agent-default-model',
      origin: join(home, 'settings.yaml'),
      deploymentProvider: 'fuyao',
    })
  })

  it('falls back to the stock DeepSeek route when the deployment declares no agent-default-model', () => {
    const home = homeWith('ui-theme:\n  preference: dark\n')
    expect(resolveEvalModel(undefined, { DSH_HOME: home })).toEqual({
      model: 'deepseek-v4-flash',
      source: 'fallback',
    })
  })

  it('falls back when no deployment home exists (bare machine)', () => {
    expect(resolveEvalModel(undefined, { DSH_HOME: '/nonexistent-eval-home' })).toEqual({
      model: 'deepseek-v4-flash',
      source: 'fallback',
    })
  })

  it('fails loud on an unparseable settings document', () => {
    const home = homeWith('{ not yaml at all')
    expect(() => resolveEvalModel(undefined, { DSH_HOME: home })).toThrow(/not valid YAML/)
  })

  it('fails loud on a malformed agent-default-model mapping', () => {
    const home = homeWith('agent-default-model: just-a-string\n')
    expect(() => resolveEvalModel(undefined, { DSH_HOME: home })).toThrow(/must be a mapping/)
  })

  it('fails loud on an agent-default-model without a model id', () => {
    const home = homeWith('agent-default-model:\n  provider: fuyao\n')
    expect(() => resolveEvalModel(undefined, { DSH_HOME: home })).toThrow(/must be a non-empty string/)
  })
})

describe('describeEvalModelRoute', () => {
  it('names the source of each resolution', () => {
    expect(describeEvalModelRoute({ model: 'm', source: 'flag' })).toBe('--model flag')
    expect(describeEvalModelRoute({ model: 'm', source: 'fallback' })).toContain('fallback default')
    expect(describeEvalModelRoute({ model: 'm', source: 'agent-default-model', origin: '/h/settings.yaml' })).toContain('/h/settings.yaml')
  })
})
