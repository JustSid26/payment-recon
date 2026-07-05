import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DailyVolumeRow } from '../lib/types'
import { currencyExponent, fmtMoney } from '../lib/money'
import { EmptyState } from './ui'

const SERIES_COLORS = ['#2a78d6', '#1baf7a', '#eda100', '#4a3aa7', '#e34948', '#e87ba4']

/**
 * Daily captured volume. Currencies have different units (and JPY a different
 * exponent), so they never share one axis: a tab bar picks the currency and the
 * chart shows a single series. Each currency keeps a fixed color regardless of
 * which one is selected.
 */
export default function VolumeChart({ rows }: { rows: DailyVolumeRow[] }) {
  const { currencies, totals, colorOf } = useMemo(() => {
    const totals = new Map<string, number>()
    for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.captured_minor)
    // Stable color assignment: alphabetical currency order → palette slot
    const alpha = Array.from(totals.keys()).sort()
    const colorOf = (c: string) => SERIES_COLORS[alpha.indexOf(c) % SERIES_COLORS.length]
    // Tab order: biggest captured volume first
    const currencies = alpha.slice().sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
    return { currencies, totals, colorOf }
  }, [rows])

  const [sel, setSel] = useState<string | null>(null)
  const active = sel && currencies.includes(sel) ? sel : currencies[0]

  const [chartType, setChartType] = useState<'bar' | 'line'>(
    () => (localStorage.getItem('tw_chart_type') === 'line' ? 'line' : 'bar'),
  )
  const chooseChart = (t: 'bar' | 'line') => {
    setChartType(t)
    localStorage.setItem('tw_chart_type', t)
  }

  const data = useMemo(() => {
    if (!active) return []
    const byDate = new Map<string, number>()
    for (const r of rows) {
      if (r.currency !== active) continue
      byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.captured_minor)
    }
    const exp = currencyExponent(active)
    return Array.from(byDate.keys())
      .sort()
      .map((date) => ({
        date,
        value: (byDate.get(date) ?? 0) / 10 ** exp,
        minor: byDate.get(date) ?? 0,
      }))
  }, [rows, active])

  if (!active || data.length === 0) {
    return <EmptyState title="No volume yet" hint="Captured transactions will appear here" icon="▁▃▅" />
  }

  const color = colorOf(active)
  const axes = [
    <CartesianGrid key="g" vertical={false} stroke="#eceef1" />,
    <XAxis
      key="x"
      dataKey="date"
      tick={{ fontSize: 11, fill: '#9ca3af' }}
      tickLine={false}
      axisLine={{ stroke: '#e5e7eb' }}
      tickFormatter={(d: string) => {
        const dt = new Date(d + 'T00:00:00Z')
        return isNaN(dt.getTime())
          ? d
          : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
      }}
    />,
    <YAxis
      key="y"
      tick={{ fontSize: 11, fill: '#9ca3af' }}
      tickLine={false}
      axisLine={false}
      width={56}
      tickFormatter={(v: number) =>
        new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
      }
    />,
    <Tooltip
      key="t"
      cursor={chartType === 'bar' ? { fill: 'rgba(17, 24, 39, 0.04)' } : { stroke: color, strokeWidth: 1 }}
      contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', boxShadow: '0 4px 12px rgba(16,24,40,0.08)', fontSize: 12 }}
      formatter={(_value, _name, item) => {
        const payload = (item as { payload?: { minor?: number } }).payload
        return [fmtMoney(payload?.minor ?? 0, active), `Captured (${active})`]
      }}
    />,
  ]

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', padding: '12px 16px 0' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {currencies.map((c) => (
            <button
              key={c}
              className="btn sm"
              onClick={() => setSel(c)}
              style={
                c === active
                  ? { borderColor: colorOf(c), color: colorOf(c), background: '#fff', boxShadow: `inset 0 0 0 1px ${colorOf(c)}` }
                  : undefined
              }
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: colorOf(c), display: 'inline-block' }} />
              {c}
              <span className="dim small num">{fmtMoney(totals.get(c) ?? 0, c)}</span>
            </button>
          ))}
        </div>
        <div className="seg">
          <button className={chartType === 'bar' ? 'on' : ''} onClick={() => chooseChart('bar')}>Bars</button>
          <button className={chartType === 'line' ? 'on' : ''} onClick={() => chooseChart('line')}>Line</button>
        </div>
      </div>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height="100%">
          {chartType === 'bar' ? (
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              {axes}
              <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              {axes}
              <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={{ r: 2.5, fill: color }} activeDot={{ r: 4 }} isAnimationActive={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}
