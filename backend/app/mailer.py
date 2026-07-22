"""Gmail-API mailer — sends transactional email via a single Google account.

Auth is OAuth2 with a long-lived refresh token (the standard "send as one
mailbox" setup): a Google Cloud project with the Gmail API enabled, an OAuth
client, and a refresh token minted once for the sending account. Configure via
env — if any of these are missing the mailer is DORMANT (send() returns a
skipped result instead of raising), so the app runs fine locally without creds:

  TW_GMAIL_CLIENT_ID       OAuth client id
  TW_GMAIL_CLIENT_SECRET   OAuth client secret
  TW_GMAIL_REFRESH_TOKEN   refresh token for the sending account
  TW_MAIL_FROM             From header, e.g. "TransactWorld <payouts@acme.com>"
  TW_MAIL_ENABLED          optional master switch ("0" force-disables)

No third-party deps: token refresh and message send go over stdlib urllib.
"""
from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from email.utils import parseaddr

_TOKEN_URL = "https://oauth2.googleapis.com/token"
_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"

_lock = threading.Lock()
_access_token: str | None = None
_token_expiry: float = 0.0


def _cfg(name: str) -> str:
    """Config value for a key: a DB override (set from the settings UI) wins,
    else the environment variable. Import is local to avoid a cycle at module load."""
    try:
        from . import settings_store
        override = settings_store.get(name)
    except Exception:
        override = None
    if override:
        return override.strip()
    return (os.environ.get(name) or "").strip()


def is_configured() -> bool:
    """True when Gmail creds are present and the master switch isn't off."""
    if _cfg("TW_MAIL_ENABLED") in ("0", "false", "no"):
        return False
    return all(_cfg(k) for k in
               ("TW_GMAIL_CLIENT_ID", "TW_GMAIL_CLIENT_SECRET",
                "TW_GMAIL_REFRESH_TOKEN", "TW_MAIL_FROM"))


def status() -> dict:
    """Non-secret config snapshot for a health/settings view."""
    return {
        "configured": is_configured(),
        "from": _cfg("TW_MAIL_FROM") or None,
        "disabled": _cfg("TW_MAIL_ENABLED") in ("0", "false", "no"),
    }


def _http_post(url: str, *, data: bytes, headers: dict, timeout: float = 10.0) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_access_token() -> str:
    """Exchange the refresh token for a short-lived access token (cached)."""
    global _access_token, _token_expiry
    with _lock:
        if _access_token and time.time() < _token_expiry - 30:
            return _access_token
        body = urllib.parse.urlencode({
            "client_id": _cfg("TW_GMAIL_CLIENT_ID"),
            "client_secret": _cfg("TW_GMAIL_CLIENT_SECRET"),
            "refresh_token": _cfg("TW_GMAIL_REFRESH_TOKEN"),
            "grant_type": "refresh_token",
        }).encode("utf-8")
        tok = _http_post(_TOKEN_URL, data=body,
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
        _access_token = tok["access_token"]
        _token_expiry = time.time() + int(tok.get("expires_in", 3600))
        return _access_token


def _build_mime(to: str, subject: str, html: str,
                attachments: list[tuple[str, str, bytes]] | None = None) -> str:
    msg = EmailMessage()
    msg["To"] = to
    msg["From"] = _cfg("TW_MAIL_FROM")
    msg["Subject"] = subject
    msg.set_content("This message requires an HTML-capable email client.")
    msg.add_alternative(html, subtype="html")
    for filename, mimetype, payload in (attachments or []):
        maintype, _, subtype = mimetype.partition("/")
        msg.add_attachment(payload, maintype=maintype or "application",
                           subtype=subtype or "octet-stream", filename=filename)
    return base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")


def send(to: str, subject: str, html: str,
         attachments: list[tuple[str, str, bytes]] | None = None) -> dict:
    """Send one HTML email (with optional attachments) via the Gmail API.

    Returns {"sent": True, "id": <gmail message id>} on success, or
    {"sent": False, "reason": ...} if the mailer is dormant / the address is
    blank / Gmail rejects it. Never raises for a config miss — callers can fire
    this from a request path without guarding.
    """
    to = (to or "").strip()
    if not to or "@" not in parseaddr(to)[1]:
        return {"sent": False, "reason": "no valid recipient address"}
    if not is_configured():
        return {"sent": False, "reason": "mailer not configured"}
    try:
        raw = _build_mime(to, subject, html, attachments)
        token = _get_access_token()
        out = _http_post(_SEND_URL, data=json.dumps({"raw": raw}).encode("utf-8"),
                         headers={"Authorization": f"Bearer {token}",
                                  "Content-Type": "application/json"})
        return {"sent": True, "id": out.get("id"), "to": to}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300] if hasattr(e, "read") else str(e)
        return {"sent": False, "reason": f"gmail api error {e.code}: {detail}"}
    except Exception as e:  # pragma: no cover - network/other
        return {"sent": False, "reason": f"{type(e).__name__}: {e}"}
