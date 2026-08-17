import { describe, it, expect } from 'vitest'
import { MemoryId } from '../src/brand.ts'
import { validateProjectScope } from '../src/index.ts'
import type { AddMemoryInput } from '../src/types.ts'

describe('MemoryId', () => {
  it('mints a unique branded id', () => {
    const a = MemoryId()
    const b = MemoryId()
    expect(a).not.toBe(b)
    expect(typeof a).toBe('string')
  })

  it('accepts an explicit id', () => {
    const id = MemoryId('test-id-123')
    expect(id).toBe('test-id-123')
  })
})

describe('validateProjectScope', () => {
  it('accepts project scope with projectName', () => {
    expect(() =>
      validateProjectScope({ scope: 'project', content: 'x', projectName: 'my-repo' }),
    ).not.toThrow()
  })

  it('rejects project scope without projectName', () => {
    expect(() =>
      validateProjectScope({ scope: 'project', content: 'x' } as AddMemoryInput),
    ).toThrow('project-scoped memory requires a projectName')
  })

  it('rejects project scope with empty projectName', () => {
    expect(() =>
      validateProjectScope({ scope: 'project', content: 'x', projectName: '  ' }),
    ).toThrow('project-scoped memory requires a projectName')
  })

  it('accepts global scope without projectName', () => {
    expect(() =>
      validateProjectScope({ scope: 'global', content: 'x' }),
    ).not.toThrow()
  })

  it('accepts user scope without projectName', () => {
    expect(() =>
      validateProjectScope({ scope: 'user', content: 'x' }),
    ).not.toThrow()
  })
})
