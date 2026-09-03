/**
 * Unit coverage for the eval harness pure layer: profile-template
 * materialization, quiesce stability judgment, and the SDK session-event
 * reducer. The spawn/mock-dependent boot path stays out of vitest —
 * `npm run eval:smoke` is its lane.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_BUNDLE_NAME,
  PROFILE_BUNDLES,
  materializeProfile,
  renderProfilePackageJson,
  renderProfilePatchYaml,
  renderSettingsYaml,
} from '../eval/harness/profile-template.ts'
import { mediumSnapshot, memoryMediumPath, snapshotStable } from '../eval/harness/quiesce.ts'
import { collectSessionEvent, emptyTurnCollector, isInboxReceipt } from '../eval/harness/sdk-client.ts'
import { materializeChildHome } from '../eval/boot.ts'

/** One throwaway directory removed after each case. */
const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('eval profile template rendering', () => {
  it('renders the profile manifest with the sdk bundles plus the linked plugin', () => {
    const manifest = JSON.parse(renderProfilePackageJson('/tmp/build-a')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[]; patchReload: string } }
    }
    expect(manifest.dsh.profile.bundles).toEqual([...PROFILE_BUNDLES])
    expect(PROFILE_BUNDLES[0]).toBe('@deepseek-ai/dsh-base')
    expect(PROFILE_BUNDLES[1]).toBe('@deepseek-ai/dsh-sdk-app')
    expect(PROFILE_BUNDLES[2]).toBe('@chenhw7/dsh-memory')
    expect(manifest.dependencies[PLUGIN_BUNDLE_NAME]).toBe('link:/tmp/build-a')
    expect(manifest.dsh.profile.patchReload).toBe('startup')
  })

  it('substitutes the mock base URL only in the mock settings document; external pins nothing', () => {
    const mock = renderSettingsYaml('mock', 'http://127.0.0.1:4567/v1')
    expect(mock).toContain('http://127.0.0.1:4567/v1')
    expect(mock).not.toContain('{{MOCK_BASE_URL}}')
    const real = renderSettingsYaml('real', undefined)
    expect(real).not.toContain('{{')
    // external routes per scenario through the child env, so it pins nothing.
    expect(renderSettingsYaml('external', undefined)).toBe(real)
    const patch = renderProfilePatchYaml()
    expect(patch).toContain('decayDays: 0')
    expect(patch).toContain('curatorEnabled: false')
    expect(patch).toContain('confirmBeforeWrite: false')
  })

  it('rejects an invalid profile name and a mock run without a mock URL', () => {
    const home = tempDir('dsh-eval-tpl-')
    expect(() => materializeProfile(home, '../escape', { mode: 'mock', buildDir: home, mockBaseUrl: 'http://x/v1' })).toThrow()
    expect(() => materializeProfile(home, 'ok-name', { mode: 'mock', buildDir: home })).toThrow(/mockBaseUrl/)
  })
})

describe('eval profile materialization', () => {
  it('writes the manifest and pinned patch into the profile dir, settings at the home root, and the plugin symlink', () => {
    const home = tempDir('dsh-eval-tpl-')
    const buildDir = tempDir('dsh-eval-build-')
    const profileDir = materializeProfile(home, 'eval-smoke', { mode: 'mock', buildDir, mockBaseUrl: 'http://127.0.0.1:1/v1' })
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      name: string
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.name).toBe('dsh-profile-eval-smoke')
    expect(manifest.dsh.profile.bundles).toContain('@chenhw7/dsh-memory')
    expect(manifest.dependencies['@chenhw7/dsh-memory']).toBe(`link:${buildDir}`)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('memory-review')
    // settings-file parses only $DSH_HOME/settings.yaml, so the document must
    // land at the home root, not inside the profile directory.
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('llm-deepseek')
    expect(existsSync(join(profileDir, 'settings.yaml'))).toBe(false)
    // The bundle link points at the build directory so the loader's
    // profile-anchor resolution finds the built package.
    const link = join(profileDir, 'node_modules', '@chenhw7', 'dsh-memory')
    expect(realpathSync(link)).toBe(realpathSync(buildDir))
  })

  it('re-points a drifted plugin symlink at the current build', () => {
    const home = tempDir('dsh-eval-tpl-')
    const buildA = tempDir('dsh-eval-build-a-')
    const buildB = tempDir('dsh-eval-build-b-')
    const profileDir = materializeProfile(home, 'eval-drift', { mode: 'real', buildDir: buildA })
    materializeProfile(home, 'eval-drift', { mode: 'real', buildDir: buildB })
    const link = join(profileDir, 'node_modules', '@chenhw7', 'dsh-memory')
    expect(realpathSync(link)).toBe(realpathSync(buildB))
  })
})

describe('eval child home isolation', () => {
  it('materializes an empty fake home with a pinned git identity inside the dshHome', () => {
    const dshHome = tempDir('dsh-eval-spec-childhome-')
    const home = materializeChildHome(dshHome)
    expect(home).toBe(join(dshHome, 'home'))
    expect(existsSync(home)).toBe(true)
    const gitconfig = readFileSync(join(home, '.gitconfig'), 'utf8')
    expect(gitconfig).toContain('name = dsh-eval')
    expect(gitconfig).not.toContain(process.env['USER'] ?? '\u0000-none')
  })

  it('is idempotent for a second handle on the same dshHome', () => {
    const dshHome = tempDir('dsh-eval-spec-childhome-')
    const first = materializeChildHome(dshHome)
    const second = materializeChildHome(dshHome)
    expect(second).toBe(first)
    expect(readFileSync(join(first, '.gitconfig'), 'utf8')).toContain('defaultBranch = main')
  })
})

describe('eval quiesce stability judgment', () => {
  it('reads the v0 medium: entries count and max audit seq', () => {
    const raw = `${JSON.stringify({
      unit: { name: 'memory', version: 0 },
      global: null,
      tables: {
        entries: { a: { id: 'a', scope: 'global', content: 'x', createdAt: 1, updatedAt: 1 } },
        audit: {
          r1: { id: 'r1', op: 'add', entryId: 'a', scope: 'global', source: 'tool', ts: 1, seq: 3 },
          r2: { id: 'r2', op: 'add', entryId: 'a', scope: 'global', source: 'tool', ts: 2, seq: 7 },
        },
      },
    }, undefined, 2)}\n`
    const snapshot = mediumSnapshot(raw)
    expect(snapshot.maxAuditSeq).toBe(7)
    expect(snapshot.entryCount).toBe(1)
  })

  it('treats pre-audit media and missing files as settled-empty states', () => {
    expect(mediumSnapshot('').maxAuditSeq).toBe(0)
    const preAudit = JSON.stringify({ unit: { name: 'memory', version: 0 }, global: null, tables: { entries: {} } })
    expect(mediumSnapshot(preAudit).maxAuditSeq).toBe(0)
    expect(mediumSnapshot(preAudit).entryCount).toBe(0)
  })

  it('stability compares raw content plus audit seq', () => {
    const a = mediumSnapshot('{}')
    const b = mediumSnapshot('{}')
    expect(snapshotStable(a, b)).toBe(true)
    const changed = mediumSnapshot('{"tables":{"audit":{"r":{"seq":1}}}}')
    expect(snapshotStable(a, changed)).toBe(false)
  })

  it('exposes the medium path under the harness home', () => {
    expect(memoryMediumPath('/tmp/h')).toBe(join('/tmp/h', 'storages', 'memory.json'))
  })
})

describe('eval SDK session-event reducer', () => {
  it('captures the assembled system prompt from request/header snapshots', () => {
    const collector = emptyTurnCollector()
    collectSessionEvent(collector, { type: 'request/header', seq: 1, data: { header: { system: 'You are a coding agent.\n<memory-index>\nindex lines' } } })
    collectSessionEvent(collector, { type: 'request/header', seq: 5, data: { header: { system: 'changed header' } } })
    expect(collector.systemPrompt).toBe('changed header')
  })

  it('keeps the last assistant message text and pairs tool calls with results', () => {
    const collector = emptyTurnCollector()
    collectSessionEvent(collector, { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } } })
    collectSessionEvent(collector, { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'memory_search', arguments: '{"query":"pnpm"}' } })
    collectSessionEvent(collector, { type: 'tool/call', seq: 4, data: { callId: 'c2', name: 'memory_add', arguments: 'not-json' } })
    // Real wire shape (packages/llm/llm/src/message.ts): a user-role message
    // whose content[0] is the tool-result block carrying toolCallId; the
    // message-level `source.callId` is its twin.
    collectSessionEvent(collector, {
      type: 'tool/result',
      seq: 4,
      data: {
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'hit' }] }],
        },
      },
    })
    collectSessionEvent(collector, {
      type: 'tool/result',
      seq: 5,
      data: {
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'c2' },
          content: [{ type: 'tool-result', toolCallId: 'c2', content: [], isError: true }],
        },
        error: { name: 'ToolError', code: 'rejected' },
      },
    })
    collectSessionEvent(collector, { type: 'assistant/message', seq: 6, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'final ' }, { type: 'text', text: 'answer' }] } } })
    expect(collector.finalText).toBe('final answer')
    expect(collector.toolCalls).toEqual([
      { callId: 'c1', name: 'memory_search', args: { query: 'pnpm' }, ok: true, settled: true },
      { callId: 'c2', name: 'memory_add', args: 'not-json', ok: false, settled: true },
    ])
  })

  it('pairs results via source.callId when the content block is not first-shaped', () => {
    const collector = emptyTurnCollector()
    collectSessionEvent(collector, { type: 'tool/call', seq: 1, data: { callId: 'c9', name: 'memory_get', arguments: '{}' } })
    collectSessionEvent(collector, {
      type: 'tool/result',
      seq: 2,
      data: {
        message: { role: 'user', source: { kind: 'tool', callId: 'c9' }, content: [] },
      },
    })
    expect(collector.toolCalls[0]?.ok).toBe(true)
    expect(collector.toolCalls[0]?.settled).toBe(true)
  })

  it('ignores chunk and boundary records without touching the collector', () => {
    const collector = emptyTurnCollector()
    collectSessionEvent(collector, { type: 'assistant/chunk', seq: 1, data: { turn: 0, step: 0, chunk: {} } })
    collectSessionEvent(collector, { type: 'turn/start', seq: 2, data: { turn: 0 } })
    expect(collector.finalText).toBe('')
    expect(collector.systemPrompt).toBeUndefined()
    expect(collector.toolCalls).toEqual([])
  })

  it('recognizes the durable inbox receipt of the queued message', () => {
    const event = { type: 'agent/inbox/spliced', seq: 1, data: { inserted: [{ id: 'm-1' }, { id: 'm-2' }] } }
    expect(isInboxReceipt(event, 'm-2')).toBe(true)
    expect(isInboxReceipt(event, 'm-9')).toBe(false)
    expect(isInboxReceipt({ type: 'user/message', seq: 2, data: {} }, 'm-1')).toBe(false)
  })
})
