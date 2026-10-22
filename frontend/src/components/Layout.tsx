import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api, ApiError, clearSession, getUser } from '../lib/api'
import { Modal, toastError, toastSuccess } from './ui'
import Tour from './Tour'
import { ADMIN_TOUR, MERCHANT_TOUR, TOUR_EVENT, TOUR_VERSION, openTour } from '../lib/tour'
import type { AdminStatus } from '../lib/types'

// "Reset demo" wipes ALL data — it belongs only on the demo box / local dev, never on
// a client production deployment.
const IS_DEMO_HOST = typeof window !== 'undefined' &&
  ['app.paymentrecon.site', 'localhost', '127.0.0.1'].includes(window.location.hostname)

type NavItem = { to: string; label: string; icon: string; end?: boolean; tour?: string }

const ADMIN_NAV: NavItem[] = [
  { to: '/upload', label: 'Upload & Verify', icon: 'upload_file', tour: 'upload' },
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true, tour: 'dashboard' },
  { to: '/merchants', label: 'Merchants', icon: 'storefront', tour: 'merchants' },
  { to: '/transactions', label: 'Transactions', icon: 'receipt_long', tour: 'transactions' },
  { to: '/settlements', label: 'Settlements', icon: 'payments', tour: 'settlements' },
  { to: '/rolling-reserve', label: 'Rolling reserve', icon: 'savings', tour: 'rolling-reserve' },
  { to: '/ledger', label: 'Ledger', icon: 'account_balance_wallet', tour: 'ledger' },
  { to: '/insights', label: 'Insights', icon: 'insights', tour: 'insights' },
  { to: '/integrity', label: 'Integrity', icon: 'verified_user', tour: 'integrity' },
  { to: '/settings', label: 'Settings', icon: 'settings', tour: 'settings' },
]

const MERCHANT_NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true, tour: 'dashboard' },
  { to: '/transactions', label: 'Transactions', icon: 'receipt_long', tour: 'transactions' },
  { to: '/settlements', label: 'Settlements', icon: 'payments', tour: 'settlements' },
  { to: '/reserve', label: 'Reserve', icon: 'savings', tour: 'reserve' },
  { to: '/ledger', label: 'Ledger', icon: 'account_balance_wallet', tour: 'ledger' },
  { to: '/insights', label: 'Insights', icon: 'insights', tour: 'insights' },
]

export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const user = getUser()

  // Mobile nav drawer — closes whenever the route changes.
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => { setNavOpen(false) }, [location.pathname])

  const [showReset, setShowReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [showPwd, setShowPwd] = useState(false)
  const [curPwd, setCurPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [savingPwd, setSavingPwd] = useState(false)

  // Onboarding tour. Auto-shown once per user on first sign-in; keyed per
  // account so a shared browser doesn't hide it from the next person to log in.
  const tourSteps = user?.role === 'admin' ? ADMIN_TOUR : MERCHANT_TOUR
  const tourKey = `cs_tour_${TOUR_VERSION}_${user?.role}_${user?.merchant_uuid ?? 'admin'}`
  const [showTour, setShowTour] = useState(false)
  const [tourStart, setTourStart] = useState(0)
  // A real merchant to walk into for the "configure a merchant" steps.
  const [tourMerchant, setTourMerchant] = useState<string | undefined>()

  useEffect(() => {
    if (!showTour || user?.role !== 'admin' || tourMerchant) return
    api<{ items: { merchant_uuid: string }[] }>('/api/merchants')
      .then((r) => setTourMerchant(r.items[0]?.merchant_uuid))
      .catch(() => {})
  }, [showTour, user, tourMerchant])

  useEffect(() => {
    if (!user) return
    if (localStorage.getItem(tourKey)) return
    // let the first paint settle so the nav targets exist to spotlight
    const t = window.setTimeout(() => { setTourStart(0); setShowTour(true) }, 450)
    return () => window.clearTimeout(t)
  }, [user, tourKey])

  // Replay / jump-to-page requests from the top bar and the Settings help panel.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const idx = (e as CustomEvent<{ startIndex?: number }>).detail?.startIndex ?? 0
      setTourStart(idx)
      setShowTour(true)
    }
    window.addEventListener(TOUR_EVENT, onOpen)
    return () => window.removeEventListener(TOUR_EVENT, onOpen)
  }, [])

  const closeTour = () => {
    localStorage.setItem(tourKey, '1')
    setShowTour(false)
  }

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
    if (newPwd.length < 8) return toastError('New password must be at least 8 characters')
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
    <div className={`shell${navOpen ? ' nav-open' : ''}`}>
      {showTour && <Tour key={tourStart} steps={tourSteps} startIndex={tourStart} onClose={closeTour} context={{ merchant: tourMerchant }} />}
      <div className="nav-backdrop" onClick={() => setNavOpen(false)} />
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="mark">CS</div>
          <div>
            <div className="name">CoreServices</div>
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
              data-tour={item.tour}
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
          <button className="nav-toggle" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <span className="material-symbols-outlined">menu</span>
          </button>
          <div className="topbar-brand">
            <span className="mark">CS</span>
            <span>CoreServices</span>
          </div>
          <div className="tb-actions" style={{ marginLeft: 'auto' }}>
            {isAdmin && IS_DEMO_HOST && (
              <button className="btn sm" onClick={() => setShowReset(true)}>
                ⟳ Reset demo
              </button>
            )}
            {!isAdmin && (
              <>
                <button className="btn sm" onClick={() => openTour()}>
                  🧭 Take a tour
                </button>
                <button className="btn sm" onClick={() => setShowPwd(true)} data-tour="account">
                  🔑 Change password
                </button>
              </>
            )}
          </div>
        </header>

        <main className="main" data-tour="page-main">
          <Outlet />
        </main>

        <footer className="app-footer internal-only">
          Internal use only · CoreServices Settlement &amp; Ledger · data for demonstration
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
                placeholder="At least 8 characters"
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
