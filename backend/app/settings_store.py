"""Runtime settings overlay backed by the `app_settings` table.

The outbound mailer used to be env-only (TW_GMAIL_* / TW_MAIL_FROM). This module
lets an admin set those from the UI instead: values saved here are cached in
process and OVERRIDE the matching environment variable. Anything not set in the
DB falls back to the env var, so existing deployments keep working unchanged.

Only a small allow-list of keys is persisted (the mail config). The cache is
loaded lazily on first read and refreshed on every write.
"""
from __future__ import annotations

import threading

from .db import get_pool

# Keys the settings UI is allowed to store/override. Kept in sync with the env
# names mailer.py reads so the overlay is a drop-in for the environment.
MAIL_KEYS = (
    "TW_MAIL_FROM",
    "TW_MAIL_ENABLED",
    "TW_GMAIL_CLIENT_ID",
    "TW_GMAIL_CLIENT_SECRET",
    "TW_GMAIL_REFRESH_TOKEN",
)
# Never echoed back to the client — only a "set / not set" boolean is exposed.
SECRET_KEYS = frozenset({"TW_GMAIL_CLIENT_SECRET", "TW_GMAIL_REFRESH_TOKEN"})

_lock = threading.Lock()
_cache: dict[str, str] | None = None


def _load(conn) -> dict[str, str]:
    cur = conn.cursor()
    cur.execute("SELECT key, value FROM app_settings")
    return {r["key"]: r["value"] for r in cur.fetchall() if r["value"] not in (None, "")}


def refresh(conn) -> None:
    """Reload the overlay cache from an existing connection."""
    global _cache
    data = _load(conn)
    with _lock:
        _cache = data


def _ensure_loaded() -> dict[str, str]:
    global _cache
    with _lock:
        if _cache is not None:
            return _cache
    try:
        with get_pool().connection() as conn:
            data = _load(conn)
    except Exception:
        data = {}
    with _lock:
        if _cache is None:
            _cache = data
        return _cache


def get(name: str) -> str | None:
    """DB override for a key, or None to fall back to the environment."""
    return _ensure_loaded().get(name)


def save(conn, values: dict[str, str | None]) -> None:
    """Upsert the given keys. A value of None deletes the override (revert to env);
    an empty string is treated the same as None (cleared)."""
    cur = conn.cursor()
    for key in values:
        if key not in MAIL_KEYS:
            continue
        val = values[key]
        if val is not None:
            val = val.strip()
        if not val:
            cur.execute("DELETE FROM app_settings WHERE key=%s", (key,))
        else:
            cur.execute(
                """INSERT INTO app_settings (key, value, updated_at)
                   VALUES (%s, %s, now())
                   ON CONFLICT (key) DO UPDATE
                     SET value=EXCLUDED.value, updated_at=now()""",
                (key, val),
            )
    conn.commit()
    refresh(conn)


def mail_overview() -> dict:
    """Non-secret snapshot for the settings UI: which fields are set and from where."""
    data = _ensure_loaded()
    import os

    def source(key: str) -> str:
        if data.get(key):
            return "db"
        if (os.environ.get(key) or "").strip():
            return "env"
        return "unset"

    out: dict = {}
    for key in MAIL_KEYS:
        src = source(key)
        entry: dict = {"source": src, "set": src != "unset"}
        if key not in SECRET_KEYS:
            entry["value"] = data.get(key) or (os.environ.get(key) or "").strip() or None
        out[key] = entry
    return out
