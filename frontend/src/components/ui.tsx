import { useEffect, useState, type ReactNode } from 'react'
import { fmtMoney } from '../lib/money'

/* ---------- StatusChip ---------- */

const CHIP_COLORS: Record<string, string> = {
  captured: 'green',
  completed: 'green',
  active: 'green',
  paid: 'green',
  ok: 'green',
  auth_failed: 'red',
  failed: 'red',
  voided: 'red',
  suspended: 'red',
  generated: 'blue',
  initiated: 'blue',
  pending: 'blue',
  refunded: 'amber',
  partially_refunded: 'amber',
  chargeback: 'amber',
}

export function StatusChip({ status }: { status: string }) {
  const color = CHIP_COLORS[status] ?? ''
  return <span className={`chip ${color}`}>{status.replace(/_/g, ' ')}</span>
}

/* ---------- MoneyCell ---------- */

export function MoneyCell({
  minor,
  currency,
  dimZero,
}: {
  minor: number
  currency: string
  dimZero?: boolean
}) {
  if (dimZero && minor === 0) return <span className="money dim">—</span>
  return <span className={`money${minor < 0 ? ' neg' : ''}`}>{fmtMoney(minor, currency)}</span>
}

/* ---------- DataTable ---------- */

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T, index: number) => ReactNode
  align?: 'left' | 'right'
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading,
  empty,
  skeletonRows = 6,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  loading?: boolean
  empty?: ReactNode
  skeletonRows?: number
}) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'ta-r' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key}>
                      <div className="skeleton" style={{ height: 14, width: '70%' }} />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row, i) => (
                <tr
                  key={rowKey(row)}
                  className={onRowClick ? 'click' : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={c.align === 'right' ? 'ta-r' : undefined}>
                      {c.render(row, i)}
                    </td>
                  ))}
                </tr>
              ))}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length}>{empty ?? <EmptyState title="No records found" />}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/* ---------- EmptyState ---------- */

export function EmptyState({ title, hint, icon = '◌' }: { title: string; hint?: string; icon?: string }) {
  return (
    <div className="empty">
      <div className="icon">{icon}</div>
      <div className="t">{title}</div>
      {hint && <div className="s">{hint}</div>}
    </div>
  )
}

/* ---------- Loading ---------- */

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-block">
      <div className="spinner" />
      {label}
    </div>
  )
}

export function SkeletonCard() {
  return (
    <div className="card card-pad">
      <div className="skeleton" style={{ height: 12, width: '45%' }} />
      <div className="skeleton" style={{ height: 24, width: '65%', marginTop: 12 }} />
    </div>
  )
}

/* ---------- Pager ---------- */

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number
  pageSize: number
  total: number
  onPage: (p: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <div className="pager">
      <span className="num">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="btns">
        <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ← Prev
        </button>
        <span style={{ alignSelf: 'center', padding: '0 6px' }} className="num">
          {page} / {pages}
        </span>
        <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next →
        </button>
      </div>
    </div>
  )
}

/* ---------- Modal ---------- */

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

/* ---------- Toasts (tiny pub/sub) ---------- */

interface ToastItem {
  id: number
  kind: 'error' | 'success' | 'info'
  message: string
}

type ToastListener = (t: ToastItem) => void
let toastListener: ToastListener | null = null
let toastId = 0

export function toast(message: string, kind: ToastItem['kind'] = 'info') {
  toastListener?.({ id: ++toastId, kind, message })
}
export const toastError = (m: string) => toast(m, 'error')
export const toastSuccess = (m: string) => toast(m, 'success')

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    toastListener = (t) => {
      setItems((prev) => [...prev, t])
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 4200)
    }
    return () => {
      toastListener = null
    }
  }, [])

  if (items.length === 0) return null
  return (
    <div className="toaster">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.kind === 'error' ? '⚠' : t.kind === 'success' ? '✓' : 'ℹ'}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  )
}
