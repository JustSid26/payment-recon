import { Fragment, useMemo, useState } from 'react'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { Merchant, Settlement } from '../lib/types'
import { fmtDate, fmtInt, fmtMoney } from '../lib/money'
import { DataTable, EmptyState, MoneyCell, StatusChip, type Column } from '../components/ui'
import DailySettlementRecords from '../components/DailySettlementRecords'
import SettlementDetailPage from './SettlementDetail'

type MerchantGroup = {
  merchant_uuid: string
  merchant_name: string
  currencies: string[]
  nets: { currency: string; minor: number }[]
  openCount: number
  settlements: Settlement[]
}

export default function Settlements() {
  const user = getUser()!
  const isAdmin = user.role === 'admin'

  const [view, setView] = useState<'list' | 'daily'>('list')
  const [merchantUuid, setMerchantUuid] = useState('')       // daily view: which merchant
  const [openMerchant, setOpenMerchant] = useState<string | null>(null) // list drill-down
  const [q, setQ] = useState('')

  const merchants = useApi(
    () => (isAdmin ? api<{ items: Merchant[] }>('/api/merchants') : Promise.resolve(null)),
    [isAdmin],
  )

  const { data, loading } = useApi(() => api<{ items: Settlement[] }>('/api/settlements'), [])

  // Cancelled settlements are an internal artifact of the one-account model — hide them.
  const visibleItems = useMemo(
    () => (data?.items ?? []).filter((s) => s.state !== 'cancelled'),
    [data],
  )

  // Level 1 (admin): one row per merchant, aggregating its per-currency settlements.
  const groups = useMemo<MerchantGroup[]>(() => {
    const m = new Map<string, MerchantGroup>()
    for (const s of visibleItems) {
      let g = m.get(s.merchant_uuid)
      if (!g) {
        g = { merchant_uuid: s.merchant_uuid, merchant_name: s.merchant_name,
              currencies: [], nets: [], openCount: 0, settlements: [] }
        m.set(s.merchant_uuid, g)
      }
      g.settlements.push(s)
      if (!g.currencies.includes(s.currency)) g.currencies.push(s.currency)
      g.nets.push({ currency: s.currency, minor: s.net_payout_minor })
      if (s.state !== 'completed') g.openCount += 1
    }
    for (const g of m.values()) g.currencies.sort()
    return [...m.values()].sort((a, b) => a.merchant_name.localeCompare(b.merchant_name))
  }, [visibleItems])

  const filteredGroups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? groups.filter((g) => g.merchant_name.toLowerCase().includes(needle)) : groups
  }, [groups, q])

  const openGroup = openMerchant ? groups.find((g) => g.merchant_uuid === openMerchant) : null

  const merchantCols: Column<MerchantGroup>[] = [
    { key: 'name', header: 'Merchant', render: (g) => <b>{g.merchant_name}</b> },
    {
      key: 'ccy', header: 'Currencies',
      render: (g) => (
        <div className="ccy-chip-row">
          {g.currencies.map((c) => <span key={c} className="ccy-tag">{c}</span>)}
        </div>
      ),
    },
    { key: 'net', header: 'Net payout', align: 'right', render: (g) => <NetStack rows={g.nets} /> },
    {
      key: 'state', header: 'To settle', align: 'right',
      render: (g) =>
        g.openCount > 0
          ? <span className="pill-open">{g.openCount} open</span>
          : <StatusChip status="completed" />,
    },
  ]

  const subtitle =
    view === 'daily'
      ? 'Per-day payable, fees and settled-vs-remaining'
      : openGroup
        ? `${fmtInt(openGroup.currencies.length)} settlement${openGroup.currencies.length === 1 ? '' : 's'} — one per currency`
        : data
          ? `${fmtInt(isAdmin ? groups.length : visibleItems.length)} ${isAdmin ? 'merchant' + (groups.length === 1 ? '' : 's') : 'settlement' + (visibleItems.length === 1 ? '' : 's')}`
          : ' '

  const dailyUuid = isAdmin ? merchantUuid : user.merchant_uuid ?? ''
  const dailyName = isAdmin
    ? (merchants.data?.items ?? []).find((m) => m.merchant_uuid === merchantUuid)?.name ?? 'merchant'
    : user.merchant_name ?? 'merchant'

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Settlements</h1>
          <div className="sub">{subtitle}</div>
        </div>
        <div className="head-actions">
          <div className="seg">
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>Settlements</button>
            <button className={view === 'daily' ? 'on' : ''} onClick={() => setView('daily')}>Daily records</button>
          </div>
        </div>
      </div>

      {view === 'daily' ? (
        isAdmin && !merchantUuid ? (
          <div className="card">
            <div className="card-pad" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="dim">Pick a merchant to see daily records:</span>
              <select className="select" style={{ maxWidth: 240 }} value={merchantUuid} onChange={(e) => setMerchantUuid(e.target.value)}>
                <option value="">Select merchant…</option>
                {(merchants.data?.items ?? []).map((m) => (
                  <option key={m.merchant_uuid} value={m.merchant_uuid}>{m.name}</option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <DailySettlementRecords key={dailyUuid} merchantUuid={dailyUuid} merchantName={dailyName} />
        )
      ) : isAdmin ? (
        openGroup ? (
          <div className="stack">
            <div className="drill-head">
              <button className="btn sm" onClick={() => setOpenMerchant(null)}>← All merchants</button>
              <h2 className="drill-title">{openGroup.merchant_name}</h2>
            </div>
            <SettlementCurrencyView key={openGroup.merchant_uuid} settlements={openGroup.settlements} />
          </div>
        ) : (
          <div className="card">
            <div className="filter-bar">
              <input
                className="input"
                style={{ maxWidth: 280 }}
                placeholder="Search merchant…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <DataTable
              columns={merchantCols}
              rows={filteredGroups}
              rowKey={(g) => g.merchant_uuid}
              loading={loading}
              onRowClick={(g) => setOpenMerchant(g.merchant_uuid)}
              empty={<EmptyState title={q ? 'No matches' : 'No settlements yet'} hint={q ? 'Try a different search' : 'Upload transactions for a configured merchant'} />}
            />
          </div>
        )
      ) : (
        <SettlementCurrencyView settlements={visibleItems} loading={loading} merchantView />
      )}
    </div>
  )
}

/** One card per currency for a single merchant. Pick a currency → its settlement
 *  report renders below. Used by the admin drill-down and the merchant's own view. */
function SettlementCurrencyView({
  settlements,
  loading,
  merchantView,
}: {
  settlements: Settlement[]
  loading?: boolean
  merchantView?: boolean
}) {
  // one running settlement per currency (keep the latest if there's ever more).
  const byCcy = useMemo(() => {
    const m = new Map<string, Settlement>()
    for (const s of settlements) {
      const cur = m.get(s.currency)
      if (!cur || s.window_end > cur.window_end) m.set(s.currency, s)
    }
    return [...m.values()].sort((a, b) => a.currency.localeCompare(b.currency))
  }, [settlements])

  const [ccy, setCcy] = useState('')
  const selected = byCcy.find((s) => s.currency === ccy) ?? byCcy[0] ?? null

  if (loading) {
    return <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--ink-2)' }}>Loading settlements…</div>
  }
  if (byCcy.length === 0) {
    return <EmptyState title="No settlement to show" hint="Settlements appear here once transactions are uploaded" />
  }

  return (
    <div className="stack">
      <div className="ccy-card-row" data-tour={merchantView ? 'm-settle-filters' : undefined}>
        {byCcy.map((s) => (
          <button
            key={s.settlement_uuid}
            type="button"
            className={`ccy-settle-card${selected?.currency === s.currency ? ' on' : ''}`}
            onClick={() => setCcy(s.currency)}
          >
            <div className="ccy-settle-top">
              <span className="ccy-tag">{s.currency}</span>
              <StatusChip status={s.state} />
            </div>
            <div className="ccy-settle-net"><MoneyCell minor={s.net_payout_minor} currency={s.currency} /></div>
            <div className="dim small nowrap">{fmtDate(s.window_start)} → {fmtDate(s.window_end)}</div>
          </button>
        ))}
      </div>

      {selected && (
        <div data-tour={merchantView ? 'm-settle-report' : undefined}>
          <SettlementDetailPage key={selected.settlement_uuid} uuid={selected.settlement_uuid} embedded />
        </div>
      )}
    </div>
  )
}

function NetStack({ rows }: { rows: { currency: string; minor: number }[] }) {
  if (rows.length === 0) return <span className="dim">—</span>
  const sorted = [...rows].sort((a, b) => a.currency.localeCompare(b.currency))
  return (
    <div className="ccy-stack">
      {sorted.map((r) => (
        <Fragment key={r.currency}>
          <span className="ccy-tag">{r.currency}</span>
          <span className={`money${r.minor < 0 ? ' neg' : ''}`}>{fmtMoney(r.minor, r.currency)}</span>
        </Fragment>
      ))}
    </div>
  )
}
