/**
 * Live config contract with the DSH 0.2 settings wire. The host projects a
 * settings namespace only for `volatile` fields, and it hands a plugin its
 * resolved config with those fields replaced by live refs (changing them does
 * not restart the fiber). These tests pin the three consequences:
 *
 * 1. every field the bundle's settings page edits is marked volatile on its
 *    owning entry `Config`;
 * 2. every resolver reads through the live ref, so a settings change is visible
 *    on the next call without re-applying the plugin;
 * 3. the store's published settings slice is a live read, not a snapshot.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveValue } from '../src/live-config.ts'
import { Config as storeConfig } from '../src/store/index.ts'
import { resolveInjectionSettings } from '../src/store/settings.ts'
import { Config as notesConfig, resolveNotesSettings } from '../src/notes/index.ts'
import { Config as identityConfig, resolveIdentitySettings } from '../src/identity/index.ts'
import { Config as autoRecallConfig } from '../src/context/index.ts'
import { Config as reviewConfig } from '../src/review/index.ts'
import { resolveAutoRecallSettings } from '../src/context/settings.ts'
import { SqliteMemoryStore } from '../src/store/sqlite.ts'

/** A live ref shaped exactly like the one the host loader installs. */
function ref<T>(get: () => T): { get(): T } {
  return { get }
}

/** Whether one schema field is marked volatile (the settings-wire projection gate). */
function volatileField(schema: unknown, path: readonly string[]): boolean {
  let node = schema as { dict?: Record<string, unknown>; meta?: { volatile?: boolean } }
  for (const [index, key] of path.entries()) {
    if (index === path.length - 1) {
      node = (node.dict as Record<string, typeof node>)[key]!
      return node.meta?.volatile === true
    }
    node = (node.dict as Record<string, typeof node>)[key]!
  }
  return false
}

describe('liveValue', () => {
  it('passes plain values through and unwraps live refs', () => {
    expect(liveValue(42)).toBe(42)
    expect(liveValue('plain')).toBe('plain')
    expect(liveValue(undefined)).toBeUndefined()
    expect(liveValue(ref(() => 42))).toBe(42)
    expect(liveValue(ref(() => 'live'))).toBe('live')
  })
})

describe('entry Configs expose the settings-page fields as volatile', () => {
  it('memory entry', () => {
    for (const key of [
      'memoryMode', 'memoryPolicyCustomText', 'memoryCharLimit', 'memoryDigestCharLimit',
      'memoryMaxEntries', 'maxSearchResults', 'decayDays',
    ]) {
      expect(volatileField(storeConfig, [key]), key).toBe(true)
    }
    // Backend knobs are mount-time inputs and stay ordinary config.
    for (const key of ['storage', 'entriesCap', 'crossProcessProbeMs']) {
      expect(volatileField(storeConfig, [key]), key).toBe(false)
    }
  })

  it('notes, identity, auto-recall, and review entries', () => {
    for (const key of ['notesEnabled', 'notesConventionsCharLimit', 'notesPitfallsCharLimit', 'notesMaxEntriesPerFile']) {
      expect(volatileField(notesConfig, [key]), key).toBe(true)
    }
    for (const key of ['identityEnabled', 'soulCharLimit', 'userCharLimit']) {
      expect(volatileField(identityConfig, [key]), key).toBe(true)
    }
    expect(volatileField(identityConfig, ['identitySeedDir'])).toBe(false)
    for (const key of ['autoRecallEnabled', 'autoRecallLimit', 'autoRecallMinChars', 'hitSignalEnabled', 'hitSignalThreshold']) {
      expect(volatileField(autoRecallConfig, [key]), key).toBe(true)
    }
    for (const key of ['reviewEnabled', 'confirmBeforeWrite', 'consolidation', 'sweepTopN']) {
      expect(volatileField(reviewConfig, [key]), key).toBe(true)
    }
  })
})

describe('resolvers read live refs', () => {
  it('materializes defaults and current ref values into plain settings', () => {
    const injection = resolveInjectionSettings({
      memoryMode: ref(() => 'full' as const),
      memoryCharLimit: ref(() => 1234),
      maxSearchResults: ref(() => 7),
    } as never)
    expect(injection.memoryMode).toBe('full')
    expect(injection.memoryCharLimit).toBe(1234)
    expect(injection.maxSearchResults).toBe(7)
    expect(injection.decayDays).toBe(30)

    const notes = resolveNotesSettings({
      notesEnabled: ref(() => false),
      notesConventionsCharLimit: ref(() => 12),
      notesMaxEntriesPerFile: ref(() => 3),
    } as never)
    expect(notes.notesEnabled).toBe(false)
    expect(notes.notesConventionsCharLimit).toBe(12)
    expect(notes.notesMaxEntriesPerFile).toBe(3)

    const identity = resolveIdentitySettings({ identityEnabled: ref(() => true), soulCharLimit: ref(() => 99) } as never)
    expect(identity.identityEnabled).toBe(true)
    expect(identity.soulCharLimit).toBe(99)

    const autoRecall = resolveAutoRecallSettings({ autoRecallEnabled: ref(() => false), hitSignalThreshold: ref(() => 0.5) } as never)
    expect(autoRecall.autoRecallEnabled).toBe(false)
    expect(autoRecall.hitSignalThreshold).toBe(0.5)
  })

  it('a changed ref is visible on the next read without re-applying', () => {
    let mode: 'index' | 'digest' = 'index'
    const config = {
      memoryMode: ref(() => mode),
      memoryCharLimit: 100,
    } as never
    expect(resolveInjectionSettings(config).memoryMode).toBe('index')
    mode = 'digest'
    expect(resolveInjectionSettings(config).memoryMode).toBe('digest')
  })
})

describe('the store publishes a live settings slice', () => {
  it('settings() re-reads its source instead of caching the first value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-live-'))
    try {
      let limit = 50
      const store = new SqliteMemoryStore({
        dbPath: join(dir, 'storages', 'memory.db'),
        entriesCap: 100,
        settings: () => resolveInjectionSettings({ maxSearchResults: limit, memoryMode: 'index' }),
      })
      expect(store.settings().maxSearchResults).toBe(50)
      limit = 9
      expect(store.settings().maxSearchResults).toBe(9)
      expect(store.settings().memoryMode).toBe('index')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
