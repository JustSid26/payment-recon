import { useNavigate } from 'react-router-dom'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { LedgerAccount } from '../lib/types'
import { fmtInt } from '../lib/money'
import { DataTable, EmptyState, MoneyCell, type Column } from '../components/ui'

export default function Ledger() {
  const isAdmin = getUser()?.role === 'admin'
  const navigate = useNavigate()
  const { data, loading } = useApi(() => api<{ items: LedgerAccount[] }>('/api/ledger/accounts'), [])

  const cols: Column<LedgerAccount>[] = [
    {
      key: 'label',
      header: 'Account',
      render: (a) => (
        <div>
          <b>{a.label}</b>
          <div className="small dim internal-only">#{String(a.account_id)}</div>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (a) => (
        <span className="chip" style={{ textTransform: 'none' }}>
          {a.account_type.replace(/_/g, ' ')}
        </span>
      ),
    },
    ...(isAdmin
      ? ([
          {
            key: 'merchant',
            header: 'Merchant',
            render: (a: LedgerAccount) => (a.merchant_name ? <span className="small">{a.merchant_name}</span> : <span className="dim">— platform —</span>),
          },
        ] as Column<LedgerAccount>[])
      : []),
    { key: 'ccy', header: 'Currency', render: (a) => <span className="ccy-tag">{a.currency}</span> },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      render: (a) => (
        <b>
          <MoneyCell minor={a.balance_minor} currency={a.currency} />
        </b>
      ),
    },
  ]

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Ledger accounts</h1>
          <div className="sub">
            {data ? `${fmtInt(data.items.length)} accounts · balances derived from double-entry postings` : ' '}
          </div>
        </div>
      </div>
      <div className="card">
        <DataTable
          columns={cols}
          rows={data?.items ?? []}
          rowKey={(a) => String(a.account_id)}
          loading={loading}
          skeletonRows={8}
          onRowClick={(a) => navigate(`/ledger/accounts/${a.account_id}`)}
          empty={<EmptyState title="No ledger accounts" />}
        />
      </div>
    </div>
  )
}
