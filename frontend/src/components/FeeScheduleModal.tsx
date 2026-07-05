import { useState } from 'react'
import { Modal, toastError } from './ui'
import { ApiError } from '../lib/api'
import type { FeeSchedule } from '../lib/types'

export interface FeeForm {
  mdrPct: string
  approvedFee: string
  declinedFee: string
  refundFee: string
  chargebackFee: string
  reservePct: string
  reserveDays: string
  settlementPct: string
  delayDays: string
}

export interface FeeRates {
  mdr_bps: number
  approved_txn_fee_minor: number
  declined_txn_fee_minor: number
  refund_fee_minor: number
  chargeback_fee_minor: number
  reserve_hold_bps: number
  reserve_hold_days: number
  settlement_fee_bps: number
  settlement_delay_days: number
  settlement_schedule: string
}

const PRESETS: Record<string, FeeForm> = {
  workbook: { mdrPct: '5', approvedFee: '0.30', declinedFee: '0', refundFee: '40', chargebackFee: '70', reservePct: '5', reserveDays: '180', settlementPct: '1', delayDays: '0' },
  annex: { mdrPct: '6.5', approvedFee: '0.35', declinedFee: '0.10', refundFee: '10', chargebackFee: '70', reservePct: '10', reserveDays: '180', settlementPct: '1', delayDays: '0' },
}

export const EMPTY_FEE_FORM: FeeForm = {
  mdrPct: '', approvedFee: '', declinedFee: '', refundFee: '',
  chargebackFee: '', reservePct: '', reserveDays: '180', settlementPct: '', delayDays: '0',
}

/** Prefill the form from an existing schedule (bps→%, minor→major). */
export function feeFormFromSchedule(fs: FeeSchedule): FeeForm {
  return {
    mdrPct: String(fs.mdr_bps / 100),
    approvedFee: (fs.approved_txn_fee_minor / 100).toFixed(2),
    declinedFee: (fs.declined_txn_fee_minor / 100).toFixed(2),
    refundFee: (fs.refund_fee_minor / 100).toFixed(2),
    chargebackFee: (fs.chargeback_fee_minor / 100).toFixed(2),
    reservePct: String(fs.reserve_hold_bps / 100),
    reserveDays: String(fs.reserve_hold_days),
    settlementPct: String(fs.settlement_fee_bps / 100),
    delayDays: '0',
  }
}

const pct = (s: string) => Math.round(parseFloat(s || '0') * 100)
const minor = (s: string) => Math.round(parseFloat(s || '0') * 100)

export function FeeScheduleModal({
  title,
  subtitle,
  saveLabel = 'Save',
  initial,
  onClose,
  onSubmit,
}: {
  title: string
  subtitle?: string
  saveLabel?: string
  initial?: FeeForm
  onClose: () => void
  onSubmit: (rates: FeeRates) => Promise<void>
}) {
  const [f, setF] = useState<FeeForm>(initial ?? EMPTY_FEE_FORM)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const set = (k: keyof FeeForm, v: string) => setF((p) => ({ ...p, [k]: v }))

  const save = async () => {
    if (f.mdrPct === '' || Number.isNaN(parseFloat(f.mdrPct))) {
      setMsg('Enter an MDR percentage (e.g. 3 for 3%).')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await onSubmit({
        mdr_bps: pct(f.mdrPct),
        approved_txn_fee_minor: minor(f.approvedFee),
        declined_txn_fee_minor: minor(f.declinedFee),
        refund_fee_minor: minor(f.refundFee),
        chargeback_fee_minor: minor(f.chargebackFee),
        reserve_hold_bps: pct(f.reservePct),
        reserve_hold_days: parseInt(f.reserveDays || '180', 10),
        settlement_fee_bps: pct(f.settlementPct),
        settlement_delay_days: parseInt(f.delayDays || '0', 10),
        settlement_schedule: 'daily',
      })
      onClose()
    } catch (e) {
      const m = e instanceof ApiError ? e.message : 'Failed to save fee schedule'
      setMsg(m)
      toastError(m)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : saveLabel}
          </button>
        </>
      }
    >
      {subtitle && <div className="dim small">{subtitle}</div>}
      {msg && <div className="form-error">{msg}</div>}
      <div className="field">
        <label>Quick-fill preset</label>
        <select
          className="select"
          defaultValue=""
          onChange={(e) => {
            const p = PRESETS[e.target.value]
            if (p) setF(p)
          }}
        >
          <option value="">Custom…</option>
          <option value="workbook">Workbook (5% MDR)</option>
          <option value="annex">Annex / Canamoney (6.5% MDR)</option>
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="MDR (%)" value={f.mdrPct} on={(v) => set('mdrPct', v)} ph="e.g. 3" />
        <Field label="Settlement fee (%)" value={f.settlementPct} on={(v) => set('settlementPct', v)} ph="e.g. 1" />
        <Field label="Rolling reserve (%)" value={f.reservePct} on={(v) => set('reservePct', v)} ph="e.g. 5" />
        <Field label="Reserve hold (days)" value={f.reserveDays} on={(v) => set('reserveDays', v)} ph="180" num />
        <Field label="Approved txn fee" value={f.approvedFee} on={(v) => set('approvedFee', v)} ph="0.30" />
        <Field label="Declined txn fee" value={f.declinedFee} on={(v) => set('declinedFee', v)} ph="0.00" />
        <Field label="Refund fee" value={f.refundFee} on={(v) => set('refundFee', v)} ph="0.00" />
        <Field label="Chargeback fee" value={f.chargebackFee} on={(v) => set('chargebackFee', v)} ph="0.00" />
        <Field label="Settlement delay (T+days)" value={f.delayDays} on={(v) => set('delayDays', v)} ph="0" num />
      </div>
      <div className="dim small">Fixed fees are in the merchant's settlement currency.</div>
    </Modal>
  )
}

function Field({ label, value, on, ph, num }: { label: string; value: string; on: (v: string) => void; ph?: string; num?: boolean }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input className="input" inputMode={num ? 'numeric' : 'decimal'} value={value} placeholder={ph} onChange={(e) => on(e.target.value)} />
    </div>
  )
}
