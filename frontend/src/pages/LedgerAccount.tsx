import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { AccountEntry, LedgerAccount, Paginated } from '../lib/types'
import { fmtDateTime, fmtMoney } from '../lib/money'
import { DataTable, EmptyState, MoneyCell, Pager, type Column } from '../components/ui'

const PAGE_SIZE = 50

export default function LedgerAccountPage() {
  const { id } = useParams<{ id: string }>()
  const [page, setPage] = useState(1)

  // No single-account endpoint in the contract — resolve metadata from the accounts list.
  const accounts = useApi(() => api<{ items: LedgerAccount[] }>('/api/ledger/accounts'), [])
  const account = accounts.data?.items.find((a) => String(a.account_id) === id) ?? null

  const { data, loading } = useApi(
    () =>
      api<Paginated<AccountEntry>>(`/api/ledger/accounts/${id}/entries`, {
        params: { page, page_size: PAGE_SIZE },
      }),
    [id, page],
  )

  const cols: Column<AccountEntry>[] = [
    {
      key: 'posted',
      header: 'Posted at',
      render: (e) => <span className="nowrap small num">{fmtDateTime(e.posted_at)}</span>,
    },
    {
      key: 'event',
      header: 'Event',
      render: (e) => (
        <div>
          <span style={{ textTransform: 'capitalize' }}>{e.event_type.replace(/_/g, ' ')}</span>
          <div className="small dim mono internal-only">{e.event_uuid.slice(0, 8)}…</div>
        </div>
      ),
    },
    {
      key: 'dir',
      header: 'DR / CR',
      render: (e) => (
        <span className={`dir-badge ${e.direction === 'debit' ? 'dr' : 'cr'}`}>
          {e.direction === 'debit' ? 'DR' : 'CR'}
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (e) => <MoneyCell minor={e.amount_minor} currency={e.currency} />,
    },
    {
      key: 'after',
      header: 'Balance after',
      align: 'right',
      render: (e) => (
        <b>
          <MoneyCell minor={e.balance_after_minor} currency={e.currency} />
        </b>
      ),
    },
  ]

  return (
    <div className="stack">
      <div>
        <Link to="/ledger" className="back-link">← Ledger accounts</Link>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h1>{account?.label ?? `Account #${id}`}</h1>
            <div className="sub">
              {account && (
                <>
                  {account.account_type.replace(/_/g, ' ')} · <span className="ccy-tag">{account.currency}</span>
                  {account.merchant_name ? ` · ${account.merchant_name}` : ''} · Balance{' '}
                  <b className={account.balance_minor < 0 ? 'money neg' : 'money'}>
                    {fmtMoney(account.balance_minor, account.currency)}
                  </b>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Account statement</div>
        <DataTable
          columns={cols}
          rows={data?.items ?? []}
          rowKey={(e) => e.entry_uuid}
          loading={loading}
          skeletonRows={10}
          empty={<EmptyState title="No entries" hint="Postings to this account will appear here" />}
        />
        {data && <Pager page={page} pageSize={data.page_size || PAGE_SIZE} total={data.total} onPage={setPage} />}
      </div>
    </div>
  )
}
