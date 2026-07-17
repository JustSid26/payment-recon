import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type {
  LedgerMerchantDetail,
  MerchantLedgerStatementRow,
  Paginated,
} from '../lib/types'
import { fmtDate, fmtInt, fmtMoney } from '../lib/money'
import { DataTable, EmptyState, MoneyCell, Pager, toastError, toastSuccess, type Column } from '../components/ui'
import { downloadCSV, downloadExcel, printToPDF, toMajor } from '../lib/export'

const PAGE_SIZE = 50
const EXPORT_LIMIT = 5000

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  AUD: 'A$',
  CAD: 'C$',
}

type LedgerView = 'daily' | 'whole'
type LedgerDisplayRow = MerchantLedgerStatementRow & { period_label?: string; confirmation_label?: string }

function CurrencyCell({ currency }: { currency: string }) {
  return (
    <div className="currency-cell">
      <span className="currency-logo">{CURRENCY_SYMBOL[currency] ?? currency.slice(0, 1)}</span>
      <b>{currency}</b>
    </div>
  )
}

function BalanceCell({ row }: { row: MerchantLedgerStatementRow }) {
  return (
    <div className="balance-cell">
      <b><MoneyCell minor={row.balance_minor} currency={row.currency} /></b>
    </div>
  )
}

function rowPeriod(row: LedgerDisplayRow): string {
  return row.period_label ?? fmtDate(row.processed_date)
}

function rangeLabel(items: MerchantLedgerStatementRow[], dateFrom: string, dateTo: string): string {
  const dates = items.map((r) => r.processed_date).sort()
  const start = dateFrom || dates[0]
  const end = dateTo || dates[dates.length - 1]
  if (!start && !end) return 'All dates'
  if (start && !end) return `${fmtDate(start)} onward`
  if (!start && end) return `Until ${fmtDate(end)}`
  if (start === end) return fmtDate(start)
  return `${fmtDate(start)} → ${fmtDate(end)}`
}

function aggregateRows(items: MerchantLedgerStatementRow[], dateFrom: string, dateTo: string): LedgerDisplayRow[] {
  const byCurrency = new Map<string, MerchantLedgerStatementRow[]>()
  items.forEach((row) => {
    byCurrency.set(row.currency, [...(byCurrency.get(row.currency) ?? []), row])
  })
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, currencyRows]) => {
      const sortedDesc = [...currencyRows].sort((a, b) => b.processed_date.localeCompare(a.processed_date))
      const latest = sortedDesc[0]
      return {
        row_id: `whole:${currency}`,
        processed_date: latest?.processed_date ?? '',
        period_label: rangeLabel(currencyRows, dateFrom, dateTo),
        currency,
        processed_minor: currencyRows.reduce((sum, row) => sum + row.processed_minor, 0),
        payable_minor: currencyRows.reduce((sum, row) => sum + row.payable_minor, 0),
        reserve_minor: currencyRows.reduce((sum, row) => sum + row.reserve_minor, 0),
        paid_minor: currencyRows.reduce((sum, row) => sum + row.paid_minor, 0),
        balance_minor: latest?.balance_minor ?? 0,
        event_count: currencyRows.reduce((sum, row) => sum + row.event_count, 0),
        confirmation: latest?.confirmation ?? '',
        confirmation_label: `${fmtInt(currencyRows.length)} day${currencyRows.length === 1 ? '' : 's'} · ${fmtInt(currencyRows.reduce((sum, row) => sum + row.event_count, 0))} events`,
        confirmed: currencyRows.some((row) => row.confirmed),
      }
    })
}

function moneyTone(minor: number): 'positive' | 'negative' | 'neutral' {
  if (minor > 0) return 'positive'
  if (minor < 0) return 'negative'
  return 'neutral'
}

function movementLabel(row: LedgerDisplayRow): string {
  if (row.row_id.startsWith('whole:')) return 'Whole ledger'
  if (row.processed_minor > 0) return 'Processed day'
  if (row.paid_minor > 0) return 'Paid out'
  if (row.payable_minor < 0 && row.processed_minor === 0) return 'Settlement allocated'
  if (row.reserve_minor !== 0) return 'Reserve movement'
  if (row.payable_minor !== 0) return 'Payable movement'
  return 'Ledger movement'
}

function movementHint(row: LedgerDisplayRow): string {
  if (row.row_id.startsWith('whole:')) return row.confirmation_label ?? `${fmtInt(row.event_count)} events`
  if (row.processed_minor > 0) return `${fmtInt(row.event_count)} transaction event${row.event_count === 1 ? '' : 's'}`
  if (row.paid_minor > 0) return 'Settlement payout posted'
  if (row.payable_minor < 0 && row.processed_minor === 0) return 'Payable moved into settlement'
  if (row.reserve_minor !== 0) return 'Reserve held or released'
  return `${fmtInt(row.event_count)} ledger event${row.event_count === 1 ? '' : 's'}`
}

export default function LedgerMerchant() {
  const { uuid } = useParams<{ uuid: string }>()
  const isAdmin = getUser()?.role === 'admin'
  const [params, setParams] = useSearchParams()
  const dateFrom = params.get('date_from') ?? ''
  const dateTo = params.get('date_to') ?? ''
  const query = params.get('q') ?? ''
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)
  const [view, setView] = useState<LedgerView>('daily')

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key !== 'page') next.delete('page')
    setParams(next, { replace: true })
  }

  const { data: m, loading, reload } = useApi(
    () => api<LedgerMerchantDetail>(`/api/ledger/merchants/${uuid}`),
    [uuid],
  )
  const statement = useApi(
    () =>
      api<Paginated<MerchantLedgerStatementRow>>(`/api/ledger/merchants/${uuid}/statement`, {
        params: { q: query, date_from: dateFrom, date_to: dateTo, page, page_size: PAGE_SIZE },
      }),
    [uuid, query, dateFrom, dateTo, page],
  )
  const fullStatement = useApi(
    () =>
      api<Paginated<MerchantLedgerStatementRow>>(`/api/ledger/merchants/${uuid}/statement`, {
        params: { q: query, date_from: dateFrom, date_to: dateTo, page: 1, page_size: EXPORT_LIMIT },
      }),
    [uuid, query, dateFrom, dateTo],
  )

  const dailyRows: LedgerDisplayRow[] = statement.data?.items ?? []
  const wholeRows = useMemo(
    () => aggregateRows(fullStatement.data?.items ?? [], dateFrom, dateTo),
    [fullStatement.data, dateFrom, dateTo],
  )
  const rows = view === 'whole' ? wholeRows : dailyRows
  const [selectedId, setSelectedId] = useState('')
  const selected = rows.find((r) => r.row_id === selectedId) ?? rows[0] ?? null

  // debounced search box → URL param `q`
  const [search, setSearch] = useState(query)
  useEffect(() => setSearch(query), [query])
  useEffect(() => {
    if (search === query) return
    const t = setTimeout(() => setParam('q', search), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // rename
  const [editing, setEditing] = useState(false)
  const [nameVal, setNameVal] = useState('')
  const [saving, setSaving] = useState(false)
  const startEdit = () => {
    setNameVal(m?.name ?? '')
    setEditing(true)
  }
  const saveName = async () => {
    const name = nameVal.trim()
    if (!name) return
    setSaving(true)
    try {
      await api(`/api/merchants/${uuid}`, { method: 'PATCH', body: { name } })
      toastSuccess('Merchant renamed')
      setEditing(false)
      reload()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Rename failed')
    } finally {
      setSaving(false)
    }
  }

  const exportRows = (items: MerchantLedgerStatementRow[]): (string | number)[][] => [
    [
      view === 'whole' ? 'Period' : 'Date processed',
      'Currency',
      'Processed amount',
      'Payable',
      'Rolling reserve',
      'Paid',
      'Balance',
      'Movement',
      'Events',
    ],
    ...items.map((r: LedgerDisplayRow) => [
        rowPeriod(r),
        r.currency,
        toMajor(r.processed_minor, r.currency),
        toMajor(r.payable_minor, r.currency),
        toMajor(r.reserve_minor, r.currency),
        toMajor(r.paid_minor, r.currency),
        toMajor(r.balance_minor, r.currency),
        movementLabel(r),
        r.event_count,
      ]),
  ]

  const loadExportRows = async () => {
    const res = await api<Paginated<MerchantLedgerStatementRow>>(`/api/ledger/merchants/${uuid}/statement`, {
      params: { q: query, date_from: dateFrom, date_to: dateTo, page: 1, page_size: EXPORT_LIMIT },
    })
    return view === 'whole' ? aggregateRows(res.items, dateFrom, dateTo) : res.items
  }
  const exportCSV = async () => downloadCSV(`ledger-${m?.member_id ?? uuid}.csv`, exportRows(await loadExportRows()))
  const exportExcel = async () => downloadExcel(`ledger-${m?.member_id ?? uuid}.xls`, 'Merchant ledger', exportRows(await loadExportRows()))

  const cols: Column<LedgerDisplayRow>[] = [
    { key: 'date', header: view === 'whole' ? 'Period' : 'Date', render: (r) => <span className="nowrap small num">{rowPeriod(r)}</span> },
    { key: 'processed', header: 'Processed amt', align: 'right', render: (r) => <MoneyCell minor={r.processed_minor} currency={r.currency} dimZero /> },
    { key: 'payable', header: 'Payable', align: 'right', render: (r) => <MoneyCell minor={r.payable_minor} currency={r.currency} dimZero /> },
    { key: 'rr', header: 'RR', align: 'right', render: (r) => <MoneyCell minor={r.reserve_minor} currency={r.currency} dimZero /> },
    { key: 'paid', header: 'Paid', align: 'right', render: (r) => <MoneyCell minor={r.paid_minor} currency={r.currency} dimZero /> },
    { key: 'currency', header: 'Currency', render: (r) => <CurrencyCell currency={r.currency} /> },
    { key: 'balance', header: 'Balance', align: 'right', render: (r) => <BalanceCell row={r} /> },
    {
      key: 'movement',
      header: 'Movement',
      render: (r) => (
        <div className="movement-cell">
          <b>{movementLabel(r)}</b>
          <small>{movementHint(r)}</small>
        </div>
      ),
    },
  ]

  return (
    <div className="stack">
      <div data-print="hide">
        <Link to="/ledger" className="back-link">← Ledger</Link>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div style={{ minWidth: 0 }}>
            {editing ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="input"
                  style={{ maxWidth: 320, fontSize: 20, fontWeight: 650 }}
                  value={nameVal}
                  autoFocus
                  onChange={(e) => setNameVal(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void saveName()}
                />
                <button className="btn primary sm" onClick={() => void saveName()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button className="btn sm" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
              </div>
            ) : (
              <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {m?.name ?? 'Merchant'}
                {isAdmin && m && (
                  <button className="btn sm" title="Rename merchant" onClick={startEdit}>Rename</button>
                )}
              </h1>
            )}
            <div className="sub">
              {m && (
                <>
                  <span className="mono">ID {m.member_id}</span> · {m.status}
                  {' · '}
                  <span className={`ledger-pill ${m.balanced ? 'ok' : 'bad'}`} style={{ display: 'inline-flex' }}>
                    {m.balanced ? '✓ Balanced' : '⚠ Off'}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {selected && (
        <div className="card ledger-dashboard">
          <div className="ledger-dashboard-head">
            <div>
              <div className="ledger-eyebrow">Dashboard</div>
              <h2>{view === 'whole' ? 'Whole ledger summary' : 'Day-wise ledger summary'}</h2>
              <p>{view === 'whole' ? rowPeriod(selected) : `Processed ${rowPeriod(selected)}`}</p>
            </div>
            <div className="ledger-dashboard-badges">
              <CurrencyCell currency={selected.currency} />
            </div>
          </div>
          <div className="ledger-metric-grid">
            <LedgerMetric label="Processed amount" value={fmtMoney(selected.processed_minor, selected.currency)} tone={moneyTone(selected.processed_minor)} />
            <LedgerMetric label="Payable movement" value={fmtMoney(selected.payable_minor, selected.currency)} tone={moneyTone(selected.payable_minor)} />
            <LedgerMetric label="Rolling reserve" value={fmtMoney(selected.reserve_minor, selected.currency)} tone={moneyTone(selected.reserve_minor)} />
            <LedgerMetric label="Paid" value={fmtMoney(selected.paid_minor, selected.currency)} tone={selected.paid_minor > 0 ? 'positive' : 'neutral'} />
            <LedgerMetric label="Balance" value={fmtMoney(selected.balance_minor, selected.currency)} />
          </div>
        </div>
      )}

      <div className="card ledger-statement-card">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>Merchant ledger</span>
          <div className="seg" data-print="hide">
            <button className={view === 'daily' ? 'on' : ''} onClick={() => setView('daily')}>
              Day-wise
              <span className="c">{statement.data ? fmtInt(statement.data.total) : '·'}</span>
            </button>
            <button className={view === 'whole' ? 'on' : ''} onClick={() => setView('whole')}>
              Whole
              <span className="c">{fullStatement.data ? fmtInt(wholeRows.length) : '·'}</span>
            </button>
          </div>
          <input
            className="input sm"
            style={{ maxWidth: 220 }}
            placeholder="Search date, currency, confirmation…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-print="hide"
          />
          <div className="ledger-actions" data-print="hide">
            <span className="dim small">From</span>
            <input className="input sm" type="date" value={dateFrom} onChange={(e) => setParam('date_from', e.target.value)} />
            <span className="dim small">to</span>
            <input className="input sm" type="date" value={dateTo} onChange={(e) => setParam('date_to', e.target.value)} />
            {(dateFrom || dateTo || query) && (
              <button className="btn sm" onClick={() => { setParam('date_from', ''); setParam('date_to', ''); setSearch('') }}>Clear</button>
            )}
            <span className="export-label">Export</span>
            <button className="export-btn" onClick={() => void exportCSV()} disabled={!rows.length}>CSV</button>
            <button className="export-btn" onClick={() => void exportExcel()} disabled={!rows.length}>Excel</button>
            <button className="export-btn" onClick={printToPDF} disabled={!rows.length}>PDF</button>
          </div>
        </div>
        <div className="dim small ledger-note">
          {view === 'whole'
            ? fullStatement.data ? `${fmtInt(wholeRows.length)} whole ledger row${wholeRows.length === 1 ? '' : 's'} by currency` : ' '
            : statement.data ? `${fmtInt(statement.data.total)} daily ledger row${statement.data.total === 1 ? '' : 's'}` : ' '}
        </div>
        <DataTable
          columns={cols}
          rows={rows}
          rowKey={(r) => r.row_id}
          loading={loading || (view === 'whole' ? fullStatement.loading : statement.loading)}
          skeletonRows={10}
          onRowClick={(r) => setSelectedId(r.row_id)}
          empty={<EmptyState title="No ledger rows" hint={dateFrom || dateTo ? 'No rows in this date range' : 'Processed ledger activity will appear here'} />}
        />
        {view === 'daily' && statement.data && (
          <Pager page={page} pageSize={statement.data.page_size || PAGE_SIZE} total={statement.data.total} onPage={(pp) => setParam('page', String(pp))} />
        )}
      </div>
    </div>
  )
}

function LedgerMetric({
  label,
  value,
  meta,
  tone = 'neutral',
}: {
  label: string
  value: ReactNode
  meta?: ReactNode
  tone?: 'positive' | 'negative' | 'neutral'
}) {
  return (
    <div className={`ledger-metric ${tone}`}>
      <span>{label}</span>
      <div className="ledger-metric-value">{value}</div>
      {meta && <small>{meta}</small>}
    </div>
  )
}
