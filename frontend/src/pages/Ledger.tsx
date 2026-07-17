import { Fragment, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { CcyAmount, LedgerMerchantRow, LedgerMerchantsResp } from '../lib/types'
import { fmtInt, fmtMoney } from '../lib/money'
import { DataTable, EmptyState, type Column } from '../components/ui'

/** Right-aligned per-currency amount stack (one merchant may span currencies). */
function CcyStack({ rows }: { rows: CcyAmount[] }) {
  if (!rows || rows.length === 0) return <span className="dim">—</span>
  const sorted = [...rows].sort((a, b) => a.currency.localeCompare(b.currency))
  return (
    <div className="ccy-stack">
      {sorted.map((r) => (
        <Fragment key={r.currency}>
          <span className="ccy-tag">{r.currency}</span>
          <span className={`money${r.minor < 0 ? ' neg' : ''}`}>{fmtMoney(r.minor, r.currency)}</span>
        </Fragment>
      ))}
    </div>
  )
}

export default function Ledger() {
  const navigate = useNavigate()
  const { data, loading } = useApi(() => api<LedgerMerchantsResp>('/api/ledger/merchants'), [])

  const merchantCols: Column<LedgerMerchantRow>[] = [
    { key: 'idx', header: '#', render: (_m, i) => <span className="num dim">{i + 1}</span> },
    {
      key: 'name',
      header: 'Merchant',
      render: (m) => (
        <div>
          <b>{m.name}</b>
          <div className="small dim mono">ID {m.member_id}</div>
        </div>
      ),
    },
    { key: 'payable', header: 'Payable', align: 'right', render: (m) => <CcyStack rows={m.payable} /> },
    {
      key: 'paid',
      header: 'Paid out',
      align: 'right',
      render: (m) => <CcyStack rows={m.paid.map((p) => ({ currency: p.currency, minor: p.amount_minor }))} />,
    },
    {
      key: 'balanced',
      header: 'Balanced',
      align: 'right',
      render: (m) => (
        <span className={`ledger-pill ${m.balanced ? 'ok' : 'bad'}`} style={{ display: 'inline-flex' }}>
          {m.balanced ? '✓ Balanced' : '⚠ Off'}
        </span>
      ),
    },
  ]

  const [q, setQ] = useState('')
  const allMerchants = data?.merchants ?? []
  const merchants = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return allMerchants
    return allMerchants.filter(
      (m) => m.name.toLowerCase().includes(needle) || (m.member_id ?? '').toLowerCase().includes(needle),
    )
  }, [allMerchants, q])

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Ledger</h1>
          <div className="sub">
            {data ? `${fmtInt(merchants.length)} merchant${merchants.length === 1 ? '' : 's'} · balances derived from double-entry postings` : ' '}
          </div>
        </div>
      </div>

      <div>
        <div className="section-head">
          <span className="st">Merchants</span>
          <input
            className="input sm"
            style={{ maxWidth: 240, marginLeft: 'auto' }}
            placeholder="Search name or ID…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="card">
          <DataTable
            columns={merchantCols}
            rows={merchants}
            rowKey={(m) => m.merchant_uuid}
            loading={loading}
            skeletonRows={6}
            onRowClick={(m) => navigate(`/ledger/merchants/${m.merchant_uuid}`)}
            empty={<EmptyState title="No merchant ledgers yet" hint="Merchants appear here once their transactions are posted" />}
          />
        </div>
      </div>
    </div>
  )
}
