import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import type {
  GenerateSkipped,
  MerchantDetail,
  ReserveStatement,
  Settlement,
  SettlementDetail,
} from '../lib/types'
import { fmtDate, fmtInt, fmtMoney } from '../lib/money'
import {
  DataTable,
  EmptyState,
  LoadingBlock,
  Modal,
  MoneyCell,
  StatusChip,
  toastError,
  toastSuccess,
  type Column,
} from '../components/ui'
import { FeeScheduleModal, feeFormFromSchedule, type FeeRates } from '../components/FeeScheduleModal'
import DailySettlementRecords from '../components/DailySettlementRecords'

function bps(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `${(n / 100).toFixed(2).replace(/\.?0+$/, '')}%`
}

export default function MerchantDetailPage() {
  const { uuid } = useParams<{ uuid: string }>()
  const navigate = useNavigate()
  const isAdmin = getUser()?.role === 'admin'

  const { data: merchant, loading, reload: reloadMerchant } = useApi(
    () => api<MerchantDetail>(`/api/merchants/${uuid}`), [uuid])
  const settlements = useApi(
    () => api<{ items: Settlement[] }>('/api/settlements', { params: { merchant_uuid: uuid } }),
    [uuid],
  )

  // rename
  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState('')
  const [savingName, setSavingName] = useState(false)
  const saveName = async () => {
    const name = nameVal.trim()
    if (!name) return
    setSavingName(true)
    try {
      await api(`/api/merchants/${uuid}`, { method: 'PATCH', body: { name } })
      toastSuccess('Merchant renamed')
      setEditingName(false)
      reloadMerchant()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Rename failed')
    } finally {
      setSavingName(false)
    }
  }

  const currencies = useMemo(() => merchant?.balances.map((b) => b.currency) ?? [], [merchant])
  const [reserveCcy, setReserveCcy] = useState<string | null>(null)
  const activeCcy = reserveCcy ?? currencies[0] ?? null

  const reserve = useApi(
    () =>
      activeCcy
        ? api<ReserveStatement>(`/api/merchants/${uuid}/reserve-statement`, { params: { currency: activeCcy } })
        : Promise.resolve(null),
    [uuid, activeCcy],
  )

  // ---- Generate settlement modal ----
  const [showGen, setShowGen] = useState(false)
  const [genCcy, setGenCcy] = useState('')
  const [genStart, setGenStart] = useState('')
  const [genEnd, setGenEnd] = useState('')
  const [genBusy, setGenBusy] = useState(false)
  const [genMsg, setGenMsg] = useState<string | null>(null)

  const openGen = () => {
    // Default the window so the user doesn't have to guess: end = today (only
    // matured funds are ever included), start = 30 days back to cover recent uploads.
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const today = new Date()
    const start = new Date()
    start.setDate(today.getDate() - 30)
    setGenCcy(currencies[0] ?? 'USD')
    setGenStart(iso(start))
    setGenEnd(iso(today))
    setGenMsg(null)
    setShowGen(true)
  }

  const doGenerate = async () => {
    if (!genStart || !genEnd) {
      setGenMsg('Pick a window start and end date.')
      return
    }
    setGenBusy(true)
    setGenMsg(null)
    try {
      const res = await api<SettlementDetail | GenerateSkipped>('/api/settlements/generate', {
        method: 'POST',
        body: { merchant_uuid: uuid, currency: genCcy, window_start: genStart, window_end: genEnd },
      })
      if ('skipped' in res && res.skipped) {
        setGenMsg(`Skipped — ${res.reason}`)
      } else {
        toastSuccess('Settlement generated')
        navigate(`/settlements/${(res as SettlementDetail).settlement_uuid}`)
      }
    } catch (e) {
      setGenMsg(e instanceof ApiError ? e.message : 'Failed to generate settlement')
    } finally {
      setGenBusy(false)
    }
  }

  // ---- Fee schedule editor (uses the shared modal) ----
  const [showFee, setShowFee] = useState(false)

  const saveFee = async (rates: FeeRates) => {
    const res = await api<{ transactions_posted: number }>(
      `/api/merchants/${uuid}/fee-schedule`,
      { method: 'POST', body: rates },
    )
    toastSuccess(
      res.transactions_posted > 0
        ? `Fees saved — ${fmtInt(res.transactions_posted)} transactions posted to the ledger`
        : 'Fee schedule saved',
    )
    reloadMerchant()
    settlements.reload()
    reserve.reload()
  }

  const settlementCols: Column<Settlement>[] = [
    {
      key: 'window',
      header: 'Window',
      render: (s) => (
        <span className="nowrap">
          {fmtDate(s.window_start)} → {fmtDate(s.window_end)}
        </span>
      ),
    },
    { key: 'ccy', header: 'Ccy', render: (s) => <span className="ccy-tag">{s.currency}</span> },
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
      render: (s) => <MoneyCell minor={s.net_payout_minor} currency={s.currency} />,
    },
  ]

  if (loading || !merchant) {
    return (
      <div>
        <Link to="/merchants" className="back-link">← Merchants</Link>
        <LoadingBlock label="Loading merchant…" />
      </div>
    )
  }

  const fs = merchant.fee_schedule
  // Fixed fees are denominated in fee_fixed_currency when present; fall back to the merchant's first balance currency.
  const feeCcy = fs.fee_fixed_currency ?? merchant.balances[0]?.currency ?? null
  const configured = fs != null && fs.mdr_bps != null

  return (
    <div className="stack">
      <div>
        <Link to="/merchants" className="back-link">← Merchants</Link>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div style={{ minWidth: 0 }}>
            {editingName ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="input"
                  style={{ maxWidth: 320, fontSize: 20, fontWeight: 650 }}
                  value={nameVal}
                  autoFocus
                  onChange={(e) => setNameVal(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void saveName()}
                />
                <button className="btn primary sm" onClick={() => void saveName()} disabled={savingName}>
                  {savingName ? 'Saving…' : 'Save'}
                </button>
                <button className="btn sm" onClick={() => setEditingName(false)} disabled={savingName}>Cancel</button>
              </div>
            ) : (
              <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {merchant.name}
                {isAdmin && (
                  <button className="btn sm" title="Rename merchant" onClick={() => { setNameVal(merchant.name); setEditingName(true) }}>Rename</button>
                )}
              </h1>
            )}
            <div className="sub">
              <span className="internal-only">Member ID <span className="mono">{merchant.member_id}</span> · </span>
              <StatusChip status={merchant.status} /> · {fmtInt(merchant.txn_count)} transactions
            </div>
          </div>
          <div className="head-actions">
            <button className="btn primary" onClick={openGen}>＋ Generate settlement</button>
          </div>
        </div>
      </div>

      {/* Balance cards per currency */}
      <div className="grid grid-cards">
        {merchant.balances.map((b) => {
          const outstandingMinor = b.payable_minor + b.in_settlement_minor;
          return (
            <div className="card stat-card" key={b.currency}>
              <div className="label" title="Owed to the merchant but not yet paid out (net payable + in-transit settlements; excludes locked reserve)">
                <span className="ccy-tag">{b.currency}</span> Outstanding Balance
              </div>
              <div className="value" title="Owed to the merchant but not yet paid out (net payable + in-transit settlements; excludes locked reserve)">
                <MoneyCell minor={outstandingMinor} currency={b.currency} />
              </div>
              <div className="meta" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px', marginTop: 10, width: '100%' }}>
                <div style={{ display: 'flex', flexDirection: 'column' }} title="Amount the gateway owes after deductions">
                  <span className="dim small" style={{ fontSize: 11 }}>Net Payable</span>
                  <b style={{ color: 'var(--ink)' }}>{fmtMoney(b.payable_minor, b.currency)}</b>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }} title="Amount already credited to the merchant's bank account">
                  <span className="dim small" style={{ fontSize: 11 }}>Paid (Settled)</span>
                  <b style={{ color: 'var(--green)' }}>{fmtMoney(b.paid_minor, b.currency)}</b>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }} title="Funds held for chargeback risk">
                  <span className="dim small" style={{ fontSize: 11 }}>Reserve</span>
                  <b style={{ color: 'var(--ink-2)' }}>{fmtMoney(b.reserve_minor, b.currency)}</b>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }} title="Settlements in transit to bank account">
                  <span className="dim small" style={{ fontSize: 11 }}>In Settlement</span>
                  <b style={{ color: 'var(--ink-2)' }}>{fmtMoney(b.in_settlement_minor, b.currency)}</b>
                </div>
              </div>
            </div>
          );
        })}
        {merchant.balances.length === 0 && (
          <div className="card"><EmptyState title="No balances yet" /></div>
        )}
      </div>

      {/* grid-2: fee schedule + reserve statement */}
      <div className="grid grid-2">
        {/* Fee schedule */}
        <div className="card">
          <div className="card-title">
            Fee schedule
            <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setShowFee(true)}>
              {configured ? 'Edit fees' : 'Set fees'}
            </button>
          </div>
          {configured ? (
            <div className="detail-grid">
              <div className="cell"><div className="k">MDR</div><div className="v num">{bps(fs.mdr_bps)}</div></div>
              <div className="cell">
                <div className="k">Approved txn fee</div>
                <div className="v num">{fmtMoney(fs.approved_txn_fee_minor, feeCcy)}</div>
              </div>
              <div className="cell">
                <div className="k">Declined txn fee</div>
                <div className="v num">{fmtMoney(fs.declined_txn_fee_minor, feeCcy)}</div>
              </div>
              <div className="cell">
                <div className="k">Refund fee</div>
                <div className="v num">{fmtMoney(fs.refund_fee_minor, feeCcy)}</div>
              </div>
              <div className="cell">
                <div className="k">Chargeback fee</div>
                <div className="v num">{fmtMoney(fs.chargeback_fee_minor, feeCcy)}</div>
              </div>
              <div className="cell">
                <div className="k">Rolling reserve</div>
                <div className="v num">{bps(fs.reserve_hold_bps)} · {fs.reserve_hold_days} days</div>
              </div>
              <div className="cell"><div className="k">Settlement fee</div><div className="v num">{bps(fs.settlement_fee_bps)}</div></div>
            </div>
          ) : (
            <EmptyState
              title="No fee schedule"
              hint="This merchant is unconfigured — its transactions are held (no ledger events). Set fees to onboard and post them."
            />
          )}
        </div>

        {/* Reserve statement */}
        <div className="card">
          <div className="card-title">
            Reserve statement
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {reserve.data && (
                <span className="dim small num">
                  Current: {activeCcy ? fmtMoney(reserve.data.current_reserve_minor, activeCcy) : '—'}
                </span>
              )}
              <select
                className="select"
                style={{ padding: '4px 8px', fontSize: 12 }}
                value={activeCcy ?? ''}
                onChange={(e) => setReserveCcy(e.target.value)}
              >
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </span>
          </div>
          <DataTable
            columns={[
              { key: 'date', header: 'Date', render: (r) => <span className="nowrap">{r.date}</span> },
              { key: 'open', header: 'Opening', align: 'right', render: (r) => <MoneyCell minor={r.opening_minor} currency={activeCcy ?? 'USD'} /> },
              { key: 'held', header: 'Held', align: 'right', render: (r) => <MoneyCell minor={r.held_minor} currency={activeCcy ?? 'USD'} dimZero /> },
              { key: 'rel', header: 'Released', align: 'right', render: (r) => <MoneyCell minor={r.released_minor} currency={activeCcy ?? 'USD'} dimZero /> },
              { key: 'close', header: 'Closing', align: 'right', render: (r) => <b><MoneyCell minor={r.closing_minor} currency={activeCcy ?? 'USD'} /></b> },
            ]}
            rows={reserve.data?.items ?? []}
            rowKey={(r) => r.date}
            loading={reserve.loading}
            empty={<EmptyState title="No reserve activity" />}
          />
        </div>
      </div>

      {/* Settlements for this merchant */}
      <div className="card">
        <div className="card-title">Settlements</div>
        <DataTable
          columns={settlementCols}
          rows={settlements.data?.items ?? []}
          rowKey={(s) => s.settlement_uuid}
          loading={settlements.loading}
          onRowClick={(s) => navigate(`/settlements/${s.settlement_uuid}`)}
          empty={<EmptyState title="No settlements yet" hint="Generate one for a captured window" />}
        />
      </div>

      {/* Per-day settlement records (volume, fees, net payable, settled vs remaining) */}
      <div className="section-head"><span className="st">Daily settlement records</span></div>
      <DailySettlementRecords merchantUuid={uuid!} merchantName={merchant.name} />

      {/* Generate settlement modal */}
      {showGen && (
        <Modal
          title="Generate settlement"
          onClose={() => setShowGen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowGen(false)} disabled={genBusy}>Cancel</button>
              <button className="btn primary" onClick={() => void doGenerate()} disabled={genBusy}>
                {genBusy ? 'Generating…' : 'Generate'}
              </button>
            </>
          }
        >
          <div className="dim small">
            {merchant.name} — settles all captured activity in the window. Regenerating an existing window returns
            the same settlement.
          </div>
          {genMsg && <div className="form-error">{genMsg}</div>}
          <div className="field">
            <label>Currency</label>
            <select className="select" value={genCcy} onChange={(e) => setGenCcy(e.target.value)}>
              {(currencies.length ? currencies : ['USD', 'EUR']).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Window start</label>
            <input className="input" type="date" value={genStart} onChange={(e) => setGenStart(e.target.value)} />
          </div>
          <div className="field">
            <label>Window end</label>
            <input className="input" type="date" value={genEnd} onChange={(e) => setGenEnd(e.target.value)} />
            <div className="dim small" style={{ marginTop: 6, lineHeight: 1.5 }}>
              These are the <b>processing dates</b> to settle — a single day works (e.g. 9 → 9).
              Only funds matured <b>T+{fs?.settlement_delay_days ?? 0}</b> (
              {fs?.settlement_delay_days ?? 0} business day{(fs?.settlement_delay_days ?? 0) === 1 ? '' : 's'} after
              capture) are paid out; anything not yet matured in the range is skipped, with the date it becomes settleable.
            </div>
          </div>
        </Modal>
      )}

      {/* Fee schedule editor modal (shared) */}
      {showFee && (
        <FeeScheduleModal
          title={configured ? 'Edit fee schedule' : `Set fees — ${merchant.name}`}
          subtitle={configured
            ? 'Rate changes apply to transactions posted from now on — the ledger is append-only.'
            : `Setting fees onboards ${merchant.name}: its ${fmtInt(merchant.txn_count)} held transactions are posted to the ledger at these rates.`}
          saveLabel={configured ? 'Save' : 'Save & onboard'}
          initial={configured ? feeFormFromSchedule(fs) : undefined}
          onClose={() => setShowFee(false)}
          onSubmit={saveFee}
        />
      )}
    </div>
  )
}
