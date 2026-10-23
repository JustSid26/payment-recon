import { Fragment, useMemo, useState } from 'react'
import { api, getUser } from '../lib/api'
import { useApi } from '../lib/useApi'
import { fmtInt, fmtMoney } from '../lib/money'
import { downloadExcelWorkbook, toMajor, type Cell } from '../lib/export'
import { EmptyState, LoadingBlock } from '../components/ui'
import { CountUp } from '../components/CountUp'
import { useGrow } from '../lib/useGrow'
import type {
  CountryInsight, CountryInsights, MLCountry, MLInsights,
  IssuersResponse, MerchantsResponse,
} from '../lib/types'

// ISO-3166 alpha-2 → display name (the countries our processors send, plus the
// common long tail). Unknown codes fall back to the raw code.
const NAMES: Record<string, string> = {
  AT: 'Austria', AU: 'Australia', BE: 'Belgium', BG: 'Bulgaria', BR: 'Brazil',
  CA: 'Canada', CH: 'Switzerland', CN: 'China', CY: 'Cyprus', CZ: 'Czechia',
  DE: 'Germany', DK: 'Denmark', EE: 'Estonia', ES: 'Spain', FI: 'Finland',
  FR: 'France', GB: 'United Kingdom', GR: 'Greece', HK: 'Hong Kong', HR: 'Croatia',
  HU: 'Hungary', IE: 'Ireland', IL: 'Israel', IN: 'India', IS: 'Iceland',
  IT: 'Italy', JP: 'Japan', LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia',
  MT: 'Malta', MX: 'Mexico', NL: 'Netherlands', NO: 'Norway', NZ: 'New Zealand',
  PL: 'Poland', PT: 'Portugal', RO: 'Romania', SE: 'Sweden', SG: 'Singapore',
  SI: 'Slovenia', SK: 'Slovakia', TR: 'Türkiye', UA: 'Ukraine', US: 'United States',
  ZA: 'South Africa', AE: 'United Arab Emirates', SA: 'Saudi Arabia',
}

const flag = (cc: string) =>
  /^[A-Za-z]{2}$/.test(cc)
    ? String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 127397 + ch.charCodeAt(0)))
    : '🏳️'

const countryName = (cc: string) => NAMES[cc.toUpperCase()] ?? (cc === '??' ? 'Not provided' : cc)

const pct = (r: number | null) => (r == null ? '—' : `${Math.round(r * 100)}%`)

type Signal = 'good' | 'opportunity' | 'watch' | 'neutral'

// Turn the raw numbers into a plain-English recommendation. Heuristics, clearly
// framed as suggestions — not a model.
function recommend(c: CountryInsight, avgVol: number): { signal: Signal; label: string; text: string } {
  const r = c.acceptance_rate
  const brand = c.top_brand && c.top_brand !== '—' ? c.top_brand : null
  const brandLine = brand ? ` ${brandLabel(brand)} leads here.` : ''
  if (r == null || c.transactions < 10) {
    return { signal: 'neutral', label: 'Low volume', text: 'Too few transactions to read a reliable signal yet.' }
  }
  const hiVol = c.transactions >= avgVol
  const cbRate = c.transactions ? c.chargebacks / c.transactions : 0
  if (r < 0.45) {
    return {
      signal: 'watch',
      label: 'High declines',
      text: `Only ${pct(r)} of attempts are approved — a lot of lost sales. Review issuer routing and add retry logic to recover them.${brandLine}`,
    }
  }
  if (cbRate > 0.02) {
    return {
      signal: 'watch',
      label: 'Chargeback risk',
      text: `Chargebacks are running hot (${fmtInt(c.chargebacks)} of ${fmtInt(c.transactions)}). Tighten risk checks before scaling volume here.`,
    }
  }
  if (r >= 0.65 && hiVol) {
    return {
      signal: 'good',
      label: 'Strong market',
      text: `Strong ${pct(r)} acceptance at high volume — one of your best markets. A prime place to acquire more customers.${brandLine}`,
    }
  }
  if (r >= 0.6 && !hiVol) {
    return {
      signal: 'opportunity',
      label: 'Growth opportunity',
      text: `Acceptance is healthy (${pct(r)}) but volume is still low — underpenetrated. Worth investing in acquisition here.${brandLine}`,
    }
  }
  return { signal: 'neutral', label: 'Steady', text: `Acceptance ${pct(r)} — performing around your portfolio average.${brandLine}` }
}

const brandLabel = (b: string) =>
  ({ MC: 'Mastercard', VISA: 'Visa', APPLEPAY: 'Apple Pay', GOOGLEPAY: 'Google Pay', AMEX: 'Amex' } as Record<string, string>)[
    b.toUpperCase()
  ] ?? b

const BRAND_COLORS: Record<string, string> = {
  APPLEPAY: '#aeb4bd', VISA: '#1a4fba', MC: '#e8641c', GOOGLEPAY: '#f5b400', AMEX: '#2e77bb',
}
const PALETTE = ['#7c3aed', '#0891b2', '#65a30d', '#db2777', '#ca8a04', '#0e7490']

// Continuous red→green ramp so each cohort reads as a distinct, intuitive tier.
const cohortColor = (approval: number) => {
  const t = Math.max(0, Math.min(1, (approval - 0.4) / 0.34)) // ~0.40..0.74
  return `hsl(${Math.round(t * 132)} 60% 44%)`
}

// Quick signal from an acceptance rate (used for issuer rows).
function rateSignal(rate: number | null): { signal: Signal; label: string } {
  if (rate == null) return { signal: 'neutral', label: '—' }
  if (rate < 0.45) return { signal: 'watch', label: 'High declines' }
  if (rate >= 0.65) return { signal: 'good', label: 'Strong' }
  if (rate >= 0.55) return { signal: 'opportunity', label: 'Steady' }
  return { signal: 'neutral', label: 'Mixed' }
}

type Seg = { label: string; value: number; color: string }

/** Dependency-free SVG donut that sweeps in (and counts its center up) on mount. */
function Donut({ segments, size = 132 }: { segments: Seg[]; size?: number }) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const p = useGrow(900, [total]) // 0→1 draw progress
  const stroke = 20
  const r = (size - stroke) / 2
  const C = 2 * Math.PI * r
  let acc = 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="donut" role="img">
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {/* track */}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--gray-bg)" strokeWidth={stroke} />
        {total > 0 && segments.filter((s) => s.value > 0).map((s) => {
          const frac = s.value / total
          // scale both the arc length and its start by the draw progress so the
          // whole ring sweeps clockwise from nothing to full.
          const dash = frac * C * p
          const seg = (
            <circle
              key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={s.color} strokeWidth={stroke}
              strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-acc * C * p}
            />
          )
          acc += frac
          return seg
        })}
      </g>
      <text x="50%" y="50%" className="donut-center" dominantBaseline="middle" textAnchor="middle">
        {fmtInt(Math.round(total * p))}
      </text>
    </svg>
  )
}

function Legend({ segments }: { segments: Seg[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  return (
    <div className="legend">
      {segments.filter((s) => s.value > 0).map((s) => (
        <div className="legend-row" key={s.label}>
          <span className="swatch" style={{ background: s.color }} />
          <span className="lg-label">{s.label}</span>
          <b className="num">{fmtInt(s.value)}</b>
          <span className="lg-pct">{Math.round((s.value / total) * 100)}%</span>
        </div>
      ))}
    </div>
  )
}

function DonutBlock({ heading, segments }: { heading: string; segments: Seg[] }) {
  return (
    <div className="chart-cell">
      <div className="mini-head">{heading}</div>
      <div className="chart-row">
        <Donut segments={segments} />
        <Legend segments={segments} />
      </div>
    </div>
  )
}

type PickedMerchant = { uuid: string; name: string }

export default function Insights() {
  const isAdmin = getUser()?.role === 'admin'
  const [selected, setSelected] = useState<PickedMerchant | null>(null)
  // Admins pick a merchant first (portfolio is too broad to read as one blob);
  // merchant users go straight to their own insights.
  if (isAdmin && !selected) return <MerchantLanding onPick={setSelected} />
  return <InsightsDetail merchant={selected} onBack={isAdmin ? () => setSelected(null) : undefined} />
}

// Admin landing: a portfolio summary, then one ranked metric card per merchant.
function MerchantLanding({ onPick }: { onPick: (m: PickedMerchant) => void }) {
  const { data, loading } = useApi(() => api<MerchantsResponse>('/api/insights/merchants'), [])
  const list = useMemo(() => data?.merchants ?? [], [data])

  // Rank by acceptance (who's doing better) — enough-volume merchants first, then
  // the long tail; the top of that list is the portfolio leader.
  const ranked = useMemo(() => {
    const score = (m: typeof list[number]) =>
      (m.acceptance_rate ?? -1) * (m.transactions >= 20 ? 1 : 0.5) // de-rank tiny samples
    return [...list].sort((a, b) => score(b) - score(a))
  }, [list])

  const totals = useMemo(() => {
    const acc = list.reduce((s, m) => s + (m.accepted ?? 0), 0)
    const dec = list.reduce((s, m) => s + (m.declined ?? 0), 0)
    return {
      merchants: list.length,
      transactions: list.reduce((s, m) => s + (m.transactions ?? 0), 0),
      accepted: acc, declined: dec,
      acceptance_rate: acc + dec ? acc / (acc + dec) : null,
      settlements: list.reduce((s, m) => s + (m.settlements ?? 0), 0),
    }
  }, [list])
  const leader = ranked.find((m) => m.acceptance_rate != null && m.transactions >= 20) ?? ranked[0]

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Insights</h1>
          <div className="sub">Pick a merchant to see where their card volume comes from</div>
        </div>
      </div>
      {loading && !data && <LoadingBlock label="Loading merchants…" />}
      {data && list.length === 0 && (
        <EmptyState title="No merchants to analyse yet" hint="Insights appear once transactions are imported." />
      )}
      {list.length > 0 && (
        <>
          <div className="insights-portfolio">
            <div className="ip-stat"><span className="eyebrow2">Merchants</span><b className="num"><CountUp value={totals.merchants} /></b></div>
            <div className="ip-stat"><span className="eyebrow2">Transactions</span><b className="num"><CountUp value={totals.transactions} /></b></div>
            <div className="ip-stat"><span className="eyebrow2">Overall acceptance</span><b className="num">{totals.acceptance_rate == null ? '—' : <CountUp value={totals.acceptance_rate * 100} format={(n) => `${Math.round(n)}%`} />}</b></div>
            <div className="ip-stat"><span className="eyebrow2">Settlements</span><b className="num"><CountUp value={totals.settlements} /></b></div>
            {leader && list.length > 1 && (
              <div className="ip-leader">
                <span className="eyebrow2">Top performer</span>
                <b title={leader.name}>★ {leader.name}</b>
                <span className="dim small">{pct(leader.acceptance_rate)} acceptance</span>
              </div>
            )}
          </div>

          <div className="insights-merchant-grid">
            {ranked.map((m, i) => {
              const sig = rateSignal(m.acceptance_rate)
              const isLeader = list.length > 1 && m.merchant_uuid === leader?.merchant_uuid
              return (
                <button
                  key={m.merchant_uuid}
                  className={`minsight-card${isLeader ? ' is-leader' : ''}`}
                  onClick={() => onPick({ uuid: m.merchant_uuid, name: m.name })}
                >
                  <div className="minsight-top">
                    <span className="minsight-name" title={m.name}>
                      <span className="minsight-rank">#{i + 1}</span> {m.name}
                    </span>
                    {isLeader ? <span className="signal-chip good">★ Top</span>
                      : <span className={`signal-chip ${sig.signal}`}>{sig.label}</span>}
                  </div>
                  <div className="minsight-donut">
                    <Donut
                      size={112}
                      segments={[
                        { label: 'Accepted', value: m.accepted ?? 0, color: '#12b76a' },
                        { label: 'Declined', value: m.declined ?? 0, color: '#f04438' },
                        ...((m.transactions ?? 0) - (m.accepted ?? 0) - (m.declined ?? 0) > 0
                          ? [{ label: 'Other', value: (m.transactions ?? 0) - (m.accepted ?? 0) - (m.declined ?? 0), color: '#98a2b3' }]
                          : []),
                      ]}
                    />
                    <div className="minsight-accrow">
                      <b className="num">{pct(m.acceptance_rate)}</b><span className="dim small">acceptance</span>
                    </div>
                  </div>
                  <div className="minsight-stats">
                    <div><span className="dim small">Accepted</span><b className="num" style={{ color: 'var(--green)' }}><CountUp value={m.accepted ?? 0} /></b></div>
                    <div><span className="dim small">Declined</span><b className="num" style={{ color: 'var(--red)' }}><CountUp value={m.declined ?? 0} /></b></div>
                    <div><span className="dim small">Settlements</span><b className="num"><CountUp value={m.settlements ?? 0} /></b></div>
                  </div>
                  {m.captured.length > 0 && (
                    <div className="minsight-cap">
                      {m.captured.map((v) => (
                        <span key={v.currency} className="cap-tag"><span className="ccy-tag">{v.currency}</span> {fmtMoney(v.minor, v.currency)}</span>
                      ))}
                    </div>
                  )}
                  <span className="minsight-go">View insights →</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function InsightsDetail({ merchant, onBack }: { merchant: PickedMerchant | null; onBack?: () => void }) {
  const [currency, setCurrency] = useState('')
  // Compose the shared query string (currency filter + optional merchant scope).
  const qs = (() => {
    const p = new URLSearchParams()
    if (currency) p.set('currency', currency)
    if (merchant) p.set('merchant', merchant.uuid)
    const s = p.toString()
    return s ? `?${s}` : ''
  })()
  const { data, loading } = useApi(
    () => api<CountryInsights>(`/api/insights/countries${qs}`),
    [currency, merchant?.uuid],
  )
  const { data: ml } = useApi(
    () => api<MLInsights>(`/api/insights/ml${qs}`),
    [currency, merchant?.uuid],
  )
  const { data: issuers } = useApi(
    () => api<IssuersResponse>(`/api/insights/issuers${qs}`),
    [currency, merchant?.uuid],
  )
  const [open, setOpen] = useState<Set<string>>(new Set())

  // Keep the "Not provided" bucket last — it isn't an actionable market.
  const countries = useMemo(() => {
    const arr = [...(data?.countries ?? [])]
    arr.sort((a, b) => (a.country === '??' ? 1 : 0) - (b.country === '??' ? 1 : 0))
    return arr
  }, [data])
  const avgVol = data && data.totals.countries ? data.totals.transactions / data.totals.countries : 0
  const recs = useMemo(
    () => new Map(countries.map((c) => [c.country, recommend(c, avgVol)])),
    [countries, avgVol],
  )


  const toggle = (cc: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(cc)) n.delete(cc)
      else n.add(cc)
      return n
    })
  // Consolidated report — all currencies (respecting the current filter), all
  // merchants, as a multi-sheet Excel workbook.
  const downloadReport = () => {
    const capStr = (cap: { currency: string; minor: number }[]) =>
      cap.map((v) => `${v.currency} ${toMajor(v.minor, v.currency).toLocaleString()}`).join('  ')
    const summary: Cell[][] = [
      ['Metric', 'Value'],
      ['Scope', currency ? `${currency} only` : 'All currencies'],
      ['Countries', totals?.countries ?? 0],
      ['Transactions', totals?.transactions ?? 0],
      ['Accepted', totals?.accepted ?? 0],
      ['Declined', totals?.declined ?? 0],
      ['Overall acceptance %', totals?.acceptance_rate != null ? Math.round(totals.acceptance_rate * 100) : ''],
      ['Model', ml?.model ? `${ml.model.type} (AUC ${ml.model.auc})` : 'n/a'],
      ['Recoverable', ml?.recoverable ? capStr(ml.recoverable.by_currency) : ''],
    ]
    const byCountry: Cell[][] = [
      ['Country', 'Code', 'Transactions', 'Accepted', 'Declined', 'Acceptance %', 'Top brand'],
      ...countries.map((c) => [countryName(c.country), c.country, c.transactions, c.accepted, c.declined,
        c.acceptance_rate != null ? Math.round(c.acceptance_rate * 100) : '', c.top_brand ? brandLabel(c.top_brand) : '']),
    ]
    const byIssuer: Cell[][] = [
      ['Issuing bank', 'BINs', 'Transactions', 'Accepted', 'Declined', 'Acceptance %', 'Top brand'],
      ...(issuers?.banks ?? []).map((b) => [b.bank, b.bin_count, b.transactions, b.accepted, b.declined,
        b.acceptance_rate != null ? Math.round(b.acceptance_rate * 100) : '', b.top_brand ? brandLabel(b.top_brand) : '']),
    ]
    downloadExcelWorkbook(merchant ? `insights-${merchant.name}` : 'insights-report', [
      { name: 'Summary', rows: summary },
      { name: 'By country', rows: byCountry },
      { name: 'By issuer', rows: byIssuer },
    ])
  }

  const totals = data?.totals

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          {onBack && (
            <button className="btn sm" onClick={onBack} style={{ marginBottom: 10 }}>← All merchants</button>
          )}
          <h1>{merchant ? merchant.name : 'Insights'}</h1>
          <div className="sub">Where {merchant ? 'their' : 'your'} card volume comes from — and where to grow</div>
        </div>
        {data && (
          <div className="head-actions">
            {data.currencies.length > 1 && (
              <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="">All currencies</option>
                {data.currencies.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            )}
            <button className="btn" onClick={downloadReport} disabled={!totals}>⬇ Download report</button>
          </div>
        )}
      </div>

      {loading && !data && <LoadingBlock label="Crunching country metrics…" />}

      {data && countries.length === 0 && (
        <EmptyState title="No transactions to analyse yet" hint="Insights appear once transactions are imported." />
      )}

      {totals && countries.length > 0 && (
        <>
          {/* Visual report hero — charts lead, tables below */}
          <ReportHero totals={totals} countries={countries} recoverable={ml?.recoverable} daily={data?.daily ?? []} />

          {/* ML predictions */}
          {ml?.available && <MLBand ml={ml} />}

          <div className="section-head report-divider">
            <span className="st">Detailed breakdown</span>
            <span className="dim small">Full tables — expand any row for the drill-down</span>
          </div>

          {/* Country table */}
          <div className="card">
            <div className="card-title">By country</div>
            <div className="table-wrap">
              <table className="data insights-table">
                <thead>
                  <tr>
                    <th>Country</th>
                    <th className="r">Transactions</th>
                    <th className="r">Accepted</th>
                    <th className="r">Declined</th>
                    <th>Acceptance</th>
                    <th>Top brand</th>
                    <th>Signal</th>
                    <th aria-label="expand" />
                  </tr>
                </thead>
                <tbody>
                  {countries.map((c) => {
                    const rec = recs.get(c.country)!
                    const mlc = ml?.countries?.[c.country]
                    const isOpen = open.has(c.country)
                    return (
                      <Fragment key={c.country}>
                        <tr className="insight-row" onClick={() => toggle(c.country)}>
                          <td>
                            <span className="ctry"><span className="flag">{flag(c.country)}</span>
                              <span>{countryName(c.country)} <span className="dim">{c.country}</span></span>
                            </span>
                          </td>
                          <td className="r num">{fmtInt(c.transactions)}</td>
                          <td className="r num" style={{ color: 'var(--green)' }}>{fmtInt(c.accepted)}</td>
                          <td className="r num" style={{ color: 'var(--red)' }}>{fmtInt(c.declined)}</td>
                          <td>
                            <div className="accept" title={pct(c.acceptance_rate)}>
                              <div className="accept-bar">
                                <div className={`accept-fill ${rec.signal}`} style={{ width: `${(c.acceptance_rate ?? 0) * 100}%` }} />
                              </div>
                              <span className="accept-pct">{pct(c.acceptance_rate)}</span>
                            </div>
                          </td>
                          <td>{c.top_brand ? brandLabel(c.top_brand) : '—'}</td>
                          <td><span className={`signal-chip ${rec.signal}`}>{rec.label}</span></td>
                          <td className="r"><span className={`chev${isOpen ? ' open' : ''}`}>›</span></td>
                        </tr>
                        {isOpen && (
                          <tr className="insight-detail">
                            <td colSpan={8}>
                              <div className="insight-detail-grid">
                                <div className="rec-box">
                                  <span className={`signal-chip ${rec.signal}`}>{rec.label}</span>
                                  <p>{rec.text}</p>
                                  <div className="rec-vol">
                                    {c.captured.map((v) => (
                                      <span key={v.currency} className="rec-vol-row">
                                        <span className="ccy-tag">{v.currency}</span>
                                        <b className="num">{fmtMoney(v.minor, v.currency)}</b>
                                      </span>
                                    ))}
                                    {(c.refunds > 0 || c.chargebacks > 0) && (
                                      <span className="dim small">{fmtInt(c.refunds)} refunds · {fmtInt(c.chargebacks)} chargebacks</span>
                                    )}
                                  </div>
                                </div>
                                <DonutBlock
                                  heading="Card brands"
                                  segments={c.brands.map((b, i) => ({
                                    label: brandLabel(b.brand),
                                    value: b.count,
                                    color: BRAND_COLORS[b.brand.toUpperCase()] ?? PALETTE[i % PALETTE.length],
                                  }))}
                                />
                                <DonutBlock
                                  heading="Accepted vs declined"
                                  segments={[
                                    { label: 'Accepted', value: c.accepted, color: '#12b76a' },
                                    { label: 'Declined', value: c.declined, color: '#f04438' },
                                    ...(c.transactions - c.accepted - c.declined > 0
                                      ? [{ label: 'Pending', value: c.transactions - c.accepted - c.declined, color: '#98a2b3' }]
                                      : []),
                                  ]}
                                />
                              </div>
                              {mlc && <PredictionBlock mlc={mlc} />}
                              {isOpen && <CountryIssuers country={c.country} currency={currency} merchant={merchant?.uuid} />}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {countries.some((c) => c.country === '??') && (
              <div className="table-note dim small">
                “Not provided” groups transactions whose country field was empty in the source file (largely the
                US processor export). They’re still counted in totals, just not attributed to a market.
              </div>
            )}
          </div>


        </>
      )}
    </div>
  )
}

// Portfolio-level ML band: recoverable revenue, market cohorts, anomalies.
function MLBand({ ml }: { ml: MLInsights }) {
  const m = ml.model
  return (
    <div className="ml-band">
      <div className="ml-band-head">
        <span className="ml-title">🤖 Predictions</span>
        {m && (
          <span className="ml-model" title={`Trained on ${fmtInt(m.n)} transactions · features: ${m.features.join(', ')}`}>
            {m.type} · AUC {m.auc.toFixed(2)} · {fmtInt(m.n)} txns
          </span>
        )}
      </div>
      <div className="grid grid-2">
        {/* Market cohorts */}
        <div className="card ml-card">
          <div className="mini-head">🗺 Market cohorts</div>
          {ml.clusters && ml.clusters.length > 0 ? (
            <div className="ml-cohorts">
              {ml.clusters.map((cl) => {
                const color = cohortColor(cl.approval)
                return (
                  <div className="ml-cohort" key={cl.name}>
                    <div className="ml-cohort-top">
                      <span className="ml-cohort-name"><span className="ml-dot" style={{ background: color }} />{cl.name}</span>
                      <span className="ml-cohort-rate">{pct(cl.approval)}</span>
                    </div>
                    <div className="ml-cohort-bar"><div style={{ width: `${cl.approval * 100}%`, background: color }} /></div>
                    <div className="ml-cohort-sub">
                      <span className="ml-flags">{cl.countries.slice(0, 10).map((c) => <span key={c} title={countryName(c)}>{flag(c)}</span>)}</span>
                      <span className="ml-cohort-count">{cl.size} {cl.size === 1 ? 'market' : 'markets'}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="dim small">Not enough markets to cluster.</div>
          )}
        </div>

        {/* Anomalies */}
        <div className="card ml-card">
          <div className="mini-head">🔎 Anomalies vs. expected</div>
          {ml.anomalies && ml.anomalies.length > 0 ? (
            <div className="ml-anoms">
              {ml.anomalies.map((a) => (
                <div className="ml-anom" key={a.country}>
                  <span className="flag">{flag(a.country)}</span>
                  <span className="ml-anom-name">{countryName(a.country)}</span>
                  <span className="ml-anom-nums"><b>{pct(a.actual_approval)}</b><span className="dim"> vs {pct(a.expected_approval)} exp</span></span>
                  <span className={`signal-chip ${a.direction === 'under' ? 'watch' : 'good'}`}>
                    {a.direction === 'under' ? 'below' : 'above'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="dim small">No statistical outliers.</div>
          )}
          <div className="ml-anom-note dim small">
            “Expected” is the approval rate the model predicts from each market’s card, issuer, ticket-size and
            timing mix. A gap flags a market doing better or worse than its mix alone explains.
          </div>
        </div>
      </div>
    </div>
  )
}

// Per-country: predicted (mix) vs actual approval + decline drivers.
function PredictionBlock({ mlc }: { mlc: MLCountry }) {
  const maxPp = Math.max(1, ...mlc.drivers.map((d) => d.pp))
  return (
    <div className="pred-block">
      <div className="mini-head">🤖 Prediction &amp; decline drivers</div>
      <div className="pred-grid">
        <div className="pred-nums">
          <div className="pred-num">
            <span className="dim small">Actual approval</span>
            <b>{pct(mlc.actual_approval)}</b>
          </div>
          <div className="pred-num">
            <span className="dim small">Expected from mix</span>
            <b>{pct(mlc.expected_approval)}</b>
          </div>
          <div className="pred-num">
            <span className="dim small">Gap vs expected</span>
            <b style={{ color: mlc.gap_pp < -1 ? 'var(--red)' : mlc.gap_pp > 1 ? 'var(--green)' : 'var(--ink)' }}>
              {mlc.gap_pp > 0 ? '+' : ''}{mlc.gap_pp} pts
            </b>
          </div>
          {mlc.recover_minor != null && mlc.recover_minor > 0 && (
            <div className="pred-num">
              <span className="dim small">Recoverable</span>
              <b>{fmtInt(mlc.recover_txns ?? 0)} txns</b>
            </div>
          )}
        </div>
        <div className="pred-drivers">
          <div className="dim small" style={{ marginBottom: 8 }}>What raises declines here (vs. your portfolio)</div>
          {mlc.drivers.length === 0 && <div className="dim small">Declines are in line with what the mix predicts — no standout driver.</div>}
          {mlc.drivers.map((d) => (
            <div className="driver-row" key={d.factor}>
              <span className="driver-label">{d.factor}</span>
              <div className="driver-bar"><div className="driver-fill" style={{ width: `${(d.pp / maxPp) * 100}%` }} /></div>
              <span className="driver-pp">+{d.pp} pts</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Lazy-loaded issuing-bank breakdown for one country (only fetched on expand).
function CountryIssuers({ country, currency, merchant }: { country: string; currency: string; merchant?: string }) {
  const { data, loading } = useApi(
    () => api<IssuersResponse>(`/api/insights/issuers?country=${encodeURIComponent(country)}${currency ? `&currency=${currency}` : ''}${merchant ? `&merchant=${merchant}` : ''}`),
    [country, currency, merchant],
  )
  if (loading && !data) {
    return <div className="issuers-block"><div className="mini-head">🏦 Issuing banks</div><div className="dim small">Loading…</div></div>
  }
  if (!data?.available) return null
  const banks = data.banks.slice(0, 8)
  return (
    <div className="issuers-block">
      <div className="mini-head">
        🏦 Top issuing banks{data.total_banks > banks.length ? ` — ${banks.length} of ${fmtInt(data.total_banks)}` : ''}
      </div>
      <div className="rank-list">
        {banks.map((b) => {
          const sig = rateSignal(b.acceptance_rate)
          return (
            <div className="bank-rank" key={b.bank}>
              <div className="br-name">
                <span className="br-title" title={b.bank}>{b.bank.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase())}</span>
                <span className="br-sub dim">{fmtInt(b.transactions)} txns · {b.top_brand ? brandLabel(b.top_brand) : '—'}</span>
              </div>
              <div className="rank-bar"><div className={`rank-fill ${sig.signal}`} style={{ width: `${(b.acceptance_rate ?? 0) * 100}%` }} /></div>
              <span className="rank-val num">{pct(b.acceptance_rate)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Small SVG area+line sparkline for the daily acceptance trend.
function AreaTrend({ points }: { points: number[] }) {
  if (points.length < 2) return null
  const w = 300, h = 60, px = 4, py = 6
  const max = Math.max(...points), min = Math.min(...points)
  const rng = max - min || 1
  const xs = points.map((_, i) => px + (i / (points.length - 1)) * (w - px * 2))
  const ys = points.map((v) => h - py - ((v - min) / rng) * (h - py * 2))
  const line = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  const area = `${xs[0].toFixed(1)},${h} ${line} ${xs[xs.length - 1].toFixed(1)},${h}`
  return (
    <svg className="trend" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={area} className="trend-fill" />
      <polyline points={line} className="trend-line" vectorEffect="non-scaling-stroke" />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="3.5" className="trend-dot" />
    </svg>
  )
}

// Visual-report hero: recoverable headline + trend, acceptance-by-market bars,
// and the portfolio accepted/declined donut — charts lead, tables come below.
function ReportHero({
  totals, countries, recoverable, daily,
}: {
  totals: CountryInsights['totals']
  countries: CountryInsight[]
  recoverable: MLInsights['recoverable']
  daily: CountryInsights['daily']
}) {
  const markets = countries.filter((c) => c.country !== '??' && c.acceptance_rate != null).slice(0, 8)
  const trend = daily.filter((d) => d.acceptance_rate != null).map((d) => d.acceptance_rate as number)
  const other = totals.transactions - totals.accepted - totals.declined
  const portfolio: Seg[] = [
    { label: 'Accepted', value: totals.accepted, color: '#12b76a' },
    { label: 'Declined', value: totals.declined, color: '#f04438' },
    ...(other > 0 ? [{ label: 'Pending', value: other, color: '#98a2b3' }] : []),
  ]
  return (
    <div className="report-hero">
      <div className="report-top">
        {/* Recoverable + trend */}
        <div className="card cardpad recover-hero">
          <div className="mini-head">💸 Recoverable revenue</div>
          {recoverable && recoverable.by_currency.length > 0 ? (
            <>
              <div className="recover-figs">
                {recoverable.by_currency.map((v) => (
                  <span className="recover-fig" key={v.currency}>{fmtMoney(v.minor, v.currency)}</span>
                ))}
              </div>
              <p className="report-note">
                Lift markets below <b>{pct(recoverable.target_approval)}</b> approval to your top-quartile rate →
                recover about <b>{fmtInt(recoverable.recover_txns)}</b> more approved transactions.
              </p>
            </>
          ) : (
            <div className="dim small">No underperforming segments to recover.</div>
          )}
          {trend.length > 1 && (
            <div className="trend-wrap">
              <div className="trend-head"><span>Daily acceptance</span><b className="num">{pct(trend[trend.length - 1])}</b></div>
              <AreaTrend points={trend} />
            </div>
          )}
        </div>

        {/* Acceptance by market */}
        <div className="card cardpad">
          <div className="mini-head">Acceptance by market</div>
          <div className="rank-list">
            {markets.map((m) => {
              const sig = rateSignal(m.acceptance_rate)
              return (
                <div className="rank-row" key={m.country}>
                  <span className="rank-lab"><span className="flag">{flag(m.country)}</span> {countryName(m.country)}</span>
                  <div className="rank-bar"><div className={`rank-fill ${sig.signal}`} style={{ width: `${(m.acceptance_rate ?? 0) * 100}%` }} /></div>
                  <span className="rank-val num">{pct(m.acceptance_rate)}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Portfolio donut + totals */}
      <div className="card cardpad portfolio-hero">
        <div className="portfolio-donut">
          <Donut segments={portfolio} size={124} />
          <div className="portfolio-legend">
            <div><span className="sw2" style={{ background: '#12b76a' }} /> Accepted <b className="num">{fmtInt(totals.accepted)}</b> <span className="dim">{pct(totals.acceptance_rate)}</span></div>
            <div><span className="sw2" style={{ background: '#f04438' }} /> Declined <b className="num">{fmtInt(totals.declined)}</b> <span className="dim">{pct(totals.acceptance_rate == null ? null : 1 - totals.acceptance_rate)}</span></div>
          </div>
        </div>
        <div className="portfolio-totals">
          <div className="pt"><div className="eyebrow2">Transactions</div><b className="num">{fmtInt(totals.transactions)}</b></div>
          <div className="pt"><div className="eyebrow2">Countries</div><b className="num">{fmtInt(totals.countries)}</b></div>
          <div className="pt"><div className="eyebrow2">Overall acceptance</div><b className="num">{pct(totals.acceptance_rate)}</b></div>
        </div>
      </div>
    </div>
  )
}
