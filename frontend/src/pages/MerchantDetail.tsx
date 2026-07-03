import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
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
  toastSuccess,
  type Column,
} from '../components/ui'

function bps(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `${(n / 100).toFixed(2).replace(/\.?0+$/, '')}%`
}

// Quick-fill presets for the fee form (values in human units: %, major currency).
const FEE_PRESETS: Record<string, FeeForm> = {
  workbook: { mdrPct: '5', approvedFee: '0.30', declinedFee: '0', refundFee: '40',
    chargebackFee: '70', reservePct: '5', reserveDays: '180', settlementPct: '1', delayDays: '0' },
  annex: { mdrPct: '6.5', approvedFee: '0.35', declinedFee: '0.10', refundFee: '10',
    chargebackFee: '70', reservePct: '10', reserveDays: '180', settlementPct: '1', delayDays: '0' },
}

interface FeeForm {
  mdrPct: string; approvedFee: string; declinedFee: string; refundFee: string
  chargebackFee: string; reservePct: string; reserveDays: string; settlementPct: string; delayDays: string
}

const EMPTY_FEE_FORM: FeeForm = {
  mdrPct: '', approvedFee: '', declinedFee: '', refundFee: '',
  chargebackFee: '', reservePct: '', reserveDays: '180', settlementPct: '', delayDays: '0',
}

export default function MerchantDetailPage() {
  const { uuid } = useParams<{ uuid: string }>()
  const navigate = useNavigate()

  const { data: merchant, loading, reload: reloadMerchant } = useApi(
    () => api<MerchantDetail>(`/api/merchants/${uuid}`), [uuid])
  const settlements = useApi(
    () => api<{ items: Settlement[] }>('/api/settlements', { params: { merchant_uuid: uuid } }),
    [uuid],
  )

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
    setGenCcy(currencies[0] ?? 'USD')
    setGenStart('')
    setGenEnd('')
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

  // ---- Fee schedule editor ----
  const [showFee, setShowFee] = useState(false)
  const [feeForm, setFeeForm] = useState<FeeForm>(EMPTY_FEE_FORM)
  const [feeBusy, setFeeBusy] = useState(false)
  const [feeMsg, setFeeMsg] = useState<string | null>(null)

  const openFee = () => {
    const fs = merchant?.fee_schedule
    // prefill from the existing schedule (convert bps→%, minor→major) when configured
    setFeeForm(
      fs && fs.mdr_bps != null
        ? {
            mdrPct: String(fs.mdr_bps / 100),
            approvedFee: (fs.approved_txn_fee_minor / 100).toFixed(2),
            declinedFee: (fs.declined_txn_fee_minor / 100).toFixed(2),
            refundFee: (fs.refund_fee_minor / 100).toFixed(2),
            chargebackFee: (fs.chargeback_fee_minor / 100).toFixed(2),
            reservePct: String(fs.reserve_hold_bps / 100),
            reserveDays: String(fs.reserve_hold_days),
            settlementPct: String(fs.settlement_fee_bps / 100),
            delayDays: '0',
          }
        : EMPTY_FEE_FORM,
    )
    setFeeMsg(null)
    setShowFee(true)
  }

  const setFF = (k: keyof FeeForm, v: string) => setFeeForm((f) => ({ ...f, [k]: v }))
  const pct = (s: string) => Math.round(parseFloat(s || '0') * 100)
  const minor = (s: string) => Math.round(parseFloat(s || '0') * 100)

  const doSaveFee = async () => {
    if (feeForm.mdrPct === '' || Number.isNaN(parseFloat(feeForm.mdrPct))) {
      setFeeMsg('Enter an MDR percentage (e.g. 3 for 3%).')
      return
    }
    setFeeBusy(true)
    setFeeMsg(null)
    try {
      const res = await api<{ transactions_posted: number }>(
        `/api/merchants/${uuid}/fee-schedule`,
        {
          method: 'POST',
          body: {
            mdr_bps: pct(feeForm.mdrPct),
            approved_txn_fee_minor: minor(feeForm.approvedFee),
            declined_txn_fee_minor: minor(feeForm.declinedFee),
            refund_fee_minor: minor(feeForm.refundFee),
            chargeback_fee_minor: minor(feeForm.chargebackFee),
            reserve_hold_bps: pct(feeForm.reservePct),
            reserve_hold_days: parseInt(feeForm.reserveDays || '180', 10),
            settlement_fee_bps: pct(feeForm.settlementPct),
            settlement_delay_days: parseInt(feeForm.delayDays || '0', 10),
            settlement_schedule: 'daily',
          },
        },
      )
      toastSuccess(
        res.transactions_posted > 0
          ? `Fees saved — ${fmtInt(res.transactions_posted)} transactions posted to the ledger`
          : 'Fee schedule saved',
      )
      setShowFee(false)
      reloadMerchant()
      settlements.reload()
      reserve.reload()
    } catch (e) {
      setFeeMsg(e instanceof ApiError ? e.message : 'Failed to save fee schedule')
    } finally {
      setFeeBusy(false)
    }
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
          <div>
            <h1>{merchant.name}</h1>
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
        {merchant.balances.map((b) => (
          <div className="card stat-card" key={b.currency}>
            <div className="label">
              <span className="ccy-tag">{b.currency}</span> Payable balance
            </div>
            <div className="value">
              <MoneyCell minor={b.payable_minor} currency={b.currency} />
            </div>
            <div className="meta">
              <span>
                Reserve <b>{fmtMoney(b.reserve_minor, b.currency)}</b>
              </span>
              <span>
                In settlement <b>{fmtMoney(b.in_settlement_minor, b.currency)}</b>
              </span>
            </div>
          </div>
        ))}
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
            <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={openFee}>
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
          </div>
        </Modal>
      )}

      {/* Fee schedule editor modal */}
      {showFee && (
        <Modal
          title={configured ? 'Edit fee schedule' : `Set fees — ${merchant.name}`}
          onClose={() => setShowFee(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowFee(false)} disabled={feeBusy}>Cancel</button>
              <button className="btn primary" onClick={() => void doSaveFee()} disabled={feeBusy}>
                {feeBusy ? 'Saving…' : configured ? 'Save' : 'Save & onboard'}
              </button>
            </>
          }
        >
          <div className="dim small">
            {configured
              ? 'Rate changes apply to transactions posted from now on — the ledger is append-only.'
              : `Setting fees onboards ${merchant.name}: its ${fmtInt(merchant.txn_count)} held transactions are posted to the ledger at these rates.`}
          </div>
          {feeMsg && <div className="form-error">{feeMsg}</div>}
          <div className="field">
            <label>Quick-fill preset</label>
            <select
              className="select"
              defaultValue=""
              onChange={(e) => {
                const p = FEE_PRESETS[e.target.value]
                if (p) setFeeForm(p)
              }}
            >
              <option value="">Custom…</option>
              <option value="workbook">Workbook (5% MDR)</option>
              <option value="annex">Annex / Canamoney (6.5% MDR)</option>
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>MDR (%)</label>
              <input className="input" inputMode="decimal" value={feeForm.mdrPct}
                onChange={(e) => setFF('mdrPct', e.target.value)} placeholder="e.g. 3" />
            </div>
            <div className="field">
              <label>Settlement fee (%)</label>
              <input className="input" inputMode="decimal" value={feeForm.settlementPct}
                onChange={(e) => setFF('settlementPct', e.target.value)} placeholder="e.g. 1" />
            </div>
            <div className="field">
              <label>Rolling reserve (%)</label>
              <input className="input" inputMode="decimal" value={feeForm.reservePct}
                onChange={(e) => setFF('reservePct', e.target.value)} placeholder="e.g. 5" />
            </div>
            <div className="field">
              <label>Reserve hold (days)</label>
              <input className="input" inputMode="numeric" value={feeForm.reserveDays}
                onChange={(e) => setFF('reserveDays', e.target.value)} placeholder="180" />
            </div>
            <div className="field">
              <label>Approved txn fee</label>
              <input className="input" inputMode="decimal" value={feeForm.approvedFee}
                onChange={(e) => setFF('approvedFee', e.target.value)} placeholder="0.30" />
            </div>
            <div className="field">
              <label>Declined txn fee</label>
              <input className="input" inputMode="decimal" value={feeForm.declinedFee}
                onChange={(e) => setFF('declinedFee', e.target.value)} placeholder="0.00" />
            </div>
            <div className="field">
              <label>Refund fee</label>
              <input className="input" inputMode="decimal" value={feeForm.refundFee}
                onChange={(e) => setFF('refundFee', e.target.value)} placeholder="0.00" />
            </div>
            <div className="field">
              <label>Chargeback fee</label>
              <input className="input" inputMode="decimal" value={feeForm.chargebackFee}
                onChange={(e) => setFF('chargebackFee', e.target.value)} placeholder="0.00" />
            </div>
            <div className="field">
              <label>Settlement delay (T+days)</label>
              <input className="input" inputMode="numeric" value={feeForm.delayDays}
                onChange={(e) => setFF('delayDays', e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="dim small">Fixed fees are in the merchant's settlement currency.</div>
        </Modal>
      )}
    </div>
  )
}
