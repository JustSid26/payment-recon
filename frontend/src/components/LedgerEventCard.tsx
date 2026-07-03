import type { LedgerEvent } from '../lib/types'
import { fmtDateTime, fmtMoney } from '../lib/money'

/** DR/CR breakdown card for a single ledger event — always balances to zero. */
export default function LedgerEventCard({ event }: { event: LedgerEvent }) {
  const debits = event.entries.filter((e) => e.direction === 'debit')
  const credits = event.entries.filter((e) => e.direction === 'credit')
  const drTotal = debits.reduce((s, e) => s + e.amount_minor, 0)
  const crTotal = credits.reduce((s, e) => s + e.amount_minor, 0)
  const balanced = drTotal === crTotal

  return (
    <div className="event-card">
      <div className="event-card-head">
        <div className="etype">
          <span className="dot" />
          {event.event_type.replace(/_/g, ' ')}
        </div>
        <div className="when">{fmtDateTime(event.posted_at)}</div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Account</th>
              <th style={{ width: 70 }}>Dir</th>
              <th className="ta-r" style={{ width: 140 }}>
                Debit
              </th>
              <th className="ta-r" style={{ width: 140 }}>
                Credit
              </th>
            </tr>
          </thead>
          <tbody>
            {event.entries.map((e, i) => (
              <tr key={i}>
                <td>{e.account_label}</td>
                <td>
                  <span className={`dir-badge ${e.direction === 'debit' ? 'dr' : 'cr'}`}>
                    {e.direction === 'debit' ? 'DR' : 'CR'}
                  </span>
                </td>
                <td className="ta-r money">
                  {e.direction === 'debit' ? fmtMoney(e.amount_minor, event.currency) : <span className="dim">—</span>}
                </td>
                <td className="ta-r money">
                  {e.direction === 'credit' ? fmtMoney(e.amount_minor, event.currency) : <span className="dim">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="event-foot">
        <span>{balanced ? 'Balanced ✓ Σ = 0' : '⚠ Unbalanced'}</span>
        <span className="money">
          DR {fmtMoney(drTotal, event.currency)} · CR {fmtMoney(crTotal, event.currency)}
        </span>
      </div>
    </div>
  )
}
