import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { Merchant, Paginated, Transaction } from '../lib/types'
import { fmtDateTime, fmtInt } from '../lib/money'
import { DataTable, EmptyState, MoneyCell, Pager, StatusChip, type Column } from '../components/ui'

const STATUSES = ['captured', 'auth_failed', 'initiated', 'voided', 'refunded', 'partially_refunded']
const CURRENCIES = ['EUR', 'USD', 'AUD', 'CAD', 'GBP', 'JPY']
const PAGE_SIZE = 50

export default function Transactions() {
  const user = getUser()!
  const isAdmin = user.role === 'admin'
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const q = params.get('q') ?? ''
  const status = params.get('status') ?? ''
  const currency = params.get('currency') ?? ''
  const merchantUuid = params.get('merchant_uuid') ?? ''
  const dateFrom = params.get('date_from') ?? ''
  const dateTo = params.get('date_to') ?? ''
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key !== 'page') next.delete('page')
    setParams(next, { replace: true })
  }

  // Debounced search box
  const [search, setSearch] = useState(q)
  useEffect(() => setSearch(q), [q])
  useEffect(() => {
    if (search === q) return
    const t = setTimeout(() => setFilter('q', search), 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const merchants = useApi(
    () => (isAdmin ? api<{ items: Merchant[] }>('/api/merchants') : Promise.resolve(null)),
    [isAdmin],
  )

  const { data, loading } = useApi(
    () =>
      api<Paginated<Transaction>>('/api/transactions', {
        params: {
          q,
          status,
          currency,
          merchant_uuid: isAdmin ? merchantUuid : undefined,
          date_from: dateFrom,
          date_to: dateTo,
          page,
          page_size: PAGE_SIZE,
        },
      }),
    [q, status, currency, merchantUuid, dateFrom, dateTo, page, isAdmin],
  )

  const cols: Column<Transaction>[] = [
    {
      key: 'occurred',
      header: 'Occurred',
      render: (t) => <span className="nowrap small num">{fmtDateTime(t.occurred_at)}</span>,
    },
    ...(isAdmin
      ? ([
          {
            key: 'merchant',
            header: 'Merchant',
            render: (t: Transaction) => <span className="small">{t.merchant_name}</span>,
          },
        ] as Column<Transaction>[])
      : []),
    {
      key: 'tracking',
      header: 'Tracking / Order',
      render: (t) => (
        <div>
          <div className="mono">{t.tracking_id}</div>
          <div className="mono dim">{t.order_id}</div>
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (t) => (
        <div>
          <div className="small">{t.customer_name || '—'}</div>
          <div className="small dim">{t.customer_email}</div>
        </div>
      ),
    },
    {
      key: 'card',
      header: 'Payment',
      render: (t) => (
        <span className="nowrap small">
          {t.payment_brand} {t.card_last_four ? <span className="mono">•••• {t.card_last_four}</span> : null}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (t) => <StatusChip status={t.status} /> },
    {
      key: 'auth',
      header: 'Auth',
      align: 'right',
      render: (t) => <MoneyCell minor={t.auth_minor} currency={t.currency} dimZero />,
    },
    {
      key: 'captured',
      header: 'Captured',
      align: 'right',
      render: (t) => <MoneyCell minor={t.captured_minor} currency={t.currency} dimZero />,
    },
    {
      key: 'refunded',
      header: 'Refunded',
      align: 'right',
      render: (t) => <MoneyCell minor={t.refunded_minor} currency={t.currency} dimZero />,
    },
  ]

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Transactions</h1>
          <div className="sub">{data ? `${fmtInt(data.total)} transactions` : ' '}</div>
        </div>
      </div>

      <div className="card">
        <div className="filter-bar">
          <input
            className="input"
            style={{ flex: '1 1 220px' }}
            placeholder="Search tracking, order, payment id, customer, last 4…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="select" value={status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <select className="select" value={currency} onChange={(e) => setFilter('currency', e.target.value)}>
            <option value="">All currencies</option>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {isAdmin && (
            <select
              className="select"
              style={{ maxWidth: 220 }}
              value={merchantUuid}
              onChange={(e) => setFilter('merchant_uuid', e.target.value)}
            >
              <option value="">All merchants</option>
              {(merchants.data?.items ?? []).map((m) => (
                <option key={m.merchant_uuid} value={m.merchant_uuid}>{m.name}</option>
              ))}
            </select>
          )}
          <input
            className="input"
            type="date"
            value={dateFrom}
            onChange={(e) => setFilter('date_from', e.target.value)}
            title="From"
          />
          <input
            className="input"
            type="date"
            value={dateTo}
            onChange={(e) => setFilter('date_to', e.target.value)}
            title="To"
          />
        </div>

        <DataTable
          columns={cols}
          rows={data?.items ?? []}
          rowKey={(t) => t.transaction_uuid}
          loading={loading}
          skeletonRows={10}
          onRowClick={(t) => navigate(`/transactions/${t.transaction_uuid}`)}
          empty={<EmptyState title="No transactions match" hint="Try clearing filters" />}
        />
        {data && (
          <Pager page={page} pageSize={data.page_size || PAGE_SIZE} total={data.total} onPage={(p) => setFilter('page', String(p))} />
        )}
      </div>
    </div>
  )
}
