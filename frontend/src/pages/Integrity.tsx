import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import type { IntegrityReport } from '../lib/types'
import { LoadingBlock } from '../components/ui'

export default function Integrity() {
  const { data, loading, reload } = useApi(() => api<IntegrityReport>('/api/integrity'), [])

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Ledger integrity</h1>
          <div className="sub">Live invariant checks run directly against the ledger</div>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={reload} disabled={loading}>
            ↻ Re-run checks
          </button>
        </div>
      </div>

      {loading && <LoadingBlock label="Running integrity checks…" />}

      {data && (
        <>
          <div className="card">
            <div className="integrity-hero">
              <div className="shield">{data.ok ? '🛡️' : '⚠️'}</div>
              <div className="t" style={{ color: data.ok ? 'var(--green)' : 'var(--red)' }}>
                {data.ok ? 'All integrity checks passed' : 'Integrity check failure detected'}
              </div>
              <div className="s">
                {data.ok
                  ? 'Every posting balances, every balance reconciles, and history is immutable.'
                  : 'One or more ledger invariants failed — see details below.'}
              </div>
            </div>
          </div>

          <div className="stack">
            {data.checks.map((c) => (
              <div className={`integrity-row ${c.ok ? 'pass' : 'fail'}`} key={c.name}>
                <div className="mark">{c.ok ? '✓' : '✕'}</div>
                <div>
                  <div className="name">{c.name}</div>
                  <div className="detail internal-only">{c.detail}</div>
                </div>
                <span
                  className={`chip ${c.ok ? 'green' : 'red'}`}
                  style={{ marginLeft: 'auto' }}
                >
                  {c.ok ? 'pass' : 'fail'}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
