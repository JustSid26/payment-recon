import { useMemo, useState } from 'react'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { LedgerAccount, ReserveStatement } from '../lib/types'
import { fmtMoney } from '../lib/money'
import { DataTable, EmptyState, MoneyCell } from '../components/ui'

/** Merchant-only rolling reserve statement. */
export default function Reserve() {
  const user = getUser()!
  const uuid = user.merchant_uuid

  const accounts = useApi(() => api<{ items: LedgerAccount[] }>('/api/ledger/accounts'), [])
  const currencies = useMemo(
    () => Array.from(new Set((accounts.data?.items ?? []).map((a) => a.currency))).sort(),
    [accounts.data],
  )

  const [selCcy, setSelCcy] = useState<string | null>(null)
  const activeCcy = selCcy ?? currencies[0] ?? null

  const reserve = useApi(
    () =>
      uuid && activeCcy
        ? api<ReserveStatement>(`/api/merchants/${uuid}/reserve-statement`, { params: { currency: activeCcy } })
        : Promise.resolve(null),
    [uuid, activeCcy],
  )

  const ccy = reserve.data?.currency ?? activeCcy ?? 'USD'

  const items = reserve.data?.items ?? []
  const periodHeld = items.reduce((s, r) => s + Math.abs(r.held_minor), 0)
  const periodReleased = items.reduce((s, r) => s + Math.abs(r.released_minor), 0)

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Rolling reserve</h1>
          <div className="sub">Funds held against refunds and chargebacks, released on schedule</div>
        </div>
        <div className="head-actions">
          <select
            className="select"
            value={activeCcy ?? ''}
            onChange={(e) => setSelCcy(e.target.value)}
            disabled={currencies.length === 0}
          >
            {currencies.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      {reserve.data && (
        <div className="money-hero">
          <div className="card money-card">
            <div className="mh-top">
              <span className="ccy-tag">{ccy}</span>
            </div>
            <div className="mh-primary">
              <span className="mh-label">Reserve held right now</span>
              <span className="mh-value">{fmtMoney(reserve.data.current_reserve_minor, ccy)}</span>
            </div>
            <div className="mh-split">
              <div className="mh-metric">
                <span className="mh-sub">Held (this period)</span>
                <b>{fmtMoney(periodHeld, ccy)}</b>
              </div>
              <div className="mh-metric">
                <span className="mh-sub">Released back</span>
                <b>{fmtMoney(periodReleased, ccy)}</b>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">Reserve statement</div>
        <DataTable
          columns={[
            { key: 'date', header: 'Date', render: (r) => <span className="nowrap num">{r.date}</span> },
            {
              key: 'open',
              header: 'Opening',
              align: 'right',
              render: (r) => <MoneyCell minor={r.opening_minor} currency={ccy} />,
            },
            {
              key: 'held',
              header: 'Held',
              align: 'right',
              render: (r) => <MoneyCell minor={r.held_minor} currency={ccy} dimZero />,
            },
            {
              key: 'released',
              header: 'Released',
              align: 'right',
              render: (r) => <MoneyCell minor={r.released_minor} currency={ccy} dimZero />,
            },
            {
              key: 'close',
              header: 'Closing',
              align: 'right',
              render: (r) => (
                <b>
                  <MoneyCell minor={r.closing_minor} currency={ccy} />
                </b>
              ),
            },
          ]}
          rows={reserve.data?.items ?? []}
          rowKey={(r) => r.date}
          loading={reserve.loading || accounts.loading}
          empty={<EmptyState title="No reserve activity yet" hint="Reserve holds appear after settlements" />}
        />
      </div>
    </div>
  )
}
