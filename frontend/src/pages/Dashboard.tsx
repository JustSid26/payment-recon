import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { Dashboard as DashboardData, LedgerAccount, Settlement, VolumeRow } from '../lib/types'
import { fmtDate, fmtInt, fmtMoney } from '../lib/money'
import VolumeChart from '../components/VolumeChart'
import { DataTable, EmptyState, MoneyCell, SkeletonCard, StatusChip, type Column } from '../components/ui'

export default function Dashboard() {
  const user = getUser()!
  const isMerchant = user.role === 'merchant'
  const navigate = useNavigate()

  const { data, loading } = useApi(() => api<DashboardData>('/api/dashboard'), [])

  // remembered "By currency" view preference (cards by default — easier to read)
  const [ccyView, setCcyView] = useState<'cards' | 'list'>(
    () => (localStorage.getItem('tw_ccy_view') === 'list' ? 'list' : 'cards'),
  )
  const chooseView = (v: 'cards' | 'list') => {
    setCcyView(v)
    localStorage.setItem('tw_ccy_view', v)
  }
  const accounts = useApi(
    () => (isMerchant ? api<{ items: LedgerAccount[] }>('/api/ledger/accounts') : Promise.resolve(null)),
    [isMerchant],
  )
  const settlements = useApi(
    () => (isMerchant ? api<{ items: Settlement[] }>('/api/settlements') : Promise.resolve(null)),
    [isMerchant],
  )

  const totals = useMemo(() => {
    const v = data?.volume ?? []
    return {
      paid: v.reduce((s, r) => s + r.paid_count, 0),
      declined: v.reduce((s, r) => s + r.declined_count, 0),
    }
  }, [data])

  // ---- the recon table: money per currency ----
  const currencyCols: Column<VolumeRow>[] = [
    { key: 'ccy', header: 'Currency', render: (v) => <span className="ccy-tag">{v.currency}</span> },
    { key: 'cap', header: 'Captured', align: 'right', render: (v) => <MoneyCell minor={v.captured_minor} currency={v.currency} /> },
    { key: 'fees', header: isMerchant ? 'Fees' : 'Fees earned', align: 'right', render: (v) => <MoneyCell minor={v.fees_minor} currency={v.currency} dimZero /> },
    { key: 'ref', header: 'Refunds', align: 'right', render: (v) => <MoneyCell minor={v.refunded_minor} currency={v.currency} dimZero /> },
    { key: 'net', header: 'Net payable', align: 'right', render: (v) => <b><MoneyCell minor={v.net_payable_minor} currency={v.currency} /></b> },
    { key: 'paid', header: 'Paid', align: 'right', render: (v) => <span className="num" style={{ color: 'var(--green)' }}>{fmtInt(v.paid_count)}</span> },
    { key: 'dec', header: 'Declined', align: 'right', render: (v) => <span className="num dim">{fmtInt(v.declined_count)}</span> },
  ]

  const topMerchantCols: Column<DashboardData['top_merchants'][number]>[] = [
    { key: 'name', header: 'Merchant', render: (m) => <b>{m.name}</b> },
    { key: 'ccy', header: 'Currency', render: (m) => <span className="ccy-tag">{m.currency}</span> },
    { key: 'txn', header: 'Txns', align: 'right', render: (m) => <span className="num">{fmtInt(m.txn_count)}</span> },
    { key: 'captured', header: 'Captured', align: 'right', render: (m) => <MoneyCell minor={m.captured_minor} currency={m.currency} /> },
  ]

  const recentSettlementCols: Column<Settlement>[] = [
    { key: 'win', header: 'Window', render: (s) => <span className="nowrap small">{fmtDate(s.window_start)} → {fmtDate(s.window_end)}</span> },
    { key: 'ccy', header: 'Ccy', render: (s) => <span className="ccy-tag">{s.currency}</span> },
    { key: 'state', header: 'State', render: (s) => <StatusChip status={s.state} /> },
    { key: 'net', header: 'Net payout', align: 'right', render: (s) => <MoneyCell minor={s.net_payout_minor} currency={s.currency} /> },
  ]

  const needSetup = data?.quarantine?.unconfigured_merchants ?? 0
  const merchantBalances = (accounts.data?.items ?? []).filter(
    (a) => a.account_type === 'merchant_payable' || a.account_type === 'merchant_reserve',
  )

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 4, alignItems: 'center' }}>
        <h1>{isMerchant ? user.merchant_name ?? 'Overview' : 'Dashboard'}</h1>
        {data && (
          <span className={`ledger-pill ${data.integrity.ok ? 'ok' : 'bad'}`}>
            {data.integrity.ok ? '✓ Ledger balanced' : '⚠ Ledger check failed'}
            {!isMerchant && data.integrity.ok && (
              <Link to="/integrity" className="internal-only">Details</Link>
            )}
          </span>
        )}
      </div>

      {/* Needs-attention callout (admin) */}
      {!isMerchant && needSetup > 0 && (
        <Link to="/merchants" className="callout amber">
          <span><b>{fmtInt(needSetup)}</b> merchant{needSetup === 1 ? '' : 's'} need fees set
            {' '}· <b>{fmtInt(data?.quarantine?.quarantined_transactions ?? 0)}</b> transactions on hold</span>
          <span className="go">Set up →</span>
        </Link>
      )}

      {/* KPI tiles */}
      <div className="grid grid-cards">
        {loading && [1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}

        {!isMerchant && data && (
          <div className="card stat-card">
            <div className="label">Merchants</div>
            <div className="value num">{fmtInt(data.merchant_count)}</div>
            <div className="meta"><span>{fmtInt(data.merchant_count - needSetup)} active · {fmtInt(needSetup)} to set up</span></div>
          </div>
        )}

        {data && (
          <div className="card stat-card">
            <div className="label">Transactions</div>
            <div className="value num">{fmtInt(totals.paid + totals.declined)}</div>
            <div className="meta">
              <span>Paid <b style={{ color: 'var(--green)' }}>{fmtInt(totals.paid)}</b></span>
              <span>Declined <b>{fmtInt(totals.declined)}</b></span>
            </div>
          </div>
        )}

        {data && (
          <div className="card stat-card">
            <div className="label">Settlements</div>
            <div className="value num">{fmtInt(data.settlements.generated + data.settlements.completed)}</div>
            <div className="meta">
              <span>Paid out <b>{fmtInt(data.settlements.completed)}</b></span>
              <span>Pending <b>{fmtInt(data.settlements.generated)}</b></span>
            </div>
          </div>
        )}

        {!isMerchant && data && (
          <div className="card stat-card">
            <div className="label">Total paid out</div>
            <div className="value" style={{ fontSize: 18 }}>
              <div className="mini-rows">
                {data.settlements.total_paid_out.length === 0 && <span className="dim">—</span>}
                {data.settlements.total_paid_out.map((p) => (
                  <div className="mini-row" key={p.currency}>
                    <span className="ccy-tag">{p.currency}</span>
                    <MoneyCell minor={p.amount_minor} currency={p.currency} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* merchant: available + reserve balances */}
        {isMerchant && merchantBalances.map((a) => (
          <div className="card stat-card" key={String(a.account_id)}>
            <div className="label">
              <span className="ccy-tag">{a.currency}</span>
              {a.account_type === 'merchant_payable' ? 'Available' : 'Reserve held'}
            </div>
            <div className="value"><MoneyCell minor={a.balance_minor} currency={a.currency} /></div>
            <div className="meta"><Link to={`/ledger/accounts/${a.account_id}`} className="small">Statement →</Link></div>
          </div>
        ))}
      </div>

      {/* Money by currency — cards or list, user's choice */}
      <div>
        <div className="section-head">
          <span className="st">By currency</span>
          <div className="seg">
            <button className={ccyView === 'cards' ? 'on' : ''} onClick={() => chooseView('cards')}>Cards</button>
            <button className={ccyView === 'list' ? 'on' : ''} onClick={() => chooseView('list')}>List</button>
          </div>
        </div>
        {ccyView === 'list' ? (
          <div className="card">
            <DataTable
              columns={currencyCols}
              rows={data?.volume ?? []}
              rowKey={(v) => v.currency}
              loading={loading}
              empty={<EmptyState title="No volume yet" />}
            />
          </div>
        ) : (
          <div className="grid grid-cards">
            {loading && [1, 2, 3].map((i) => <SkeletonCard key={i} />)}
            {(data?.volume ?? []).map((v) => <CurrencyCard key={v.currency} v={v} />)}
            {data && data.volume.length === 0 && <div className="card"><EmptyState title="No volume yet" /></div>}
          </div>
        )}
      </div>

      {/* Daily volume chart */}
      <div className="card">
        <div className="card-title">Daily captured volume</div>
        {loading ? (
          <div className="chart-box"><div className="skeleton" style={{ height: '100%' }} /></div>
        ) : (
          <VolumeChart rows={data?.daily_volume ?? []} />
        )}
      </div>

      {/* Admin: top merchants / Merchant: recent settlements */}
      {!isMerchant ? (
        <div className="card">
          <div className="card-title">
            Top merchants
            <Link to="/merchants" className="small">All merchants →</Link>
          </div>
          <DataTable
            columns={topMerchantCols}
            rows={data?.top_merchants ?? []}
            rowKey={(m) => `${m.merchant_uuid}-${m.currency}`}
            loading={loading}
            onRowClick={(m) => navigate(`/merchants/${m.merchant_uuid}`)}
            empty={<EmptyState title="No merchants yet" />}
          />
        </div>
      ) : (
        <div className="card">
          <div className="card-title">
            Recent settlements
            <Link to="/settlements" className="small">All settlements →</Link>
          </div>
          <DataTable
            columns={recentSettlementCols}
            rows={(settlements.data?.items ?? []).slice(0, 6)}
            rowKey={(s) => s.settlement_uuid}
            loading={settlements.loading}
            onRowClick={(s) => navigate(`/settlements/${s.settlement_uuid}`)}
            empty={<EmptyState title="No settlements yet" />}
          />
        </div>
      )}
    </div>
  )
}

function CurrencyCard({ v }: { v: VolumeRow }) {
  return (
    <div className="card stat-card">
      <div className="label"><span className="ccy-tag">{v.currency}</span> Captured</div>
      <div className="value"><MoneyCell minor={v.captured_minor} currency={v.currency} /></div>
      <div className="meta">
        <span>Fees <b>{fmtMoney(v.fees_minor, v.currency)}</b></span>
        <span>Net payable <b>{fmtMoney(v.net_payable_minor, v.currency)}</b></span>
      </div>
      <div className="meta">
        <span>Paid <b style={{ color: 'var(--green)' }}>{fmtInt(v.paid_count)}</b></span>
        <span>Declined <b>{fmtInt(v.declined_count)}</b></span>
        <span>Refunds <b>{fmtMoney(v.refunded_minor, v.currency)}</b></span>
      </div>
    </div>
  )
}
