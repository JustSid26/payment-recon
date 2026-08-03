import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, setSession } from '../lib/api'
import type { LoginResponse } from '../lib/types'

const DEMO_ACCOUNTS = [
  { label: 'Admin', email: 'admin@transactworld.com', password: 'demo123', sub: 'TransactWorld operations' },
  { label: 'Merchant', email: 'merchant@canamoney.com', password: 'demo123', sub: 'CANAMONEY EXCHANGE LTD.' },
]

type Mode = 'login' | 'set-password'

export default function Login() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('login')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const finish = (res: LoginResponse) => {
    setSession(res.token, res.user)
    navigate('/', { replace: true })
  }

  const doLogin = async (id: string, pw: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: { email: id, password: pw },
      })
      finish(res)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_password_set') {
        // First login for this merchant — let them choose a password.
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
    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
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
    if (mode === 'set-password') void doSetPassword()
    else void doLogin(identifier, password)
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="brand-row">
          <div className="mark" style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'linear-gradient(135deg, #2563eb, #7c3aed)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 16,
          }}>
            TW
          </div>
          <div>
            <h1>TransactWorld</h1>
            <div className="dim small">Merchant settlement &amp; ledger platform</div>
          </div>
        </div>

        <form className="form" onSubmit={onSubmit}>
          {error && <div className="form-error">{error}</div>}
          {notice && !error && <div className="form-notice">{notice}</div>}
          <div className="field">
            <label htmlFor="identifier">Merchant ID or email</label>
            <input
              id="identifier"
              className="input"
              type="text"
              autoComplete="username"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="100123 or you@company.com"
              disabled={mode === 'set-password'}
              required
            />
          </div>
          {mode === 'login' ? (
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="new-password">New password</label>
                <input
                  id="new-password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="confirm-password">Confirm password</label>
                <input
                  id="confirm-password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter password"
                  required
                />
              </div>
            </>
          )}
          <button className="btn primary" type="submit" disabled={busy} style={{ justifyContent: 'center' }}>
            {busy
              ? (mode === 'set-password' ? 'Setting password…' : 'Signing in…')
              : (mode === 'set-password' ? 'Set password & sign in' : 'Sign in')}
          </button>
          {mode === 'set-password' ? (
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={() => { setMode('login'); setError(null); setNotice(null) }}
            >
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
          )}
        </form>

        <div className="demo-chips">
          {DEMO_ACCOUNTS.map((a) => (
            <button
              key={a.email}
              type="button"
              className="demo-chip"
              disabled={busy}
              onClick={() => {
                setMode('login')
                setIdentifier(a.email)
                setPassword(a.password)
                void doLogin(a.email, a.password)
              }}
            >
              <div className="t">{a.label} demo</div>
              <div className="s">{a.email}</div>
              <div className="s">{a.sub}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
