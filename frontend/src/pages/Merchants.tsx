import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { Merchant } from '../lib/types'
import { fmtInt, fmtMoney } from '../lib/money'
import { DataTable, EmptyState, StatusChip, type Column } from '../components/ui'

export default function Merchants() {
  const navigate = useNavigate()
  const { data, loading } = useApi(() => api<{ items: Merchant[] }>('/api/merchants'), [])

  const cols: Column<Merchant>[] = [
    {
      key: 'name',
      header: 'Merchant',
      render: (m) => (
        <div>
          <b>{m.name}</b>
          <div className="small dim mono internal-only">{m.member_id}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (m) => <StatusChip status={m.status} /> },
    {
      key: 'txn',
      header: 'Txns',
      align: 'right',
      render: (m) => <span className="num">{fmtInt(m.txn_count)}</span>,
    },
    {
      key: 'captured',
      header: 'Captured total',
      align: 'right',
      render: (m) => (
        <div className="mini-rows" style={{ alignItems: 'flex-end' }}>
          {m.captured_minor_total.length === 0 && <span className="dim">—</span>}
          {m.captured_minor_total.map((c) => (
            <div className="mini-row" key={c.currency}>
              <span className="ccy-tag">{c.currency}</span>
              <span className="money">{fmtMoney(c.amount_minor, c.currency)}</span>
            </div>
          ))}
        </div>
      ),
    },
    {
      key: 'payable',
      header: 'Payable',
      align: 'right',
      render: (m) => (
        <div className="mini-rows" style={{ alignItems: 'flex-end' }}>
          {m.balances.length === 0 && <span className="dim">—</span>}
          {m.balances.map((b) => (
            <div className="mini-row" key={b.currency}>
              <span className="ccy-tag">{b.currency}</span>
              <span className={`money${b.payable_minor < 0 ? ' neg' : ''}`}>
                {fmtMoney(b.payable_minor, b.currency)}
              </span>
            </div>
          ))}
        </div>
      ),
    },
    {
      key: 'reserve',
      header: 'Reserve',
      align: 'right',
      render: (m) => (
        <div className="mini-rows" style={{ alignItems: 'flex-end' }}>
          {m.balances.length === 0 && <span className="dim">—</span>}
          {m.balances.map((b) => (
            <div className="mini-row" key={b.currency}>
              <span className="ccy-tag">{b.currency}</span>
              <span className={`money${b.reserve_minor < 0 ? ' neg' : ''}`}>
                {fmtMoney(b.reserve_minor, b.currency)}
              </span>
            </div>
          ))}
        </div>
      ),
    },
  ]

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Merchants</h1>
          <div className="sub">{data ? `${fmtInt(data.items.length)} merchants onboarded` : ' '}</div>
        </div>
      </div>
      <div className="card">
        <DataTable
          columns={cols}
          rows={data?.items ?? []}
          rowKey={(m) => m.merchant_uuid}
          loading={loading}
          onRowClick={(m) => navigate(`/merchants/${m.merchant_uuid}`)}
          empty={<EmptyState title="No merchants" hint="Onboarded merchants will appear here" />}
        />
      </div>
    </div>
  )
}
