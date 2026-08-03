import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { api, ApiError, clearSession, getUser } from '../lib/api'
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
  { to: '/settings', label: 'Settings', icon: 'settings' },
]

const MERCHANT_NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/transactions', label: 'Transactions', icon: 'receipt_long' },
  { to: '/settlements', label: 'Settlements', icon: 'payments' },
  { to: '/reserve', label: 'Reserve', icon: 'savings' },
  { to: '/ledger', label: 'Ledger', icon: 'account_balance_wallet' },
]

export default function Layout() {
  const navigate = useNavigate()
  const user = getUser()

  const [showReset, setShowReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [showPwd, setShowPwd] = useState(false)
  const [curPwd, setCurPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [savingPwd, setSavingPwd] = useState(false)

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

  const closePwd = () => {
    if (savingPwd) return
    setShowPwd(false)
    setCurPwd('')
    setNewPwd('')
    setConfirmPwd('')
  }

  const changePassword = async () => {
    if (newPwd.length < 6) return toastError('New password must be at least 6 characters')
    if (newPwd !== confirmPwd) return toastError('New passwords do not match')
    setSavingPwd(true)
    try {
      await api('/api/auth/merchant/change-password', {
        method: 'POST',
        body: { current_password: curPwd, new_password: newPwd },
      })
      toastSuccess('Password changed')
      closePwd()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Could not change password')
    } finally {
      setSavingPwd(false)
    }
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
          <div className="tb-actions" style={{ marginLeft: 'auto' }}>
            {isAdmin && (
              <button className="btn sm" onClick={() => setShowReset(true)}>
                ⟳ Reset demo
              </button>
            )}
            {!isAdmin && (
              <button className="btn sm" onClick={() => setShowPwd(true)}>
                🔑 Change password
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

      {showPwd && (
        <Modal
          title="Change your password"
          onClose={closePwd}
          footer={
            <>
              <button className="btn" onClick={closePwd} disabled={savingPwd}>Cancel</button>
              <button className="btn primary" onClick={() => void changePassword()} disabled={savingPwd}>
                {savingPwd ? 'Saving…' : 'Update password'}
              </button>
            </>
          }
        >
          <div className="form" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="cur-pwd">Current password</label>
              <input id="cur-pwd" className="input" type="password" autoComplete="current-password"
                value={curPwd} onChange={(e) => setCurPwd(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="new-pwd">New password</label>
              <input id="new-pwd" className="input" type="password" autoComplete="new-password"
                placeholder="At least 6 characters"
                value={newPwd} onChange={(e) => setNewPwd(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="confirm-pwd">Confirm new password</label>
              <input id="confirm-pwd" className="input" type="password" autoComplete="new-password"
                value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void changePassword()} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
