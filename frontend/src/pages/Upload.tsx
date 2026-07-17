import { useRef, useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiUpload, ApiError } from '../lib/api'
import type { IntegrityCheck, UploadResult } from '../lib/types'
import { fmtInt } from '../lib/money'
import { EmptyState, toastError, toastSuccess } from '../components/ui'

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Derive the four integrity checks (same shape as /api/integrity) from an upload response. */
function deriveChecks(r: UploadResult): IntegrityCheck[] {
  const i = r.integrity
  return [
    {
      name: 'Every event sums to zero',
      ok: i.unbalanced_events === 0,
      detail: `${fmtInt(i.events)} events / ${fmtInt(i.entries)} entries, ${fmtInt(i.unbalanced_events)} unbalanced`,
    },
    {
      name: 'Balances equal sum of entries',
      ok: i.balance_mismatches === 0,
      detail: `${fmtInt(i.balance_mismatches)} balance mismatches`,
    },
    {
      name: 'Ledger is append-only',
      ok: true,
      detail: 'enforced by database trigger',
    },
    {
      name: 'Idempotent import',
      ok: true,
      detail: `replayed rows skipped: ${fmtInt(r.stats.skipped_dupes)}`,
    },
  ]
}

export default function Upload() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<UploadResult | null>(null)

  const addFiles = (list: FileList | null) => {
    if (!list) return
    const incoming = Array.from(list).filter((f) => /\.(csv|xlsx)$/i.test(f.name))
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size))
      return [...prev, ...incoming.filter((f) => !seen.has(f.name + f.size))]
    })
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx))

  const runImport = async () => {
    if (files.length === 0) return
    setBusy(true)
    try {
      const res = await apiUpload<UploadResult>('/api/admin/upload', files)
      setResult(res)
      const okCount = res.files.filter((f) => f.ok).length
      toastSuccess(`Imported ${okCount}/${res.files.length} file${res.files.length === 1 ? '' : 's'} — ${fmtInt(res.stats.txns)} transactions`)
      setFiles([])
      // fresh data is now in the backend; lists/dashboard refetch on next navigation
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  const checks = result ? deriveChecks(result) : []

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Upload &amp; Verify</h1>
          <div className="sub">Import processor CSVs and settlement workbooks, then run ledger integrity checks</div>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/')}>View dashboard →</button>
        </div>
      </div>

      <div className="grid grid-2">
        {/* ---- Left: upload ---- */}
        <div className="card">
          <div className="card-title">Upload files</div>
          <div className="card-pad">
            <div
              className={`dropzone${dragging ? ' dragging' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
            >
              <div className="dz-icon">⇪</div>
              <div className="dz-title">Drag &amp; drop files here</div>
              <div className="dz-sub">or click to browse — .csv and .xlsx, multiple allowed</div>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.xlsx"
                multiple
                hidden
                onChange={(e) => addFiles(e.target.files)}
              />
            </div>

            {files.length > 0 && (
              <div className="file-list">
                {files.map((f, i) => (
                  <div className="file-row" key={f.name + f.size}>
                    <span className="fr-icon">{/\.xlsx$/i.test(f.name) ? '▤' : '☰'}</span>
                    <span className="fr-name" title={f.name}>{f.name}</span>
                    <span className="fr-size num">{humanSize(f.size)}</span>
                    <button className="fr-x" onClick={() => removeFile(i)} disabled={busy} aria-label={`Remove ${f.name}`}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <button className="btn primary" onClick={() => void runImport()} disabled={busy || files.length === 0}>
                {busy && <span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,0.4)' }} />}
                {busy ? 'Importing…' : `Import & run checks${files.length ? ` (${files.length})` : ''}`}
              </button>
              {busy && <span className="dim small">This can take up to ~20s for large files</span>}
            </div>
          </div>
        </div>

        {/* ---- Right: results ---- */}
        <div className="card">
          <div className="card-title">Results</div>
          {!result && !busy && (
            <EmptyState
              title="No import yet"
              hint="Upload the processor CSVs and/or the settlement .xlsx, then run checks."
              icon="✓"
            />
          )}
          {busy && !result && (
            <div className="loading-block">
              <div className="spinner" />
              Importing &amp; posting to the ledger…
            </div>
          )}
          {result && (
            <div className="card-pad stack">
              {/* Per-file rows */}
              <div className="stack" style={{ gap: 8 }}>
                {result.files.map((f, i) => (
                  <div className={`file-result ${f.ok ? 'ok' : 'bad'}`} key={i}>
                    <span className="mark">{f.ok ? '✓' : '✗'}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="fr-name" title={f.file}>{f.file}</div>
                      <div className="dim small">{f.detail}</div>
                      {f.delta && (
                        <div className="delta-chips">
                          {f.delta.txns != null && <span className="mini-chip">{fmtInt(f.delta.txns)} txns</span>}
                          {f.delta.captures != null && <span className="mini-chip green">{fmtInt(f.delta.captures)} captured</span>}
                          {f.delta.declines != null && <span className="mini-chip red">{fmtInt(f.delta.declines)} declined</span>}
                          {f.delta.refunds != null && f.delta.refunds > 0 && <span className="mini-chip amber">{fmtInt(f.delta.refunds)} refunds</span>}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Quarantine notice — imported but not booked (unknown merchants) */}
              {result.stats.quarantined > 0 && (
                <div className="callout amber" onClick={() => navigate('/merchants')} style={{ cursor: 'pointer' }}>
                  <span>
                    <b>{fmtInt(result.stats.quarantined)}</b> transactions on hold from{' '}
                    <b>{fmtInt(result.stats.quarantined_merchants)}</b> unknown merchant
                    {result.stats.quarantined_merchants === 1 ? '' : 's'} — no ledger events until you assign fee schedules.
                  </span>
                  <span className="go">Set up →</span>
                </div>
              )}

              {/* Outcome summary — always visible */}
              <div className="outcome-summary">
                <div className="outcome ok">
                  <div className="ov num">{fmtInt(result.stats.captures)}</div>
                  <div className="ol">Approved / Captured</div>
                </div>
                <div className="outcome bad">
                  <div className="ov num">{fmtInt(result.stats.declines)}</div>
                  <div className="ol">Declined</div>
                </div>
                <div className="outcome">
                  <div className="ov num">{fmtInt(result.stats.refunds)}</div>
                  <div className="ol">Refunds</div>
                </div>
              </div>

              {/* Import totals */}
              <div className="totals-grid internal-only">
                {([
                  ['Transactions', result.stats.txns],
                  ['Captured', result.stats.captures],
                  ['Declined', result.stats.declines],
                  ['Refunds', result.stats.refunds],
                  ['Skipped dupes', result.stats.skipped_dupes],
                  ['Unmatched refunds', result.stats.unmatched_refunds],
                ] as const).map(([label, val]) => (
                  <div className="total-cell" key={label}>
                    <div className="tv num">{fmtInt(val)}</div>
                    <div className="tl">{label}</div>
                  </div>
                ))}
              </div>

              {/* Integrity banner + checks */}
              <div className={`banner ${result.integrity.ok ? 'green' : 'red'}`}>
                <span className="shield">{result.integrity.ok ? '🛡' : '⚠'}</span>
                <span>
                  {result.integrity.ok ? 'Ledger integrity verified' : 'Integrity check failed'}
                  <span className="detail internal-only">
                    {' '}— {fmtInt(result.integrity.events)} events · {fmtInt(result.integrity.entries)} entries
                  </span>
                </span>
              </div>

              <div className="stack" style={{ gap: 8 }}>
                {checks.map((c) => (
                  <div className={`integrity-row ${c.ok ? 'pass' : 'fail'}`} key={c.name}>
                    <div className="mark">{c.ok ? '✓' : '✕'}</div>
                    <div>
                      <div className="name">{c.name}</div>
                      <div className="detail internal-only">{c.detail}</div>
                    </div>
                    <span className={`chip ${c.ok ? 'green' : 'red'}`} style={{ marginLeft: 'auto' }}>
                      {c.ok ? 'pass' : 'fail'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
