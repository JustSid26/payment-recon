import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useApi } from '../lib/useApi'
import { LoadingBlock, toastError, toastSuccess } from '../components/ui'
import type { MailSettings, MailSendResult } from '../lib/types'

export default function Settings() {
  const { data, loading, reload } = useApi(() => api<MailSettings>('/api/settings/mail'), [])

  // Editable form state, seeded from the server config once it loads.
  const [fromAddr, setFromAddr] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [saving, setSaving] = useState(false)

  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<MailSendResult | null>(null)

  useEffect(() => {
    if (!data) return
    setFromAddr(data.config.TW_MAIL_FROM.value ?? '')
    setEnabled(!data.status.disabled)
    setClientId(data.config.TW_GMAIL_CLIENT_ID.value ?? '')
    setClientSecret('')
    setRefreshToken('')
  }, [data])

  const secretSet = (k: 'TW_GMAIL_CLIENT_SECRET' | 'TW_GMAIL_REFRESH_TOKEN') =>
    data?.config[k].set ?? false

  const save = async () => {
    setSaving(true)
    try {
      // Secrets are write-only: only send them when the admin typed a new value,
      // otherwise omit so the stored one is kept.
      const body: Record<string, unknown> = {
        from_addr: fromAddr.trim(),
        enabled,
        client_id: clientId.trim(),
      }
      if (clientSecret.trim()) body.client_secret = clientSecret.trim()
      if (refreshToken.trim()) body.refresh_token = refreshToken.trim()
      await api<MailSettings>('/api/settings/mail', { method: 'PUT', body })
      toastSuccess('Mail settings saved')
      setClientSecret('')
      setRefreshToken('')
      reload()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : 'Could not save settings')
    } finally {
      setSaving(false)
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
                Emails send through the Gmail API. Enter the sender address and its OAuth
                credentials (client ID/secret + refresh token minted for that mailbox).
                Saved values override the server env vars — no redeploy needed.
              </div>

              <div className="settings-form">
              <div className="field">
                <label>From address</label>
                <input
                  className="input"
                  placeholder="TransactWorld &lt;payouts@yourdomain.com&gt;"
                  value={fromAddr}
                  onChange={(e) => setFromAddr(e.target.value)}
                />
              </div>

              <label className="switch" style={{ marginTop: 4 }}>
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                <span className="track"><span className="thumb" /></span>
                <span className="switch-label">Sending enabled</span>
              </label>

              <div className="field">
                <label>Gmail OAuth client ID</label>
                <input
                  className="input"
                  placeholder="xxxxxxxx.apps.googleusercontent.com"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              </div>

              <div className="field">
                <label>
                  Gmail OAuth client secret{' '}
                  <span className="dim">{secretSet('TW_GMAIL_CLIENT_SECRET') ? '· saved' : '· not set'}</span>
                </label>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  placeholder={secretSet('TW_GMAIL_CLIENT_SECRET') ? 'Leave blank to keep current' : 'Paste client secret'}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              </div>

              <div className="field">
                <label>
                  Gmail refresh token{' '}
                  <span className="dim">{secretSet('TW_GMAIL_REFRESH_TOKEN') ? '· saved' : '· not set'}</span>
                </label>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  placeholder={secretSet('TW_GMAIL_REFRESH_TOKEN') ? 'Leave blank to keep current' : 'Paste refresh token'}
                  value={refreshToken}
                  onChange={(e) => setRefreshToken(e.target.value)}
                />
              </div>

              <div className="head-actions" style={{ marginTop: 4 }}>
                <button className="btn primary" onClick={() => void save()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save settings'}
                </button>
                </div>
              </div>
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
                  title={status?.configured ? '' : 'Configure and save the sending account first'}
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
