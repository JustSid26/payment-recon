import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { api, clearSession, getUser } from '../lib/api'
import { Modal, toastError, toastSuccess } from './ui'
import type { AdminStatus } from '../lib/types'

const ADMIN_NAV = [
  { to: '/upload', label: 'Upload & Verify', icon: 'upload_file' },
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/merchants', label: 'Merchants', icon: 'storefront' },
  { to: '/transactions', label: 'Transactions', icon: 'receipt_long' },
  { to: '/settlements', label: 'Settlements', icon: 'payments' },
  { to: '/rolling-reserve', label: 'Rolling reserve', icon: 'savings' },
  { to: '/ledger', label: 'Ledger', icon: 'account_balance_wallet' },
  { to: '/integrity', label: 'Integrity', icon: 'verified_user' },
]

const MERCHANT_NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/transactions', label: 'Transactions', icon: 'receipt_long' },
  { to: '/settlements', label: 'Settlements', icon: 'payments' },
  { to: '/reserve', label: 'Reserve', icon: 'savings' },
  { to: '/ledger', label: 'Ledger', icon: 'account_balance_wallet' },
]

const PRESENTATION_KEY = 'tw_presentation'

export default function Layout() {
  const navigate = useNavigate()
  const user = getUser()

  const [presentation, setPresentation] = useState<boolean>(() => localStorage.getItem(PRESENTATION_KEY) === '1')
  const [showReset, setShowReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    document.body.classList.toggle('presentation', presentation)
    localStorage.setItem(PRESENTATION_KEY, presentation ? '1' : '0')
  }, [presentation])

  useEffect(() => () => document.body.classList.remove('presentation'), [])

  if (!user) return null

  const isAdmin = user.role === 'admin'
  const nav = isAdmin ? ADMIN_NAV : MERCHANT_NAV
  const initials = user.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  const logout = () => {
    clearSession()
    navigate('/login')
  }

  const doReset = async () => {
    setResetting(true)
    try {
      await api<{ ok: boolean; status: AdminStatus }>('/api/admin/reset', { method: 'POST' })
      toastSuccess('Cleared — ready for a fresh upload')
      setShowReset(false)
      navigate('/upload')
    } catch {
      toastError('Reset failed')
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="mark">TW</div>
          <div>
            <div className="name">TransactWorld</div>
            <div className="sub">Settlement &amp; Ledger</div>
          </div>
        </div>
        <nav>
          <div className="nav-section">{isAdmin ? 'Admin portal' : 'Merchant portal'}</div>
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <span className="material-symbols-outlined">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="avatar">{initials}</div>
          <div className="who">
            <div className="n" title={user.merchant_name ?? user.name}>
              {user.role === 'merchant' && user.merchant_name ? user.merchant_name : user.name}
            </div>
            <div className="r">{user.role}</div>
          </div>
          <button className="logout-btn" onClick={logout} title="Sign out">
            <span className="material-symbols-outlined">logout</span>
          </button>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <div className="tb-demo">
            <label className="switch" title="Client-facing presentation mode">
              <input
                type="checkbox"
                checked={presentation}
                onChange={(e) => setPresentation(e.target.checked)}
              />
              <span className="track"><span className="thumb" /></span>
              <span className="switch-label">Presentation mode</span>
            </label>
          </div>
          <div className="tb-actions">
            {isAdmin && (
              <button className="btn sm" onClick={() => setShowReset(true)}>
                ⟳ Reset demo
              </button>
            )}
            <button className="btn sm" onClick={logout}>Sign out</button>
          </div>
        </header>

        <main className="main">
          <Outlet />
        </main>

        <footer className="app-footer internal-only">
          Internal use only · TransactWorld Settlement &amp; Ledger · data for demonstration
        </footer>
      </div>

      {showReset && (
        <Modal
          title="Reset demo data"
          onClose={() => (resetting ? null : setShowReset(false))}
          footer={
            <>
              <button className="btn" onClick={() => setShowReset(false)} disabled={resetting}>Cancel</button>
              <button className="btn primary" onClick={() => void doReset()} disabled={resetting} style={{ background: 'var(--red)', borderColor: 'var(--red)' }}>
                {resetting ? 'Clearing…' : 'Clear all data'}
              </button>
            </>
          }
        >
          <div>
            Clear <b>ALL</b> imported data? This wipes every transaction, ledger entry and settlement so you can
            upload fresh in front of the client.
          </div>
          <div className="dim small">This cannot be undone.</div>
        </Modal>
      )}
    </div>
  )
}
