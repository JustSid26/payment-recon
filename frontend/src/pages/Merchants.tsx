import { Fragment, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { Merchant } from '../lib/types'
import { fmtInt, fmtMoney } from '../lib/money'
import { DataTable, EmptyState, StatusChip, toastSuccess, type Column } from '../components/ui'
import { FeeScheduleModal, type FeeRates } from '../components/FeeScheduleModal'
import { ApplyPresetModal } from '../components/ApplyPresetModal'

type Filter = 'all' | 'active' | 'unconfigured'

export default function Merchants() {
  const navigate = useNavigate()
  const { data, loading, reload } = useApi(() => api<{ items: Merchant[] }>('/api/merchants'), [])

  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [showFees, setShowFees] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  const items = useMemo(() => data?.items ?? [], [data])
  const counts = useMemo(() => ({
    all: items.length,
    active: items.filter((m) => m.status === 'active').length,
    unconfigured: items.filter((m) => m.status === 'unconfigured').length,
  }), [items])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter((m) => {
      if (filter === 'active' && m.status !== 'active') return false
      if (filter === 'unconfigured' && m.status !== 'unconfigured') return false
      if (!needle) return true
      return m.name.toLowerCase().includes(needle) || (m.member_id ?? '').toLowerCase().includes(needle)
    })
  }, [items, q, filter])

  const createPreset = async (rates: FeeRates, name: string) => {
    await api('/api/fee-presets', { method: 'POST', body: { name, ...rates } })
    toastSuccess(`Preset "${name}" created`)
  }

  const cols: Column<Merchant>[] = [
    { key: 'idx', header: '#', render: (_m, i) => <span className="num dim">{i + 1}</span> },
    {
      key: 'name',
      header: 'Merchant',
      render: (m) => (
        <div>
          <b>{m.name}</b>
          <div className="small dim mono internal-only">{m.member_id}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (m) => <StatusChip status={m.status} /> },
    { key: 'txn', header: 'Txns', align: 'right', render: (m) => <span className="num">{fmtInt(m.txn_count)}</span> },
    { key: 'captured', header: 'Captured', align: 'right', render: (m) => <CcyStack rows={m.captured_minor_total.map((c) => ({ currency: c.currency, minor: c.amount_minor }))} /> },
    { key: 'payable', header: 'Payable', align: 'right', render: (m) => <CcyStack rows={m.balances.map((b) => ({ currency: b.currency, minor: b.payable_minor }))} /> },
    { key: 'reserve', header: 'Reserve', align: 'right', render: (m) => <CcyStack rows={m.balances.map((b) => ({ currency: b.currency, minor: b.reserve_minor }))} /> },
  ]

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 4 }}>
        <div>
          <h1>Merchants</h1>
          <div className="sub">
            {fmtInt(counts.all)} total · {fmtInt(counts.active)} active
            {counts.unconfigured > 0 && <> · <span style={{ color: 'var(--amber)' }}>{fmtInt(counts.unconfigured)} to set up</span></>}
          </div>
        </div>
      </div>

      <div className="toolbar">
        <input className="input" placeholder="Search name or ID…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          {(['all', 'active', 'unconfigured'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'active' ? 'Active' : 'Needs setup'}
              <span className="c">{fmtInt(counts[f])}</span>
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setShowCreate(true)}>Create preset</button>
          <button className="btn primary" onClick={() => setShowFees(true)}>Set fee schedule</button>
        </div>
      </div>

      <div className="card">
        <DataTable
          columns={cols}
          rows={rows}
          rowKey={(m) => m.merchant_uuid}
          loading={loading}
          onRowClick={(m) => navigate(`/merchants/${m.merchant_uuid}`)}
          empty={<EmptyState title={q || filter !== 'all' ? 'No matches' : 'No merchants'} hint={q || filter !== 'all' ? 'Try a different search or filter' : undefined} />}
        />
      </div>

      {showFees && (
        <ApplyPresetModal
          merchants={items}
          onClose={() => setShowFees(false)}
          onApplied={() => reload()}
          onCreatePreset={() => { setShowFees(false); setShowCreate(true) }}
        />
      )}

      {showCreate && (
        <FeeScheduleModal
          title="Create fee preset"
          subtitle="Save a reusable named fee config. It won't change any merchant until you apply it."
          saveLabel="Create preset"
          showName
          onClose={() => setShowCreate(false)}
          onSubmit={createPreset}
        />
      )}
    </div>
  )
}

function CcyStack({ rows }: { rows: { currency: string; minor: number }[] }) {
  if (rows.length === 0) return <span className="dim">—</span>
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
