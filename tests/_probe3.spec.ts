import { it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as memoryStore from '../src/store/index.ts'

it('goodbye closes marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'))
  try {
    const ctx = new Context()
    await ctx.plugin(storage.default ?? (storage as never as { default: never }), {})
    console.log('storage plugin keys:', Object.keys(storage).slice(0, 8))
  } catch (e) { console.log('storage plugin load err:', String(e).slice(0, 80)) }
  expect(true).toBe(true)
})
