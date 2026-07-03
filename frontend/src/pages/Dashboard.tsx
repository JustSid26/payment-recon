import { Link, useNavigate } from 'react-router-dom'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { Dashboard as DashboardData, LedgerAccount, Settlement } from '../lib/types'
import { fmtDate, fmtInt, fmtMoney } from '../lib/money'
import VolumeChart from '../components/VolumeChart'
import { DataTable, EmptyState, MoneyCell, SkeletonCard, StatusChip, type Column } from '../components/ui'

export default function Dashboard() {
  const user = getUser()!
  const isMerchant = user.role === 'merchant'
  const navigate = useNavigate()

  const { data, loading } = useApi(() => api<DashboardData>('/api/dashboard'), [])
  const accounts = useApi(
    () => (isMerchant ? api<{ items: LedgerAccount[] }>('/api/ledger/accounts') : Promise.resolve(null)),
    [isMerchant],
  )
  const settlements = useApi(
    () => (isMerchant ? api<{ items: Settlement[] }>('/api/settlements') : Promise.resolve(null)),
    [isMerchant],
  )

  const topMerchantCols: Column<DashboardData['top_merchants'][number]>[] = [
    { key: 'name', header: 'Merchant', render: (m) => <b>{m.name}</b> },
    { key: 'ccy', header: 'Currency', render: (m) => <span className="ccy-tag">{m.currency}</span> },
    { key: 'txn', header: 'Txns', align: 'right', render: (m) => <span className="num">{fmtInt(m.txn_count)}</span> },
    {
      key: 'captured',
      header: 'Captured',
      align: 'right',
      render: (m) => <MoneyCell minor={m.captured_minor} currency={m.currency} />,
    },
  ]

  const recentSettlementCols: Column<Settlement>[] = [
    { key: 'win', header: 'Window', render: (s) => <span className="nowrap small">{fmtDate(s.window_start)} → {fmtDate(s.window_end)}</span> },
    { key: 'ccy', header: 'Ccy', render: (s) => <span className="ccy-tag">{s.currency}</span> },
    { key: 'state', header: 'State', render: (s) => <StatusChip status={s.state} /> },
    {
      key: 'net',
      header: 'Net payout',
      align: 'right',
      render: (s) => <MoneyCell minor={s.net_payout_minor} currency={s.currency} />,
    },
  ]

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">
            {isMerchant ? user.merchant_name ?? 'Merchant overview' : 'Platform-wide settlement & ledger overview'}
          </div>
        </div>
      </div>

      {/* Integrity banner */}
      {data && (
        <div className={`banner ${data.integrity.ok ? 'green' : 'red'}`}>
          <span className="shield">{data.integrity.ok ? '🛡' : '⚠'}</span>
          <span>
            {data.integrity.ok ? 'Ledger integrity verified' : 'Ledger integrity check FAILED'}{' '}
            <span className="detail internal-only">
              — {fmtInt(data.integrity.events)} events · {fmtInt(data.integrity.entries)} entries ·{' '}
              {fmtInt(data.integrity.unbalanced_events)} unbalanced · {fmtInt(data.integrity.balance_mismatches)}{' '}
              balance mismatches
            </span>
          </span>
          {!isMerchant && (
            <Link to="/integrity" style={{ marginLeft: 'auto', fontWeight: 600, fontSize: 12.5 }}>
              View checks →
            </Link>
          )}
        </div>
      )}

      {/* Empty state — no data imported yet */}
      {data && data.volume.length === 0 && data.merchant_count === 0 && (
        <div className="card">
          <EmptyState
            title="No data yet"
            hint={isMerchant ? 'Data will appear once the platform is loaded.' : 'Go to Upload & Verify to import processor files.'}
            icon="⇪"
          />
          {!isMerchant && (
            <div style={{ textAlign: 'center', paddingBottom: 22 }}>
              <button className="btn primary" onClick={() => navigate('/upload')}>Go to Upload &amp; Verify →</button>
            </div>
          )}
        </div>
      )}

      {/* Per-currency volume stat cards */}
      <div className="grid grid-cards">
        {loading && [1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        {data?.volume.map((v) => (
          <div className="card stat-card" key={v.currency}>
            <div className="label">
              <span className="ccy-tag">{v.currency}</span> Captured volume
            </div>
            <div className="value">{fmtMoney(v.captured_minor, v.currency)}</div>
            <div className="meta">
              <span>
                Fees {isMerchant ? 'charged' : 'earned'} <b>{fmtMoney(v.fees_minor, v.currency)}</b>
              </span>
              <span>
                Net payable <b>{fmtMoney(v.net_payable_minor, v.currency)}</b>
              </span>
            </div>
            <div className="meta">
              <span>
                Paid <b style={{ color: 'var(--green)' }}>{fmtInt(v.paid_count)}</b>
              </span>
              <span>
                Declined <b style={{ color: 'var(--red)' }}>{fmtInt(v.declined_count)}</b>
              </span>
              <span>
                Refunded <b>{fmtMoney(v.refunded_minor, v.currency)}</b>
              </span>
            </div>
          </div>
        ))}
        {data && data.volume.length === 0 && (
          <div className="card">
            <EmptyState title="No volume yet" />
          </div>
        )}
      </div>

      {/* Merchant: available balances */}
      {isMerchant && accounts.data && (
        <div className="grid grid-cards">
          {accounts.data.items
            .filter((a) => a.account_type === 'merchant_payable' || a.account_type === 'merchant_reserve')
            .map((a) => (
              <div className="card stat-card" key={String(a.account_id)}>
                <div className="label">
                  <span className="ccy-tag">{a.currency}</span>
                  {a.account_type === 'merchant_payable' ? 'Available (payable)' : 'Rolling reserve'}
                </div>
                <div className="value">
                  <MoneyCell minor={a.balance_minor} currency={a.currency} />
                </div>
                <div className="meta">
                  <Link to={`/ledger/accounts/${a.account_id}`} className="small">
                    View statement →
                  </Link>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Admin: platform summary strip */}
      {!isMerchant && data && (
        <div className="grid grid-cards">
          <div className="card stat-card">
            <div className="label">Merchants</div>
            <div className="value num">{fmtInt(data.merchant_count)}</div>
          </div>
          <div className="card stat-card">
            <div className="label">Settlements</div>
            <div className="value num">{fmtInt(data.settlements.generated + data.settlements.completed)}</div>
            <div className="meta">
              <span>
                Generated <b>{fmtInt(data.settlements.generated)}</b>
              </span>
              <span>
                Completed <b>{fmtInt(data.settlements.completed)}</b>
              </span>
            </div>
          </div>
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
        </div>
      )}

      {/* Daily volume chart */}
      <div className="card">
        <div className="card-title">Daily captured volume</div>
        {loading ? (
          <div className="chart-box">
            <div className="skeleton" style={{ height: '100%' }} />
          </div>
        ) : (
          <VolumeChart rows={data?.daily_volume ?? []} />
        )}
      </div>

      {/* Admin: top merchants / Merchant: recent settlements */}
      {!isMerchant ? (
        <div className="card">
          <div className="card-title">
            Top merchants by captured volume
            <Link to="/merchants" className="small">
              All merchants →
            </Link>
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
            <Link to="/settlements" className="small">
              All settlements →
            </Link>
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
