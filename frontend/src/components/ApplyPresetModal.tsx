import { useMemo, useRef, useState } from 'react'
import { Modal, StatusChip, toastError, toastSuccess } from './ui'
import { api, ApiError } from '../lib/api'
import { useApi } from '../lib/useApi'
import { fmtInt } from '../lib/money'
import type { FeeSchedule, Merchant, SavedPreset } from '../lib/types'
import type { FeeRates } from './FeeScheduleModal'

// The rate fields that define a preset — used to detect which preset (if any) a
// merchant's current schedule already matches.
const MATCH_KEYS = [
  'mdr_bps', 'approved_txn_fee_minor', 'declined_txn_fee_minor', 'refund_fee_minor',
  'chargeback_fee_minor', 'reserve_hold_bps', 'reserve_hold_days', 'settlement_fee_bps',
  'settlement_delay_days',
] as const

function ratesOf(p: SavedPreset): FeeRates {
  return {
    mdr_bps: p.mdr_bps,
    approved_txn_fee_minor: p.approved_txn_fee_minor,
    declined_txn_fee_minor: p.declined_txn_fee_minor,
    refund_fee_minor: p.refund_fee_minor,
    chargeback_fee_minor: p.chargeback_fee_minor,
    reserve_hold_bps: p.reserve_hold_bps,
    reserve_hold_days: p.reserve_hold_days,
    settlement_fee_bps: p.settlement_fee_bps,
    settlement_delay_days: p.settlement_delay_days ?? 0,
    settlement_schedule: 'daily',
  }
}

/** Name of the saved preset a schedule matches exactly, or null (= custom / none). */
function appliedPreset(fs: FeeSchedule | null | undefined, presets: SavedPreset[]): string | null {
  if (!fs) return null
  for (const p of presets) {
    if (MATCH_KEYS.every((k) => (p as unknown as Record<string, number>)[k] === (fs as unknown as Record<string, number>)[k])) {
      return p.name
    }
  }
  return null
}

const pctOf = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`

function presetSummary(p: SavedPreset): string {
  return `MDR ${pctOf(p.mdr_bps)} · Settlement ${pctOf(p.settlement_fee_bps)} · Reserve ${pctOf(p.reserve_hold_bps)} · T+${p.settlement_delay_days ?? 0}`
}

/** Preset-first bulk fee editor: pick a saved preset, see which preset each merchant
 *  is currently on, tick the merchants to move onto it, apply in one shot. */
export function ApplyPresetModal({
  merchants,
  initialSelected,
  onClose,
  onApplied,
  onCreatePreset,
}: {
  merchants: Merchant[]
  initialSelected?: Set<string>
  onClose: () => void
  onApplied: () => void
  onCreatePreset: () => void
}) {
  const presetsApi = useApi(() => api<{ items: SavedPreset[] }>('/api/fee-presets'), [])
  const presets = presetsApi.data?.items ?? []

  const [presetName, setPresetName] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set(initialSelected ?? []))
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const chosen = presets.find((p) => p.name === presetName) ?? null

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return merchants.filter(
      (m) => !needle || m.name.toLowerCase().includes(needle) || (m.member_id ?? '').toLowerCase().includes(needle),
    )
  }, [merchants, q])

  const toggle = (uuid: string) =>
    setSel((s) => {
      const n = new Set(s)
      n.has(uuid) ? n.delete(uuid) : n.add(uuid)
      return n
    })

  const allInView = rows.length > 0 && rows.every((m) => sel.has(m.merchant_uuid))
  const someInView = rows.some((m) => sel.has(m.merchant_uuid))
  const toggleAll = () =>
    setSel((s) => {
      const n = new Set(s)
      if (allInView) rows.forEach((m) => n.delete(m.merchant_uuid))
      else rows.forEach((m) => n.add(m.merchant_uuid))
      return n
    })

  const apply = async () => {
    if (!chosen) {
      setMsg('Pick a preset to apply.')
      return
    }
    if (sel.size === 0) {
      setMsg('Select at least one merchant to apply it to.')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const res = await api<{ applied: number; failed: number; auto_settlements?: { generated: number; appended?: number } }>(
        '/api/merchants/fee-schedule/bulk',
        { method: 'POST', body: { ...ratesOf(chosen), merchant_uuids: [...sel] } },
      )
      const g = (res.auto_settlements?.generated ?? 0) + (res.auto_settlements?.appended ?? 0)
      toastSuccess(
        `"${chosen.name}" applied to ${res.applied} merchant${res.applied === 1 ? '' : 's'}` +
          `${res.failed ? ` · ${res.failed} failed` : ''}` +
          `${g > 0 ? ` · ${g} settlement${g === 1 ? '' : 's'} updated` : ''}`,
      )
      onApplied()
      onClose()
    } catch (e) {
      const m = e instanceof ApiError ? e.message : 'Failed to apply preset'
      setMsg(m)
      toastError(m)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Set fee schedule"
      onClose={onClose}
      size="wide"
      footer={
        <>
          <button className="btn" onClick={onCreatePreset} disabled={busy} style={{ marginRight: 'auto' }}>
            + Create preset
          </button>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => void apply()} disabled={busy || !chosen || sel.size === 0}>
            {busy ? 'Applying…' : `Apply${chosen ? ` "${chosen.name}"` : ''} to ${fmtInt(sel.size)} merchant${sel.size === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      {msg && <div className="form-error">{msg}</div>}

      {/* 1 — choose a preset */}
      <div className="field">
        <label>Choose a preset</label>
        {presetsApi.loading ? (
          <div className="dim small">Loading presets…</div>
        ) : presets.length === 0 ? (
          <div className="dim small">
            No presets yet. <button className="linklike" onClick={onCreatePreset}>Create one</button> to get started.
          </div>
        ) : (
          <div className="preset-grid">
            {presets.map((p) => (
              <button
                key={p.name}
                type="button"
                className={`preset-card${presetName === p.name ? ' on' : ''}`}
                onClick={() => setPresetName(p.name)}
              >
                <div className="preset-card-name">{p.name}</div>
                <div className="preset-card-sum">{presetSummary(p)}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 2 — pick the merchants */}
      <div className="field" style={{ gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ margin: 0 }}>Apply to merchants</label>
          <span className="dim small">
            {sel.size > 0 ? `${fmtInt(sel.size)} selected` : 'none selected'}
          </span>
          <input
            className="input sm"
            style={{ marginLeft: 'auto', maxWidth: 220 }}
            placeholder="Search name or ID…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="apply-list">
          <div className="apply-list-head">
            <SelectAll checked={allInView} indeterminate={someInView && !allInView} onChange={toggleAll} />
            <span className="dim small">Merchant</span>
            <span className="dim small">Status</span>
            <span className="dim small">Current preset</span>
          </div>
          {rows.length === 0 ? (
            <div className="dim small" style={{ padding: '12px 14px' }}>No merchants match.</div>
          ) : (
            rows.map((m) => {
              const cur = appliedPreset(m.fee_schedule, presets)
              const isTarget = chosen && cur === chosen.name
              return (
                <label key={m.merchant_uuid} className={`apply-row${sel.has(m.merchant_uuid) ? ' on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={sel.has(m.merchant_uuid)}
                    onChange={() => toggle(m.merchant_uuid)}
                  />
                  <span className="apply-row-name">
                    <b>{m.name}</b>
                    <span className="small dim mono internal-only">{m.member_id}</span>
                  </span>
                  <StatusChip status={m.status} />
                  <span className="apply-row-preset">
                    {cur ? (
                      <span className={`preset-pill${isTarget ? ' same' : ''}`}>
                        {cur}{isTarget ? ' · current' : ''}
                      </span>
                    ) : m.fee_schedule ? (
                      <span className="preset-pill custom">Custom</span>
                    ) : (
                      <span className="dim small">Not set</span>
                    )}
                  </span>
                </label>
              )
            })
          )}
        </div>
      </div>

      <div className="dim small">
        Applying replays each merchant's held transactions and auto-generates their settlement — no separate Generate step.
      </div>
    </Modal>
  )
}

function SelectAll({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  if (ref.current) ref.current.indeterminate = indeterminate
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} />
}
