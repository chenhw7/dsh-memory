/**
 * Memory management settings section — the React component (§3.8).
 *
 * Renders the full memory CRUD UI: browse by scope (cards with id, category,
 * timestamps), a search box, add/edit/remove, pin/unpin, and a memory
 * activity panel (timeline over the audit store). All data access goes
 * through `ctx.remote.memory.*` (the @Remote service).
 *
 * This component runs in the host's client build pipeline (TSX + React).
 *
 * @module @chenhw7/dsh-memory/client/MemorySection
 */

import { useCallback, useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconPlusOutline16, IconTrashOutline16, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

// ─── Wire types (mirrors src/remote/types.ts, but client-safe) ──────────────

export interface MemoryEntryJson {
  id: string
  scope: 'global' | 'project' | 'user'
  category?: string
  content: string
  projectName?: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  lastRecalledAt?: number
}

export interface MemoryHealthJson {
  totalEntries: number
  byScope: { global: number; project: number; user: number }
  pinned: number
  auditRecords: number
  lastActivityTs?: number
  lastExtractionTs?: number
}

export interface AuditEntryJson {
  id: string
  op: 'add' | 'update' | 'remove'
  entryId: string
  scope: 'global' | 'project' | 'user'
  category?: string
  source: 'tool' | 'review' | 'flush' | 'ui'
  sessionId?: string
  ts: number
  contentPreview: string
}

/** The remote namespace (ctx.remote.memory after dsh-api-remotes mount). */
export interface MemoryRemote {
  list(request: { scope?: string; limit?: number }): Promise<{ entries: readonly MemoryEntryJson[]; total: number }>
  search(request: { query?: string; scope?: string; limit?: number }): Promise<{ entries: readonly MemoryEntryJson[]; total: number }>
  get(request: { id: string }): Promise<{ entry?: MemoryEntryJson; found: boolean }>
  add(request: { scope: string; content: string; category?: string; projectName?: string }): Promise<{ entry?: MemoryEntryJson; error?: string }>
  update(request: { id: string; content?: string; category?: string }): Promise<{ entry?: MemoryEntryJson; found: boolean; error?: string }>
  remove(request: { id: string }): Promise<{ removed: boolean }>
  pin(request: { id: string; pinned: boolean }): Promise<{ entry?: MemoryEntryJson; found: boolean }>
  health(): Promise<MemoryHealthJson>
  auditLog(request: { limit?: number }): Promise<{ entries: readonly AuditEntryJson[] }>
}

/** Registration-side business face for the memory section. */
export interface MemorySectionInjected {
  hooks: {
    /** The remote namespace, available after dsh-api-remotes mount. */
    remote: MemoryRemote
  }
}

/** Props the settings shell passes to the section component. */
export interface MemorySectionProps
  extends PropsLocale, PropsRuntime, InjectFace<MemorySectionInjected> {}

// ─── Component ─────────────────────────────────────────────────────────────

const SCOPES = ['global', 'project', 'user'] as const
const CATEGORIES = ['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk', 'procedure'] as const

export function MemorySection(props: MemorySectionProps) {
  const { remote } = props.useMemorySection().hooks
  const t = props.t

  const [entries, setEntries] = useState<MemoryEntryJson[]>([])
  const [health, setHealth] = useState<MemoryHealthJson | null>(null)
  const [auditLog, setAuditLog] = useState<AuditEntryJson[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [activeScope, setActiveScope] = useState<string | undefined>(undefined)
  const [editing, setEditing] = useState<MemoryEntryJson | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // ── Load entries ────────────────────────────────────────────────────────
  const loadEntries = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let result: { entries: readonly MemoryEntryJson[]; total: number }
      if (searchQuery.length > 0) {
        result = await remote.search({ query: searchQuery, scope: activeScope, limit: 200 })
      } else {
        result = await remote.list({ scope: activeScope, limit: 200 })
      }
      setEntries([...result.entries])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load memories')
    } finally {
      setLoading(false)
    }
  }, [remote, searchQuery, activeScope])

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await remote.health())
    } catch { /* best-effort */ }
  }, [remote])

  const loadAuditLog = useCallback(async () => {
    try {
      const result = await remote.auditLog({ limit: 50 })
      setAuditLog([...result.entries])
    } catch { /* best-effort */ }
  }, [remote])

  useEffect(() => { void loadEntries() }, [loadEntries])
  useEffect(() => { void loadHealth() }, [loadHealth])
  useEffect(() => { void loadAuditLog() }, [loadAuditLog])

  // ── CRUD handlers ────────────────────────────────────────────────────────
  const handleRemove = async (id: string) => {
    try {
      await remote.remove({ id })
      await Promise.all([loadEntries(), loadHealth(), loadAuditLog()])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove')
    }
  }

  const handlePin = async (id: string, pinned: boolean) => {
    try {
      await remote.pin({ id, pinned })
      await loadEntries()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to pin')
    }
  }

  const handleSave = async (entry: { id?: string; scope: string; content: string; category?: string; projectName?: string }) => {
    setError(null)
    try {
      if (entry.id !== undefined) {
        const result = await remote.update({ id: entry.id, content: entry.content, ...entry.category !== undefined ? { category: entry.category } : {} })
        if (!result.found) { setError('Entry not found'); return }
        if (result.error) { setError(result.error); return }
      } else {
        const result = await remote.add({ scope: entry.scope, content: entry.content, ...entry.category !== undefined ? { category: entry.category } : {}, ...entry.projectName !== undefined ? { projectName: entry.projectName } : {} })
        if (result.error) { setError(result.error); return }
      }
      setEditing(null)
      setAdding(false)
      await Promise.all([loadEntries(), loadHealth(), loadAuditLog()])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '24px', maxWidth: '960px', margin: '0 auto' }}>
      <h2>{t('title')}</h2>
      {error !== null && (
        <div style={{ color: 'red', margin: '8px 0', padding: '8px', background: '#fee', borderRadius: '4px' }}>
          {error}
          <Button onClick={() => setError(null)} style={{ marginLeft: '8px' }}>Dismiss</Button>
        </div>
      )}

      {/* Health row */}
      {health !== null && (
        <div style={{ display: 'flex', gap: '16px', margin: '16px 0', fontSize: '13px', color: '#666' }}>
          <span>{t('total')}: {health.totalEntries}</span>
          <span>global: {health.byScope.global}</span>
          <span>project: {health.byScope.project}</span>
          <span>user: {health.byScope.user}</span>
          <span>pinned: {health.pinned}</span>
          {health.lastActivityTs !== undefined && (
            <span>{t('lastActivity')}: {new Date(health.lastActivityTs).toLocaleString()}</span>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <Input
          placeholder={t('searchPlaceholder')}
          value={searchQuery}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') void loadEntries() }}
          style={{ flex: 1 }}
        />
        <select
          value={activeScope ?? ''}
          onChange={(e) => setActiveScope(e.target.value || undefined)}
          style={{ padding: '0 8px' }}
        >
          <option value="">{t('allScopes')}</option>
          {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <Button onClick={() => void loadEntries()}>{t('refresh')}</Button>
        <Button onClick={() => setAdding(true)}>
          <IconPlusOutline16 /> {t('add')}
        </Button>
      </div>

      {/* Entry cards */}
      {loading ? (
        <p>{t('loading')}</p>
      ) : entries.length === 0 ? (
        <p style={{ color: '#999' }}>{t('noEntries')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {entries.map(entry => (
            <div key={entry.id} style={{
              border: '1px solid #e0e0e0', borderRadius: '6px', padding: '12px',
              background: entry.pinned ? '#fffde6' : '#fff',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>
                    <strong>{entry.scope}</strong>
                    {entry.category !== undefined && <span> / {entry.category}</span>}
                    {entry.projectName !== undefined && <span> · {entry.projectName}</span>}
                    {entry.pinned === true && <span style={{ color: '#d4a017' }}> · 📌 pinned</span>}
                  </div>
                  <div>{entry.content}</div>
                  <div style={{ fontSize: '11px', color: '#aaa', marginTop: '4px' }}>
                    {new Date(entry.createdAt).toLocaleDateString()} → {new Date(entry.updatedAt).toLocaleDateString()}
                    {entry.lastRecalledAt !== undefined && (
                      <span> · last recalled: {new Date(entry.lastRecalledAt).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <Button onClick={() => setEditing(entry)}>{t('edit')}</Button>
                  <Button onClick={() => void handlePin(entry.id, !(entry.pinned ?? false))}>
                    {entry.pinned === true ? t('unpin') : t('pin')}
                  </Button>
                  <Button onClick={() => void handleRemove(entry.id)}>
                    <IconTrashOutline16 />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Activity panel */}
      {auditLog.length > 0 && (
        <details style={{ marginTop: '24px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 500 }}>{t('activityPanel')}</summary>
          <div style={{ marginTop: '8px', maxHeight: '300px', overflowY: 'auto' }}>
            {auditLog.map(record => (
              <div key={record.id} style={{
                display: 'flex', gap: '8px', padding: '4px 0',
                borderBottom: '1px solid #f0f0f0', fontSize: '12px',
              }}>
                <span style={{ color: '#888', width: '60px' }}>{record.op}</span>
                <span style={{ color: '#aaa', width: '80px' }}>{record.source}</span>
                <span style={{ color: '#aaa', width: '60px' }}>{record.scope}</span>
                <span style={{ flex: 1, color: '#666' }}>{record.contentPreview}</span>
                <span style={{ color: '#ccc' }}>{new Date(record.ts).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Add/Edit modal */}
      {(adding || editing !== null) && (
        <EditModal
          entry={editing}
          onSave={handleSave}
          onCancel={() => { setEditing(null); setAdding(false); setError(null) }}
          t={t}
        />
      )}
    </div>
  )
}

// ─── Edit modal ──────────────────────────────────────────────────────────────

interface EditModalProps {
  entry: MemoryEntryJson | null
  onSave: (entry: { id?: string; scope: string; content: string; category?: string; projectName?: string }) => Promise<void>
  onCancel: () => void
  t: (key: string) => string
}

function EditModal({ entry, onSave, onCancel, t }: EditModalProps) {
  const [scope, setScope] = useState(entry?.scope ?? 'global')
  const [content, setContent] = useState(entry?.content ?? '')
  const [category, setCategory] = useState(entry?.category ?? '')
  const [projectName, setProjectName] = useState(entry?.projectName ?? '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    await onSave({
      ...entry !== null ? { id: entry.id } : {},
      scope,
      content,
      ...category.length > 0 ? { category } : {},
      ...scope === 'project' && projectName.length > 0 ? { projectName } : {},
    })
    setSaving(false)
  }

  return (
    <Modal onClose={onCancel} title={entry !== null ? t('editEntry') : t('addEntry')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '400px' }}>
        <label>
          {t('scope')}
          <select value={scope} onChange={(e) => setScope(e.target.value)} style={{ width: '100%', marginTop: '4px' }}>
            {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {scope === 'project' && (
          <label>
            {t('projectName')}
            <Input value={projectName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setProjectName(e.target.value)} style={{ width: '100%', marginTop: '4px' }} />
          </label>
        )}
        <label>
          {t('content')}
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            style={{ width: '100%', marginTop: '4px', fontFamily: 'inherit' }}
          />
        </label>
        <label>
          {t('category')}
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: '100%', marginTop: '4px' }}>
            <option value="">—</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button onClick={onCancel}>{t('cancel')}</Button>
          <Button onClick={() => void handleSave()} disabled={saving || content.length === 0}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
