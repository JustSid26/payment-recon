import { useMemo } from 'react'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { LedgerAccount, ReserveStatement } from '../lib/types'
import { fmtMoney } from '../lib/money'
import { DataTable, EmptyState, MoneyCell } from '../components/ui'

/** Merchant-only rolling reserve — all currencies shown together. */
export default function Reserve() {
  const user = getUser()!
  const uuid = user.merchant_uuid

  const accounts = useApi(() => api<{ items: LedgerAccount[] }>('/api/ledger/accounts'), [])
  const currencies = useMemo(
    () => Array.from(new Set((accounts.data?.items ?? []).map((a) => a.currency))).sort(),
    [accounts.data],
  )

  // Fetch every currency's reserve statement at once — no picker.
  const reserves = useApi(
    () =>
      uuid && currencies.length
        ? Promise.all(
            currencies.map((c) =>
              api<ReserveStatement>(`/api/merchants/${uuid}/reserve-statement`, { params: { currency: c } }),
            ),
          )
        : Promise.resolve([] as ReserveStatement[]),
    [uuid, currencies.join(',')],
  )

  const list = reserves.data ?? []
  const loading = accounts.loading || reserves.loading

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Rolling reserve</h1>
          <div className="sub">Funds held against refunds and chargebacks, released on schedule</div>
        </div>
      </div>

      {list.length > 0 && (
        <div className="money-hero">
          {list.map((r) => {
            const ccy = r.currency
            const periodHeld = r.items.reduce((s, x) => s + Math.abs(x.held_minor), 0)
            const periodReleased = r.items.reduce((s, x) => s + Math.abs(x.released_minor), 0)
            return (
              <div className="card money-card" key={ccy}>
                <div className="mh-top">
                  <span className="ccy-tag">{ccy}</span>
                </div>
                <div className="mh-primary">
                  <span className="mh-label">Reserve held right now</span>
                  <span className="mh-value">{fmtMoney(r.current_reserve_minor, ccy)}</span>
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
            )
          })}
        </div>
      )}

      {loading && list.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--ink-2)' }}>
          Loading reserve…
        </div>
      )}

      {!loading && list.length === 0 && (
        <div className="card">
          <EmptyState title="No reserve activity yet" hint="Reserve holds appear after settlements" />
        </div>
      )}

      {list.map((r) => (
        <div className="card" key={`stmt-${r.currency}`}>
          <div className="card-title">
            <span>Reserve statement</span>
            <span className="ccy-tag">{r.currency}</span>
          </div>
          <DataTable
            columns={[
              { key: 'date', header: 'Date', render: (row) => <span className="nowrap num">{row.date}</span> },
              { key: 'open', header: 'Opening', align: 'right', render: (row) => <MoneyCell minor={row.opening_minor} currency={r.currency} /> },
              { key: 'held', header: 'Held', align: 'right', render: (row) => <MoneyCell minor={row.held_minor} currency={r.currency} dimZero /> },
              { key: 'released', header: 'Released', align: 'right', render: (row) => <MoneyCell minor={row.released_minor} currency={r.currency} dimZero /> },
              { key: 'close', header: 'Closing', align: 'right', render: (row) => <b><MoneyCell minor={row.closing_minor} currency={r.currency} /></b> },
            ]}
            rows={r.items}
            rowKey={(row) => row.date}
            loading={false}
            empty={<EmptyState title="No reserve activity" hint={`No ${r.currency} reserve movements yet`} />}
          />
        </div>
      ))}
    </div>
  )
}
