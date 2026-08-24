/**
 * Unit tests for the extraction-model dropdown option resolvers.
 * Regression: `modelOptions` used to read `providerId.length` unguarded, so a
 * draft whose provider field was `undefined` (the "follow session route"
 * sentinel) crashed the whole card render.
 *
 * @module tests/model-catalog
 */
import { describe, expect, it } from 'vitest'
import { modelOptions, providerOptions } from '../src/client/model-catalog.ts'

const catalog = {
  groups: [
    { id: 'fuyao', name: 'Fuyao', models: [{ id: 'fuyao-work', name: 'Fuyao Work' }, { id: 'fuyao-coding' }] },
    { id: 'openrouter', models: [{ id: 'stealth/ox-alpha' }] },
  ],
}

describe('providerOptions', () => {
  it('lists every advertised provider with a display-name label', () => {
    expect(providerOptions({ catalog, draft: {} })).toEqual([
      { value: 'fuyao', label: 'Fuyao (fuyao)' },
      { value: 'openrouter', label: 'openrouter' },
    ])
  })

  it('tolerates an absent or malformed catalog', () => {
    expect(providerOptions({ draft: {} })).toEqual([])
    expect(providerOptions({ catalog: {}, draft: {} })).toEqual([])
    expect(providerOptions({ catalog: { groups: [undefined, { id: 'x' }] }, draft: {} })).toEqual([
      { value: 'x', label: 'x' },
    ])
  })
})

describe('modelOptions', () => {
  it('does not throw when the drafted provider is undefined (follow-session sentinel)', () => {
    // Regression for the card-disappearing render crash.
    expect(() => modelOptions({ catalog, draft: {} })).not.toThrow()
    expect(() => modelOptions({ catalog, draft: { extractionModelProvider: undefined } })).not.toThrow()
  })

  it('aggregates all providers with a `provider ·` prefix when no provider is drafted', () => {
    expect(modelOptions({ catalog, draft: {} })).toEqual([
      { value: 'fuyao-work', label: 'fuyao · Fuyao Work (fuyao-work)' },
      { value: 'fuyao-coding', label: 'fuyao · fuyao-coding' },
      { value: 'stealth/ox-alpha', label: 'openrouter · stealth/ox-alpha' },
    ])
  })

  it('scopes to the drafted provider without the prefix', () => {
    expect(modelOptions({ catalog, draft: { extractionModelProvider: 'fuyao' } })).toEqual([
      { value: 'fuyao-work', label: 'Fuyao Work (fuyao-work)' },
      { value: 'fuyao-coding', label: 'fuyao-coding' },
    ])
  })

  it('returns an empty list for an unknown drafted provider (card degrades to free text)', () => {
    expect(modelOptions({ catalog, draft: { extractionModelProvider: 'gone' } })).toEqual([])
  })

  it('deduplicates model ids across providers keeping the first entry', () => {
    const duplicated = {
      groups: [
        { id: 'a', models: [{ id: 'shared' }] },
        { id: 'b', models: [{ id: 'shared' }, { id: 'unique' }] },
      ],
    }
    expect(modelOptions({ catalog: duplicated, draft: {} }).map(o => o.value)).toEqual(['shared', 'unique'])
  })
})
