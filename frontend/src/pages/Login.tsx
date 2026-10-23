import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { api, ApiError, getToken, getUser, setSession } from '../lib/api'
import type { LoginResponse } from '../lib/types'

type Role = 'merchant' | 'admin'
type Mode = 'login' | 'set-password'

// The brand panel speaks to whoever is signing in: operators reconcile the whole
// book; merchants read their own payouts.
const BRAND: Record<Role, { line1: string; hl: string; sub: string; features: { t: string; s: string }[] }> = {
  admin: {
    line1: 'Every payout,',
    hl: 'reconciled.',
    sub: 'Import processor files, auto-reconcile into a double-entry ledger, and pay merchants per currency — reserves, fees and chargebacks tracked to the cent.',
    features: [
      { t: 'Double-entry ledger', s: 'Every cent posted append-only and fully auditable.' },
      { t: 'Per-currency settlements', s: 'T+N timing, day-wise payouts and running balances.' },
      { t: 'Reserves & chargebacks', s: 'Rolling reserve, refunds and CB fees handled automatically.' },
    ],
  },
  merchant: {
    line1: 'Your money,',
    hl: 'clearly settled.',
    sub: 'Track every settlement, read your per-currency statements, and see exactly what’s paid, pending and held — down to the cent.',
    features: [
      { t: 'Day-wise statements', s: 'Every processing day broken down and exportable.' },
      { t: 'Per-currency payouts', s: 'Balances, fees and net payout for each currency.' },
      { t: 'Clear reserves & refunds', s: 'See what’s held, released, refunded and charged back.' },
    ],
  },
}

function PasswordInput({
  id, value, onChange, placeholder, autoComplete, onEnter,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  onEnter?: () => void
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="pw-field">
      <input
        id={id}
        className="input"
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
        placeholder={placeholder}
        required
      />
      <button
        type="button"
        className="pw-toggle"
        tabIndex={-1}
        aria-label={show ? 'Hide password' : 'Show password'}
        onClick={() => setShow((s) => !s)}
      >
        <span className="material-symbols-outlined">{show ? 'visibility_off' : 'visibility'}</span>
      </button>
    </div>
  )
}

export default function Login({ role }: { role: Role }) {
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('login')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Already signed in? Don't show a login form — go to the app.
  if (getToken() && getUser()) return <Navigate to="/dashboard" replace />

  const reset = () => {
    setMode('login')
    setError(null)
    setNotice(null)
    setPassword('')
    setConfirm('')
  }

  const finish = (res: LoginResponse) => {
    setSession(res.token, res.user)
    navigate('/dashboard', { replace: true })
  }

  const doLogin = async (id: string, pw: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api<LoginResponse>('/api/auth/login', { method: 'POST', body: { email: id, password: pw } })
      finish(res)
    } catch (e) {
      // Only merchants have a first-login set-password path.
      if (role === 'merchant' && e instanceof ApiError && e.code === 'no_password_set') {
        setMode('set-password')
        setPassword('')
        setConfirm('')
        setNotice('First time signing in — choose a password for this merchant account.')
      } else {
        setError(e instanceof ApiError ? e.message : 'Login failed')
      }
    } finally {
      setBusy(false)
    }
  }

  const doSetPassword = async () => {
    if (password.length < 8) return setError('Password must be at least 8 characters.')
    if (password !== confirm) return setError('Passwords do not match.')
    setBusy(true)
    setError(null)
    try {
      const res = await api<LoginResponse>('/api/auth/merchant/set-password', {
        method: 'POST',
        body: { identifier, password },
      })
      finish(res)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not set password')
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (role === 'merchant' && mode === 'set-password') void doSetPassword()
    else void doLogin(identifier, password)
  }

  const isMerchant = role === 'merchant'
  const settingPw = isMerchant && mode === 'set-password'

  return (
    <div className="login-split">
      <aside className="login-brand">
        <div className="lb-brand">
          <div className="lb-mark">CS</div>
          <span>CoreServices</span>
        </div>
        <div className="lb-body" key={role}>
          <h1 className="lb-head">{BRAND[role].line1}<br /><span className="hl">{BRAND[role].hl}</span></h1>
          <p className="lb-sub">{BRAND[role].sub}</p>
          <ul className="lb-features">
            {BRAND[role].features.map((f) => (
              <li key={f.t}>
                <span className="lb-check material-symbols-outlined">check</span>
                <div><b>{f.t}</b><span>{f.s}</span></div>
              </li>
            ))}
          </ul>
        </div>
        <div className="lb-foot">Internal settlement &amp; ledger platform</div>
      </aside>

      <main className="login-form-panel">
        <div className="login-form-inner">
          <div className="brand-row lf-brand">
            <div className="lf-mark">CS</div>
            <div>
              <h1>CoreServices</h1>
              <div className="dim small">Settlement &amp; ledger platform</div>
            </div>
          </div>

          <Link to="/" className="lf-back">← Back to home</Link>

          <div className="login-animin">
          <div className="login-heading">
            <h2>{isMerchant ? 'Merchant sign in' : 'Admin sign in'}</h2>
            <div className="dim small">
              {isMerchant ? 'Sign in with your merchant ID or email.' : 'CoreServices operations console.'}
            </div>
          </div>

          <form className="form" onSubmit={onSubmit}>
            {error && <div className="form-error">{error}</div>}
            {notice && !error && <div className="form-notice">{notice}</div>}

            <div className="field">
              <label htmlFor="identifier">{isMerchant ? 'Merchant ID or email' : 'Email'}</label>
              <input
                id="identifier"
                className="input"
                type={isMerchant ? 'text' : 'email'}
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder={isMerchant ? '100123 or you@company.com' : 'you@company.com'}
                disabled={settingPw}
                required
              />
            </div>

            {settingPw ? (
              <>
                <div className="field">
                  <label htmlFor="new-password">New password</label>
                  <PasswordInput id="new-password" value={password} onChange={setPassword}
                    autoComplete="new-password" placeholder="At least 8 characters" />
                </div>
                <div className="field">
                  <label htmlFor="confirm-password">Confirm password</label>
                  <PasswordInput id="confirm-password" value={confirm} onChange={setConfirm}
                    autoComplete="new-password" placeholder="Re-enter password" onEnter={() => void doSetPassword()} />
                </div>
              </>
            ) : (
              <div className="field">
                <label htmlFor="password">Password</label>
                <PasswordInput id="password" value={password} onChange={setPassword}
                  autoComplete="current-password" placeholder="••••••••" />
              </div>
            )}

            <button className="btn primary" type="submit" disabled={busy} style={{ justifyContent: 'center' }}>
              {busy
                ? (settingPw ? 'Setting password…' : 'Signing in…')
                : (settingPw ? 'Set password & sign in' : 'Sign in')}
            </button>

            {isMerchant && (
              settingPw ? (
                <button type="button" className="link-btn" disabled={busy} onClick={reset}>
                  ← Back to sign in
                </button>
              ) : (
                <button
                  type="button"
                  className="link-btn"
                  disabled={busy}
                  onClick={() => {
                    setError(null)
                    if (!identifier.trim()) {
                      setNotice('Enter your merchant ID or email above, then set a password.')
                      return
                    }
                    setMode('set-password')
                    setPassword('')
                    setConfirm('')
                    setNotice('Choose a password for this merchant account.')
                  }}
                >
                  First time? Set your password
                </button>
              )
            )}
          </form>

          <div className="lf-switch">
            {isMerchant ? (
              <>Operations team? <Link to="/login/admin">Admin sign in →</Link></>
            ) : (
              <>Are you a merchant? <Link to="/login/merchant">Merchant sign in →</Link></>
            )}
          </div>
          </div>
        </div>
      </main>
    </div>
  )
}
