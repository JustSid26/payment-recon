import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { DayPayouts, SettlementDetail, SettlementLineItem } from '../lib/types'
import { fmtDate, fmtDateTime, fmtInt, fmtMoney, fmtMoneySigned } from '../lib/money'
import { LoadingBlock, Modal, StatusChip, toastError, toastSuccess } from '../components/ui'
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

/** Per-transaction fee detail showing the count it's charged on, e.g. "$0.35 × 77". */
const feeTimes = (minor: number | undefined | null, ccy: string, count: number) =>
  minor == null ? undefined : `${fmtMoney(minor, ccy)} × ${fmtInt(count)}`

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

const LINE_HEADER = [
  'Date (UTC)', 'Type', 'Reference', 'Brand', 'Last 4', 'Status',
  'Gross', 'MDR', 'Approved fee', 'Declined fee', 'Refund fee', 'Chargeback fee', 'Reserve', 'Net',
]

/** Per-transaction rows (header + one row per line item) for CSV/Excel export. */
function lineItemRows(items: SettlementLineItem[], ccy: string): (string | number)[][] {
  return [
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
}

export default function SettlementDetailPage({ uuid: uuidProp, embedded }: { uuid?: string; embedded?: boolean } = {}) {
  const params = useParams<{ uuid: string }>()
  const uuid = uuidProp ?? params.uuid
  const isAdmin = getUser()?.role === 'admin'
  const { data: s, loading, reload } = useApi(() => api<SettlementDetail>(`/api/settlements/${uuid}`), [uuid])
  const lines = useApi(() => api<{ items: SettlementLineItem[] }>(`/api/settlements/${uuid}/items`), [uuid])
  const dayPay = useApi(() => api<DayPayouts>(`/api/settlements/${uuid}/day-payouts`), [uuid])
  const [view, setView] = useState<View>('statement')
  const [completing, setCompleting] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [confirmDayValue, setConfirmDayValue] = useState<string | null>(null)
  const [confirmingDay, setConfirmingDay] = useState(false)

  const doConfirmDay = async (day: string) => {
    setConfirmingDay(true)
    try {
      await api(`/api/settlements/${uuid}/days/${day}/complete`, { method: 'POST' })
      toastSuccess(`Payout confirmed for ${fmtDate(day)}`)
      setConfirmDayValue(null)
      reload()
      dayPay.reload()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Failed to confirm this day’s payout')
    } finally {
      setConfirmingDay(false)
    }
  }

  // Confirm the WHOLE settlement. If it's being paid per day, pay every still-
  // unpaid day (never the whole net again — that would double-pay days already
  // settled). Otherwise (a day nets ≤ 0) post one whole-settlement payout.
  const confirmWhole = async () => {
    setCompleting(true)
    try {
      const dp = dayPay.data
      if (dp && dp.per_day_available) {
        for (const day of dp.days.filter((d) => !d.paid).map((d) => d.day)) {
          await api(`/api/settlements/${uuid}/days/${day}/complete`, { method: 'POST' })
        }
      } else {
        await api(`/api/settlements/${uuid}/complete`, { method: 'POST' })
      }
      toastSuccess('Payout confirmed — settlement marked paid, balances updated')
      setShowConfirm(false)
      reload()
      dayPay.reload()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Failed to confirm payout')
    } finally {
      setCompleting(false)
    }
  }

  const [showCancel, setShowCancel] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const cancelSettlement = async () => {
    setCancelling(true)
    try {
      await api(`/api/settlements/${uuid}/cancel`, { method: 'POST' })
      toastSuccess('Settlement cancelled — its days are free to settle individually')
      setShowCancel(false)
      reload()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Failed to cancel settlement')
    } finally {
      setCancelling(false)
    }
  }

  // Sends open a confirm dialog first (they email the merchant), so a misclick
  // can't fire — and the dialog states the scope: whole settlement vs one day.
  const [sendDayValue, setSendDayValue] = useState<string | null>(null)
  const [sendingDay, setSendingDay] = useState(false)
  const doSendDay = async (day: string) => {
    setSendingDay(true)
    try {
      const res = await api<{ sent: boolean; reason?: string; to?: string }>(
        `/api/settlements/${uuid}/days/${day}/send-confirmation`, { method: 'POST' })
      if (res.sent) toastSuccess(`Day report for ${fmtDate(day)} sent${res.to ? ` to ${res.to}` : ''}`)
      else toastError(`Not sent — ${res.reason ?? 'unknown reason'}`)
      setSendDayValue(null)
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Failed to send day report')
    } finally {
      setSendingDay(false)
    }
  }

  const [showSendReport, setShowSendReport] = useState(false)
  const [emailing, setEmailing] = useState(false)
  const sendConfirmation = async () => {
    setEmailing(true)
    try {
      const res = await api<{ sent: boolean; reason?: string; to?: string }>(
        `/api/settlements/${uuid}/send-confirmation`, { method: 'POST' })
      if (res.sent) toastSuccess(`Full report sent${res.to ? ` to ${res.to}` : ''}`)
      else toastError(`Not sent — ${res.reason ?? 'unknown reason'}`)
      setShowSendReport(false)
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Failed to send report')
    } finally {
      setEmailing(false)
    }
  }

  if (loading || !s) {
    return (
      <div>
        {!embedded && <Link to="/settlements" className="back-link">← Settlements</Link>}
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
    ['CoreServices — Settlement statement'],
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

  const lineRows = (): (string | number)[][] => lineItemRows(items, ccy)

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
        {!embedded && <Link to="/settlements" className="back-link">← Settlements</Link>}
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              Settlement statement <StatusChip status={s.state} />
            </h1>
            <div className="sub">
              {s.merchant_name} · <span className="ccy-tag">{ccy}</span> · {fmtInt(s.items_count)} items
              {s.confirmation_code && (
                <> · Code <b className="mono">{s.confirmation_code}</b></>
              )}
            </div>
          </div>
          {isAdmin && (
            <div className="head-actions">
              <span className="scope-tag" title="These buttons act on the WHOLE settlement">Whole settlement</span>
              <button className="btn" onClick={() => setShowSendReport(true)} disabled={emailing}
                      title="Email the whole-settlement report (PDF + Excel) to the merchant">
                {emailing ? 'Sending…' : '✉ Send full report'}
              </button>
              {s.state === 'generated' && (
                <>
                  <button className="btn" onClick={() => setShowCancel(true)} disabled={completing || cancelling}>
                    Cancel settlement
                  </button>
                  <button className="btn primary" onClick={() => setShowConfirm(true)} disabled={completing || cancelling}>
                    {completing ? 'Posting payout…' : '✓ Confirm whole payout'}
                  </button>
                </>
              )}
              {s.state === 'completed' && (
                <button className="btn success" disabled>✓ Completed</button>
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
        <StatementView s={s} counts={counts} dayPay={dayPay.data} />
      ) : view === 'daily' ? (
        <DailyView
          days={days}
          loading={lines.loading}
          s={s}
          items={items}
          baseName={base}
          canConfirm={isAdmin && s.state === 'generated'}
          onConfirm={() => setShowConfirm(true)}
          dayPay={dayPay.data}
          confirming={confirmingDay}
          onConfirmDay={(day) => setConfirmDayValue(day)}
          isAdmin={isAdmin}
          sendingDay={sendingDay}
          onSendDay={(day) => setSendDayValue(day)}
        />
      ) : (
        <LinesView items={items} loading={lines.loading} ccy={ccy} />
      )}

      {showConfirm && (() => {
        const dp = dayPay.data
        const remainingDays = dp ? dp.days.filter((d) => !d.paid) : []
        const partial = dp ? dp.days_paid > 0 : false
        const amount = dp && dp.per_day_available
          ? remainingDays.reduce((a, d) => a + d.payout_minor, 0)
          : b.net_payout_minor
        return (
          <Modal
            title="Confirm whole-settlement payout"
            onClose={() => (completing ? null : setShowConfirm(false))}
            footer={
              <>
                <button className="btn" onClick={() => setShowConfirm(false)} disabled={completing}>Cancel</button>
                <button className="btn primary" onClick={() => void confirmWhole()} disabled={completing}>
                  {completing ? 'Posting payout…' : `Confirm & pay ${fmtMoney(amount, ccy)}`}
                </button>
              </>
            }
          >
            <div>
              {partial ? (
                <>Pay the <b>{fmtInt(remainingDays.length)} remaining day{remainingDays.length === 1 ? '' : 's'}</b>{' '}
                (<b>{fmtMoney(amount, ccy)}</b>) to <b>{s.merchant_name}</b> — the other{' '}
                {fmtInt(dp?.days_paid ?? 0)} day{(dp?.days_paid ?? 0) === 1 ? ' is' : 's are'} already paid.</>
              ) : (
                <>Confirm the whole payout of <b>{fmtMoney(amount, ccy)}</b> to <b>{s.merchant_name}</b> for the
                window {fmtDate(s.window_start)} → {fmtDate(s.window_end)}.</>
              )}
            </div>
            <ul className="dim small" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
              <li>Posts the payout{partial ? ' for the remaining days' : ''} to the ledger (money leaves the gateway clearing account).</li>
              <li>Marks this settlement <b>completed</b> — “In settlement” → “Paid” on the merchant’s balances, daily records and ledger.</li>
            </ul>
            <div className="dim small" style={{ marginTop: 10 }}>This posts an append-only ledger event and cannot be undone from the UI.</div>
          </Modal>
        )
      })()}

      {confirmDayValue && (
        <Modal
          title="Confirm day payout"
          onClose={() => (confirmingDay ? null : setConfirmDayValue(null))}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDayValue(null)} disabled={confirmingDay}>Cancel</button>
              <button className="btn primary" onClick={() => void doConfirmDay(confirmDayValue)} disabled={confirmingDay}>
                {confirmingDay
                  ? 'Posting payout…'
                  : `Confirm & pay ${fmtMoney(dayPay.data?.days.find((d) => d.day === confirmDayValue)?.payout_minor ?? 0, ccy)}`}
              </button>
            </>
          }
        >
          <div>
            Pay <b>{fmtMoney(dayPay.data?.days.find((d) => d.day === confirmDayValue)?.payout_minor ?? 0, ccy)}</b> for{' '}
            <b>{fmtDate(confirmDayValue)}</b> to <b>{s.merchant_name}</b>.
          </div>
          <ul className="dim small" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Pays <b>only this day</b> to the ledger — other days stay pending.</li>
            <li>The settlement is marked <b>completed</b> once every day has been paid.</li>
          </ul>
          <div className="dim small" style={{ marginTop: 10 }}>This posts an append-only ledger event and cannot be undone from the UI.</div>
        </Modal>
      )}

      {showCancel && (
        <Modal
          title="Cancel settlement"
          onClose={() => (cancelling ? null : setShowCancel(false))}
          footer={
            <>
              <button className="btn" onClick={() => setShowCancel(false)} disabled={cancelling}>Keep settlement</button>
              <button className="btn primary" onClick={() => void cancelSettlement()} disabled={cancelling}
                      style={{ background: 'var(--red)', borderColor: 'var(--red)' }}>
                {cancelling ? 'Cancelling…' : 'Cancel settlement'}
              </button>
            </>
          }
        >
          <div>
            Cancel this generated settlement for <b>{s.merchant_name}</b> ({fmtDate(s.window_start)} → {fmtDate(s.window_end)})?
          </div>
          <ul className="dim small" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Reverses the generation on the ledger (append-only) — payable returns to the merchant’s available balance.</li>
            <li>Unlinks its {fmtInt(s.items_count)} events so each processing day can be settled and paid <b>individually</b> from the merchant’s Daily records.</li>
            <li>Only works because it hasn’t been paid yet — a completed payout can’t be cancelled.</li>
          </ul>
        </Modal>
      )}

      {showSendReport && (
        <Modal
          title="Send full settlement report"
          onClose={() => (emailing ? null : setShowSendReport(false))}
          footer={
            <>
              <button className="btn" onClick={() => setShowSendReport(false)} disabled={emailing}>Cancel</button>
              <button className="btn primary" onClick={() => void sendConfirmation()} disabled={emailing}>
                {emailing ? 'Sending…' : '✉ Send full report'}
              </button>
            </>
          }
        >
          <div>
            Email the <b>whole settlement</b> report to <b>{s.merchant_name}</b>’s payout email?
          </div>
          <ul className="dim small" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Covers the entire window {fmtDate(s.window_start)} → {fmtDate(s.window_end)} ({fmtInt(s.items_count)} items).</li>
            <li>Attaches the full report (PDF) + all transactions (Excel), code <b className="mono">{s.confirmation_code}</b>.</li>
            <li>This is the <b>whole</b> report — to email just one day, use “Send day report” in the Day-wise tab.</li>
          </ul>
        </Modal>
      )}

      {sendDayValue && (
        <Modal
          title="Send day report"
          onClose={() => (sendingDay ? null : setSendDayValue(null))}
          footer={
            <>
              <button className="btn" onClick={() => setSendDayValue(null)} disabled={sendingDay}>Cancel</button>
              <button className="btn primary" onClick={() => void doSendDay(sendDayValue)} disabled={sendingDay}>
                {sendingDay ? 'Sending…' : '✉ Send day report'}
              </button>
            </>
          }
        >
          <div>
            Email the report for <b>just {fmtDate(sendDayValue)}</b> to <b>{s.merchant_name}</b>’s payout email?
          </div>
          <ul className="dim small" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Covers <b>only this one day</b> — that day’s breakdown (PDF) + that day’s transactions (Excel).</li>
            <li>Not the whole settlement.</li>
          </ul>
        </Modal>
      )}
    </div>
  )
}

function DailyView({ days, loading, s, items, baseName, canConfirm, onConfirm, dayPay, confirming, onConfirmDay, isAdmin, sendingDay, onSendDay }: {
  days: SettlementDayRow[]
  loading: boolean
  s: SettlementDetail
  items: SettlementLineItem[]
  baseName: string
  canConfirm: boolean
  onConfirm: () => void
  dayPay: DayPayouts | null
  confirming: boolean
  onConfirmDay: (day: string) => void
  isAdmin: boolean
  sendingDay: boolean
  onSendDay: (day: string) => void
}) {
  const ccy = s.currency
  const fs = s.fee_schedule
  const [selectedDate, setSelectedDate] = useState('')

  const settlementPaid = s.state === 'completed'
  // Per-day payout state: each processing day can be paid on its own from its
  // report card. per_day_available is false only when a day nets ≤ 0 (then the
  // whole settlement is paid as one unit instead).
  const paidByDay = new Map((dayPay?.days ?? []).map((d) => [d.day, d]))
  const perDayAvailable = dayPay?.per_day_available ?? false
  const daysPaid = dayPay?.days_paid ?? 0
  const daysTotal = dayPay?.days_total ?? days.length
  const remainingPayout = (dayPay?.days ?? []).filter((d) => !d.paid).reduce((a, d) => a + d.payout_minor, 0)

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
  const selectedItems = items.filter((it) => dayKey(it.occurred_at) === selected.date)

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
              {settlementPaid ? 'Paid' : daysPaid > 0 ? `${fmtInt(daysPaid)}/${fmtInt(daysTotal)} days paid` : 'Pending payout'}
            </span>
          </div>
          <div className="dim small">
            {settlementPaid
              ? `all ${fmtInt(daysTotal)} days paid · total ${fmtMoney(payout, ccy)}`
              : perDayAvailable
                ? `confirm each day below · ${fmtMoney(remainingPayout, ccy)} remaining`
                : `${fmtInt(daysTotal)} days awaiting one payout of ${fmtMoney(payout, ccy)}`}
          </div>
          {canConfirm && !perDayAvailable && (
            <button className="btn primary" style={{ marginTop: 12, alignSelf: 'flex-start' }} onClick={onConfirm}>
              ✓ Confirm whole payout
            </button>
          )}
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
                    {(settlementPaid || paidByDay.get(d.date)?.paid) && <span className="chip green">Paid</span>}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <DailyStatement
          day={selected}
          dayItems={selectedItems}
          baseName={baseName}
          ccy={ccy}
          feeSchedule={fs}
          merchantName={s.merchant_name}
          windowStart={s.window_start}
          windowEnd={s.window_end}
          paid={settlementPaid || (paidByDay.get(selected.date)?.paid ?? false)}
          canConfirmDay={canConfirm && perDayAvailable && !(paidByDay.get(selected.date)?.paid ?? false)}
          confirming={confirming}
          onConfirmDay={() => onConfirmDay(selected.date)}
          dayCode={paidByDay.get(selected.date)?.confirmation_code}
          canSend={isAdmin}
          sending={sendingDay}
          onSendReport={() => onSendDay(selected.date)}
        />
      </div>
    </div>
  )
}

function DailyStatement({
  day,
  dayItems,
  baseName,
  ccy,
  feeSchedule,
  merchantName,
  windowStart,
  windowEnd,
  paid,
  canConfirmDay,
  confirming,
  onConfirmDay,
  dayCode,
  canSend,
  sending,
  onSendReport,
}: {
  day: SettlementDayRow
  dayItems: SettlementLineItem[]
  baseName: string
  ccy: string
  feeSchedule: SettlementDetail['fee_schedule']
  merchantName: string
  windowStart: string
  windowEnd: string
  paid: boolean
  canConfirmDay: boolean
  confirming: boolean
  onConfirmDay: () => void
  dayCode?: string
  canSend: boolean
  sending: boolean
  onSendReport: () => void
}) {
  const settlementFeeDetail = basisLabel(percentBasis(feeSchedule?.settlement_fee_bps))
  const txnBase = `${baseName}-${day.date}-transactions`
  const exportDayCSV = () => downloadCSV(`${txnBase}.csv`, lineItemRows(dayItems, ccy))
  const exportDayExcel = () => downloadExcel(`${txnBase}.xls`, day.date, lineItemRows(dayItems, ccy))

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
          {dayCode && (
            <div className="win num">Day code <b className="mono">{dayCode}</b></div>
          )}
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
                ? 'this day’s payout has been posted'
                : canConfirmDay
                  ? 'confirm to pay out just this day'
                  : 'paid when this settlement is completed'}
            </div>
            {canConfirmDay && (
              <button className="btn primary sm" style={{ marginTop: 10 }} disabled={confirming} onClick={onConfirmDay}>
                ✓ Confirm this day only
              </button>
            )}
          </div>
          <div className="daily-report-actions" data-print="hide">
            <div className="dra-head">
              <span className="dra-title">This day’s transactions</span>
              <span className="dra-count">{fmtInt(dayItems.length)} txns</span>
            </div>
            <div className="dra-buttons">
              <button className="export-btn" onClick={exportDayCSV} disabled={!dayItems.length}>
                <span className="material-symbols-outlined">table_view</span>CSV
              </button>
              <button className="export-btn" onClick={exportDayExcel} disabled={!dayItems.length}>
                <span className="material-symbols-outlined">grid_on</span>Excel
              </button>
            </div>
            {canSend && (
              <button className="btn sm dra-send" onClick={onSendReport} disabled={sending || !dayItems.length}
                      title="Email this day’s report (PDF + Excel) to the merchant">
                {sending ? 'Sending…' : '✉ Send day report'}
              </button>
            )}
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
            detail={basisLabel(feeTimes(feeSchedule?.approved_txn_fee_minor, ccy, day.payments))}
          />
          <Row
            label="Declined transaction fees"
            op="−"
            minor={-Math.abs(day.declined_fee_minor)}
            currency={ccy}
            detail={basisLabel(feeTimes(feeSchedule?.declined_txn_fee_minor, ccy, day.declines))}
            dimZero
          />
          <Row label="Refunds" op="−" minor={-Math.abs(day.refunds_minor)} currency={ccy} dimZero />
          <Row
            label="Refund fees"
            op="−"
            minor={-Math.abs(day.refund_fee_minor)}
            currency={ccy}
            detail={basisLabel(feeTimes(feeSchedule?.refund_fee_minor, ccy, day.refunds))}
            dimZero
          />
          <Row label="Chargebacks" op="−" minor={-Math.abs(day.chargebacks_minor)} currency={ccy} dimZero />
          <Row
            label="Chargeback fees"
            op="−"
            minor={-Math.abs(day.chargeback_fee_minor)}
            currency={ccy}
            detail={basisLabel(feeTimes(feeSchedule?.chargeback_fee_minor, ccy, day.chargebacks))}
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

function StatementView({ s, counts, dayPay }: { s: SettlementDetail; counts: SettlementCounts; dayPay: DayPayouts | null }) {
  const b = s.breakdown
  const ccy = s.currency
  const fs = s.fee_schedule
  const paidMinor = (dayPay?.days ?? []).filter((d) => d.paid).reduce((a, d) => a + d.payout_minor, 0)
  const remainingMinor = b.net_payout_minor - paidMinor
  const partial = (dayPay?.days_paid ?? 0) > 0 && s.state !== 'completed'
  return (
    <div className="card statement">
      <div className="statement-head">
        <div>
          <div className="kicker">Settlement statement</div>
          <div className="m-name">{s.merchant_name}</div>
          <div className="win num">
            Window {fmtDate(s.window_start)} → {fmtDate(s.window_end)} · Currency {ccy}
          </div>
          {partial && (
            <div className="win num" style={{ color: 'var(--amber)', fontWeight: 600 }}>
              {fmtInt(dayPay?.days_paid ?? 0)}/{fmtInt(dayPay?.days_total ?? 0)} days paid ·{' '}
              {fmtMoney(paidMinor, ccy)} paid · {fmtMoney(remainingMinor, ccy)} remaining
            </div>
          )}
          {s.state === 'completed' && (
            <div className="win num" style={{ color: 'var(--green)', fontWeight: 600 }}>
              ✓ Paid in full · {fmtMoney(b.net_payout_minor, ccy)}
            </div>
          )}
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
            detail={basisLabel(feeTimes(fs?.approved_txn_fee_minor, ccy, counts.paid))}
          />
          <Row
            label="Declined transaction fees"
            op="−"
            minor={-Math.abs(b.declined_txn_fees_minor)}
            currency={ccy}
            detail={basisLabel(feeTimes(fs?.declined_txn_fee_minor, ccy, counts.declined))}
          />
          <Row label="Refunds" op="−" minor={-Math.abs(b.refunds_minor)} currency={ccy} dimZero />
          <Row
            label="Refund fees"
            op="−"
            minor={-Math.abs(b.refund_fees_minor)}
            currency={ccy}
            detail={basisLabel(feeTimes(fs?.refund_fee_minor, ccy, counts.refunds))}
            dimZero
          />
          <Row label="Chargebacks" op="−" minor={-Math.abs(b.chargebacks_minor)} currency={ccy} dimZero />
          <Row
            label="Chargeback fees"
            op="−"
            minor={-Math.abs(b.chargeback_fees_minor)}
            currency={ccy}
            detail={basisLabel(feeTimes(fs?.chargeback_fee_minor, ccy, counts.chargebacks))}
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
          <tr className={partial ? 'sub' : 'total'}>
            <td className="row-label">
              <span className="op">=</span>NET PAYOUT
            </td>
            <td className={b.net_payout_minor < 0 ? 'money neg' : 'money'}>
              {fmtMoney(b.net_payout_minor, ccy)}
            </td>
          </tr>
          {partial && (
            <>
              <Row
                label={`Already paid (${fmtInt(dayPay?.days_paid ?? 0)} day${(dayPay?.days_paid ?? 0) === 1 ? '' : 's'})`}
                op="−"
                minor={-paidMinor}
                currency={ccy}
              />
              <tr className="total">
                <td className="row-label">
                  <span className="op">=</span>REMAINING PAYOUT
                </td>
                <td className={remainingMinor < 0 ? 'money neg' : 'money'}>
                  {fmtMoney(remainingMinor, ccy)}
                </td>
              </tr>
            </>
          )}
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
