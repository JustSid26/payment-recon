import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { Merchant, Settlement } from '../lib/types'
import { fmtDate, fmtInt } from '../lib/money'
import { DataTable, EmptyState, MoneyCell, StatusChip, type Column } from '../components/ui'

const CURRENCIES = ['EUR', 'USD', 'AUD', 'CAD', 'GBP', 'JPY']

export default function Settlements() {
  const user = getUser()!
  const isAdmin = user.role === 'admin'
  const navigate = useNavigate()

  const [merchantUuid, setMerchantUuid] = useState('')
  const [currency, setCurrency] = useState('')

  const merchants = useApi(
    () => (isAdmin ? api<{ items: Merchant[] }>('/api/merchants') : Promise.resolve(null)),
    [isAdmin],
  )

  const { data, loading } = useApi(
    () =>
      api<{ items: Settlement[] }>('/api/settlements', {
        params: { merchant_uuid: isAdmin ? merchantUuid : undefined, currency },
      }),
    [merchantUuid, currency, isAdmin],
  )

  const cols: Column<Settlement>[] = [
    ...(isAdmin
      ? ([
          {
            key: 'merchant',
            header: 'Merchant',
            render: (s: Settlement) => <b>{s.merchant_name}</b>,
          },
        ] as Column<Settlement>[])
      : []),
    { key: 'ccy', header: 'Currency', render: (s) => <span className="ccy-tag">{s.currency}</span> },
    {
      key: 'window',
      header: 'Window',
      render: (s) => (
        <span className="nowrap num">
          {fmtDate(s.window_start)} → {fmtDate(s.window_end)}
        </span>
      ),
    },
    { key: 'state', header: 'State', render: (s) => <StatusChip status={s.state} /> },
    {
      key: 'counts',
      header: 'Paid / Declined',
      align: 'right',
      render: (s) => (
        <span className="num">
          {fmtInt(s.paid_count)} / {fmtInt(s.declined_count)}
        </span>
      ),
    },
    {
      key: 'net',
      header: 'Net payout',
      align: 'right',
      render: (s) => (
        <b>
          <MoneyCell minor={s.net_payout_minor} currency={s.currency} />
        </b>
      ),
    },
  ]

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Settlements</h1>
          <div className="sub">{data ? `${fmtInt(data.items.length)} settlements` : ' '}</div>
        </div>
      </div>

      <div className="card">
        <div className="filter-bar">
          {isAdmin && (
            <select
              className="select"
              style={{ maxWidth: 240 }}
              value={merchantUuid}
              onChange={(e) => setMerchantUuid(e.target.value)}
            >
              <option value="">All merchants</option>
              {(merchants.data?.items ?? []).map((m) => (
                <option key={m.merchant_uuid} value={m.merchant_uuid}>{m.name}</option>
              ))}
            </select>
          )}
          <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="">All currencies</option>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <DataTable
          columns={cols}
          rows={data?.items ?? []}
          rowKey={(s) => s.settlement_uuid}
          loading={loading}
          onRowClick={(s) => navigate(`/settlements/${s.settlement_uuid}`)}
          empty={
            <EmptyState
              title="No settlements yet"
              hint={isAdmin ? 'Generate one from a merchant page' : 'Settlements will appear here once generated'}
            />
          }
        />
      </div>
    </div>
  )
}
