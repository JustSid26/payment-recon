import { Link, useParams } from 'react-router-dom'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { TransactionDetail } from '../lib/types'
import { fmtDateTime, fmtMoney } from '../lib/money'
import LedgerEventCard from '../components/LedgerEventCard'
import { DataTable, EmptyState, LoadingBlock, MoneyCell, StatusChip } from '../components/ui'

export default function TransactionDetailPage() {
  const { uuid } = useParams<{ uuid: string }>()
  const isAdmin = getUser()?.role === 'admin'
  const { data: txn, loading } = useApi(() => api<TransactionDetail>(`/api/transactions/${uuid}`), [uuid])

  if (loading || !txn) {
    return (
      <div>
        <Link to="/transactions" className="back-link">← Transactions</Link>
        <LoadingBlock label="Loading transaction…" />
      </div>
    )
  }

  const fields: Array<[string, React.ReactNode]> = [
    ['Occurred at', <span className="num">{fmtDateTime(txn.occurred_at)}</span>],
    ...(isAdmin
      ? ([['Merchant', <Link to={`/merchants/${txn.merchant_uuid}`}>{txn.merchant_name}</Link>]] as Array<
          [string, React.ReactNode]
        >)
      : []),
    ['Tracking ID', <span className="mono">{txn.tracking_id}</span>],
    ['Order ID', <span className="mono">{txn.order_id}</span>],
    ['Upstream payment ID', <span className="mono">{txn.upstream_payment_id || '—'}</span>],
    ['Customer', txn.customer_name || '—'],
    ['Email', txn.customer_email || '—'],
    [
      'Payment',
      <span>
        {txn.payment_brand} {txn.payment_mode ? `· ${txn.payment_mode}` : ''}{' '}
        {txn.card_last_four ? <span className="mono">•••• {txn.card_last_four}</span> : ''}
      </span>,
    ],
    ['MID', <span className="mono">{txn.mid || '—'}</span>],
    ['Country', txn.country || '—'],
    ['Currency', <span className="ccy-tag">{txn.currency}</span>],
    ['Authorized', <MoneyCell minor={txn.auth_minor} currency={txn.currency} />],
    ['Captured', <MoneyCell minor={txn.captured_minor} currency={txn.currency} />],
    ['Refunded', <MoneyCell minor={txn.refunded_minor} currency={txn.currency} dimZero />],
    ['Chargeback', <MoneyCell minor={txn.chargeback_minor} currency={txn.currency} dimZero />],
  ]

  const totalFees = txn.fees.reduce((s, f) => s + f.fee_minor, 0)
  const feeCurrency = txn.fees[0]?.currency ?? txn.currency
  const sameCcyFees = txn.fees.every((f) => f.currency === feeCurrency)

  return (
    <div className="stack">
      <div>
        <Link to="/transactions" className="back-link">← Transactions</Link>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="mono" style={{ fontSize: 17 }}>{txn.tracking_id}</span>
              <StatusChip status={txn.status} />
            </h1>
            <div className="sub">
              {fmtMoney(txn.captured_minor || txn.auth_minor, txn.currency)} · {txn.merchant_name}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Transaction details</div>
        <div className="detail-grid">
          {fields.map(([k, v]) => (
            <div className="cell" key={k}>
              <div className="k">{k}</div>
              <div className="v">{v}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          Fees
          {txn.fees.length > 0 && sameCcyFees && (
            <span className="num small">Total {fmtMoney(totalFees, feeCurrency)}</span>
          )}
        </div>
        <DataTable
          columns={[
            {
              key: 'type',
              header: 'Fee type',
              render: (f) => <span style={{ textTransform: 'capitalize' }}>{f.fee_type.replace(/_/g, ' ')}</span>,
            },
            { key: 'ccy', header: 'Currency', render: (f) => <span className="ccy-tag">{f.currency}</span> },
            {
              key: 'amount',
              header: 'Amount',
              align: 'right',
              render: (f) => <MoneyCell minor={f.fee_minor} currency={f.currency} />,
            },
          ]}
          rows={txn.fees}
          rowKey={(f) => `${f.fee_type}-${f.currency}`}
          empty={<EmptyState title="No fees on this transaction" />}
        />
      </div>

      <div>
        <div className="page-head" style={{ marginBottom: 12 }}>
          <div>
            <h2>Ledger events</h2>
            <div className="sub">
              Double-entry postings for this transaction — every event sums to zero across debits and credits.
            </div>
          </div>
        </div>
        <div className="stack">
          {txn.ledger_events.length === 0 && (
            <div className="card">
              <EmptyState title="No ledger events" hint="Postings appear once the transaction hits the ledger" />
            </div>
          )}
          {txn.ledger_events.map((ev) => (
            <LedgerEventCard key={ev.event_uuid} event={ev} />
          ))}
        </div>
      </div>
    </div>
  )
}
