import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, setSession } from '../lib/api'
import type { LoginResponse } from '../lib/types'

type Role = 'merchant' | 'admin'
type Mode = 'login' | 'set-password'

const DEMO: Record<Role, { email: string; password: string; sub: string }> = {
  admin: { email: 'admin@transactworld.com', password: 'demo123', sub: 'TransactWorld operations' },
  merchant: { email: 'merchant@canamoney.com', password: 'demo123', sub: 'CANAMONEY EXCHANGE LTD.' },
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

export default function Login() {
  const navigate = useNavigate()
  const [role, setRole] = useState<Role>('merchant')
  const [mode, setMode] = useState<Mode>('login')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setMode('login')
    setError(null)
    setNotice(null)
    setPassword('')
    setConfirm('')
  }

  const switchRole = (r: Role) => {
    if (r === role) return
    setRole(r)
    setIdentifier('')
    reset()
  }

  const finish = (res: LoginResponse) => {
    setSession(res.token, res.user)
    navigate('/', { replace: true })
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
    if (password.length < 6) return setError('Password must be at least 6 characters.')
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

        <div className="role-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={isMerchant}
            className={isMerchant ? 'on' : ''}
            onClick={() => switchRole('merchant')}
          >
            Merchant
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!isMerchant}
            className={!isMerchant ? 'on' : ''}
            onClick={() => switchRole('admin')}
          >
            Admin
          </button>
        </div>

        <div className="login-heading">
          <h2>{isMerchant ? 'Merchant sign in' : 'Admin sign in'}</h2>
          <div className="dim small">
            {isMerchant ? 'Sign in with your merchant ID or email.' : 'TransactWorld operations console.'}
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
                  autoComplete="new-password" placeholder="At least 6 characters" />
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

        <button
          type="button"
          className="demo-chip"
          disabled={busy}
          onClick={() => {
            reset()
            const d = DEMO[role]
            setIdentifier(d.email)
            setPassword(d.password)
            void doLogin(d.email, d.password)
          }}
        >
          <div className="t">Use {isMerchant ? 'merchant' : 'admin'} demo</div>
          <div className="s">{DEMO[role].email}</div>
          <div className="s">{DEMO[role].sub}</div>
        </button>
      </div>
    </div>
  )
}
