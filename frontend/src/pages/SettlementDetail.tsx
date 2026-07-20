import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { SettlementDetail, SettlementLineItem } from '../lib/types'
import { fmtDate, fmtDateTime, fmtInt, fmtMoney, fmtMoneySigned } from '../lib/money'
import { LoadingBlock, StatusChip, toastError, toastSuccess } from '../components/ui'
import { downloadCSV, downloadExcel, printToPDF, toMajor } from '../lib/export'

type View = 'statement' | 'daily' | 'lines'

interface SettlementDayRow {
  date: string
  txns: number
  payments: number
  declines: number
  refunds: number
  chargebacks: number
  gross_minor: number
  refunds_minor: number
  chargebacks_minor: number
  mdr_minor: number
  approved_fee_minor: number
  declined_fee_minor: number
  refund_fee_minor: number
  chargeback_fee_minor: number
  reserve_held_minor: number
  reserve_released_minor: number
  adjustments_minor: number
  net_minor: number
  settlement_fee_minor: number
  payout_minor: number
}

interface SettlementCounts {
  paid: number
  declined: number
  refunds: number
  chargebacks: number
}

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
  detail,
  dimZero,
  className,
}: {
  label: string
  minor: number
  currency: string
  op?: string
  detail?: string
  dimZero?: boolean
  className?: string
}) {
  const dim = dimZero && minor === 0
  return (
    <tr className={className}>
      <td className="row-label">
        <span className="op">{op ?? ''}</span>
        {label}
        {detail && <span className="rate-basis">{detail}</span>}
      </td>
      <td className={dim ? 'dim' : minor < 0 ? 'money neg' : 'money'}>
        {dim ? '—' : fmtMoneySigned(minor, currency)}
      </td>
    </tr>
  )
}

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()

const fmtPct = (bps: number) => `${(bps / 100).toFixed(2)}%`

const fixedBasis = (minor: number | undefined | null, ccy: string) =>
  minor == null ? undefined : fmtMoney(minor, ccy)

const percentBasis = (bps: number | undefined | null) => (bps == null ? undefined : fmtPct(bps))

const basisLabel = (basis?: string) => (basis ? `(${basis})` : undefined)

const dayKey = (iso: string) => {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso.slice(0, 10) : d.toISOString().slice(0, 10)
}

const isDeclineLine = (it: SettlementLineItem) => it.type === 'decline_fee' || it.status === 'auth_failed'
const isRefundLine = (it: SettlementLineItem) => it.type === 'refund' || it.gross_minor < 0
const isChargebackLine = (it: SettlementLineItem) => it.type.startsWith('chargeback')
const isPaymentLine = (it: SettlementLineItem) =>
  !isDeclineLine(it) && !isRefundLine(it) && !isChargebackLine(it) && (it.type === 'payment_captured' || it.gross_minor > 0)

function countLineItems(items: SettlementLineItem[]): SettlementCounts {
  return items.reduce(
    (acc, it) => {
      if (isDeclineLine(it)) acc.declined += 1
      else if (isRefundLine(it)) acc.refunds += 1
      else if (isChargebackLine(it)) acc.chargebacks += 1
      else if (isPaymentLine(it)) acc.paid += 1
      return acc
    },
    { paid: 0, declined: 0, refunds: 0, chargebacks: 0 },
  )
}

function displayCounts(saved: SettlementDetail['counts'], items: SettlementLineItem[]): SettlementCounts {
  const base = {
    paid: saved?.paid ?? 0,
    declined: saved?.declined ?? 0,
    refunds: saved?.refunds ?? 0,
    chargebacks: saved?.chargebacks ?? 0,
  }
  if (items.length === 0) return base
  const derived = countLineItems(items)
  return {
    paid: base.paid || derived.paid,
    declined: base.declined || derived.declined,
    refunds: Math.max(base.refunds, derived.refunds),
    chargebacks: Math.max(base.chargebacks, derived.chargebacks),
  }
}

function buildDayRows(items: SettlementLineItem[], settlementFeeMinor: number): SettlementDayRow[] {
  const byDay = new Map<string, SettlementDayRow>()
  for (const it of items) {
    const date = dayKey(it.occurred_at)
    const row = byDay.get(date) ?? {
      date,
      txns: 0,
      payments: 0,
      declines: 0,
      refunds: 0,
      chargebacks: 0,
      gross_minor: 0,
      refunds_minor: 0,
      chargebacks_minor: 0,
      mdr_minor: 0,
      approved_fee_minor: 0,
      declined_fee_minor: 0,
      refund_fee_minor: 0,
      chargeback_fee_minor: 0,
      reserve_held_minor: 0,
      reserve_released_minor: 0,
      adjustments_minor: 0,
      net_minor: 0,
      settlement_fee_minor: 0,
      payout_minor: 0,
    }
    row.txns += 1
    if (isDeclineLine(it)) row.declines += 1
    else if (isRefundLine(it)) row.refunds += 1
    else if (isChargebackLine(it)) row.chargebacks += 1
    else if (isPaymentLine(it)) row.payments += 1
    if (it.gross_minor > 0) row.gross_minor += it.gross_minor
    if (isRefundLine(it)) row.refunds_minor += Math.abs(Math.min(it.gross_minor, 0))
    if (isChargebackLine(it)) row.chargebacks_minor += Math.abs(Math.min(it.gross_minor, 0))
    row.mdr_minor += it.mdr_minor
    row.approved_fee_minor += it.approved_fee_minor
    row.declined_fee_minor += it.declined_fee_minor
    row.refund_fee_minor += it.refund_fee_minor
    row.chargeback_fee_minor += it.chargeback_fee_minor
    if (it.reserve_minor > 0) row.reserve_held_minor += it.reserve_minor
    if (it.reserve_minor < 0) row.reserve_released_minor += Math.abs(it.reserve_minor)
    row.net_minor += it.net_minor
    byDay.set(date, row)
  }
  const rows = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date))
  const fee = Math.abs(settlementFeeMinor)
  const bases = rows.map((d) => Math.max(d.net_minor, 0))
  const totalBase = bases.reduce((a, n) => a + n, 0)
  if (fee > 0 && totalBase > 0) {
    const allocations = bases.map((basis) => Math.floor((fee * basis) / totalBase))
    const allocated = allocations.reduce((a, n) => a + n, 0)
    let lastPositive = -1
    for (let i = bases.length - 1; i >= 0; i -= 1) {
      if (bases[i] > 0) {
        lastPositive = i
        break
      }
    }
    if (lastPositive >= 0) allocations[lastPositive] += fee - allocated
    rows.forEach((row, i) => {
      row.settlement_fee_minor = allocations[i]
      row.payout_minor = row.net_minor - allocations[i]
    })
  } else {
    rows.forEach((row) => {
      row.payout_minor = row.net_minor
    })
  }
  return rows
}

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
      toastSuccess('Settlement marked as completed — payout posted, confirmation emailed')
      reload()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Failed to complete settlement')
    } finally {
      setCompleting(false)
    }
  }

  const [emailing, setEmailing] = useState(false)
  const sendConfirmation = async () => {
    setEmailing(true)
    try {
      const res = await api<{ sent: boolean; reason?: string; to?: string }>(
        `/api/settlements/${uuid}/send-confirmation`, { method: 'POST' })
      if (res.sent) toastSuccess(`Payout confirmation sent${res.to ? ` to ${res.to}` : ''}`)
      else toastError(`Not sent — ${res.reason ?? 'unknown reason'}`)
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Failed to send confirmation')
    } finally {
      setEmailing(false)
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
  const days = buildDayRows(items, b.settlement_fee_minor)
  const counts = displayCounts(s.counts, items)
  const fs = s.fee_schedule

  // --- statement export (key/value, mirrors the printed statement) ---
  const statementRows = (): (string | number)[][] => [
    ['TransactWorld — Settlement statement'],
    ['Merchant', s.merchant_name],
    ['Currency', ccy],
    ['Window', `${fmtDate(s.window_start)} → ${fmtDate(s.window_end)}`],
    ['State', s.state],
    ['Items', s.items_count],
    [],
    ['Line', 'Rate / basis', `Amount (${ccy})`],
    ['Gross captured', '', toMajor(b.gross_captured_minor, ccy)],
    ['MDR', basisLabel(percentBasis(fs?.mdr_bps)) ?? '', -toMajor(Math.abs(b.mdr_minor), ccy)],
    [
      'Approved transaction fees',
      basisLabel(fixedBasis(fs?.approved_txn_fee_minor, ccy)) ?? '',
      -toMajor(Math.abs(b.approved_txn_fees_minor), ccy),
    ],
    [
      'Declined transaction fees',
      basisLabel(fixedBasis(fs?.declined_txn_fee_minor, ccy)) ?? '',
      -toMajor(Math.abs(b.declined_txn_fees_minor), ccy),
    ],
    ['Refunds', '', -toMajor(Math.abs(b.refunds_minor), ccy)],
    [
      'Refund fees',
      basisLabel(fixedBasis(fs?.refund_fee_minor, ccy)) ?? '',
      -toMajor(Math.abs(b.refund_fees_minor), ccy),
    ],
    ['Chargebacks', '', -toMajor(Math.abs(b.chargebacks_minor), ccy)],
    [
      'Chargeback fees',
      basisLabel(fixedBasis(fs?.chargeback_fee_minor, ccy)) ?? '',
      -toMajor(Math.abs(b.chargeback_fees_minor), ccy),
    ],
    ['Reserve held', basisLabel(percentBasis(fs?.reserve_hold_bps)) ?? '', -toMajor(Math.abs(b.reserve_held_minor), ccy)],
    ['Reserve released', '', toMajor(Math.abs(b.reserve_released_minor), ccy)],
    ['Adjustments', '', toMajor(b.adjustments_minor, ccy)],
    ['Subtotal', '', toMajor(b.subtotal_minor, ccy)],
    ['Settlement fee', basisLabel(percentBasis(fs?.settlement_fee_bps)) ?? '', -toMajor(Math.abs(b.settlement_fee_minor), ccy)],
    ['NET PAYOUT', '', toMajor(b.net_payout_minor, ccy)],
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

  const dayRows = (): (string | number)[][] => [
    [
      'Processing date',
      'Transactions',
      'Payments',
      'Declines',
      'Refunds',
      'Chargebacks',
      `Gross (${ccy})`,
      `MDR (${ccy})`,
      `Approved fees (${ccy})`,
      `Declined fees (${ccy})`,
      `Refunds (${ccy})`,
      `Refund fees (${ccy})`,
      `Chargebacks (${ccy})`,
      `Chargeback fees (${ccy})`,
      `Reserve held (${ccy})`,
      `Reserve released (${ccy})`,
      `Subtotal (${ccy})`,
      `Allocated settlement fee (${ccy})`,
      `Day net payout (${ccy})`,
    ],
    ...days.map((d) => [
      d.date,
      d.txns,
      d.payments,
      d.declines,
      d.refunds,
      d.chargebacks,
      toMajor(d.gross_minor, ccy),
      -toMajor(Math.abs(d.mdr_minor), ccy),
      -toMajor(Math.abs(d.approved_fee_minor), ccy),
      -toMajor(Math.abs(d.declined_fee_minor), ccy),
      -toMajor(Math.abs(d.refunds_minor), ccy),
      -toMajor(Math.abs(d.refund_fee_minor), ccy),
      -toMajor(Math.abs(d.chargebacks_minor), ccy),
      -toMajor(Math.abs(d.chargeback_fee_minor), ccy),
      -toMajor(Math.abs(d.reserve_held_minor), ccy),
      toMajor(Math.abs(d.reserve_released_minor), ccy),
      toMajor(d.net_minor, ccy),
      -toMajor(Math.abs(d.settlement_fee_minor), ccy),
      toMajor(d.payout_minor, ccy),
    ]),
    [
      'TOTAL',
      days.reduce((a, d) => a + d.txns, 0),
      days.reduce((a, d) => a + d.payments, 0),
      days.reduce((a, d) => a + d.declines, 0),
      days.reduce((a, d) => a + d.refunds, 0),
      days.reduce((a, d) => a + d.chargebacks, 0),
      toMajor(days.reduce((a, d) => a + d.gross_minor, 0), ccy),
      -toMajor(Math.abs(days.reduce((a, d) => a + d.mdr_minor, 0)), ccy),
      -toMajor(Math.abs(days.reduce((a, d) => a + d.approved_fee_minor, 0)), ccy),
      -toMajor(Math.abs(days.reduce((a, d) => a + d.declined_fee_minor, 0)), ccy),
      -toMajor(Math.abs(days.reduce((a, d) => a + d.refunds_minor, 0)), ccy),
      -toMajor(Math.abs(days.reduce((a, d) => a + d.refund_fee_minor, 0)), ccy),
      -toMajor(Math.abs(days.reduce((a, d) => a + d.chargebacks_minor, 0)), ccy),
      -toMajor(Math.abs(days.reduce((a, d) => a + d.chargeback_fee_minor, 0)), ccy),
      -toMajor(Math.abs(days.reduce((a, d) => a + d.reserve_held_minor, 0)), ccy),
      toMajor(Math.abs(days.reduce((a, d) => a + d.reserve_released_minor, 0)), ccy),
      toMajor(days.reduce((a, d) => a + d.net_minor, 0), ccy),
      -toMajor(Math.abs(days.reduce((a, d) => a + d.settlement_fee_minor, 0)), ccy),
      toMajor(days.reduce((a, d) => a + d.payout_minor, 0), ccy),
    ],
  ]

  const exportCSV = () =>
    view === 'statement'
      ? downloadCSV(`${base}.csv`, statementRows())
      : view === 'daily'
        ? downloadCSV(`${base}-daily.csv`, dayRows())
      : downloadCSV(`${base}-transactions.csv`, lineRows())
  const exportExcel = () =>
    view === 'statement'
      ? downloadExcel(`${base}.xls`, 'Statement', statementRows())
      : view === 'daily'
        ? downloadExcel(`${base}-daily.xls`, 'Daily', dayRows())
      : downloadExcel(`${base}-transactions.xls`, 'Transactions', lineRows())

  const exporting = view !== 'statement' && lines.loading

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
          {isAdmin && (s.state === 'generated' || s.state === 'completed') && (
            <div className="head-actions">
              {s.state === 'generated' ? (
                <button className="btn" onClick={() => void markCompleted()} disabled={completing}>
                  {completing ? 'Posting payout…' : '✓ Mark completed'}
                </button>
              ) : (
                <>
                  <button className="btn success" disabled>
                    ✓ Completed
                  </button>
                  <button className="btn" onClick={() => void sendConfirmation()} disabled={emailing}
                          title="Email the payout confirmation (report + transaction list) to the merchant">
                    {emailing ? 'Sending…' : '✉ Email confirmation'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="statement-bar" data-print="hide">
        <div className="seg">
          <button className={view === 'statement' ? 'on' : ''} onClick={() => setView('statement')}>
            Whole settlement
          </button>
          <button className={view === 'daily' ? 'on' : ''} onClick={() => setView('daily')}>
            Day-wise
            <span className="c">{lines.data ? fmtInt(days.length) : '·'}</span>
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
          {view !== 'lines' && (
            <button className="export-btn" onClick={printToPDF}>PDF</button>
          )}
        </div>
      </div>

      {view === 'statement' ? (
        <StatementView s={s} counts={counts} />
      ) : view === 'daily' ? (
        <DailyView days={days} loading={lines.loading} s={s} />
      ) : (
        <LinesView items={items} loading={lines.loading} ccy={ccy} />
      )}
    </div>
  )
}

function DailyView({ days, loading, s }: { days: SettlementDayRow[]; loading: boolean; s: SettlementDetail }) {
  const ccy = s.currency
  const fs = s.fee_schedule
  const [selectedDate, setSelectedDate] = useState('')

  // A settlement pays out as ONE unit — completing it posts a single payout of
  // net_payout_minor covering every day in the window. So a day is paid iff the
  // settlement itself is completed; there is no per-day payout to mark. This is
  // the same truth the merchant ledger's pay_status reads, so the two views agree.
  const settlementPaid = s.state === 'completed'

  useEffect(() => {
    if (days.length > 0 && !days.some((d) => d.date === selectedDate)) {
      setSelectedDate(days[0].date)
    }
  }, [days, selectedDate])

  if (loading) return <LoadingBlock label="Loading day-wise report…" />
  if (days.length === 0)
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--ink-2)' }}>
        No day-wise rows in this settlement.
      </div>
    )

  const sum = (k: keyof SettlementDayRow) =>
    days.reduce((a, d) => a + (typeof d[k] === 'number' ? (d[k] as number) : 0), 0)
  const subtotal = sum('net_minor')
  const payout = sum('payout_minor')
  const selected = days.find((d) => d.date === selectedDate) ?? days[0]

  return (
    <div className="stack">
      <div className="grid grid-cards">
        <div className="card stat-card">
          <div className="label">Processing days</div>
          <div className="value">{fmtInt(days.length)}</div>
          <div className="dim small">{fmtDate(days[0].date)} → {fmtDate(days[days.length - 1].date)}</div>
        </div>
        <div className="card stat-card">
          <div className="label"><span className="ccy-tag">{ccy}</span> Daily subtotal</div>
          <div className="value">{fmtMoney(subtotal, ccy)}</div>
          <div className="dim small">before settlement fee</div>
        </div>
        <div className="card stat-card">
          <div className="label">Settlement fee</div>
          <div className="value money neg">−{fmtMoney(Math.abs(s.breakdown.settlement_fee_minor), ccy)}</div>
          <div className="dim small">applied once to whole settlement</div>
        </div>
        <div className="card stat-card">
          <div className="label">Payout status</div>
          <div className="value">
            <span className={`pay-pill ${settlementPaid ? 'paid' : 'in_settlement'}`}>
              {settlementPaid ? 'Paid' : 'Pending payout'}
            </span>
          </div>
          <div className="dim small">
            {settlementPaid
              ? `all ${fmtInt(days.length)} days paid · total ${fmtMoney(payout, ccy)}`
              : `${fmtInt(days.length)} days awaiting one payout of ${fmtMoney(payout, ccy)}`}
          </div>
        </div>
      </div>

      <div className="daily-report-layout">
        <div className="card daily-day-list" data-print="hide">
          <div className="card-title">
            <span>Daily payout days</span>
            <span className="dim small">{fmtInt(days.length)} days</span>
          </div>
          <div className="daily-day-options">
            {days.map((d) => {
              return (
                <button
                  key={d.date}
                  className={d.date === selected.date ? 'daily-day-option on' : 'daily-day-option'}
                  onClick={() => setSelectedDate(d.date)}
                >
                  <span>
                    <b>{fmtDate(d.date)}</b>
                    <small>{fmtInt(d.payments)} paid · {fmtInt(d.refunds)} refunds</small>
                  </span>
                  <span className="daily-day-amount">
                    {fmtMoney(d.payout_minor, ccy)}
                    {settlementPaid && <span className="chip green">Paid</span>}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <DailyStatement
          day={selected}
          ccy={ccy}
          feeSchedule={fs}
          merchantName={s.merchant_name}
          windowStart={s.window_start}
          windowEnd={s.window_end}
          paid={settlementPaid}
        />
      </div>
    </div>
  )
}

function DailyStatement({
  day,
  ccy,
  feeSchedule,
  merchantName,
  windowStart,
  windowEnd,
  paid,
}: {
  day: SettlementDayRow
  ccy: string
  feeSchedule: SettlementDetail['fee_schedule']
  merchantName: string
  windowStart: string
  windowEnd: string
  paid: boolean
}) {
  const settlementFeeDetail = basisLabel(percentBasis(feeSchedule?.settlement_fee_bps))

  return (
    <div className="card statement daily-statement">
      <div className="statement-head">
        <div>
          <div className="kicker">Day-wise settlement report</div>
          <div className="m-name">{merchantName}</div>
          <div className="win num">
            Processing date {fmtDate(day.date)} · Currency {ccy}
          </div>
          <div className="win num">
            Parent window {fmtDate(windowStart)} → {fmtDate(windowEnd)}
          </div>
        </div>
        <div className="daily-approve-box">
          <div className="kicker">Counts</div>
          <div className="small num" style={{ marginTop: 4, lineHeight: 1.7 }}>
            Paid <b>{fmtInt(day.payments)}</b> · Declined <b>{fmtInt(day.declines)}</b>
            <br />
            Refunds <b>{fmtInt(day.refunds)}</b> · Chargebacks <b>{fmtInt(day.chargebacks)}</b>
          </div>
          <div className="daily-payout">
            <span>Day net payout</span>
            <b>{fmtMoney(day.payout_minor, ccy)}</b>
          </div>
          <div className="daily-payout-status">
            <span className={`pay-pill ${paid ? 'paid' : 'in_settlement'}`}>
              {paid ? 'Paid' : 'Pending payout'}
            </span>
            <div className="dim small" style={{ marginTop: 6 }}>
              {paid
                ? 'settled in this settlement’s payout'
                : 'paid when this settlement is completed'}
            </div>
          </div>
        </div>
      </div>

      <table>
        <tbody>
          <tr className="section-gap">
            <td className="row-label" style={{ fontWeight: 600, color: 'var(--ink)' }}>
              <span className="op" />Gross captured
            </td>
            <td className="money" style={{ fontWeight: 600 }}>{fmtMoney(day.gross_minor, ccy)}</td>
          </tr>
          <Row
            label="MDR"
            op="−"
            minor={-Math.abs(day.mdr_minor)}
            currency={ccy}
            detail={basisLabel(percentBasis(feeSchedule?.mdr_bps))}
          />
          <Row
            label="Approved transaction fees"
            op="−"
            minor={-Math.abs(day.approved_fee_minor)}
            currency={ccy}
            detail={basisLabel(fixedBasis(feeSchedule?.approved_txn_fee_minor, ccy))}
          />
          <Row
            label="Declined transaction fees"
            op="−"
            minor={-Math.abs(day.declined_fee_minor)}
            currency={ccy}
            detail={basisLabel(fixedBasis(feeSchedule?.declined_txn_fee_minor, ccy))}
            dimZero
          />
          <Row label="Refunds" op="−" minor={-Math.abs(day.refunds_minor)} currency={ccy} dimZero />
          <Row
            label="Refund fees"
            op="−"
            minor={-Math.abs(day.refund_fee_minor)}
            currency={ccy}
            detail={basisLabel(fixedBasis(feeSchedule?.refund_fee_minor, ccy))}
            dimZero
          />
          <Row label="Chargebacks" op="−" minor={-Math.abs(day.chargebacks_minor)} currency={ccy} dimZero />
          <Row
            label="Chargeback fees"
            op="−"
            minor={-Math.abs(day.chargeback_fee_minor)}
            currency={ccy}
            detail={basisLabel(fixedBasis(feeSchedule?.chargeback_fee_minor, ccy))}
            dimZero
          />
          <Row
            label="Reserve held"
            op="−"
            minor={-Math.abs(day.reserve_held_minor)}
            currency={ccy}
            detail={basisLabel(percentBasis(feeSchedule?.reserve_hold_bps))}
            dimZero
          />
          <Row label="Reserve released" op="+" minor={Math.abs(day.reserve_released_minor)} currency={ccy} dimZero />
          <Row label="Adjustments" op="±" minor={day.adjustments_minor} currency={ccy} dimZero />
          <Row label="Subtotal" op="=" minor={day.net_minor} currency={ccy} className="sub" />
          <Row
            label="Allocated settlement fee"
            op="−"
            minor={-Math.abs(day.settlement_fee_minor)}
            currency={ccy}
            detail={settlementFeeDetail}
          />
          <tr className="total">
            <td className="row-label">
              <span className="op">=</span>DAY NET PAYOUT
            </td>
            <td className={day.payout_minor < 0 ? 'money neg' : 'money'}>
              {fmtMoney(day.payout_minor, ccy)}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="statement-foot">
        <div className="usdc">
          <span>Day payout status</span>
          <b>{paid ? 'Paid' : 'Generated'}</b>
        </div>
        <div className="dim">
          Statement covers {fmtInt(day.txns)} settled items for {fmtDate(day.date)}.
        </div>
      </div>
    </div>
  )
}

function StatementView({ s, counts }: { s: SettlementDetail; counts: SettlementCounts }) {
  const b = s.breakdown
  const ccy = s.currency
  const fs = s.fee_schedule
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
            Paid <b>{fmtInt(counts.paid)}</b> · Declined <b>{fmtInt(counts.declined)}</b>
            <br />
            Refunds <b>{fmtInt(counts.refunds)}</b> · Chargebacks <b>{fmtInt(counts.chargebacks)}</b>
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
          <Row
            label="MDR"
            op="−"
            minor={-Math.abs(b.mdr_minor)}
            currency={ccy}
            detail={basisLabel(percentBasis(fs?.mdr_bps))}
          />
          <Row
            label="Approved transaction fees"
            op="−"
            minor={-Math.abs(b.approved_txn_fees_minor)}
            currency={ccy}
            detail={basisLabel(fixedBasis(fs?.approved_txn_fee_minor, ccy))}
          />
          <Row
            label="Declined transaction fees"
            op="−"
            minor={-Math.abs(b.declined_txn_fees_minor)}
            currency={ccy}
            detail={basisLabel(fixedBasis(fs?.declined_txn_fee_minor, ccy))}
          />
          <Row label="Refunds" op="−" minor={-Math.abs(b.refunds_minor)} currency={ccy} dimZero />
          <Row
            label="Refund fees"
            op="−"
            minor={-Math.abs(b.refund_fees_minor)}
            currency={ccy}
            detail={basisLabel(fixedBasis(fs?.refund_fee_minor, ccy))}
            dimZero
          />
          <Row label="Chargebacks" op="−" minor={-Math.abs(b.chargebacks_minor)} currency={ccy} dimZero />
          <Row
            label="Chargeback fees"
            op="−"
            minor={-Math.abs(b.chargeback_fees_minor)}
            currency={ccy}
            detail={basisLabel(fixedBasis(fs?.chargeback_fee_minor, ccy))}
            dimZero
          />
          <Row
            label="Reserve held"
            op="−"
            minor={-Math.abs(b.reserve_held_minor)}
            currency={ccy}
            detail={basisLabel(percentBasis(fs?.reserve_hold_bps))}
          />
          <Row label="Reserve released" op="+" minor={Math.abs(b.reserve_released_minor)} currency={ccy} dimZero />
          <Row label="Adjustments" op="±" minor={b.adjustments_minor} currency={ccy} dimZero />
          <Row label="Subtotal" op="=" minor={b.subtotal_minor} currency={ccy} className="sub" />
          <Row
            label="Settlement fee"
            op="−"
            minor={-Math.abs(b.settlement_fee_minor)}
            currency={ccy}
            detail={basisLabel(percentBasis(fs?.settlement_fee_bps))}
          />
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
          Statement covers {fmtInt(s.items_count)} settled items · counts: {fmtInt(counts.paid)} paid,{' '}
          {fmtInt(counts.declined)} declined, {fmtInt(counts.refunds)} refunds
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
