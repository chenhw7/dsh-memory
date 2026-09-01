/**
 * Cross-process single-writer detection (§3.7 background-failure channel):
 * the owner stamp written into the memory domain's global slot must alert —
 * once per boot, through `reportFailure('cross-process', …)` — when a
 * concurrently publishing second process is observed, and stay silent for
 * restarts, clean exits, and dead-pid (crashed-predecessor) stamps. Unit
 * tests run the guard against injected seams; integration tests boot the
 * real composition over a temp medium and assert the claim, the
 * concurrent-boot alert, and silence-after-restart behavior end to end.
 */
import { describe, it, expect } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as memoryStore from '../src/store/index.ts'
import {
  CrossProcessGuard,
  EMPTY_OWNER,
  currentBootOwner,
  mediumOwnerReader,
  pidAlive,
} from '../src/store/cross-process.ts'
import type { OwnerStamp } from '../src/store/cross-process.ts'

/** A stamp foreign to every other stamp in the test. */
function foreignStamp(overrides: Partial<OwnerStamp> = {}): OwnerStamp {
  return { pid: 424242, startedAt: 1_000, bootId: 'foreign-boot', ...overrides }
}

/** Recording double for the store's failure channel. */
function recorder(): { failures: { site: string; error: unknown }[]; report: (site: string, error: unknown) => void } {
  const failures: { site: string; error: unknown }[] = []
  return { failures, report: (site, error) => { failures.push({ site, error }) } }
}

/** In-memory global-slot seam mirroring the domain's `global.set` + medium read-back. */
function memorySlot(initial: unknown): { write: (owner: OwnerStamp) => Promise<void>; read: () => unknown; set: (value: unknown) => void } {
  let slot: unknown = initial
  return { write: async owner => { slot = owner }, read: () => slot, set: value => { slot = value } }
}

/** A foreign writer whose pid the liveness seam always reports alive. */
function liveForeign(): { stamp: OwnerStamp; alive: (pid: number) => boolean } {
  return { stamp: foreignStamp(), alive: () => true }
}

/** A foreign writer whose pid is gone (crashed predecessor, pid not reused). */
function deadForeign(): { stamp: OwnerStamp; alive: (pid: number) => boolean } {
  return { stamp: foreignStamp({ pid: 424242 }), alive: () => false }
}

describe('pidAlive', () => {
  it('reports the current process alive and a dead pid absent', () => {
    expect(pidAlive(process.pid)).toBe(true)
    // Pid 2^22 and above cannot exist on Linux's default pid_max; a killed
    // child would be racy, so an impossible pid is the deterministic absence.
    expect(pidAlive(2 ** 22 + 1)).toBe(false)
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
  })
})

describe('cross-process guard (unit, injected seams)', () => {
  it('alerts once when the startup stamp belongs to another live writer', async () => {
    const { failures, report } = recorder()
    const foreign = liveForeign()
    const slot = memorySlot(foreign.stamp)
    const guard = new CrossProcessGuard(currentBootOwner(), undefined, slot.write, report, foreign.alive)

    await guard.startup(foreign.stamp)

    expect(failures).toHaveLength(1)
    expect(failures[0]!.site).toBe('cross-process')
    expect(String(failures[0]!.error)).toContain('another live writer')
    // The claim landed: the medium now carries this boot's identity.
    const claimed = slot.read() as OwnerStamp
    expect(claimed.bootId).not.toBe('foreign-boot')
    expect(claimed.closedAt).toBeUndefined()
  })

  it('stays silent for absent, own, cleanly exited, and dead-pid startup stamps', async () => {
    const { failures, report } = recorder()
    const dead = deadForeign()

    const neverWritten = new CrossProcessGuard(currentBootOwner(), undefined, memorySlot(null).write, report)
    await neverWritten.startup(EMPTY_OWNER)

    const ownStamp = currentBootOwner()
    const ownWriter = new CrossProcessGuard(ownStamp, undefined, memorySlot(ownStamp).write, report)
    await ownWriter.startup(ownStamp)

    const closedStamp = foreignStamp({ closedAt: 2_000 })
    const closedWriter = new CrossProcessGuard(currentBootOwner(), undefined, memorySlot(closedStamp).write, report, () => true)
    await closedWriter.startup(closedStamp)

    const crashedWriter = new CrossProcessGuard(currentBootOwner(), undefined, memorySlot(dead.stamp).write, report, dead.alive)
    await crashedWriter.startup(dead.stamp)

    expect(failures).toEqual([])
  })

  it('alerts once on a probe drift and never repeats (one boot = one alert)', async () => {
    const { failures, report } = recorder()
    const foreign = liveForeign()
    const slot = memorySlot(null)
    const guard = new CrossProcessGuard(currentBootOwner(), () => slot.read(), slot.write, report, foreign.alive)
    await guard.startup(EMPTY_OWNER)
    expect(failures).toEqual([])

    // Simulate a concurrent publisher clobbering our claim between probes —
    // exactly what a second storage-json process does with the whole file.
    slot.set(foreign.stamp)
    await guard.probe()
    await guard.probe()
    await guard.probe()
    expect(failures).toHaveLength(1)

    // A foreign stamp that later stamps itself closed is not live anyway,
    // and the boot-wide flag is spent — still exactly one alert.
    slot.set(foreignStamp({ closedAt: 2_000 }))
    await guard.probe()
    expect(failures).toHaveLength(1)
  })

  it('alerts on a probe read-back showing a foreign live stamp (the concurrent-publish signal)', async () => {
    const { failures, report } = recorder()
    const foreign = liveForeign()
    let medium: unknown = null
    const guard = new CrossProcessGuard(currentBootOwner(), async () => medium, async owner => { medium = owner }, report, foreign.alive)
    await guard.startup(EMPTY_OWNER)
    expect(failures).toEqual([])

    // Another process publishes the whole unit file, including its own stamp
    // in the global slot — exactly what storage-json does on every write.
    medium = foreign.stamp
    await guard.probe()

    expect(failures).toHaveLength(1)
    expect(failures[0]!.site).toBe('cross-process')
  })

  it('a probe stamp whose pid died between writes does not alert (crash, not concurrency)', async () => {
    const { failures, report } = recorder()
    const dead = deadForeign()
    let medium: unknown = null
    const guard = new CrossProcessGuard(currentBootOwner(), async () => medium, async owner => { medium = owner }, report, dead.alive)
    await guard.startup(EMPTY_OWNER)

    medium = dead.stamp
    await guard.probe()
    expect(failures).toEqual([])
  })

  it('reports a broken probe read under owner-probe and keeps probing', async () => {
    const { failures, report } = recorder()
    let boom = false
    const guard = new CrossProcessGuard(
      currentBootOwner(),
      async () => { if (boom) throw new Error('medium vanished') },
      async () => { /* never reached in this test */ },
      report,
    )
    await guard.probe()
    expect(failures).toEqual([])

    boom = true
    await guard.probe()
    expect(failures).toHaveLength(1)
    expect(failures[0]!.site).toBe('owner-probe')

    boom = false
    await guard.probe()
    expect(failures).toHaveLength(1)
  })

  it('does not alert when the read-back is unreadable garbage (schema rejects, not a writer)', async () => {
    const { failures, report } = recorder()
    const guard = new CrossProcessGuard(currentBootOwner(), async () => 'not-a-stamp', async () => { /* unused */ }, report)
    await guard.probe()
    expect(failures).toEqual([])
  })

  it('sayGoodbye stamps closedAt; a goodbye write failure reports under owner-goodbye', async () => {
    const { failures, report } = recorder()
    const slot = memorySlot(null)
    const guard = new CrossProcessGuard(currentBootOwner(), undefined, slot.write, report)
    await guard.startup(EMPTY_OWNER)
    await guard.sayGoodbye()
    expect((slot.read() as OwnerStamp).closedAt).toBeTypeOf('number')
    expect(failures).toEqual([])

    const brokenGuard = new CrossProcessGuard(currentBootOwner(), undefined, async () => { throw new Error('medium gone') }, report)
    await brokenGuard.sayGoodbye()
    expect(failures).toEqual([{ site: 'owner-goodbye', error: expect.any(Error) }])
  })
})

describe('cross-process guard (real composition)', () => {
  it('mount claims the medium durably before apply returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-cross-'))
    try {
      const ctx = new Context()
      const root = await ctx.plugin(Storage)
      await ctx.plugin(storageJson, { root: dir })
      await ctx.plugin(storageDomain, { backend: 'json' })
      await ctx.plugin(memoryStore, { crossProcessProbeMs: 0 })

      // The claim is durable immediately after mount: a later starter will
      // see this boot's identity, not an empty slot.
      const afterMount = JSON.parse(await readFile(`${dir}/memory.json`, 'utf8')) as { global: OwnerStamp | null }
      expect(afterMount.global?.pid).toBe(process.pid)
      expect(afterMount.global?.bootId).toBeTypeOf('string')
      expect(afterMount.global?.closedAt).toBeUndefined()
      await (root as unknown as { dispose(): Promise<void> }).dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a clean dispose stamps closedAt on the medium (deployment-shaped paths)', async () => {
    // The goodbye cannot go through the domain's global slot: the storage
    // facility's unmount closes the domain concurrently with our disposer,
    // so the write goes straight to the medium file — derived from the same
    // dshHomePath('storages','memory.json') expression the base bundle uses
    // for the storage row's root.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-cross-'))
    try {
      const ctx = new Context()
      ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide(
        'dshHomePath',
        (...segments: string[]) => `${dir}/${segments.join('/')}`,
      )
      const root = await ctx.plugin(Storage)
      await ctx.plugin(storageJson, { root: `${dir}/storages` })
      await ctx.plugin(storageDomain, { backend: 'json' })
      await ctx.plugin(memoryStore, { crossProcessProbeMs: 0 })
      await (root as unknown as { dispose(): Promise<void> }).dispose()

      const medium = JSON.parse(await readFile(`${dir}/storages/memory.json`, 'utf8')) as { global: OwnerStamp | null }
      expect(medium.global?.closedAt).toBeTypeOf('number')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a boot over a stamp with closedAt or a dead pid mounts without any cross-process alert', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-cross-'))
    try {
      const ctx = new Context()
      const root = await ctx.plugin(Storage)
      await ctx.plugin(storageJson, { root: dir })
      await ctx.plugin(storageDomain, { backend: 'json' })
      await ctx.plugin(memoryStore, { crossProcessProbeMs: 0 })
      // Two writes to make the medium real, then dispose.
      const first = ctx.get('memory') as memoryStore.DomainMemoryStore
      await first.add({ scope: 'global', content: 'written by the first boot' })
      await (root as unknown as { dispose(): Promise<void> }).dispose()

      // A predecessor stamp that is cleanly exited (closedAt set — written by
      // the goodbye when it wins the dispose race) or crashed (no closedAt,
      // pid gone) must not alert the next boot. The test runner's own pid
      // stays alive across boots, so both silences are exercised through the
      // stamp content, exactly as the unit tests do.
      const file = `${dir}/memory.json`
      const document = JSON.parse(await readFile(file, 'utf8')) as { global: OwnerStamp | null }
      document.global = foreignStamp({ closedAt: Date.now(), pid: process.pid })
      await writeFile(file, `${JSON.stringify(document, null, 2)}\n`)

      const ctx2 = new Context()
      const root2 = await ctx2.plugin(Storage)
      await ctx2.plugin(storageJson, { root: dir })
      await ctx2.plugin(storageDomain, { backend: 'json' })
      await ctx2.plugin(memoryStore, { crossProcessProbeMs: 0 })
      const store2 = ctx2.get('memory') as memoryStore.DomainMemoryStore
      expect(store2.health().backgroundFailures).toBeUndefined()
      await (root2 as unknown as { dispose(): Promise<void> }).dispose()

      // The crashed-predecessor variant: no closedAt, pid provably gone.
      const crashed = JSON.parse(await readFile(file, 'utf8')) as { global: OwnerStamp | null }
      crashed.global = foreignStamp({ pid: 2 ** 22 + 1 })
      await writeFile(file, `${JSON.stringify(crashed, null, 2)}\n`)

      const ctx3 = new Context()
      const root3 = await ctx3.plugin(Storage)
      await ctx3.plugin(storageJson, { root: dir })
      await ctx3.plugin(storageDomain, { backend: 'json' })
      await ctx3.plugin(memoryStore, { crossProcessProbeMs: 0 })
      const store3 = ctx3.get('memory') as memoryStore.DomainMemoryStore
      expect(store3.health().backgroundFailures).toBeUndefined()
      await (root3 as unknown as { dispose(): Promise<void> }).dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('two live boots over one medium: the later starter sees the earlier live stamp and alerts once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-cross-'))
    try {
      // Boot A claims the medium and stays open — the concurrent writer.
      const ctxA = new Context()
      const rootA = await ctxA.plugin(Storage)
      await ctxA.plugin(storageJson, { root: dir })
      await ctxA.plugin(storageDomain, { backend: 'json' })
      await ctxA.plugin(memoryStore, { crossProcessProbeMs: 0 })
      const storeA = ctxA.get('memory') as memoryStore.DomainMemoryStore

      // Boot B starts while A's pid is alive: the startup judgment sees a
      // live foreign stamp — the concurrent-process alert, observable here.
      const ctxB = new Context()
      const rootB = await ctxB.plugin(Storage)
      await ctxB.plugin(storageJson, { root: dir })
      await ctxB.plugin(storageDomain, { backend: 'json' })
      await ctxB.plugin(memoryStore, { crossProcessProbeMs: 0 })
      const storeB = ctxB.get('memory') as memoryStore.DomainMemoryStore

      expect(storeB.health().backgroundFailures?.['cross-process']).toBe(1)
      // A is unaware (its own claim still reads back as itself); B's probe
      // would fire only if A clobbered B's claim — one alert per boot each.
      expect(storeA.health().backgroundFailures?.['cross-process']).toBeUndefined()

      await (rootB as unknown as { dispose(): Promise<void> }).dispose()
      await (rootA as unknown as { dispose(): Promise<void> }).dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('mediumOwnerReader reads the global slot from the unit file; a never-written path reads as undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-cross-'))
    try {
      const ctx = new Context()
      const root = await ctx.plugin(Storage)
      await ctx.plugin(storageJson, { root: dir })
      await ctx.plugin(storageDomain, { backend: 'json' })
      await ctx.plugin(memoryStore, { crossProcessProbeMs: 0 })
      const reader = mediumOwnerReader(`${dir}/memory.json`)
      expect(await reader()).toEqual({ pid: expect.any(Number), startedAt: expect.any(Number), bootId: expect.any(String) })
      await (root as unknown as { dispose(): Promise<void> }).dispose()
      // The unit file survives close (storage-json never deletes units), so
      // absence is proven against a path no writer ever materialized.
      expect(await mediumOwnerReader(`${dir}/never-materialized.json`)()).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
