import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { SettlementDetail } from '../lib/types'
import { fmtDate, fmtInt, fmtMoney, fmtMoneySigned } from '../lib/money'
import { LoadingBlock, StatusChip, toastError, toastSuccess } from '../components/ui'

/** One statement line: label, minor amount, sign to display ("+", "−", "±", "="). */
function Row({
  label,
  minor,
  currency,
  op,
  dimZero,
  className,
}: {
  label: string
  minor: number
  currency: string
  op?: string
  dimZero?: boolean
  className?: string
}) {
  const dim = dimZero && minor === 0
  return (
    <tr className={className}>
      <td className="row-label">
        <span className="op">{op ?? ''}</span>
        {label}
      </td>
      <td className={dim ? 'dim' : minor < 0 ? 'money neg' : 'money'}>
        {dim ? '—' : fmtMoneySigned(minor, currency)}
      </td>
    </tr>
  )
}

export default function SettlementDetailPage() {
  const { uuid } = useParams<{ uuid: string }>()
  const isAdmin = getUser()?.role === 'admin'
  const { data: s, loading, reload } = useApi(() => api<SettlementDetail>(`/api/settlements/${uuid}`), [uuid])
  const [completing, setCompleting] = useState(false)

  const markCompleted = async () => {
    setCompleting(true)
    try {
      await api(`/api/settlements/${uuid}/complete`, { method: 'POST' })
      toastSuccess('Settlement marked as completed — payout posted')
      reload()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Failed to complete settlement')
    } finally {
      setCompleting(false)
    }
  }

  if (loading || !s) {
    return (
      <div>
        <Link to="/settlements" className="back-link">← Settlements</Link>
        <LoadingBlock label="Loading settlement…" />
      </div>
    )
  }

  const b = s.breakdown
  const ccy = s.currency

  return (
    <div className="stack">
      <div>
        <Link to="/settlements" className="back-link">← Settlements</Link>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              Settlement statement <StatusChip status={s.state} />
            </h1>
            <div className="sub">
              {s.merchant_name} · <span className="ccy-tag">{ccy}</span> · {fmtInt(s.items_count)} items
            </div>
          </div>
          {isAdmin && s.state === 'generated' && (
            <div className="head-actions">
              <button className="btn success" onClick={() => void markCompleted()} disabled={completing}>
                {completing ? 'Posting payout…' : '✓ Mark completed'}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="card statement">
        <div className="statement-head">
          <div>
            <div className="kicker">Settlement statement</div>
            <div className="m-name">{s.merchant_name}</div>
            <div className="win num">
              Window {fmtDate(s.window_start)} → {fmtDate(s.window_end)} · Currency {ccy}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="kicker">Counts</div>
            <div className="small num" style={{ marginTop: 4, lineHeight: 1.7 }}>
              Paid <b>{fmtInt(s.counts.paid)}</b> · Declined <b>{fmtInt(s.counts.declined)}</b>
              <br />
              Refunds <b>{fmtInt(s.counts.refunds)}</b> · Chargebacks <b>{fmtInt(s.counts.chargebacks)}</b>
            </div>
          </div>
        </div>

        <table>
          <tbody>
            <tr className="section-gap">
              <td className="row-label" style={{ fontWeight: 600, color: 'var(--ink)' }}>
                <span className="op" />Gross captured
              </td>
              <td className="money" style={{ fontWeight: 600 }}>{fmtMoney(b.gross_captured_minor, ccy)}</td>
            </tr>
            <Row label="MDR" op="−" minor={-Math.abs(b.mdr_minor)} currency={ccy} />
            <Row label="Approved transaction fees" op="−" minor={-Math.abs(b.approved_txn_fees_minor)} currency={ccy} />
            <Row label="Declined transaction fees" op="−" minor={-Math.abs(b.declined_txn_fees_minor)} currency={ccy} />
            <Row label="Refunds" op="−" minor={-Math.abs(b.refunds_minor)} currency={ccy} dimZero />
            <Row label="Refund fees" op="−" minor={-Math.abs(b.refund_fees_minor)} currency={ccy} dimZero />
            <Row label="Chargebacks" op="−" minor={-Math.abs(b.chargebacks_minor)} currency={ccy} dimZero />
            <Row label="Chargeback fees" op="−" minor={-Math.abs(b.chargeback_fees_minor)} currency={ccy} dimZero />
            <Row label="Reserve held" op="−" minor={-Math.abs(b.reserve_held_minor)} currency={ccy} />
            <Row label="Reserve released" op="+" minor={Math.abs(b.reserve_released_minor)} currency={ccy} dimZero />
            <Row label="Adjustments" op="±" minor={b.adjustments_minor} currency={ccy} dimZero />
            <Row label="Subtotal" op="=" minor={b.subtotal_minor} currency={ccy} className="sub" />
            <Row label="Settlement fee (1%)" op="−" minor={-Math.abs(b.settlement_fee_minor)} currency={ccy} />
            <tr className="total">
              <td className="row-label">
                <span className="op">=</span>NET PAYOUT
              </td>
              <td className={b.net_payout_minor < 0 ? 'money neg' : 'money'}>
                {fmtMoney(b.net_payout_minor, ccy)}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="statement-foot">
          <div className="usdc">
            <span>
              USDC conversion <span className="dim">@ rate {s.usdc.rate}</span>
            </span>
            <b>{Number(s.usdc.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })} USDC</b>
          </div>
          <div className="dim">
            Statement covers {fmtInt(s.items_count)} settled items · counts: {fmtInt(s.counts.paid)} paid,{' '}
            {fmtInt(s.counts.declined)} declined, {fmtInt(s.counts.refunds)} refunds
          </div>
        </div>
      </div>
    </div>
  )
}
