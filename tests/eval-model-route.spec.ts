/**
 * Unit tests for the eval model-route resolution (`--provider`/`--model`
 * flags, the deployment home's `agent-default-model` default, the stock
 * fallback, and the `llm-pi-ai` section mirroring that activates
 * non-DeepSeek provider routes).
 *
 * @module tests/eval-model-route
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
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

const FUYAO_SETTINGS = [
  'llm-pi-ai:',
  '  providers:',
  '    fuyao:',
  '      apiKeyEnv: FUYAO_API_KEY',
  '      api: openai-completions',
  '      baseURL: http://fuyao-ai-gateway.example/v1',
  '      models:',
  '        - id: fuyao-work',
  '          contextWindow: 262144',
  'agent-default-model:',
  '  provider: fuyao',
  '  model: fuyao-work',
  '  reasoningEffort: max',
  '',
].join('\n')

describe('resolveEvalModel', () => {
  it('explicit flags win over everything', () => {
    const home = homeWith(FUYAO_SETTINGS)
    expect(resolveEvalModel({ provider: 'fuyao', model: 'fuyao-coding' }, { DSH_HOME: home })).toMatchObject({
      provider: 'fuyao',
      model: 'fuyao-coding',
      source: 'flag',
    })
  })

  it('defaults to the deployment home agent-default-model (both axes)', () => {
    const home = homeWith(FUYAO_SETTINGS)
    const route = resolveEvalModel({}, { DSH_HOME: home })
    expect(route.provider).toBe('fuyao')
    expect(route.model).toBe('fuyao-work')
    expect(route.source).toBe('agent-default-model')
    expect(route.origin).toBe(join(home, 'settings.yaml'))
  })

  it('carries the deployment llm-pi-ai section for a non-DeepSeek provider', () => {
    const home = homeWith(FUYAO_SETTINGS)
    const section = resolveEvalModel({}, { DSH_HOME: home }).piAiSection
    expect(section).toBeDefined()
    const parsed = parse(section ?? '') as Record<string, unknown>
    const providers = (parsed['llm-pi-ai'] as Record<string, unknown>)['providers'] as Record<string, unknown>
    expect(Object.keys(providers)).toEqual(['fuyao'])
    expect((providers['fuyao'] as Record<string, unknown>)['apiKeyEnv']).toBe('FUYAO_API_KEY')
  })

  it('mixed flags resolve independently (provider from flags, model from deployment)', () => {
    const home = homeWith(FUYAO_SETTINGS)
    expect(resolveEvalModel({ provider: 'fuyao' }, { DSH_HOME: home })).toMatchObject({
      provider: 'fuyao',
      model: 'fuyao-work',
      source: 'flag',
    })
  })

  it('falls back to the stock DeepSeek pair when the deployment declares no route', () => {
    const home = homeWith('ui-theme:\n  preference: dark\n')
    expect(resolveEvalModel({}, { DSH_HOME: home })).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      source: 'fallback',
      origin: join(home, 'settings.yaml'),
    })
  })

  it('falls back when no deployment home exists (bare machine) and flags need no mirror', () => {
    expect(resolveEvalModel({ model: 'fuyao-coding' }, { DSH_HOME: '/nonexistent-eval-home' })).toEqual({
      provider: 'deepseek-official',
      model: 'fuyao-coding',
      source: 'flag',
    })
  })

  it('fails loud when a non-DeepSeek provider has no llm-pi-ai profile', () => {
    const home = homeWith('agent-default-model:\n  provider: fuyao\n  model: fuyao-work\n')
    expect(() => resolveEvalModel({}, { DSH_HOME: home })).toThrow(/needs an llm-pi-ai: section/)
  })

  it('fails loud on an unparseable settings document', () => {
    const home = homeWith('{ not yaml at all')
    expect(() => resolveEvalModel({}, { DSH_HOME: home })).toThrow(/not valid YAML/)
  })

  it('fails loud on a settings document that is not a mapping', () => {
    const home = homeWith('just-a-string\n')
    expect(() => resolveEvalModel({}, { DSH_HOME: home })).toThrow(/must be a mapping/)
  })

  it('fails loud on a malformed agent-default-model mapping', () => {
    const home = homeWith('agent-default-model: just-a-string\n')
    expect(() => resolveEvalModel({}, { DSH_HOME: home })).toThrow(/agent-default-model .* must be a mapping/)
  })

  it('fails loud on an agent-default-model without a model id', () => {
    const home = homeWith('agent-default-model:\n  provider: fuyao\n')
    expect(() => resolveEvalModel({}, { DSH_HOME: home })).toThrow(/must be a non-empty string/)
  })

  it('fails loud on a mirrored provider profile carrying an inline credential', () => {
    const home = homeWith([
      'llm-pi-ai:',
      '  providers:',
      '    fuyao:',
      '      apiKey: sk-inline-secret',
      '      baseURL: http://fuyao-ai-gateway.example/v1',
      'agent-default-model:',
      '  provider: fuyao',
      '  model: fuyao-work',
      '',
    ].join('\n'))
    expect(() => resolveEvalModel({}, { DSH_HOME: home })).toThrow(/inline credential field/)
  })
})

describe('describeEvalModelRoute', () => {
  it('names the source of each resolution', () => {
    expect(describeEvalModelRoute({ provider: 'p', model: 'm', source: 'flag' })).toContain('--provider')
    expect(describeEvalModelRoute({ provider: 'p', model: 'm', source: 'fallback' })).toContain('fallback default')
    expect(describeEvalModelRoute({ provider: 'p', model: 'm', source: 'agent-default-model', origin: '/h/settings.yaml' })).toContain('/h/settings.yaml')
  })
})
