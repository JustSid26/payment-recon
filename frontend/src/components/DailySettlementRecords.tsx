import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { DailySettlementResp, DailySettlementRow, SettlementLineItem } from '../lib/types'
import { fmtDate, fmtDateTime, fmtInt, fmtMoney } from '../lib/money'
import { DataTable, EmptyState, LoadingBlock, Modal, StatusChip, type Column } from './ui'
import { downloadCSV, downloadExcel, printToPDF, printModal, toMajor } from '../lib/export'

const TYPE_LABEL: Record<string, string> = {
  payment_captured: 'Payment',
  refund: 'Refund',
  decline_fee: 'Decline',
}
const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/_/g, ' ')

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()

/** Signed money, red when negative, dimmed when zero. */
function Signed({ minor, ccy }: { minor: number; ccy: string }) {
  if (minor === 0) return <span className="dim">—</span>
  return <span className={minor < 0 ? 'money neg' : 'money'}>{fmtMoney(minor, ccy)}</span>
}

/** Clickable volume cell: count + approved/declined split with a mini ratio bar. */
function VolumeCell({ volume, approved, declined, onClick }: {
  volume: number; approved: number; declined: number; onClick: () => void
}) {
  if (volume <= 0) return <span className="dim">—</span>
  const apprPct = volume > 0 ? Math.round((approved / volume) * 100) : 0
  return (
    <button className="vol-cell" onClick={onClick} title="View this day's transactions">
      <span className="vol-num">{fmtInt(volume)}</span>
      <span className="vol-meta">
        <span className="vol-dot appr" /> {fmtInt(approved)}
        <span className="vol-sep">appr</span>
        <span className="vol-dot decl" /> {fmtInt(declined)}
        <span className="vol-sep">decl</span>
      </span>
      <span className="vol-bar" aria-hidden><span style={{ width: `${apprPct}%` }} /></span>
      <span className="vol-go">›</span>
    </button>
  )
}

export default function DailySettlementRecords({
  merchantUuid,
  merchantName = 'merchant',
}: {
  merchantUuid: string
  merchantName?: string
}) {
  const [ccy, setCcy] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [openDay, setOpenDay] = useState<string | null>(null)

  const { data, loading } = useApi(
    () =>
      api<DailySettlementResp>(`/api/merchants/${merchantUuid}/daily-settlement`, {
        params: { currency: ccy || undefined, date_from: dateFrom || undefined, date_to: dateTo || undefined },
      }),
    [merchantUuid, ccy, dateFrom, dateTo],
  )

  const currency = data?.currency ?? ccy ?? 'EUR'
  const currencies = data?.currencies ?? []
  const days = data?.days ?? []
  const totals = data?.totals

  const cols: Column<DailySettlementRow>[] = [
    {
      key: 'date',
      header: 'Processing date',
      render: (r) => <span className="nowrap num">{fmtDate(r.date)}</span>,
    },
    {
      key: 'volume',
      header: 'Volume',
      render: (r) => (
        <VolumeCell
          volume={r.volume}
          approved={r.approved_count}
          declined={r.declined_count}
          onClick={() => setOpenDay(r.date)}
        />
      ),
    },
    {
      key: 'fees',
      header: 'Net fees',
      align: 'right',
      render: (r) => <Signed minor={-Math.abs(r.fees_minor)} ccy={currency} />,
    },
    {
      key: 'net',
      header: 'Net payable',
      align: 'right',
      render: (r) => (
        <b>
          <Signed minor={r.net_payable_minor} ccy={currency} />
        </b>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      render: (r) =>
        r.settlement_uuid ? (
          <Link to={`/settlements/${r.settlement_uuid}`} onClick={(e) => e.stopPropagation()}>
            <StatusChip status={r.status} />
          </Link>
        ) : (
          <StatusChip status={r.status} />
        ),
    },
  ]

  // ---- exports (daily table) ----
  const base = `daily-settlement-${slug(merchantName)}-${currency}`
  const tableRows = (): (string | number)[][] => [
    ['Processing date', 'Approved', 'Declined', 'Volume', `Gross (${currency})`, `Net fees (${currency})`, `Net payable (${currency})`, 'Status'],
    ...days.map((d) => [
      d.date,
      d.approved_count,
      d.declined_count,
      d.volume,
      toMajor(d.gross_captured_minor, currency),
      -toMajor(Math.abs(d.fees_minor), currency),
      toMajor(d.net_payable_minor, currency),
      d.status,
    ]),
    ...(totals
      ? [[
          'TOTAL', totals.approved, totals.declined, totals.volume,
          toMajor(totals.gross_captured_minor, currency),
          -toMajor(Math.abs(totals.fees_minor), currency),
          toMajor(totals.net_payable_minor, currency),
          `paid ${toMajor(totals.paid_net_minor, currency)} · remaining ${toMajor(totals.remaining_net_minor, currency)}`,
        ]]
      : []),
  ]
  const exportCSV = () => downloadCSV(`${base}.csv`, tableRows())
  const exportExcel = () => downloadExcel(`${base}.xls`, 'Daily settlement', tableRows())

  return (
    <div className="stack" data-print="statement">
      {/* Summary bar */}
      {totals && (
        <div className="grid grid-cards">
          <div className="card stat-card">
            <div className="label"><span className="ccy-tag">{currency}</span> Total payable</div>
            <div className="value">{fmtMoney(totals.net_payable_minor, currency)}</div>
            <div className="dim small">{fmtInt(totals.volume)} txns · {fmtInt(totals.approved)} appr / {fmtInt(totals.declined)} decl</div>
          </div>
          <div className="card stat-card">
            <div className="label">Paid (settled)</div>
            <div className="value" style={{ color: 'var(--green)' }}>{fmtMoney(totals.paid_net_minor, currency)}</div>
          </div>
          <div className="card stat-card" style={{ outline: totals.remaining_net_minor > 0 ? '1px solid var(--amber, #b7791f)' : undefined }}>
            <div className="label">Remaining (unsettled)</div>
            <div className="value" style={{ color: totals.remaining_net_minor > 0 ? 'var(--amber, #b7791f)' : undefined }}>
              {fmtMoney(totals.remaining_net_minor, currency)}
            </div>
            <div className="dim small">still to be settled</div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }} data-print="hide">
          <span>Daily settlement records</span>
          {currencies.length > 1 && (
            <select className="select sm" value={currency} onChange={(e) => setCcy(e.target.value)}>
              {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="dim small">From</span>
            <input className="input sm" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <span className="dim small">to</span>
            <input className="input sm" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            {(dateFrom || dateTo) && (
              <button className="btn sm" onClick={() => { setDateFrom(''); setDateTo('') }}>Clear</button>
            )}
            <span className="export-label" style={{ marginLeft: 6 }}>Export</span>
            <button className="export-btn" onClick={exportCSV} disabled={!days.length}>CSV</button>
            <button className="export-btn" onClick={exportExcel} disabled={!days.length}>Excel</button>
            <button className="export-btn" onClick={printToPDF} disabled={!days.length}>PDF</button>
          </div>
        </div>
        <DataTable
          columns={cols}
          rows={days}
          rowKey={(d) => d.date}
          loading={loading}
          skeletonRows={6}
          empty={<EmptyState title="No activity" hint="Days with processed transactions appear here" />}
        />
      </div>

      {openDay && (
        <DayModal
          merchantUuid={merchantUuid}
          merchantName={merchantName}
          day={openDay}
          currency={currency}
          onClose={() => setOpenDay(null)}
        />
      )}
    </div>
  )
}

function DayModal({
  merchantUuid,
  merchantName,
  day,
  currency,
  onClose,
}: {
  merchantUuid: string
  merchantName: string
  day: string
  currency: string
  onClose: () => void
}) {
  const { data, loading } = useApi(
    () =>
      api<{ items: SettlementLineItem[] }>(
        `/api/merchants/${merchantUuid}/daily-settlement/${day}/transactions`,
        { params: { currency } },
      ),
    [merchantUuid, day, currency],
  )
  const items = data?.items ?? []

  const [q, setQ] = useState('')
  const [typeF, setTypeF] = useState<'all' | 'payment_captured' | 'decline_fee' | 'refund'>('all')

  const TYPE_TABS: { key: typeof typeF; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'payment_captured', label: 'Payments' },
    { key: 'decline_fee', label: 'Declines' },
    { key: 'refund', label: 'Refunds' },
  ]
  const typeCount = (k: typeof typeF) => (k === 'all' ? items.length : items.filter((it) => it.type === k).length)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter((it) => {
      if (typeF !== 'all' && it.type !== typeF) return false
      if (!needle) return true
      return (
        (it.reference || '').toLowerCase().includes(needle) ||
        (it.brand || '').toLowerCase().includes(needle) ||
        (it.last_four || '').includes(needle) ||
        (it.status || '').toLowerCase().includes(needle) ||
        typeLabel(it.type).toLowerCase().includes(needle) ||
        fmtDateTime(it.occurred_at).toLowerCase().includes(needle)
      )
    })
  }, [items, q, typeF])

  const rows = (): (string | number)[][] => [
    ['#', 'Time (UTC)', 'Type', 'Reference', 'Brand', 'Last 4', 'Status',
     'Gross', 'MDR', 'Approved fee', 'Declined fee', 'Refund fee', 'Chargeback fee', 'Reserve', 'Net'],
    ...filtered.map((it, i) => [
      i + 1, fmtDateTime(it.occurred_at), typeLabel(it.type), it.reference, it.brand, it.last_four, it.status,
      toMajor(it.gross_minor, currency), toMajor(it.mdr_minor, currency),
      toMajor(it.approved_fee_minor, currency), toMajor(it.declined_fee_minor, currency),
      toMajor(it.refund_fee_minor, currency), toMajor(it.chargeback_fee_minor, currency),
      toMajor(it.reserve_minor, currency), toMajor(it.net_minor, currency),
    ]),
  ]
  const base = `daily-txns-${slug(merchantName)}-${currency}-${day}`
  const sum = (k: keyof SettlementLineItem) =>
    filtered.reduce((a, it) => a + (typeof it[k] === 'number' ? (it[k] as number) : 0), 0)

  return (
    <Modal
      title={`Transactions — ${fmtDate(day)} · ${currency}`}
      onClose={onClose}
      size="wide"
      headerActions={
        <>
          <span className="export-label">Export</span>
          <button className="export-btn" onClick={() => downloadCSV(`${base}.csv`, rows())} disabled={!filtered.length}>CSV</button>
          <button className="export-btn" onClick={() => downloadExcel(`${base}.xls`, 'Transactions', rows())} disabled={!filtered.length}>Excel</button>
          <button className="export-btn" onClick={printModal} disabled={!filtered.length}>PDF</button>
        </>
      }
    >
      {loading ? (
        <LoadingBlock label="Loading transactions…" />
      ) : items.length === 0 ? (
        <EmptyState title="No transactions" hint="No processed transactions on this day" />
      ) : (
        <>
        {/* filter toolbar */}
        <div className="modal-toolbar" data-print="hide">
          <div className="seg">
            {TYPE_TABS.map((t) => (
              <button key={t.key} className={typeF === t.key ? 'on' : ''} onClick={() => setTypeF(t.key)}>
                {t.label}<span className="c">{fmtInt(typeCount(t.key))}</span>
              </button>
            ))}
          </div>
          <input
            className="input sm"
            style={{ maxWidth: 240, marginLeft: 'auto' }}
            placeholder="Search reference, brand, last 4…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="dim small" style={{ margin: '2px 0 4px' }}>
          Showing {fmtInt(filtered.length)} of {fmtInt(items.length)} transactions · fees per fee schedule
        </div>
        <div className="lines-wrap">
          <table className="lines-table">
            <thead>
              <tr>
                <th className="idx">#</th>
                <th className="l">Time</th>
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
              {filtered.map((it, i) => (
                <tr key={i}>
                  <td className="idx num">{i + 1}</td>
                  <td className="l">{fmtDateTime(it.occurred_at)}</td>
                  <td className="l">{typeLabel(it.type)}</td>
                  <td className="l ref">{it.reference || '—'}</td>
                  <td className="l">{it.brand || '—'}</td>
                  <td>{it.last_four ? `···· ${it.last_four}` : '—'}</td>
                  <M minor={it.gross_minor} ccy={currency} />
                  <M minor={it.mdr_minor} ccy={currency} />
                  <M minor={it.approved_fee_minor} ccy={currency} />
                  <M minor={it.declined_fee_minor} ccy={currency} />
                  <M minor={it.refund_fee_minor} ccy={currency} />
                  <M minor={it.chargeback_fee_minor} ccy={currency} />
                  <M minor={it.reserve_minor} ccy={currency} />
                  <M minor={it.net_minor} ccy={currency} strong />
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td className="l" colSpan={14} style={{ textAlign: 'center', padding: 20, color: 'var(--ink-3)' }}>No transactions match your filters</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className="l" colSpan={6}>{fmtInt(filtered.length)} transactions</td>
                <td>{fmtMoney(sum('gross_minor'), currency)}</td>
                <td>{fmtMoney(sum('mdr_minor'), currency)}</td>
                <td>{fmtMoney(sum('approved_fee_minor'), currency)}</td>
                <td>{fmtMoney(sum('declined_fee_minor'), currency)}</td>
                <td>{fmtMoney(sum('refund_fee_minor'), currency)}</td>
                <td>{fmtMoney(sum('chargeback_fee_minor'), currency)}</td>
                <td>{fmtMoney(sum('reserve_minor'), currency)}</td>
                <td>{fmtMoney(sum('net_minor'), currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        </>
      )}
    </Modal>
  )
}

function M({ minor, ccy, strong }: { minor: number; ccy: string; strong?: boolean }) {
  if (minor === 0) return <td className="zero">—</td>
  return <td className={strong ? 'strong' : minor < 0 ? 'money neg' : ''}>{fmtMoney(minor, ccy)}</td>
}
