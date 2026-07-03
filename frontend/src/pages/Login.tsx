import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, setSession } from '../lib/api'
import type { LoginResponse } from '../lib/types'

const DEMO_ACCOUNTS = [
  { label: 'Admin', email: 'admin@transactworld.com', password: 'demo123', sub: 'TransactWorld operations' },
  { label: 'Merchant', email: 'merchant@canamoney.com', password: 'demo123', sub: 'CANAMONEY EXCHANGE LTD.' },
]

export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const doLogin = async (em: string, pw: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: { email: em, password: pw },
      })
      setSession(res.token, res.user)
      navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void doLogin(email, password)
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
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
            />
          </div>
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
          <button className="btn primary" type="submit" disabled={busy} style={{ justifyContent: 'center' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="demo-chips">
          {DEMO_ACCOUNTS.map((a) => (
            <button
              key={a.email}
              type="button"
              className="demo-chip"
              disabled={busy}
              onClick={() => {
                setEmail(a.email)
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
