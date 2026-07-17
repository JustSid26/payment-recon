import { Fragment, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { CcyAmount, Merchant, MerchantDetail, ReserveStatement } from '../lib/types'
import { fmtInt, fmtMoney } from '../lib/money'
import { DataTable, EmptyState, LoadingBlock, MoneyCell, StatusChip, type Column } from '../components/ui'

function CcyStack({ rows }: { rows: CcyAmount[] }) {
  const visible = [...rows].filter((r) => r.minor !== 0).sort((a, b) => a.currency.localeCompare(b.currency))
  if (visible.length === 0) return <span className="dim">-</span>
  return (
    <div className="ccy-stack">
      {visible.map((r) => (
        <Fragment key={r.currency}>
          <span className="ccy-tag">{r.currency}</span>
          <span className={`money${r.minor < 0 ? ' neg' : ''}`}>{fmtMoney(r.minor, r.currency)}</span>
        </Fragment>
      ))}
    </div>
  )
}

function sumMinor(rows: ReserveStatement['items'], key: 'held_minor' | 'released_minor'): number {
  return rows.reduce((acc, row) => acc + row[key], 0)
}

export default function RollingReserve() {
  const { uuid } = useParams<{ uuid?: string }>()
  return uuid ? <RollingReserveDetail uuid={uuid} /> : <RollingReserveList />
}

function RollingReserveList() {
  const navigate = useNavigate()
  const { data, loading } = useApi(() => api<{ items: Merchant[] }>('/api/merchants'), [])
  const [q, setQ] = useState('')
  const [onlyWithReserve, setOnlyWithReserve] = useState(false)

  const items = useMemo(() => data?.items ?? [], [data])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter((m) => {
      if (onlyWithReserve && !m.balances.some((b) => b.reserve_minor !== 0)) return false
      if (!needle) return true
      return m.name.toLowerCase().includes(needle) || (m.member_id ?? '').toLowerCase().includes(needle)
    })
  }, [items, onlyWithReserve, q])

  const merchantsWithReserve = items.filter((m) => m.balances.some((b) => b.reserve_minor !== 0)).length
  const totalReserve = useMemo(() => {
    const totals = new Map<string, number>()
    for (const m of items) {
      for (const b of m.balances) {
        totals.set(b.currency, (totals.get(b.currency) ?? 0) + b.reserve_minor)
      }
    }
    return Array.from(totals.entries()).map(([currency, minor]) => ({ currency, minor }))
  }, [items])

  const cols: Column<Merchant>[] = [
    { key: 'idx', header: '#', render: (_m, i) => <span className="num dim">{i + 1}</span> },
    {
      key: 'merchant',
      header: 'Merchant',
      render: (m) => (
        <div>
          <b>{m.name}</b>
          <div className="small dim mono internal-only">ID {m.member_id}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (m) => <StatusChip status={m.status} /> },
    { key: 'txns', header: 'Txns', align: 'right', render: (m) => <span className="num">{fmtInt(m.txn_count)}</span> },
    {
      key: 'captured',
      header: 'Captured',
      align: 'right',
      render: (m) => <CcyStack rows={m.captured_minor_total.map((c) => ({ currency: c.currency, minor: c.amount_minor }))} />,
    },
    {
      key: 'reserve',
      header: 'Current reserve',
      align: 'right',
      render: (m) => <CcyStack rows={m.balances.map((b) => ({ currency: b.currency, minor: b.reserve_minor }))} />,
    },
  ]

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Rolling reserve</h1>
          <div className="sub">
            {data
              ? `${fmtInt(rows.length)} merchant${rows.length === 1 ? '' : 's'} · ${fmtInt(merchantsWithReserve)} with reserve held`
              : ' '}
          </div>
        </div>
      </div>

      <div className="grid grid-cards">
        <div className="card stat-card">
          <div className="label">Current reserve held</div>
          <div className="value" style={{ fontSize: 18 }}><CcyStack rows={totalReserve} /></div>
        </div>
        <div className="card stat-card">
          <div className="label">Merchants with reserve</div>
          <div className="value">{fmtInt(merchantsWithReserve)}</div>
        </div>
      </div>

      <div className="toolbar">
        <input className="input" placeholder="Search name or ID..." value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="switch" title="Show only merchants with a current reserve balance">
          <input type="checkbox" checked={onlyWithReserve} onChange={(e) => setOnlyWithReserve(e.target.checked)} />
          <span className="track"><span className="thumb" /></span>
          <span className="switch-label">With reserve only</span>
        </label>
      </div>

      <div className="card">
        <DataTable
          columns={cols}
          rows={rows}
          rowKey={(m) => m.merchant_uuid}
          loading={loading}
          onRowClick={(m) => navigate(`/rolling-reserve/${m.merchant_uuid}`)}
          empty={<EmptyState title={q || onlyWithReserve ? 'No matches' : 'No merchants'} hint="Reserve appears after posted reserve-hold ledger events" />}
        />
      </div>
    </div>
  )
}

function RollingReserveDetail({ uuid }: { uuid: string }) {
  const merchant = useApi(() => api<MerchantDetail>(`/api/merchants/${uuid}`), [uuid])
  const currencies = useMemo(() => merchant.data?.balances.map((b) => b.currency) ?? [], [merchant.data])
  const reserveCurrencies = useMemo(
    () => merchant.data?.balances.filter((b) => b.reserve_minor !== 0).map((b) => b.currency) ?? [],
    [merchant.data],
  )
  const [selCcy, setSelCcy] = useState<string | null>(null)
  const activeCcy = selCcy ?? reserveCurrencies[0] ?? currencies[0] ?? null

  const reserve = useApi(
    () =>
      activeCcy
        ? api<ReserveStatement>(`/api/merchants/${uuid}/reserve-statement`, { params: { currency: activeCcy } })
        : Promise.resolve(null),
    [uuid, activeCcy],
  )

  if (merchant.loading || !merchant.data) {
    return (
      <div>
        <Link to="/rolling-reserve" className="back-link">← Rolling reserve</Link>
        <LoadingBlock label="Loading reserve..." />
      </div>
    )
  }

  const ccy = reserve.data?.currency ?? activeCcy ?? 'USD'
  const items = reserve.data?.items ?? []
  const totalHeld = sumMinor(items, 'held_minor')
  const totalReleased = sumMinor(items, 'released_minor')

  return (
    <div className="stack">
      <div>
        <Link to="/rolling-reserve" className="back-link">← Rolling reserve</Link>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div style={{ minWidth: 0 }}>
            <h1>{merchant.data.name}</h1>
            <div className="sub">
              <span className="internal-only">Member ID <span className="mono">{merchant.data.member_id}</span> · </span>
              <StatusChip status={merchant.data.status} /> · {fmtInt(merchant.data.txn_count)} transactions
            </div>
          </div>
          <div className="head-actions">
            <select
              className="select"
              value={activeCcy ?? ''}
              onChange={(e) => setSelCcy(e.target.value)}
              disabled={currencies.length === 0}
            >
              {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="grid grid-cards">
        <div className="card stat-card">
          <div className="label"><span className="ccy-tag">{ccy}</span> Current reserve held</div>
          <div className="value">{fmtMoney(reserve.data?.current_reserve_minor ?? 0, ccy)}</div>
        </div>
        <div className="card stat-card">
          <div className="label"><span className="ccy-tag">{ccy}</span> Total collected</div>
          <div className="value">{fmtMoney(totalHeld, ccy)}</div>
        </div>
        <div className="card stat-card">
          <div className="label"><span className="ccy-tag">{ccy}</span> Total released</div>
          <div className="value">{fmtMoney(totalReleased, ccy)}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Daily reserve records</div>
        <DataTable
          columns={[
            { key: 'date', header: 'Date', render: (r) => <span className="nowrap num">{r.date}</span> },
            { key: 'opening', header: 'Opening', align: 'right', render: (r) => <MoneyCell minor={r.opening_minor} currency={ccy} /> },
            { key: 'held', header: 'Collected', align: 'right', render: (r) => <MoneyCell minor={r.held_minor} currency={ccy} dimZero /> },
            { key: 'released', header: 'Released', align: 'right', render: (r) => <MoneyCell minor={r.released_minor} currency={ccy} dimZero /> },
            { key: 'closing', header: 'Closing', align: 'right', render: (r) => <b><MoneyCell minor={r.closing_minor} currency={ccy} /></b> },
          ]}
          rows={items}
          rowKey={(r) => r.date}
          loading={reserve.loading}
          empty={<EmptyState title="No reserve activity" hint="Reserve holds appear here once transactions are posted with a rolling reserve schedule" />}
        />
      </div>
    </div>
  )
}
