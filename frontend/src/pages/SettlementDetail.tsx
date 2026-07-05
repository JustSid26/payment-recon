import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { SettlementDetail, SettlementLineItem } from '../lib/types'
import { fmtDate, fmtDateTime, fmtInt, fmtMoney, fmtMoneySigned } from '../lib/money'
import { LoadingBlock, StatusChip, toastError, toastSuccess } from '../components/ui'
import { downloadCSV, downloadExcel, printToPDF, toMajor } from '../lib/export'

type View = 'statement' | 'lines'

const TYPE_LABEL: Record<string, string> = {
  payment_captured: 'Payment',
  refund: 'Refund',
  decline_fee: 'Decline fee',
  standalone_fee: 'Fee',
  reserve_hold: 'Reserve hold',
  reserve_release: 'Reserve release',
  manual_adjustment: 'Adjustment',
  chargeback_opened: 'Chargeback',
  chargeback_won: 'Chargeback won',
  reversal: 'Reversal',
}
const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/_/g, ' ')

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

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()

export default function SettlementDetailPage() {
  const { uuid } = useParams<{ uuid: string }>()
  const isAdmin = getUser()?.role === 'admin'
  const { data: s, loading, reload } = useApi(() => api<SettlementDetail>(`/api/settlements/${uuid}`), [uuid])
  const lines = useApi(() => api<{ items: SettlementLineItem[] }>(`/api/settlements/${uuid}/items`), [uuid])
  const [view, setView] = useState<View>('statement')
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
  const base = `settlement-${slug(s.merchant_name)}-${ccy}-${fmtDate(s.window_end).replace(/ /g, '')}`
  const items = lines.data?.items ?? []

  // --- statement export (key/value, mirrors the printed statement) ---
  const statementRows = (): (string | number)[][] => [
    ['TransactWorld — Settlement statement'],
    ['Merchant', s.merchant_name],
    ['Currency', ccy],
    ['Window', `${fmtDate(s.window_start)} → ${fmtDate(s.window_end)}`],
    ['State', s.state],
    ['Items', s.items_count],
    [],
    ['Line', `Amount (${ccy})`],
    ['Gross captured', toMajor(b.gross_captured_minor, ccy)],
    ['MDR', -toMajor(Math.abs(b.mdr_minor), ccy)],
    ['Approved transaction fees', -toMajor(Math.abs(b.approved_txn_fees_minor), ccy)],
    ['Declined transaction fees', -toMajor(Math.abs(b.declined_txn_fees_minor), ccy)],
    ['Refunds', -toMajor(Math.abs(b.refunds_minor), ccy)],
    ['Refund fees', -toMajor(Math.abs(b.refund_fees_minor), ccy)],
    ['Chargebacks', -toMajor(Math.abs(b.chargebacks_minor), ccy)],
    ['Chargeback fees', -toMajor(Math.abs(b.chargeback_fees_minor), ccy)],
    ['Reserve held', -toMajor(Math.abs(b.reserve_held_minor), ccy)],
    ['Reserve released', toMajor(Math.abs(b.reserve_released_minor), ccy)],
    ['Adjustments', toMajor(b.adjustments_minor, ccy)],
    ['Subtotal', toMajor(b.subtotal_minor, ccy)],
    ['Settlement fee', -toMajor(Math.abs(b.settlement_fee_minor), ccy)],
    ['NET PAYOUT', toMajor(b.net_payout_minor, ccy)],
  ]

  const LINE_HEADER = [
    'Date (UTC)', 'Type', 'Reference', 'Brand', 'Last 4', 'Status',
    'Gross', 'MDR', 'Approved fee', 'Declined fee', 'Refund fee', 'Chargeback fee', 'Reserve', 'Net',
  ]
  const lineRows = (): (string | number)[][] => [
    LINE_HEADER,
    ...items.map((it) => [
      fmtDateTime(it.occurred_at),
      typeLabel(it.type),
      it.reference,
      it.brand,
      it.last_four,
      it.status,
      toMajor(it.gross_minor, ccy),
      toMajor(it.mdr_minor, ccy),
      toMajor(it.approved_fee_minor, ccy),
      toMajor(it.declined_fee_minor, ccy),
      toMajor(it.refund_fee_minor, ccy),
      toMajor(it.chargeback_fee_minor, ccy),
      toMajor(it.reserve_minor, ccy),
      toMajor(it.net_minor, ccy),
    ]),
  ]

  const exportCSV = () =>
    view === 'statement'
      ? downloadCSV(`${base}.csv`, statementRows())
      : downloadCSV(`${base}-transactions.csv`, lineRows())
  const exportExcel = () =>
    view === 'statement'
      ? downloadExcel(`${base}.xls`, 'Statement', statementRows())
      : downloadExcel(`${base}-transactions.xls`, 'Transactions', lineRows())

  const exporting = view === 'lines' && lines.loading

  return (
    <div className="stack">
      <div data-print="hide">
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

      <div className="statement-bar" data-print="hide">
        <div className="seg">
          <button className={view === 'statement' ? 'on' : ''} onClick={() => setView('statement')}>
            Statement
          </button>
          <button className={view === 'lines' ? 'on' : ''} onClick={() => setView('lines')}>
            Per-transaction
            <span className="c">{lines.data ? fmtInt(items.length) : '·'}</span>
          </button>
        </div>
        <div className="export-group">
          <span className="export-label">Export</span>
          <button className="export-btn" onClick={exportCSV} disabled={exporting}>CSV</button>
          <button className="export-btn" onClick={exportExcel} disabled={exporting}>Excel</button>
          {view === 'statement' && (
            <button className="export-btn" onClick={printToPDF}>PDF</button>
          )}
        </div>
      </div>

      {view === 'statement' ? (
        <StatementView s={s} />
      ) : (
        <LinesView items={items} loading={lines.loading} ccy={ccy} />
      )}
    </div>
  )
}

function StatementView({ s }: { s: SettlementDetail }) {
  const b = s.breakdown
  const ccy = s.currency
  return (
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
          <Row label="Settlement fee" op="−" minor={-Math.abs(b.settlement_fee_minor)} currency={ccy} />
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
  )
}

/** A right-aligned money cell that dims exact-zero values. */
function M({ minor, ccy, strong }: { minor: number; ccy: string; strong?: boolean }) {
  if (minor === 0) return <td className="zero">—</td>
  return <td className={strong ? 'strong' : minor < 0 ? 'money neg' : ''}>{fmtMoneySigned(minor, ccy)}</td>
}

function LinesView({ items, loading, ccy }: { items: SettlementLineItem[]; loading: boolean; ccy: string }) {
  if (loading) return <LoadingBlock label="Loading transactions…" />
  if (items.length === 0)
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--ink-2)' }}>
        No transaction lines in this settlement.
      </div>
    )

  const sum = (k: keyof SettlementLineItem) =>
    items.reduce((a, it) => a + (typeof it[k] === 'number' ? (it[k] as number) : 0), 0)

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="lines-wrap">
        <table className="lines-table">
          <thead>
            <tr>
              <th className="l">Date (UTC)</th>
              <th className="l">Type</th>
              <th className="l">Reference</th>
              <th className="l">Brand</th>
              <th>Last 4</th>
              <th>Gross</th>
              <th>MDR</th>
              <th>Appr. fee</th>
              <th>Decl. fee</th>
              <th>Refund fee</th>
              <th>CB fee</th>
              <th>Reserve</th>
              <th>Net</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td className="l">{fmtDateTime(it.occurred_at)}</td>
                <td className="l">{typeLabel(it.type)}</td>
                <td className="l ref">{it.reference || '—'}</td>
                <td className="l">{it.brand || '—'}</td>
                <td>{it.last_four ? `···· ${it.last_four}` : '—'}</td>
                <M minor={it.gross_minor} ccy={ccy} />
                <M minor={it.mdr_minor} ccy={ccy} />
                <M minor={it.approved_fee_minor} ccy={ccy} />
                <M minor={it.declined_fee_minor} ccy={ccy} />
                <M minor={it.refund_fee_minor} ccy={ccy} />
                <M minor={it.chargeback_fee_minor} ccy={ccy} />
                <M minor={it.reserve_minor} ccy={ccy} />
                <M minor={it.net_minor} ccy={ccy} strong />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="l" colSpan={5}>{fmtInt(items.length)} transactions</td>
              <td>{fmtMoney(sum('gross_minor'), ccy)}</td>
              <td>{fmtMoney(sum('mdr_minor'), ccy)}</td>
              <td>{fmtMoney(sum('approved_fee_minor'), ccy)}</td>
              <td>{fmtMoney(sum('declined_fee_minor'), ccy)}</td>
              <td>{fmtMoney(sum('refund_fee_minor'), ccy)}</td>
              <td>{fmtMoney(sum('chargeback_fee_minor'), ccy)}</td>
              <td>{fmtMoney(sum('reserve_minor'), ccy)}</td>
              <td>{fmtMoney(sum('net_minor'), ccy)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
