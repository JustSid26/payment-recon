import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useApi } from '../lib/useApi'
import { LoadingBlock, StatusChip, toastError, toastSuccess } from '../components/ui'
import { ADMIN_TOUR, openTour } from '../lib/tour'
import { fmtInt } from '../lib/money'
import type { MailSettings, MailSendResult, Merchant } from '../lib/types'

// The subset of tour steps that map to an actual page, with their step index.
const TOUR_PAGES = ADMIN_TOUR.map((s, i) => ({ page: s.page, i })).filter(
  (x): x is { page: string; i: number } => Boolean(x.page),
)

export default function Settings() {
  const { data, loading, reload } = useApi(() => api<MailSettings>('/api/settings/mail'), [])
  const merchants = useApi(() => api<{ items: Merchant[] }>('/api/merchants'), [])

  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<MailSendResult | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [busy, setBusy] = useState(false)

  // Add-a-merchant form.
  const [mName, setMName] = useState('')
  const [mId, setMId] = useState('')
  const [mEmail, setMEmail] = useState('')
  const [mPass, setMPass] = useState('')
  const [addingMerchant, setAddingMerchant] = useState(false)

  const addMerchant = async () => {
    if (!mId.trim()) return toastError('Enter a merchant ID')
    if (mPass.length < 8) return toastError('Password must be at least 8 characters')
    setAddingMerchant(true)
    try {
      const res = await api<{ member_id: string; name: string }>('/api/merchants/create', {
        method: 'POST',
        body: { member_id: mId.trim(), password: mPass, name: mName.trim() || undefined, email: mEmail.trim() || undefined },
      })
      toastSuccess(`Merchant "${res.name}" created — they can sign in with ID ${res.member_id} + the password`)
      setMName(''); setMId(''); setMEmail(''); setMPass('')
      merchants.reload()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Could not create merchant')
    } finally {
      setAddingMerchant(false)
    }
  }

  // Handle the return from the Google "Connect Gmail" redirect.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    if (p.get('mail_connected')) {
      toastSuccess('Gmail connected — payout emails are ready to send')
      reload()
    } else if (p.get('mail_error')) {
      toastError(`Gmail connect failed: ${p.get('mail_error')}`)
    }
    if (p.get('mail_connected') || p.get('mail_error')) {
      window.history.replaceState({}, '', '/settings')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connectGmail = async () => {
    setConnecting(true)
    try {
      const res = await api<{ auth_url: string }>('/api/settings/mail/oauth/start')
      window.location.href = res.auth_url
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Could not start Google connect — check the server Gmail app is configured')
      setConnecting(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    try {
      await api('/api/settings/mail', { method: 'PUT', body: { refresh_token: '', enabled: false } })
      toastSuccess('Gmail disconnected — payout emails are off')
      reload()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Could not disconnect')
    } finally {
      setBusy(false)
    }
  }

  const sendTest = async () => {
    if (!testTo.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await api<MailSendResult>('/api/settings/mail/test', {
        method: 'POST',
        body: { to: testTo.trim() },
      })
      setTestResult(res)
      if (res.sent) toastSuccess(`Test email sent to ${res.to}`)
      else toastError(res.reason || 'Test email not sent')
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Could not send test email')
    } finally {
      setTesting(false)
    }
  }

  const status = data?.status

  return (
    <div className="stack settings-page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">Outbound email — the account that sends payout confirmations</div>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={reload} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Product tour &amp; help</div>
        <div className="settings-body">
          <div className="tour-help-head">
            <div className="dim small">
              New here, or need a refresher? Take the guided tour of the whole console, or jump
              straight to the page you want to know about.
            </div>
            <button className="btn primary" onClick={() => openTour(0)}>🧭 Take the full tour</button>
          </div>
          <div className="tour-pages">
            {TOUR_PAGES.map(({ page, i }) => (
              <button key={page} className="tour-page-btn" onClick={() => openTour(i)}>
                <span className="tp-name">{page}</span>
                <span className="tp-go material-symbols-outlined">arrow_forward</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Add a merchant</div>
        <div className="settings-body">
          <div className="dim small" style={{ marginBottom: 16 }}>
            Create a merchant login directly — set their ID and a password. They sign in with the
            merchant ID (or email) + this password; their fee schedule and data are added later via
            Upload &amp; Verify. No upload needed first.
          </div>
          <div className="settings-form">
            <div className="field">
              <label>Merchant name <span className="dim">· optional</span></label>
              <input className="input" placeholder="e.g. Acme Payments Ltd." value={mName} onChange={(e) => setMName(e.target.value)} />
            </div>
            <div className="field">
              <label>Merchant ID</label>
              <input className="input" placeholder="e.g. ACME01 — they log in with this" value={mId} onChange={(e) => setMId(e.target.value)} />
            </div>
            <div className="field">
              <label>Email <span className="dim">· optional (also works as a login)</span></label>
              <input className="input" placeholder="merchant@company.com" value={mEmail} onChange={(e) => setMEmail(e.target.value)} />
            </div>
            <div className="field">
              <label>Password <span className="dim">· at least 8 characters</span></label>
              <input className="input" type="text" autoComplete="off" placeholder="the password you'll give them" value={mPass} onChange={(e) => setMPass(e.target.value)} />
            </div>
            <div className="head-actions" style={{ marginTop: 4 }}>
              <button className="btn primary" onClick={() => void addMerchant()} disabled={addingMerchant}>
                {addingMerchant ? 'Creating…' : '+ Create merchant login'}
              </button>
            </div>
          </div>

          <div className="merchant-list-head">
            <span className="card-title" style={{ margin: 0 }}>Existing merchants</span>
            <span className="dim small">
              {merchants.data ? `${fmtInt(merchants.data.items.length)} total` : ''}
            </span>
          </div>
          {merchants.loading && !merchants.data ? (
            <div className="dim small">Loading merchants…</div>
          ) : (merchants.data?.items.length ?? 0) === 0 ? (
            <div className="dim small">No merchants yet — add one above, or upload data.</div>
          ) : (
            <div className="merchant-list">
              <div className="merchant-row head">
                <span>Merchant</span><span>Merchant ID</span><span>Email</span>
                <span>Status</span><span>Login</span>
              </div>
              {merchants.data!.items.map((m) => (
                <div className="merchant-row" key={m.merchant_uuid}>
                  <span className="mr-name"><b>{m.name}</b></span>
                  <span className="mono small">{m.member_id ?? '—'}</span>
                  <span className="small dim">{m.email ?? '—'}</span>
                  <StatusChip status={m.status} />
                  <span>
                    {m.has_login
                      ? <span className="preset-pill same">● set</span>
                      : <span className="preset-pill">no password</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {loading && !data && <LoadingBlock label="Loading settings…" />}

      {data && (
        <>
          <div className={`card settings-banner ${status?.configured ? 'ok' : 'warn'}`}>
            <div className="settings-body settings-status">
              <span className={`pay-pill ${status?.configured ? 'paid' : 'unpaid'}`}>
                {status?.configured ? '● Sending enabled' : '○ Not configured'}
              </span>
              <div className="dim small">
                {status?.configured
                  ? <>Payout confirmations will send from <b>{status.from}</b>.</>
                  : 'Fill in the sending account below to turn on payout-confirmation emails.'}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-title">Sending account</div>
            <div className="settings-body">
              <div className="dim small" style={{ marginBottom: 16 }}>
                Payout confirmations send from a connected Gmail account. Click{' '}
                <b>Connect Gmail</b>, sign in and approve — that's it. Nothing to copy or paste.
              </div>

              {status?.configured ? (
                <div className="head-actions" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="pay-pill paid">● Connected</span>
                  <span className="dim small">Sending from <b>{status.from}</b></span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    <button className="btn" onClick={() => void connectGmail()} disabled={connecting || busy}>
                      {connecting ? 'Redirecting…' : '🔗 Reconnect / switch account'}
                    </button>
                    <button className="btn" onClick={() => void disconnect()} disabled={busy || connecting}>
                      {busy ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn primary" onClick={() => void connectGmail()} disabled={connecting}>
                  {connecting ? 'Redirecting…' : '🔗 Connect Gmail'}
                </button>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-title">Send a test email</div>
            <div className="settings-body">
              <div className="dim small" style={{ marginBottom: 16 }}>
                Verify the sending account works before relying on automated payouts.
              </div>
              <div className="settings-test">
                <div className="field" style={{ flex: 1 }}>
                  <label>Recipient</label>
                  <input
                    className="input"
                    placeholder="you@example.com"
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                  />
                </div>
                <button
                  className="btn"
                  onClick={() => void sendTest()}
                  disabled={testing || !testTo.trim() || !status?.configured}
                  title={status?.configured ? '' : 'Connect Gmail first'}
                >
                  {testing ? 'Sending…' : '✉ Send test'}
                </button>
              </div>
              {testResult && (
                <div className="small" style={{ marginTop: 12, color: testResult.sent ? 'var(--green)' : 'var(--red)' }}>
                  {testResult.sent ? `Sent ✓ (message ${testResult.id})` : `Not sent: ${testResult.reason}`}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
