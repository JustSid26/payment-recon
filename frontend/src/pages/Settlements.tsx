import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { Merchant, Settlement } from '../lib/types'
import { fmtDate, fmtInt } from '../lib/money'
import { DataTable, EmptyState, MoneyCell, StatusChip, type Column } from '../components/ui'
import DailySettlementRecords from '../components/DailySettlementRecords'

const CURRENCIES = ['EUR', 'USD', 'AUD', 'CAD', 'GBP', 'JPY']

export default function Settlements() {
  const user = getUser()!
  const isAdmin = user.role === 'admin'
  const navigate = useNavigate()

  const [view, setView] = useState<'list' | 'daily'>('list')
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

  const dailyUuid = isAdmin ? merchantUuid : user.merchant_uuid ?? ''
  const dailyName = isAdmin
    ? (merchants.data?.items ?? []).find((m) => m.merchant_uuid === merchantUuid)?.name ?? 'merchant'
    : user.merchant_name ?? 'merchant'

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Settlements</h1>
          <div className="sub">
            {view === 'daily' ? 'Per-day payable, fees and settled-vs-remaining' : data ? `${fmtInt(data.items.length)} settlements` : ' '}
          </div>
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
      ) : (
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
      )}
    </div>
  )
}
