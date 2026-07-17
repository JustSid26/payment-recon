import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { AccountEntry, LedgerAccount, Paginated } from '../lib/types'
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/money'
import { DataTable, EmptyState, MoneyCell, Pager, type Column } from '../components/ui'

const PAGE_SIZE = 50

export default function LedgerAccountPage() {
  const { id } = useParams<{ id: string }>()
  const [params, setParams] = useSearchParams()
  const dateFrom = params.get('date_from') ?? ''
  const dateTo = params.get('date_to') ?? ''
  const query = params.get('q') ?? ''
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key !== 'page') next.delete('page')
    setParams(next, { replace: true })
  }

  // No single-account endpoint in the contract — resolve metadata from the accounts list.
  const accounts = useApi(() => api<{ items: LedgerAccount[] }>('/api/ledger/accounts'), [])
  const account = accounts.data?.items.find((a) => String(a.account_id) === id) ?? null

  const { data, loading } = useApi(
    () =>
      api<Paginated<AccountEntry>>(`/api/ledger/accounts/${id}/entries`, {
        params: { page, page_size: PAGE_SIZE, q: query, date_from: dateFrom, date_to: dateTo },
      }),
    [id, page, query, dateFrom, dateTo],
  )

  const [search, setSearch] = useState(query)
  useEffect(() => setSearch(query), [query])
  useEffect(() => {
    if (search === query) return
    const t = setTimeout(() => setParam('q', search), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const cols: Column<AccountEntry>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (e) => <span className="nowrap small num">{fmtDate(e.occurred_at)}</span>,
    },
    {
      key: 'posted',
      header: 'Posted at',
      render: (e) => <span className="nowrap small num dim">{fmtDateTime(e.posted_at)}</span>,
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
                  {account.merchant_name ? ` · ${account.merchant_name}` : ''}
                  {account.member_id ? <> · <span className="mono">ID {account.member_id}</span></> : ''} · Balance{' '}
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
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>Account statement</span>
          <input
            className="input sm"
            style={{ maxWidth: 220 }}
            placeholder="Search event…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="dim small">From</span>
            <input className="input sm" type="date" value={dateFrom} onChange={(e) => setParam('date_from', e.target.value)} />
            <span className="dim small">to</span>
            <input className="input sm" type="date" value={dateTo} onChange={(e) => setParam('date_to', e.target.value)} />
            {(dateFrom || dateTo || query) && (
              <button className="btn sm" onClick={() => { setParam('date_from', ''); setParam('date_to', ''); setSearch('') }}>Clear</button>
            )}
          </div>
        </div>
        <DataTable
          columns={cols}
          rows={data?.items ?? []}
          rowKey={(e) => e.entry_uuid}
          loading={loading}
          skeletonRows={10}
          empty={<EmptyState title="No entries" hint={dateFrom || dateTo ? 'No entries in this date range' : 'Postings to this account will appear here'} />}
        />
        {data && <Pager page={page} pageSize={data.page_size || PAGE_SIZE} total={data.total} onPage={(pp) => setParam('page', String(pp))} />}
      </div>
    </div>
  )
}
