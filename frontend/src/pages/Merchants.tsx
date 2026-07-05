import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { Merchant } from '../lib/types'
import { fmtInt, fmtMoney } from '../lib/money'
import { DataTable, EmptyState, StatusChip, toastSuccess, type Column } from '../components/ui'
import { FeeScheduleModal, type FeeRates } from '../components/FeeScheduleModal'

type Filter = 'all' | 'active' | 'unconfigured'

export default function Merchants() {
  const navigate = useNavigate()
  const { data, loading, reload } = useApi(() => api<{ items: Merchant[] }>('/api/merchants'), [])

  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showFees, setShowFees] = useState(false)

  const items = data?.items ?? []
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

  const toggle = (uuid: string) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(uuid) ? n.delete(uuid) : n.add(uuid)
      return n
    })

  const allInView = rows.length > 0 && rows.every((m) => selected.has(m.merchant_uuid))
  const someInView = rows.some((m) => selected.has(m.merchant_uuid))
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s)
      if (allInView) rows.forEach((m) => n.delete(m.merchant_uuid))
      else rows.forEach((m) => n.add(m.merchant_uuid))
      return n
    })

  const applyBulkFees = async (rates: FeeRates) => {
    const res = await api<{ applied: number; failed: number }>('/api/merchants/fee-schedule/bulk', {
      method: 'POST',
      body: { ...rates, merchant_uuids: [...selected] },
    })
    toastSuccess(`Fees applied to ${res.applied} merchant${res.applied === 1 ? '' : 's'}${res.failed ? ` · ${res.failed} failed` : ''}`)
    setSelected(new Set())
    reload()
  }

  const cols: Column<Merchant>[] = [
    {
      key: 'sel',
      header: <SelectAll checked={allInView} indeterminate={someInView && !allInView} onChange={toggleAll} />,
      render: (m) => (
        <input
          type="checkbox"
          checked={selected.has(m.merchant_uuid)}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggle(m.merchant_uuid)}
        />
      ),
    },
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
        <button className="btn primary" style={{ marginLeft: 'auto' }} disabled={selected.size === 0} onClick={() => setShowFees(true)}>
          Set fee schedule{selected.size > 0 ? ` (${selected.size})` : ''}
        </button>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <span><b>{selected.size}</b> selected</span>
          <button className="btn sm primary" onClick={() => setShowFees(true)}>Set fee schedule →</button>
          <button className="btn sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

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
        <FeeScheduleModal
          title={`Set fees — ${selected.size} merchant${selected.size === 1 ? '' : 's'}`}
          subtitle="Applies this schedule to every selected merchant and posts their held transactions."
          saveLabel="Apply to selected"
          onClose={() => setShowFees(false)}
          onSubmit={applyBulkFees}
        />
      )}
    </div>
  )
}

function SelectAll({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  if (ref.current) ref.current.indeterminate = indeterminate
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} onClick={(e) => e.stopPropagation()} />
}

function CcyStack({ rows }: { rows: { currency: string; minor: number }[] }) {
  if (rows.length === 0) return <span className="dim">—</span>
  const sorted = [...rows].sort((a, b) => a.currency.localeCompare(b.currency))
  return (
    <div className="ccy-stack">
      {sorted.map((r) => (
        <div className="ccy-line" key={r.currency}>
          <span className="ccy-tag">{r.currency}</span>
          <span className={`money${r.minor < 0 ? ' neg' : ''}`}>{fmtMoney(r.minor, r.currency)}</span>
        </div>
      ))}
    </div>
  )
}
