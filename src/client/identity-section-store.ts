/**
 * Identity governance controller — the state machine behind the Settings →
 * Identity section. The surface is READ-ONLY by design: the two self-documents
 * (SOUL.md the assistant's character, USER.md its understanding of the human)
 * are written by the agent through conversation; the human holds exactly one
 * write power — reverting to a retained version — plus the export. No editor
 * exists anywhere on this surface.
 *
 * The methods are optional on the API face: a deployment older than the
 * identity RPCs degrades to the section's empty state instead of failing the
 * settings panel (the suggestList precedent in memory-section-store).
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { IdentityHistoryJson, IdentityRecordJson } from '../typert.remote-client.js'

/** One RPC round-trip's shape over the Typert gateway. */
type Rpc<T> = Promise<{ result: { ok: true; value: T } | { ok: false; error: { message: string } } }>

/** Structural face of the identity RPCs the controller needs; optional = degradable. */
export interface IdentityRemoteApi {
  /** Both documents' current records; absent fields = never written. */
  identityList?(): Rpc<{ soul?: IdentityRecordJson; user?: IdentityRecordJson }>
  /** One document's retained version history, newest first. */
  identityHistory?(request: { kind: 'soul' | 'user' }): Rpc<{ history: readonly IdentityHistoryJson[] }>
  /** The governance valve: restore one retained version as the newest. */
  identityRevert?(request: { kind: 'soul' | 'user'; version: number }): Rpc<{ reverted?: IdentityRecordJson; error?: string }>
}

/** Page snapshot. */
export interface IdentitySectionState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; replaces the page until retried. */
  error: string | null
  /** The soul document's current record; null when never written. */
  soul: IdentityRecordJson | null
  /** The user-profile document's current record; null when never written. */
  user: IdentityRecordJson | null
  /** Retained version history per kind, newest first. */
  history: Readonly<Record<'soul' | 'user', readonly IdentityHistoryJson[]>>
  /** Failure of the last revert action; the next success clears it. */
  actionError: string | null
}

const INITIAL: IdentitySectionState = {
  status: 'idle',
  error: null,
  soul: null,
  user: null,
  history: { soul: [], user: [] },
  actionError: null,
}

/** Drive the Identity section: the two documents plus their histories. */
export class IdentitySectionController {
  /** Page snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<IdentitySectionState> = createSnapshotStore(INITIAL)

  /** Guards against overlapping loads painting partial results. */
  private seq = 0

  constructor(private readonly api: IdentityRemoteApi | undefined) {}

  private set(patch: Partial<IdentitySectionState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  private requireApi(): IdentityRemoteApi {
    if (this.api === undefined) throw new Error('the memory remote namespace is not mounted on this connection')
    return this.api
  }

  /**
   * Full load: both current records plus both histories. Used on section
   * open, manual retry, connection recovery, and after every revert.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const ticket = ++this.seq
    if (this.store.getSnapshot().status === 'idle') this.set({ status: 'loading' })
    try {
      const api = this.requireApi()
      // An older deployment without the identity RPCs degrades to the empty
      // ready state (both panels show their not-written hint), never an error.
      if (typeof api.identityList !== 'function' || typeof api.identityHistory !== 'function') {
        if (ticket !== this.seq) return
        this.set({ status: 'ready', error: null })
        return
      }
      const [records, soulHistory, userHistory] = await Promise.all([
        api.identityList(),
        api.identityHistory({ kind: 'soul' }),
        api.identityHistory({ kind: 'user' }),
      ])
      if (!records.result.ok) throw new Error(records.result.error.message)
      if (!soulHistory.result.ok) throw new Error(soulHistory.result.error.message)
      if (!userHistory.result.ok) throw new Error(userHistory.result.error.message)
      if (ticket !== this.seq) return // a newer load superseded this one
      this.set({
        status: 'ready',
        error: null,
        soul: records.result.value.soul ?? null,
        user: records.result.value.user ?? null,
        history: { soul: soulHistory.result.value.history, user: userHistory.result.value.history },
      })
    } catch (error) {
      if (ticket !== this.seq) return
      this.set({ status: 'error', error: messageOf(error) })
    }
  }

  /**
   * The governance valve: restore one retained version as the newest (the
   * history is never destroyed — the restore lands as a fresh version). A
   * refusal (revert disabled on the deployment) or failure surfaces in
   * `actionError`; success repaints from a full reload.
   */
  async revert(kind: 'soul' | 'user', version: number): Promise<boolean> {
    try {
      const api = this.requireApi()
      if (typeof api.identityRevert !== 'function') {
        this.set({ actionError: 'identity revert is not available on this deployment' })
        return false
      }
      const response = await api.identityRevert({ kind, version })
      if (!response.result.ok) {
        this.set({ actionError: response.result.error.message })
        return false
      }
      const record = response.result.value.reverted
      if (record === undefined) {
        this.set({ actionError: response.result.value.error ?? 'revert failed' })
        return false
      }
      this.set({ actionError: null })
      await this.load()
      return true
    } catch (error) {
      this.set({ actionError: messageOf(error) })
      return false
    }
  }
}

/** Extract a readable message from a thrown transport error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
