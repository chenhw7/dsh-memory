/**
 * Memory plugin configuration card — shown inside Settings → Plugins →
 * Plugin configuration. Binds to the `memory` settings namespace and lets
 * the user configure memoryMode, reviewEnabled, charLimit, etc.
 *
 * @module @chenhw7/dsh-memory/client/MemoryPluginCard
 */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** The settings scope bound to the `memory` namespace. */
export interface SettingsScope {
  describe(): Promise<Record<string, unknown>>
  update(values: Record<string, unknown>): Promise<void>
}

export interface MemoryPluginCardInjected {
  hooks: {
    settingsScope: SettingsScope
  }
}

export interface MemoryPluginCardProps
  extends PropsLocale, InjectFace<MemoryPluginCardInjected> {}

const MODES = ['policy-only', 'full', 'index', 'custom', 'off'] as const

export function MemoryPluginCard(props: MemoryPluginCardProps) {
  const { settingsScope } = props.useMemoryPluginCard().hooks
  const t = props.t

  const [values, setValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    settingsScope.describe().then(v => {
      setValues(v)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [settingsScope])

  const update = async (key: string, value: unknown) => {
    const next = { ...values, [key]: value }
    setValues(next)
    await settingsScope.update({ [key]: value })
  }

  if (loading) return <div style={{ padding: '16px' }}>{t('loading') ?? 'Loading...'}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px' }}>
      <div style={{ fontWeight: 600, marginBottom: '4px' }}>{t('pluginConfigTitle') ?? 'Memory'}</div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span>{t('memoryMode') ?? 'Memory mode'}</span>
        <select
          value={String(values['memoryMode'] ?? 'policy-only')}
          onChange={(e) => void update('memoryMode', e.target.value)}
          style={{ padding: '4px 8px' }}
        >
          {MODES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>

      <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{t('reviewEnabled') ?? 'Automatic review extraction'}</span>
        <input
          type="checkbox"
          checked={Boolean(values['reviewEnabled'] ?? true)}
          onChange={(e) => void update('reviewEnabled', e.target.checked)}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span>{t('reviewThreshold') ?? 'Review candidate threshold'}</span>
        <input
          type="number"
          min={1}
          value={Number(values['reviewCandidateThreshold'] ?? 10)}
          onChange={(e) => void update('reviewCandidateThreshold', Number(e.target.value))}
          style={{ padding: '4px 8px', width: '80px' }}
        />
      </label>

      <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{t('flushOnCompaction') ?? 'Flush on compaction'}</span>
        <input
          type="checkbox"
          checked={Boolean(values['flushOnCompaction'] ?? true)}
          onChange={(e) => void update('flushOnCompaction', e.target.checked)}
        />
      </label>

      <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{t('flushOnDispose') ?? 'Flush on dispose'}</span>
        <input
          type="checkbox"
          checked={Boolean(values['flushOnDispose'] ?? true)}
          onChange={(e) => void update('flushOnDispose', e.target.checked)}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span>{t('charLimit') ?? 'Memory character limit'}</span>
        <input
          type="number"
          min={0}
          value={Number(values['memoryCharLimit'] ?? 5000)}
          onChange={(e) => void update('memoryCharLimit', Number(e.target.value))}
          style={{ padding: '4px 8px', width: '100px' }}
        />
      </label>
    </div>
  )
}
