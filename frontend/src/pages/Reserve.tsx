import { useMemo, useState } from 'react'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { LedgerAccount, ReserveStatement } from '../lib/types'
import { fmtMoney } from '../lib/money'
import { DataTable, EmptyState, MoneyCell } from '../components/ui'

/** Merchant-only rolling reserve — all currencies as cards; click one to open its statement. */
export default function Reserve() {
  const user = getUser()!
  const uuid = user.merchant_uuid
  const [selCcy, setSelCcy] = useState<string | null>(null)

  const accounts = useApi(() => api<{ items: LedgerAccount[] }>('/api/ledger/accounts'), [])
  const currencies = useMemo(
    () => Array.from(new Set((accounts.data?.items ?? []).map((a) => a.currency))).sort(),
    [accounts.data],
  )

  // Fetch every currency's reserve statement at once — cards summarise, click reveals one.
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
  const selected = list.find((r) => r.currency === selCcy) ?? null

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Rolling reserve</h1>
          <div className="sub">Funds held against refunds and chargebacks, released on schedule</div>
        </div>
      </div>

      {list.length > 0 && (
        <>
          <div className="section-head">
            <span className="st">Your reserve by currency</span>
            <span className="dim small">Select a currency to see its statement</span>
          </div>
          <div className="money-hero">
            {list.map((r) => {
              const ccy = r.currency
              const periodHeld = r.items.reduce((s, x) => s + Math.abs(x.held_minor), 0)
              const periodReleased = r.items.reduce((s, x) => s + Math.abs(x.released_minor), 0)
              const on = selCcy === ccy
              return (
                <button
                  type="button"
                  className={`card money-card clickable${on ? ' selected' : ''}`}
                  key={ccy}
                  onClick={() => setSelCcy(on ? null : ccy)}
                  aria-pressed={on}
                >
                  <div className="mh-top">
                    <span className="ccy-tag">{ccy}</span>
                    <span className="mh-link">{on ? 'Hide statement' : 'View statement →'}</span>
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
                </button>
              )
            })}
          </div>
        </>
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

      {selected ? (
        <div className="card">
          <div className="card-title">
            <span>Reserve statement</span>
            <span className="ccy-tag">{selected.currency}</span>
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setSelCcy(null)}>Close</button>
          </div>
          <DataTable
            columns={[
              { key: 'date', header: 'Date', render: (row) => <span className="nowrap num">{row.date}</span> },
              { key: 'open', header: 'Opening', align: 'right', render: (row) => <MoneyCell minor={row.opening_minor} currency={selected.currency} /> },
              { key: 'held', header: 'Held', align: 'right', render: (row) => <MoneyCell minor={row.held_minor} currency={selected.currency} dimZero /> },
              { key: 'released', header: 'Released', align: 'right', render: (row) => <MoneyCell minor={row.released_minor} currency={selected.currency} dimZero /> },
              { key: 'close', header: 'Closing', align: 'right', render: (row) => <b><MoneyCell minor={row.closing_minor} currency={selected.currency} /></b> },
            ]}
            rows={selected.items}
            rowKey={(row) => row.date}
            loading={false}
            empty={<EmptyState title="No reserve activity" hint={`No ${selected.currency} reserve movements yet`} />}
          />
        </div>
      ) : (
        list.length > 0 && (
          <div className="card" style={{ padding: 28, textAlign: 'center', color: 'var(--ink-2)' }}>
            Click a currency card above to open its reserve statement.
          </div>
        )
      )}
    </div>
  )
}
