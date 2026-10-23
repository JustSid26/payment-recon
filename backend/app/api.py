from __future__ import annotations

from datetime import datetime, timezone
import json
import time
import urllib.parse
import urllib.request

import jwt

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from . import auth as auth_mod
from .auth import current_user, require_admin
from .db import get_pool
from .money import fmt
from . import settle as settle_mod
from . import cycle as cycle_mod
from . import onboarding as onboarding_mod
from . import mailer as mailer_mod
from . import settlement_email as settlement_email_mod
from . import settings_store as settings_store_mod

app = FastAPI(title="CoreServices Ledger API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])

from .admin import router as admin_router  # noqa: E402
app.include_router(admin_router)

_FX_FALLBACK_TO_USD = {
    "USD": 1.0,
    "EUR": 1.0850,
    "AUD": 0.6650,
    "CAD": 0.7350,
    "GBP": 1.2700,
    "JPY": 0.0069,
}
_FX_CACHE: dict = {"ts": 0.0, "payload": None}


def _fx_rates_to_usd() -> dict:
    """Best-effort live FX for display only; falls back to demo rates offline."""
    now = time.time()
    if _FX_CACHE["payload"] and now - _FX_CACHE["ts"] < 60 * 30:
        return _FX_CACHE["payload"]
    try:
        with urllib.request.urlopen("https://open.er-api.com/v6/latest/USD", timeout=2) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        rates = data.get("rates") or {}
        payload = {
            "base": "USD",
            "source": "open.er-api.com",
            "as_of": data.get("time_last_update_utc") or data.get("time_last_update_unix"),
            "fallback": False,
            "rates": {
                c: (1.0 if c == "USD" else round(1 / float(rates[c]), 8))
                for c in rates
                if c == "USD" or rates.get(c)
            },
        }
    except Exception:
        payload = {
            "base": "USD",
            "source": "demo-fallback",
            "as_of": datetime.now(timezone.utc).isoformat(),
            "fallback": True,
            "rates": _FX_FALLBACK_TO_USD,
        }
    _FX_CACHE.update({"ts": now, "payload": payload})
    return payload


def err(status: int, code: str, message: str):
    raise HTTPException(status, detail={"error": {"code": code, "message": message}})


def scope_merchant_id(user: dict, requested_uuid: str | None, cur) -> int | None:
    """Merchant tokens are hard-scoped server-side; admin may filter freely."""
    if user["role"] == "merchant":
        return user["merchant_id"]
    if requested_uuid:
        cur.execute("SELECT id FROM merchants WHERE merchant_uuid=%s", (requested_uuid,))
        row = cur.fetchone()
        if row is None:
            err(404, "not_found", "merchant not found")
        return row["id"]
    return None


@app.get("/api/fx-rates")
def fx_rates(currencies: str | None = None, user: dict = Depends(current_user)):
    payload = _fx_rates_to_usd()
    requested = [c.strip().upper() for c in currencies.split(",")] if currencies else []
    if requested:
        rates = {c: payload["rates"].get(c, _FX_FALLBACK_TO_USD.get(c, 1.0)) for c in requested}
    else:
        rates = payload["rates"]
    return {
        "base": payload["base"],
        "source": payload["source"],
        "as_of": payload["as_of"],
        "fallback": payload["fallback"],
        "rates": rates,
    }


# ---------------------------------------------------------------- auth
class LoginBody(BaseModel):
    email: str
    password: str


MIN_PASSWORD_LEN = 8


def _resolve_merchant_login(cur, identifier: str):
    """Find a merchant by member_id (exact) or contact email (case-insensitive).
    member_id wins if both somehow match. Returns the row dict or None."""
    cur.execute(
        """SELECT id, merchant_uuid, name, member_id, email
             FROM merchants
            WHERE member_id = %(id)s OR lower(email) = lower(%(id)s)
            ORDER BY (member_id = %(id)s) DESC, id
            LIMIT 1""",
        {"id": identifier},
    )
    return cur.fetchone()


def _merchant_session(m, token_sub: str):
    """Build the {token, user} payload for a logged-in merchant."""
    merchant_uuid = str(m["merchant_uuid"])
    token = auth_mod.mint(token_sub, m["name"], "merchant", merchant_uuid, m["id"])
    return {"token": token, "user": {"name": m["name"], "role": "merchant",
                                     "merchant_uuid": merchant_uuid,
                                     "merchant_name": m["name"]}}


@app.post("/api/auth/login")
def login(body: LoginBody):
    identifier = body.email.strip()
    # 1) Seeded demo accounts (admin + the canned Canamoney merchant) keep working.
    u = auth_mod.DEMO_USERS.get(identifier.lower())
    if u:
        if u["password"] != body.password:
            err(401, "bad_credentials", "invalid email or password")
        merchant_uuid = merchant_id = merchant_name = None
        if u["merchant_match"]:
            with get_pool().connection() as conn:
                cur = conn.cursor()
                # Prefer the demo's named merchant if present; otherwise fall back to
                # the merchant with the most transactions so the portal always works
                # after a reset + partial upload (demo resilience).
                cur.execute("SELECT id, merchant_uuid, name FROM merchants WHERE name=%s",
                            (u["merchant_match"],))
                m = cur.fetchone()
                if m is None:
                    cur.execute("""
                        SELECT m.id, m.merchant_uuid, m.name, COUNT(t.id) AS n
                          FROM merchants m LEFT JOIN transactions t ON t.merchant_id=m.id
                         GROUP BY m.id, m.merchant_uuid, m.name
                         ORDER BY n DESC, m.id LIMIT 1""")
                    m = cur.fetchone()
                if m is None:
                    err(503, "no_merchants", "no merchant data uploaded yet — upload a "
                        "transaction file first, then sign in as a merchant")
                merchant_uuid, merchant_id, merchant_name = str(m["merchant_uuid"]), m["id"], m["name"]
        token = auth_mod.issue(identifier.lower(), merchant_uuid, merchant_id)
        return {"token": token, "user": {"name": u["name"], "role": u["role"],
                                         "merchant_uuid": merchant_uuid,
                                         "merchant_name": merchant_name}}

    # 2) Self-service merchant: look up by member_id or contact email.
    with get_pool().connection() as conn:
        cur = conn.cursor()
        m = _resolve_merchant_login(cur, identifier)
        if m is None:
            err(401, "bad_credentials", "invalid merchant ID / email or password")
        cur.execute("SELECT password_hash FROM merchant_credentials WHERE member_id=%s",
                    (m["member_id"],))
        cred = cur.fetchone()
        if cred is None:
            # No password chosen yet — the frontend routes this to the "set a
            # password" first-login flow rather than showing a login failure.
            err(409, "no_password_set",
                "no password set for this merchant yet — set one to continue")
        if not auth_mod.verify_password(body.password, cred["password_hash"]):
            err(401, "bad_credentials", "invalid merchant ID / email or password")
        return _merchant_session(m, m["member_id"])


class MerchantSetPasswordBody(BaseModel):
    identifier: str
    password: str


@app.post("/api/auth/merchant/set-password")
def merchant_set_password(body: MerchantSetPasswordBody):
    """First-login claim: a merchant with no password yet chooses one and is
    signed in. Refuses if a password already exists (change it while signed in)."""
    if len(body.password) < MIN_PASSWORD_LEN:
        err(400, "weak_password", f"password must be at least {MIN_PASSWORD_LEN} characters")
    with get_pool().connection() as conn:
        cur = conn.cursor()
        m = _resolve_merchant_login(cur, body.identifier.strip())
        if m is None:
            err(404, "unknown_merchant", "no merchant found with that ID or email")
        cur.execute("SELECT 1 FROM merchant_credentials WHERE member_id=%s", (m["member_id"],))
        if cur.fetchone() is not None:
            err(409, "password_already_set",
                "this merchant already has a password — sign in, or change it once signed in")
        cur.execute(
            "INSERT INTO merchant_credentials (member_id, password_hash) VALUES (%s, %s)",
            (m["member_id"], auth_mod.hash_password(body.password)),
        )
        conn.commit()
        return _merchant_session(m, m["member_id"])


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str


@app.post("/api/auth/merchant/change-password")
def merchant_change_password(body: ChangePasswordBody, user: dict = Depends(current_user)):
    if user.get("role") != "merchant":
        err(403, "forbidden", "only merchants have a self-service password")
    if len(body.new_password) < MIN_PASSWORD_LEN:
        err(400, "weak_password", f"password must be at least {MIN_PASSWORD_LEN} characters")
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT member_id FROM merchants WHERE id=%s", (user["merchant_id"],))
        row = cur.fetchone()
        if row is None:
            err(404, "unknown_merchant", "merchant no longer exists")
        member_id = row["member_id"]
        cur.execute("SELECT password_hash FROM merchant_credentials WHERE member_id=%s",
                    (member_id,))
        cred = cur.fetchone()
        if cred is None:
            err(409, "no_password_set", "no password set yet")
        if not auth_mod.verify_password(body.current_password, cred["password_hash"]):
            err(401, "bad_credentials", "current password is incorrect")
        cur.execute(
            "UPDATE merchant_credentials SET password_hash=%s, updated_at=now() WHERE member_id=%s",
            (auth_mod.hash_password(body.new_password), member_id),
        )
        conn.commit()
        return {"ok": True}


# ---------------------------------------------------------------- dashboard
@app.get("/api/dashboard")
def dashboard(user: dict = Depends(current_user)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        mid = user["merchant_id"] if user["role"] == "merchant" else None
        mfilter = "AND t.merchant_id = %(mid)s" if mid else ""
        p = {"mid": mid}
        cur.execute(f"""
            SELECT t.currency,
                   COALESCE(SUM(t.captured_minor),0) AS captured_minor,
                   COALESCE(SUM(t.refunded_minor),0) AS refunded_minor,
                   COUNT(*) FILTER (WHERE t.status IN ('captured','refunded','partially_refunded')) AS paid_count,
                   COUNT(*) FILTER (WHERE t.status='auth_failed') AS declined_count
              FROM transactions t WHERE TRUE {mfilter}
             GROUP BY t.currency ORDER BY captured_minor DESC""", p)
        vol = cur.fetchall()
        cur.execute(f"""
            SELECT f.currency, COALESCE(SUM(f.fee_minor),0) AS fees
              FROM fees f WHERE TRUE {"AND f.merchant_id=%(mid)s" if mid else ""}
             GROUP BY f.currency""", p)
        fees = {r["currency"]: r["fees"] for r in cur.fetchall()}
        volume = [{
            "currency": r["currency"],
            "captured_minor": int(r["captured_minor"]),
            "refunded_minor": int(r["refunded_minor"]),
            "fees_minor": int(fees.get(r["currency"], 0)),
            "net_payable_minor": int(r["captured_minor"]) - int(r["refunded_minor"])
                                 - int(fees.get(r["currency"], 0)),
            "paid_count": int(r["paid_count"]), "declined_count": int(r["declined_count"]),
        } for r in vol]

        cur.execute(f"""
            SELECT date_trunc('day', t.occurred_at)::date AS d, t.currency,
                   COALESCE(SUM(t.captured_minor),0) AS captured,
                   COUNT(*) FILTER (WHERE t.status='auth_failed') AS declined,
                   COUNT(*) FILTER (WHERE t.status IN ('captured','refunded','partially_refunded')) AS paid
              FROM transactions t WHERE TRUE {mfilter}
             GROUP BY 1,2 ORDER BY 1""", p)
        daily = [{"date": str(r["d"]), "currency": r["currency"],
                  "captured_minor": int(r["captured"]), "declined_count": int(r["declined"]),
                  "paid_count": int(r["paid"])} for r in cur.fetchall()]

        cur.execute(f"""
            SELECT m.merchant_uuid, m.name, t.currency,
                   SUM(t.captured_minor) AS captured, COUNT(*) AS n
              FROM transactions t JOIN merchants m ON m.id=t.merchant_id
             WHERE t.status IN ('captured','refunded','partially_refunded') {mfilter}
             GROUP BY 1,2,3 ORDER BY captured DESC LIMIT 8""", p)
        top = [{"merchant_uuid": str(r["merchant_uuid"]), "name": r["name"],
                "currency": r["currency"], "captured_minor": int(r["captured"]),
                "txn_count": int(r["n"])} for r in cur.fetchall()]

        cur.execute(f"""
            SELECT COUNT(*) FILTER (WHERE state='generated') AS generated,
                   COUNT(*) FILTER (WHERE state='completed') AS completed
              FROM settlements s WHERE TRUE {"AND s.merchant_id=%(mid)s" if mid else ""}""", p)
        st = cur.fetchone()
        paid_out = [{"currency": ccy, "amount_minor": amt}
                    for ccy, amt in sorted(_paid_out_by_currency(cur, mid).items())]

        cur.execute("SELECT COUNT(*) AS n FROM merchants")
        mc = cur.fetchone()["n"]
        cur.execute(f"""
            SELECT COUNT(DISTINCT m.id) FILTER (WHERE m.status='unconfigured') AS merchants,
                   COUNT(t.id) FILTER (WHERE t.ledger_posted=false) AS transactions
              FROM merchants m LEFT JOIN transactions t ON t.merchant_id=m.id
             WHERE TRUE {"AND m.id=%(mid)s" if mid else ""}""", p)
        q = cur.fetchone()
        integ = _integrity_summary(cur)
        return {"volume": volume, "merchant_count": mc,
                "quarantine": {"unconfigured_merchants": int(q["merchants"]),
                               "quarantined_transactions": int(q["transactions"])},
                "settlements": {"generated": int(st["generated"]),
                                "completed": int(st["completed"]),
                                "total_paid_out": paid_out},
                "integrity": integ, "top_merchants": top, "daily_volume": daily}


@app.get("/api/insights/countries")
def insights_countries(currency: str | None = None, merchant: str | None = None,
                       user: dict = Depends(current_user)):
    """Country-level performance of the card portfolio: per-country transaction
    counts, accept/decline split, brand mix and captured volume. Merchants see
    only their own data; admins see the whole book, or one merchant via `merchant`
    (its uuid)."""
    from . import ml
    ctry = ml.country_case("t.country")     # normalise USA/UNITED STATES→US etc., blank→??
    with get_pool().connection() as conn:
        cur = conn.cursor()
        mid = scope_merchant_id(user, merchant, cur)
        p: dict = {"mid": mid, "ccy": currency.upper() if currency else None}
        filt = ""
        if mid:
            filt += " AND t.merchant_id = %(mid)s"
        if currency:
            filt += " AND t.currency = %(ccy)s"

        cur.execute(f"""
            SELECT {ctry} AS country,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE t.status IN ('captured','refunded','partially_refunded')) AS accepted,
                   COUNT(*) FILTER (WHERE t.status = 'auth_failed') AS declined,
                   COUNT(*) FILTER (WHERE t.status IN ('refunded','partially_refunded')) AS refunds,
                   COUNT(*) FILTER (WHERE t.chargeback_minor > 0) AS chargebacks
              FROM transactions t WHERE TRUE {filt}
             GROUP BY 1 ORDER BY total DESC""", p)
        rows = cur.fetchall()

        cur.execute(f"""
            SELECT {ctry} AS country,
                   COALESCE(NULLIF(t.payment_brand, ''), '—') AS brand, COUNT(*) AS n
              FROM transactions t WHERE TRUE {filt}
             GROUP BY 1, 2""", p)
        brands: dict = {}
        for r in cur.fetchall():
            brands.setdefault(r["country"], []).append({"brand": r["brand"], "count": int(r["n"])})

        cur.execute(f"""
            SELECT {ctry} AS country, t.currency,
                   COALESCE(SUM(t.captured_minor), 0) AS captured
              FROM transactions t
             WHERE t.status IN ('captured','refunded','partially_refunded') {filt}
             GROUP BY 1, 2 HAVING SUM(t.captured_minor) > 0
             ORDER BY captured DESC""", p)
        vol: dict = {}
        for r in cur.fetchall():
            vol.setdefault(r["country"], []).append(
                {"currency": r["currency"], "minor": int(r["captured"])})

        countries = []
        for r in rows:
            c = r["country"]
            acc, dec = int(r["accepted"]), int(r["declined"])
            decided = acc + dec
            blist = sorted(brands.get(c, []), key=lambda x: -x["count"])
            countries.append({
                "country": c,
                "transactions": int(r["total"]),
                "accepted": acc,
                "declined": dec,
                "refunds": int(r["refunds"]),
                "chargebacks": int(r["chargebacks"]),
                "acceptance_rate": round(acc / decided, 4) if decided else None,
                "top_brand": blist[0]["brand"] if blist else None,
                "brands": blist[:4],
                "captured": vol.get(c, []),
            })

        cur.execute(f"""
            SELECT date_trunc('day', t.occurred_at)::date AS d,
                   COUNT(*) FILTER (WHERE t.status IN ('captured','refunded','partially_refunded')) AS accepted,
                   COUNT(*) FILTER (WHERE t.status='auth_failed') AS declined
              FROM transactions t WHERE TRUE {filt}
             GROUP BY 1 ORDER BY 1""", p)
        daily = []
        for r in cur.fetchall():
            acc, dec = int(r["accepted"]), int(r["declined"])
            tot = acc + dec
            daily.append({"date": str(r["d"]), "accepted": acc, "declined": dec,
                          "acceptance_rate": round(acc / tot, 4) if tot else None})

        tacc = sum(c["accepted"] for c in countries)
        tdec = sum(c["declined"] for c in countries)
        return {
            "currencies": _distinct_currencies(cur, mid),
            "daily": daily,
            "totals": {
                "countries": len(countries),
                "transactions": sum(c["transactions"] for c in countries),
                "accepted": tacc,
                "declined": tdec,
                "acceptance_rate": round(tacc / (tacc + tdec), 4) if (tacc + tdec) else None,
            },
            "countries": countries,
        }


@app.get("/api/insights/ml")
def insights_ml(currency: str | None = None, merchant: str | None = None,
                user: dict = Depends(current_user)):
    """ML layer for Insights: predicted (mix-based) approval + decline drivers per
    country, statistical anomalies, recoverable-revenue sizing, and market
    cohorts. Scoped to the merchant for merchant users, or to one merchant (admin,
    via `merchant` uuid)."""
    from . import ml
    with get_pool().connection() as conn:
        cur = conn.cursor()
        mid = scope_merchant_id(user, merchant, cur)
        return ml.compute(cur, mid, currency)


_APPROVED = ["captured", "refunded", "partially_refunded"]
_DECIDED = [*_APPROVED, "auth_failed"]


@app.get("/api/insights/issuers")
def insights_issuers(currency: str | None = None, country: str | None = None,
                     merchant: str | None = None, user: dict = Depends(current_user)):
    """Issuing-bank / BIN performance: per bank (transactions, accept/decline,
    acceptance, top brand) with its individual BINs nested underneath. Optionally
    scoped to a single country (its ISO-2 code), and to one merchant (admin, via
    `merchant` uuid)."""
    from . import ml
    with get_pool().connection() as conn:
        cur = conn.cursor()
        mid = scope_merchant_id(user, merchant, cur)
        p = {"mid": mid, "ccy": currency.upper() if currency else None,
             "country": country.upper() if country else None, "app": _APPROVED, "all": _DECIDED}
        filt = (" AND merchant_id = %(mid)s" if mid else "") + (" AND currency = %(ccy)s" if currency else "")
        if country:
            filt += f" AND {ml.country_case('country')} = %(country)s"

        cur.execute(f"""
            SELECT COALESCE(NULLIF(issuing_bank,''),'—') bank,
                   COALESCE(NULLIF(first_six,''),'—') bin,
                   mode() WITHIN GROUP (ORDER BY COALESCE(NULLIF(payment_brand,''),'—')) brand,
                   COUNT(*) total,
                   COUNT(*) FILTER (WHERE status = ANY(%(app)s)) accepted,
                   COUNT(*) FILTER (WHERE status='auth_failed') declined
              FROM transactions WHERE status = ANY(%(all)s) {filt}
             GROUP BY 1,2""", p)
        rows = cur.fetchall()

        cur.execute(f"""
            SELECT COALESCE(NULLIF(issuing_bank,''),'—') bank, currency,
                   COALESCE(SUM(captured_minor),0) captured
              FROM transactions WHERE status = ANY(%(app)s) {filt}
             GROUP BY 1,2 HAVING SUM(captured_minor) > 0""", p)
        capt: dict = {}
        for r in cur.fetchall():
            capt.setdefault(r["bank"], []).append({"currency": r["currency"], "minor": int(r["captured"])})

        banks: dict = {}
        for r in rows:
            b = banks.setdefault(r["bank"], {"bank": r["bank"], "transactions": 0, "accepted": 0,
                                             "declined": 0, "bins": [], "_brand": {}})
            acc, dec, tot = int(r["accepted"]), int(r["declined"]), int(r["total"])
            b["transactions"] += tot
            b["accepted"] += acc
            b["declined"] += dec
            b["_brand"][r["brand"]] = b["_brand"].get(r["brand"], 0) + tot
            decided = acc + dec
            b["bins"].append({"bin": r["bin"], "brand": r["brand"], "transactions": tot,
                              "accepted": acc, "declined": dec,
                              "acceptance_rate": round(acc / decided, 4) if decided else None})
        out = []
        for b in banks.values():
            decided = b["accepted"] + b["declined"]
            b["acceptance_rate"] = round(b["accepted"] / decided, 4) if decided else None
            b["top_brand"] = max(b["_brand"], key=b["_brand"].get) if b["_brand"] else None
            b["bin_count"] = len(b["bins"])
            b["bins"].sort(key=lambda x: -x["transactions"])
            b["bins"] = b["bins"][:15]
            b["captured"] = sorted(capt.get(b["bank"], []), key=lambda x: -x["minor"])
            del b["_brand"]
            out.append(b)
        out.sort(key=lambda x: -x["transactions"])
        top = out[:40]
        return {"available": len(out) > 0, "banks": top, "total_banks": len(out),
                "truncated": len(out) > len(top)}


@app.get("/api/insights/merchants")
def insights_merchants(user: dict = Depends(current_user)):
    """Consolidated per-merchant summary across all currencies (admin: every
    merchant; merchant: just their own)."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        mid = user["merchant_id"] if user["role"] == "merchant" else None
        mfilter = " AND t.merchant_id = %(mid)s" if mid else ""
        cur.execute(f"""
            SELECT m.merchant_uuid, m.name, t.currency,
                   COUNT(*) total,
                   COUNT(*) FILTER (WHERE t.status = ANY(%(app)s)) accepted,
                   COUNT(*) FILTER (WHERE t.status='auth_failed') declined,
                   COALESCE(SUM(t.captured_minor),0) captured
              FROM transactions t JOIN merchants m ON m.id = t.merchant_id
             WHERE t.status = ANY(%(all)s) {mfilter}
             GROUP BY 1,2,3""", {"mid": mid, "app": _APPROVED, "all": _DECIDED})
        agg: dict = {}
        for r in cur.fetchall():
            k = str(r["merchant_uuid"])
            a = agg.setdefault(k, {"merchant_uuid": k, "name": r["name"], "transactions": 0,
                                   "accepted": 0, "declined": 0, "cap": {}})
            a["transactions"] += int(r["total"])
            a["accepted"] += int(r["accepted"])
            a["declined"] += int(r["declined"])
            if int(r["captured"]) > 0:
                a["cap"][r["currency"]] = a["cap"].get(r["currency"], 0) + int(r["captured"])
        # settlement counts per merchant (excl. cancelled), scoped the same way
        cur.execute(f"""
            SELECT m.merchant_uuid,
                   COUNT(s.id) settlements,
                   COUNT(s.id) FILTER (WHERE s.state='completed') settlements_paid,
                   COALESCE(SUM(s.net_payout_minor),0) net_minor
              FROM merchants m
              LEFT JOIN settlements s ON s.merchant_id=m.id AND s.state <> 'cancelled'
             {"WHERE m.id=%(mid)s" if mid else ""}
             GROUP BY m.merchant_uuid""", {"mid": mid})
        scounts = {str(r["merchant_uuid"]): r for r in cur.fetchall()}
        out = []
        for a in agg.values():
            decided = a["accepted"] + a["declined"]
            a["acceptance_rate"] = round(a["accepted"] / decided, 4) if decided else None
            a["captured"] = [{"currency": k, "minor": v} for k, v in sorted(a.pop("cap").items())]
            s = scounts.get(a["merchant_uuid"], {})
            a["settlements"] = int(s.get("settlements", 0) or 0)
            a["settlements_paid"] = int(s.get("settlements_paid", 0) or 0)
            a["settled_net_minor"] = int(s.get("net_minor", 0) or 0)
            out.append(a)
        out.sort(key=lambda x: -x["transactions"])
        return {"merchants": out}


def _distinct_currencies(cur, mid: int | None) -> list[str]:
    cur.execute(
        f"SELECT DISTINCT currency FROM transactions WHERE TRUE "
        f"{'AND merchant_id=%(mid)s' if mid else ''} ORDER BY currency",
        {"mid": mid})
    return [r["currency"] for r in cur.fetchall()]


def _integrity_summary(cur) -> dict:
    cur.execute("SELECT COUNT(*) AS n FROM ledger_events")
    ev = cur.fetchone()["n"]
    cur.execute("SELECT COUNT(*) AS n FROM ledger_entries")
    en = cur.fetchone()["n"]
    cur.execute("""SELECT COUNT(*) AS n FROM (
        SELECT event_id FROM ledger_entries GROUP BY event_id
        HAVING SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0
      ) x""")
    unb = cur.fetchone()["n"]
    cur.execute("""
        SELECT COUNT(*) AS n FROM account_balances b
        JOIN accounts a ON a.id=b.account_id
        LEFT JOIN (
          SELECT le.account_id,
                 SUM(CASE WHEN (a2.account_type IN ('merchant_payable','merchant_reserve',
                        'settlement_payable','chargeback_suspense','gateway_revenue','tax_payable'))
                          = (le.direction='credit')
                      THEN le.amount_minor ELSE -le.amount_minor END) AS s
            FROM ledger_entries le JOIN accounts a2 ON a2.id=le.account_id
           GROUP BY le.account_id) e ON e.account_id=b.account_id
        WHERE b.balance_minor <> COALESCE(e.s, 0)""")
    mism = cur.fetchone()["n"]
    return {"events": int(ev), "entries": int(en), "unbalanced_events": int(unb),
            "balance_mismatches": int(mism), "ok": unb == 0 and mism == 0}


# ---------------------------------------------------------------- merchants
def _paid_out_by_currency(cur, merchant_id: int | None) -> dict:
    """Money actually paid out to a merchant, per currency, derived from the ledger.

    Sums the settlement_payable debits of settlement_completed events, so it counts
    both whole-settlement completions AND per-day partial payouts consistently.
    """
    where = "AND a.merchant_id = %(mid)s" if merchant_id else ""
    cur.execute(
        f"""SELECT a.currency, COALESCE(SUM(le.amount_minor), 0) AS total
              FROM ledger_events e
              JOIN ledger_entries le ON le.event_id = e.id AND le.direction = 'debit'
              JOIN accounts a ON a.id = le.account_id AND a.account_type = 'settlement_payable'
             WHERE e.event_type = 'settlement_completed' {where}
             GROUP BY a.currency""",
        {"mid": merchant_id},
    )
    return {r["currency"]: int(r["total"]) for r in cur.fetchall()}


def _merchant_item(cur, m) -> dict:
    cur.execute("""
        SELECT a.account_type, a.currency, b.balance_minor
          FROM accounts a JOIN account_balances b ON b.account_id=a.id
         WHERE a.merchant_id=%s""", (m["id"],))
    bal: dict[str, dict] = {}
    for r in cur.fetchall():
        c = bal.setdefault(r["currency"], {"currency": r["currency"], "payable_minor": 0,
                                           "reserve_minor": 0, "in_settlement_minor": 0,
                                           "paid_minor": 0})
        key = {"merchant_payable": "payable_minor", "merchant_reserve": "reserve_minor",
               "settlement_payable": "in_settlement_minor"}.get(r["account_type"])
        if key:
            c[key] = int(r["balance_minor"])

    for currency, total in _paid_out_by_currency(cur, m["id"]).items():
        c = bal.setdefault(currency, {"currency": currency, "payable_minor": 0,
                                      "reserve_minor": 0, "in_settlement_minor": 0,
                                      "paid_minor": 0})
        c["paid_minor"] = total

    cur.execute("""
        SELECT currency, SUM(captured_minor) AS s, COUNT(*) AS n,
               COUNT(*) FILTER (WHERE ledger_posted = false) AS q FROM transactions
         WHERE merchant_id=%s GROUP BY currency""", (m["id"],))
    caps, n_total, n_quarantined = [], 0, 0
    for r in cur.fetchall():
        caps.append({"currency": r["currency"], "amount_minor": int(r["s"] or 0)})
        n_total += int(r["n"])
        n_quarantined += int(r["q"])

    # Current fee schedule (null for unconfigured merchants) — lets the Merchants
    # UI show which preset each merchant is on before a bulk re-apply.
    cur.execute(
        "SELECT mdr_bps, approved_txn_fee_minor, declined_txn_fee_minor, "
        "refund_fee_minor, chargeback_fee_minor, reserve_hold_bps, reserve_hold_days, "
        "settlement_fee_bps, settlement_delay_days FROM fee_schedules WHERE merchant_id=%s",
        (m["id"],))
    fs = cur.fetchone()
    return {"merchant_uuid": str(m["merchant_uuid"]), "name": m["name"],
            "member_id": m["member_id"], "status": m["status"],
            "email": m.get("email"),
            "balances": sorted(bal.values(), key=lambda b: b["currency"]),
            "txn_count": n_total, "quarantined_count": n_quarantined,
            "captured_minor_total": caps,
            "fee_schedule": {k: int(v) for k, v in fs.items()} if fs else None}


@app.get("/api/merchants")
def merchants(user: dict = Depends(current_user)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        if user["role"] == "merchant":
            cur.execute("SELECT * FROM merchants WHERE id=%s", (user["merchant_id"],))
        else:
            cur.execute("SELECT * FROM merchants ORDER BY name")
        items = [_merchant_item(cur, m) for m in cur.fetchall()]
        # Flag which merchants have set/been given a login password.
        cur.execute("SELECT member_id FROM merchant_credentials")
        with_login = {r["member_id"] for r in cur.fetchall()}
        for it in items:
            it["has_login"] = it.get("member_id") in with_login
        return {"items": items}


class MerchantRenameBody(BaseModel):
    name: str | None = None
    email: str | None = None  # "" clears it; omit to leave unchanged


@app.patch("/api/merchants/{muuid}")
def rename_merchant(muuid: str, body: MerchantRenameBody, user: dict = Depends(require_admin)):
    """Update a merchant's display name and/or payout-confirmation email.
    member_id and the ledger are untouched."""
    sets, params = [], []
    if body.name is not None:
        name = body.name.strip()
        if not name:
            err(400, "invalid_name", "name cannot be empty")
        if len(name) > 200:
            err(400, "invalid_name", "name is too long")
        sets.append("name=%s"); params.append(name)
    if body.email is not None:
        email = body.email.strip()
        if email and ("@" not in email or len(email) > 320):
            err(400, "invalid_email", "not a valid email address")
        sets.append("email=%s"); params.append(email or None)
    if not sets:
        err(400, "no_changes", "nothing to update")
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE merchants SET {', '.join(sets)} WHERE merchant_uuid=%s "
                    "RETURNING name, email", (*params, muuid))
        row = cur.fetchone()
        if row is None:
            err(404, "not_found", "merchant not found")
        conn.commit()
        return {"ok": True, "merchant_uuid": muuid, "name": row["name"], "email": row["email"]}


class CreateMerchantBody(BaseModel):
    member_id: str
    password: str
    name: str | None = None
    email: str | None = None


@app.post("/api/merchants/create")
def create_merchant(body: CreateMerchantBody, user: dict = Depends(require_admin)):
    """Provision a merchant login directly — the admin picks the merchant ID and sets
    the password, no upload required first. The merchant signs in with that ID (or
    email) + password. Their fee schedule and transaction data are added later via
    Upload + Set fee schedule; any imported rows with this member_id link to it."""
    member_id = body.member_id.strip()
    if not member_id:
        err(400, "bad_id", "merchant ID is required")
    if len(body.password) < MIN_PASSWORD_LEN:
        err(400, "weak_password", f"password must be at least {MIN_PASSWORD_LEN} characters")
    email = (body.email or "").strip() or None
    if email and ("@" not in email or len(email) > 320):
        err(400, "invalid_email", "not a valid email address")
    name = (body.name or "").strip() or member_id
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM merchants WHERE member_id=%s", (member_id,))
        if cur.fetchone():
            err(409, "id_taken", f"a merchant with ID “{member_id}” already exists")
        if email:
            cur.execute("SELECT 1 FROM merchants WHERE lower(email)=lower(%s)", (email,))
            if cur.fetchone():
                err(409, "email_taken", f"a merchant with email “{email}” already exists")
        cur.execute(
            "INSERT INTO merchants (member_id, name, email, status) "
            "VALUES (%s,%s,%s,'active') RETURNING merchant_uuid",
            (member_id, name, email))
        muuid = cur.fetchone()["merchant_uuid"]
        cur.execute(
            "INSERT INTO merchant_credentials (member_id, password_hash) VALUES (%s,%s)",
            (member_id, auth_mod.hash_password(body.password)))
        conn.commit()
        return {"ok": True, "merchant_uuid": str(muuid), "member_id": member_id,
                "name": name, "email": email}


@app.get("/api/merchants/unconfigured")
def unconfigured_merchants(user: dict = Depends(require_admin)):
    """Merchants imported from a sheet that have no fee schedule yet — their
    transactions are quarantined (no ledger events) until onboarded."""
    with get_pool().connection() as conn:
        rows = onboarding_mod.unconfigured_merchants(conn)
        return {"items": [{"merchant_uuid": str(r["merchant_uuid"]),
                           "member_id": r["member_id"], "name": r["name"],
                           "quarantined_count": int(r["quarantined"]),
                           "quarantined_captured_minor": int(r["quarantined_captured_minor"])}
                          for r in rows]}


class FeeScheduleBody(BaseModel):
    preset: str | None = None          # "workbook" | "annex"
    mdr_bps: int | None = None
    approved_txn_fee_minor: int | None = None
    declined_txn_fee_minor: int | None = None
    refund_fee_minor: int | None = None
    chargeback_fee_minor: int | None = None
    reserve_hold_bps: int | None = None
    reserve_hold_days: int | None = None
    settlement_fee_bps: int | None = None
    settlement_delay_days: int | None = None
    settlement_schedule: str | None = None


@app.post("/api/merchants/{muuid}/fee-schedule")
def set_fee_schedule(muuid: str, body: FeeScheduleBody, user: dict = Depends(require_admin)):
    """Assign (or replace) a merchant's fee schedule and replay their quarantined
    transactions into the ledger. This is how an unknown merchant is onboarded."""
    overrides = {k: v for k, v in body.model_dump().items()
                 if k != "preset" and v is not None}
    try:
        rates = onboarding_mod.resolve_rates(preset=body.preset, overrides=overrides)
    except ValueError as e:
        err(400, "invalid_rates", str(e))
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM merchants WHERE merchant_uuid=%s", (muuid,))
        m = cur.fetchone()
        if m is None:
            err(404, "not_found", "merchant not found")
        try:
            summary = onboarding_mod.assign_fee_schedule(conn, m["id"], rates)
        except ValueError as e:
            err(400, "onboard_failed", str(e))
        conn.commit()
        # Auto-generate the settlement now that fees are set — no "Generate" click.
        try:
            summary["auto_settlements"] = cycle_mod.generate_pending(
                conn, generated_by="auto-onboard", merchant_ids=[m["id"]])
        except Exception:
            summary["auto_settlements"] = {"generated": 0, "existing": 0, "skipped": 0}
        return summary


class BulkFeeScheduleBody(FeeScheduleBody):
    merchant_uuids: list[str]


@app.post("/api/merchants/fee-schedule/bulk")
def bulk_set_fee_schedule(body: BulkFeeScheduleBody, user: dict = Depends(require_admin)):
    """Assign one fee schedule to many merchants at once (onboarding each)."""
    overrides = {k: v for k, v in body.model_dump().items()
                 if k not in ("preset", "merchant_uuids") and v is not None}
    try:
        rates = onboarding_mod.resolve_rates(preset=body.preset, overrides=overrides)
    except ValueError as e:
        err(400, "invalid_rates", str(e))
    results, errors, applied_ids = [], [], []
    for muuid in body.merchant_uuids:
        with get_pool().connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT id FROM merchants WHERE merchant_uuid=%s", (muuid,))
            m = cur.fetchone()
            if m is None:
                errors.append({"merchant_uuid": muuid, "error": "not found"})
                continue
            try:
                s = onboarding_mod.assign_fee_schedule(conn, m["id"], rates)
                results.append({"merchant_uuid": muuid,
                                "transactions_posted": s["transactions_posted"]})
                applied_ids.append(m["id"])
            except ValueError as e:
                errors.append({"merchant_uuid": muuid, "error": str(e)})
            conn.commit()
    # Auto-generate settlements for the merchants just configured — no click.
    auto = {"generated": 0, "existing": 0, "skipped": 0}
    if applied_ids:
        try:
            with get_pool().connection() as gconn:
                auto = cycle_mod.generate_pending(gconn, generated_by="auto-onboard",
                                                  merchant_ids=applied_ids)
        except Exception:
            pass
    return {"applied": len(results), "failed": len(errors),
            "results": results, "errors": errors, "auto_settlements": auto}


# ---------------------------------------------------------------- fee presets
_PRESET_FIELDS = ("mdr_bps", "approved_txn_fee_minor", "declined_txn_fee_minor",
                  "refund_fee_minor", "chargeback_fee_minor", "reserve_hold_bps",
                  "reserve_hold_days", "settlement_fee_bps", "settlement_delay_days",
                  "settlement_schedule")


@app.get("/api/fee-presets")
def list_fee_presets(user: dict = Depends(current_user)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM fee_presets ORDER BY name")
        return {"items": [{k: r[k] for k in ("name", *_PRESET_FIELDS)} for r in cur.fetchall()]}


class SavePresetBody(FeeScheduleBody):
    name: str


@app.post("/api/fee-presets")
def save_fee_preset(body: SavePresetBody, user: dict = Depends(require_admin)):
    """Create or update a named fee preset from a config (validated)."""
    name = body.name.strip()
    if not name:
        err(400, "bad_name", "preset name is required")
    overrides = {k: v for k, v in body.model_dump().items()
                 if k not in ("preset", "name") and v is not None}
    try:
        rates = onboarding_mod.resolve_rates(preset=body.preset, overrides=overrides)
    except ValueError as e:
        err(400, "invalid_rates", str(e))
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cols = ", ".join(("name", *_PRESET_FIELDS))
        ph = ", ".join(["%s"] * (1 + len(_PRESET_FIELDS)))
        upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in _PRESET_FIELDS)
        cur.execute(
            f"INSERT INTO fee_presets ({cols}) VALUES ({ph}) "
            f"ON CONFLICT (name) DO UPDATE SET {upd}",
            (name, *[rates[c] for c in _PRESET_FIELDS]),
        )
        conn.commit()
    return {"name": name}


@app.delete("/api/fee-presets/{name}")
def delete_fee_preset(name: str, user: dict = Depends(require_admin)):
    with get_pool().connection() as conn:
        conn.cursor().execute("DELETE FROM fee_presets WHERE name=%s", (name,))
        conn.commit()
    return {"deleted": name}


@app.get("/api/merchants/{muuid}")
def merchant_detail(muuid: str, user: dict = Depends(current_user)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        if user["role"] == "merchant":
            muuid = user["merchant_uuid"]
        cur.execute("SELECT * FROM merchants WHERE merchant_uuid=%s", (muuid,))
        m = cur.fetchone()
        if m is None:
            err(404, "not_found", "merchant not found")
        item = _merchant_item(cur, m)
        cur.execute("SELECT * FROM fee_schedules WHERE merchant_id=%s", (m["id"],))
        fs = cur.fetchone() or {}
        item["fee_schedule"] = {k: v for k, v in fs.items() if k != "merchant_id"}
        return item


@app.get("/api/merchants/{muuid}/reserve-statement")
def reserve_statement(muuid: str, currency: str = Query(...),
                      user: dict = Depends(current_user)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        if user["role"] == "merchant":
            muuid = user["merchant_uuid"]
        cur.execute("SELECT id FROM merchants WHERE merchant_uuid=%s", (muuid,))
        m = cur.fetchone()
        if m is None:
            err(404, "not_found", "merchant not found")
        cur.execute("""
            SELECT a.id, b.balance_minor FROM accounts a
            JOIN account_balances b ON b.account_id=a.id
            WHERE a.account_type='merchant_reserve' AND a.merchant_id=%s AND a.currency=%s""",
                    (m["id"], currency))
        acct = cur.fetchone()
        if acct is None:
            return {"items": [], "currency": currency, "current_reserve_minor": 0}
        cur.execute("""
            SELECT date_trunc('day', e.occurred_at)::date AS d,
                   SUM(le.amount_minor) FILTER (WHERE le.direction='credit') AS held,
                   SUM(le.amount_minor) FILTER (WHERE le.direction='debit') AS released
              FROM ledger_entries le JOIN ledger_events e ON e.id=le.event_id
             WHERE le.account_id=%s GROUP BY 1 ORDER BY 1""", (acct["id"],))
        items, opening = [], 0
        for r in cur.fetchall():
            held, released = int(r["held"] or 0), int(r["released"] or 0)
            closing = opening + held - released
            items.append({"date": str(r["d"]), "opening_minor": opening,
                          "held_minor": held, "released_minor": released,
                          "closing_minor": closing})
            opening = closing
        return {"items": items, "currency": currency,
                "current_reserve_minor": int(acct["balance_minor"])}


def _merchant_currencies(cur, merchant_id: int) -> list[str]:
    cur.execute("SELECT DISTINCT currency FROM transactions WHERE merchant_id=%s ORDER BY 1",
                (merchant_id,))
    return [r["currency"] for r in cur.fetchall()]


@app.get("/api/merchants/{muuid}/daily-settlement")
def daily_settlement(muuid: str, currency: str | None = None,
                     date_from: str | None = None, date_to: str | None = None,
                     user: dict = Depends(current_user)):
    """Per processing-day rollup for a merchant+currency: volume, fees, net payable
    and whether that day's activity has been settled (paid) or is still owed.
    Answers 'what's payable and how much is still remaining to be settled'."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        if user["role"] == "merchant":
            muuid = user["merchant_uuid"]
        cur.execute("SELECT id FROM merchants WHERE merchant_uuid=%s", (muuid,))
        m = cur.fetchone()
        if m is None:
            err(404, "not_found", "merchant not found")
        mid = m["id"]
        ccys = _merchant_currencies(cur, mid)
        ccy = (currency or (ccys[0] if ccys else "EUR")).upper()

        rng, p = "", {"mid": mid, "ccy": ccy}
        if date_from:
            rng += " AND occurred_at >= %(df)s"; p["df"] = date_from
        if date_to:
            rng += " AND occurred_at < %(dt)s::date + 1"; p["dt"] = date_to

        # 1. counts + gross captured, per day
        cur.execute(f"""
            SELECT occurred_at::date AS d,
                   COUNT(*) FILTER (WHERE status IN ('captured','refunded','partially_refunded')) AS approved,
                   COUNT(*) FILTER (WHERE status='auth_failed') AS declined,
                   COALESCE(SUM(captured_minor),0) AS gross
              FROM transactions
             WHERE merchant_id=%(mid)s AND currency=%(ccy)s{rng}
             GROUP BY 1""", p)
        days: dict[str, dict] = {}
        for r in cur.fetchall():
            d = str(r["d"])
            days[d] = {"date": d, "approved_count": int(r["approved"]),
                       "declined_count": int(r["declined"]),
                       "volume": int(r["approved"]) + int(r["declined"]),
                       "gross_captured_minor": int(r["gross"]), "fees_minor": 0,
                       "reserve_minor": 0, "net_payable_minor": 0,
                       "status": "pending", "settlement_uuid": None}

        # 2. per-txn fees per day (settlement fee is not linked to a txn → excluded)
        cur.execute(f"""
            SELECT t.occurred_at::date AS d, COALESCE(SUM(f.fee_minor),0) AS fees
              FROM fees f JOIN transactions t ON t.id=f.transaction_id
             WHERE t.merchant_id=%(mid)s AND t.currency=%(ccy)s{rng.replace('occurred_at','t.occurred_at')}
             GROUP BY 1""", p)
        for r in cur.fetchall():
            if str(r["d"]) in days:
                days[str(r["d"])]["fees_minor"] = int(r["fees"])

        # 3. reserve delta (held − released) per day, from ledger
        cur.execute(f"""
            SELECT e.occurred_at::date AS d,
                   SUM(CASE WHEN le.direction='credit' THEN le.amount_minor
                            ELSE -le.amount_minor END) AS delta
              FROM ledger_entries le
              JOIN ledger_events e ON e.id=le.event_id
              JOIN accounts a ON a.id=le.account_id AND a.account_type='merchant_reserve'
             WHERE e.merchant_id=%(mid)s AND e.currency=%(ccy)s AND e.source_txn_id IS NOT NULL
               {rng.replace('occurred_at','e.occurred_at')}
             GROUP BY 1""", p)
        for r in cur.fetchall():
            if str(r["d"]) in days:
                days[str(r["d"])]["reserve_minor"] = int(r["delta"])

        # 4. settlement linkage per day → status. A day counts as paid when its
        #    settlement is completed OR the day itself has a per-day payout
        #    (settlement_day_payouts), so partial per-day payouts show as paid.
        cur.execute(f"""
            SELECT e.occurred_at::date AS d,
                   COUNT(*) AS n,
                   COUNT(si.event_id) AS n_settled,
                   COUNT(*) FILTER (WHERE s.state='completed' OR sdp.settlement_id IS NOT NULL) AS n_paid,
                   COUNT(*) FILTER (WHERE s.state='generated') AS n_generated,
                   (ARRAY_AGG(s.settlement_uuid) FILTER (WHERE s.settlement_uuid IS NOT NULL))[1] AS suuid
              FROM ledger_events e
              LEFT JOIN settlement_items si ON si.event_id=e.id
              LEFT JOIN settlements s ON s.id=si.settlement_id
              LEFT JOIN settlement_day_payouts sdp
                     ON sdp.settlement_id=s.id AND sdp.day=e.occurred_at::date
             WHERE e.merchant_id=%(mid)s AND e.currency=%(ccy)s AND e.source_txn_id IS NOT NULL
               AND e.event_type = ANY(%(types)s){rng.replace('occurred_at','e.occurred_at')}
             GROUP BY 1""", {**p, "types": list(settle_mod.CANDIDATE_TYPES)})
        for r in cur.fetchall():
            d = str(r["d"])
            if d not in days:
                continue
            n, n_settled = int(r["n"]), int(r["n_settled"])
            n_paid, n_generated = int(r["n_paid"]), int(r["n_generated"])
            if n_settled == 0:
                status = "pending"
            elif n_settled < n:
                status = "partial"
            elif n_paid == n:
                status = "paid"
            elif n_generated > 0:
                status = "in_settlement"
            else:
                status = "partial"
            days[d]["status"] = status
            days[d]["settlement_uuid"] = str(r["suuid"]) if r["suuid"] else None

        rows = sorted(days.values(), key=lambda x: x["date"])
        for row in rows:
            row["net_payable_minor"] = (row["gross_captured_minor"] - row["fees_minor"]
                                        - row["reserve_minor"])
        total_net = sum(r["net_payable_minor"] for r in rows)
        paid_net = sum(r["net_payable_minor"] for r in rows if r["status"] == "paid")
        totals = {
            "volume": sum(r["volume"] for r in rows),
            "approved": sum(r["approved_count"] for r in rows),
            "declined": sum(r["declined_count"] for r in rows),
            "gross_captured_minor": sum(r["gross_captured_minor"] for r in rows),
            "fees_minor": sum(r["fees_minor"] for r in rows),
            "net_payable_minor": total_net,
            "paid_net_minor": paid_net,
            "remaining_net_minor": total_net - paid_net,
        }
        return {"currency": ccy, "currencies": ccys, "days": rows, "totals": totals}


@app.get("/api/merchants/{muuid}/daily-settlement/{day}/transactions")
def daily_settlement_transactions(muuid: str, day: str, currency: str | None = None,
                                  user: dict = Depends(current_user)):
    """Per-transaction charge breakdown for one processing day (drill-down)."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        if user["role"] == "merchant":
            muuid = user["merchant_uuid"]
        cur.execute("SELECT id FROM merchants WHERE merchant_uuid=%s", (muuid,))
        m = cur.fetchone()
        if m is None:
            err(404, "not_found", "merchant not found")
        ccys = _merchant_currencies(cur, m["id"])
        ccy = (currency or (ccys[0] if ccys else "EUR")).upper()
        return {"items": settle_mod.day_line_items(conn, m["id"], ccy, day),
                "date": day, "currency": ccy}


# ---------------------------------------------------------------- transactions
@app.get("/api/transactions")
def transactions(user: dict = Depends(current_user), merchant_uuid: str | None = None,
                 status: str | None = None, currency: str | None = None,
                 q: str | None = None, date_from: str | None = None,
                 date_to: str | None = None, page: int = 1,
                 page_size: int = Query(50, le=200)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        mid = scope_merchant_id(user, merchant_uuid, cur)
        where, p = ["TRUE"], {}
        if mid:
            where.append("t.merchant_id=%(mid)s"); p["mid"] = mid
        if status:
            where.append("t.status=%(status)s"); p["status"] = status
        if currency:
            where.append("t.currency=%(ccy)s"); p["ccy"] = currency.upper()
        if date_from:
            where.append("t.occurred_at >= %(df)s"); p["df"] = date_from
        if date_to:
            where.append("t.occurred_at < %(dt)s::date + 1"); p["dt"] = date_to
        if q:
            where.append("""(t.tracking_id ILIKE %(q)s OR t.order_id ILIKE %(q)s
                OR t.upstream_payment_id ILIKE %(q)s OR t.customer_email ILIKE %(q)s
                OR t.customer_name ILIKE %(q)s OR t.last_four = %(qx)s)""")
            p["q"] = f"%{q}%"; p["qx"] = q
        w = " AND ".join(where)
        cur.execute(f"SELECT COUNT(*) AS n FROM transactions t WHERE {w}", p)
        total = cur.fetchone()["n"]
        p["lim"], p["off"] = page_size, (page - 1) * page_size
        cur.execute(f"""
            SELECT t.*, m.name AS merchant_name, m.merchant_uuid AS m_uuid
              FROM transactions t JOIN merchants m ON m.id=t.merchant_id
             WHERE {w} ORDER BY t.occurred_at DESC, t.id DESC
             LIMIT %(lim)s OFFSET %(off)s""", p)
        items = [_txn_item(r) for r in cur.fetchall()]
        return {"items": items, "total": int(total), "page": page, "page_size": page_size}


def _txn_item(r) -> dict:
    return {"transaction_uuid": str(r["transaction_uuid"]),
            "occurred_at": r["occurred_at"].isoformat(),
            "merchant_uuid": str(r["m_uuid"]), "merchant_name": r["merchant_name"],
            "tracking_id": r["tracking_id"], "order_id": r["order_id"],
            "upstream_payment_id": r["upstream_payment_id"],
            "customer_name": r["customer_name"], "customer_email": r["customer_email"],
            "payment_brand": r["payment_brand"], "payment_mode": r["payment_mode"],
            "card_last_four": r["last_four"], "currency": r["currency"],
            "auth_minor": int(r["auth_minor"]), "captured_minor": int(r["captured_minor"]),
            "refunded_minor": int(r["refunded_minor"]),
            "chargeback_minor": int(r["chargeback_minor"]), "status": r["status"],
            "mid": r["mid"], "country": r["country"]}


@app.get("/api/transactions/{tuuid}")
def transaction_detail(tuuid: str, user: dict = Depends(current_user)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT t.*, m.name AS merchant_name, m.merchant_uuid AS m_uuid
                       FROM transactions t JOIN merchants m ON m.id=t.merchant_id
                       WHERE t.transaction_uuid=%s""", (tuuid,))
        t = cur.fetchone()
        if t is None or (user["role"] == "merchant" and t["merchant_id"] != user["merchant_id"]):
            err(404, "not_found", "transaction not found")
        item = _txn_item(t)
        cur.execute("SELECT fee_type, currency, fee_minor FROM fees WHERE transaction_id=%s",
                    (t["id"],))
        item["fees"] = [{"fee_type": r["fee_type"], "fee_minor": int(r["fee_minor"]),
                         "currency": r["currency"]} for r in cur.fetchall()]
        cur.execute("""SELECT id, event_uuid, event_type, posted_at, currency
                       FROM ledger_events WHERE source_txn_id=%s ORDER BY id""", (t["id"],))
        events = []
        for e in cur.fetchall():
            events.append(_event_payload(cur, e))
        item["ledger_events"] = events
        return item


def _event_payload(cur, e) -> dict:
    cur.execute("""
        SELECT le.direction, le.amount_minor, a.account_type, a.currency,
               m.name AS merchant_name
          FROM ledger_entries le JOIN accounts a ON a.id=le.account_id
          LEFT JOIN merchants m ON m.id=a.merchant_id
         WHERE le.event_id=%s ORDER BY le.id""", (e["id"],))
    entries = []
    for r in cur.fetchall():
        label = r["account_type"]
        if r["merchant_name"]:
            label += f" — {r['merchant_name']}"
        label += f" ({r['currency']})"
        entries.append({"account_label": label, "account_type": r["account_type"],
                        "direction": r["direction"], "amount_minor": int(r["amount_minor"])})
    return {"event_uuid": str(e["event_uuid"]), "event_type": e["event_type"],
            "posted_at": e["posted_at"].isoformat(), "currency": e["currency"],
            "entries": entries}


# ---------------------------------------------------------------- settlements
@app.get("/api/settlements")
def settlements(user: dict = Depends(current_user), merchant_uuid: str | None = None,
                currency: str | None = None, code: str | None = None):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        mid = scope_merchant_id(user, merchant_uuid, cur)
        where, p = ["TRUE"], {}
        if mid:
            where.append("s.merchant_id=%(mid)s"); p["mid"] = mid
        if currency:
            where.append("s.currency=%(c)s"); p["c"] = currency.upper()
        if code and code.strip():
            # merchant quotes a confirmation code — match the settlement code, a uuid
            # fragment, or a per-day code (settlement code is a prefix of the day code)
            where.append("(s.confirmation_code ILIKE %(code)s OR s.settlement_uuid::text ILIKE %(code)s "
                         "OR %(raw)s ILIKE s.confirmation_code || '%%')")
            p["code"] = f"%{code.strip()}%"
            p["raw"] = code.strip()
        cur.execute(f"""
            SELECT s.*, m.name AS merchant_name, m.merchant_uuid AS m_uuid
              FROM settlements s JOIN merchants m ON m.id=s.merchant_id
             WHERE {' AND '.join(where)} ORDER BY s.created_at DESC""", p)
        items = []
        for s in cur.fetchall():
            bd = s["breakdown"] or {}
            counts = bd.get("counts", {})
            items.append({
                "settlement_uuid": str(s["settlement_uuid"]),
                "confirmation_code": s.get("confirmation_code"),
                "merchant_uuid": str(s["m_uuid"]), "merchant_name": s["merchant_name"],
                "currency": s["currency"], "window_start": s["window_start"].isoformat(),
                "window_end": s["window_end"].isoformat(), "state": s["state"],
                "net_payout_minor": int(s["net_payout_minor"]),
                "paid_count": counts.get("paid", 0), "declined_count": counts.get("declined", 0),
                "created_at": s["created_at"].isoformat()})
        return {"items": items}


class GenerateBody(BaseModel):
    merchant_uuid: str
    currency: str
    window_start: str
    window_end: str
    confirmation_code: str | None = None


def _window_start(s: str) -> datetime:
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _window_end(s: str) -> datetime:
    """Parse a window end. A date-only value ("2026-07-03") is INCLUSIVE of the
    whole day — otherwise a bare date lands at 00:00 and silently drops every
    transaction that occurred that day."""
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    if "T" not in s and ":" not in s:            # date-only → end of that day
        dt = dt.replace(hour=23, minute=59, second=59, microsecond=999999)
    return dt


@app.post("/api/settlements/generate")
def generate_settlement(body: GenerateBody, user: dict = Depends(require_admin)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM merchants WHERE merchant_uuid=%s", (body.merchant_uuid,))
        m = cur.fetchone()
        if m is None:
            err(404, "not_found", "merchant not found")
        ws = _window_start(body.window_start)
        we = _window_end(body.window_end)
        try:
            res = settle_mod.generate(conn, merchant_id=m["id"], currency=body.currency.upper(),
                                      window_start=ws, window_end=we,
                                      generated_by=user["sub"],
                                      custom_code=body.confirmation_code)
        except settle_mod.SettlementError as e:
            err(409, e.code, e.message)
        if res.get("skipped"):
            return res
        cur.execute("SELECT settlement_uuid FROM settlements WHERE id=%s",
                    (res["settlement_id"],))
        suuid = str(cur.fetchone()["settlement_uuid"])
        conn.commit()  # detail below reads via a fresh pooled connection
        return settlement_detail(suuid, user)


@app.post("/api/settlements/generate-per-day")
def generate_per_day_settlements(body: GenerateBody, user: dict = Depends(require_admin)):
    """Generate ONE settlement per processing day in the window, so each day can
    be confirmed and paid independently from its own statement."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM merchants WHERE merchant_uuid=%s", (body.merchant_uuid,))
        m = cur.fetchone()
        if m is None:
            err(404, "not_found", "merchant not found")
        ws = _window_start(body.window_start)
        we = _window_end(body.window_end)
        try:
            summary = settle_mod.generate_per_day(
                conn, merchant_id=m["id"], currency=body.currency.upper(),
                window_start=ws, window_end=we, generated_by=user["sub"],
                custom_code=body.confirmation_code)
        except settle_mod.SettlementError as e:
            err(409, e.code, e.message)
        conn.commit()
        return summary


def _email_settlement_bg(settlement_id: int) -> None:
    """Send a payout-confirmation email on its own connection (background task)."""
    try:
        with get_pool().connection() as conn:
            settlement_email_mod.send_confirmation(conn, settlement_id)
    except Exception:  # pragma: no cover - never let a mail issue surface
        pass


def _email_settlement_day_bg(settlement_id: int, day: str) -> None:
    """Send a per-day payout-confirmation email (background task)."""
    try:
        with get_pool().connection() as conn:
            settlement_email_mod.send_day_confirmation(conn, settlement_id, day)
    except Exception:  # pragma: no cover
        pass


@app.post("/api/settlements/{suuid}/complete")
def complete_settlement(suuid: str, background: BackgroundTasks,
                        user: dict = Depends(require_admin)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM settlements WHERE settlement_uuid=%s", (suuid,))
        s = cur.fetchone()
        if s is None:
            err(404, "not_found", "settlement not found")
        try:
            settle_mod.complete(conn, s["id"])
        except settle_mod.SettlementError as e:
            err(409, e.code, e.message)
        conn.commit()
        # fire-and-forget payout confirmation to the merchant (dormant if no creds)
        background.add_task(_email_settlement_bg, s["id"])
        return settlement_detail(suuid, user)


@app.get("/api/settlements/{suuid}/day-payouts")
def settlement_day_payouts(suuid: str, user: dict = Depends(current_user)):
    """Per-day payout breakdown + paid status for a settlement (admin + owning merchant)."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, merchant_id FROM settlements WHERE settlement_uuid=%s", (suuid,))
        s = cur.fetchone()
        if s is None or (user["role"] == "merchant" and s["merchant_id"] != user["merchant_id"]):
            err(404, "not_found", "settlement not found")
        return settle_mod.day_payouts(conn, s["id"])


@app.post("/api/settlements/{suuid}/days/{day}/complete")
def complete_settlement_day(suuid: str, day: str, background: BackgroundTasks,
                            user: dict = Depends(require_admin)):
    """Pay out one processing day of a settlement (partial completion)."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM settlements WHERE settlement_uuid=%s", (suuid,))
        s = cur.fetchone()
        if s is None:
            err(404, "not_found", "settlement not found")
        try:
            res = settle_mod.complete_day(conn, s["id"], day)
        except settle_mod.SettlementError as e:
            err(409, e.code, e.message)
        conn.commit()
        # email the per-day payout report (dormant if mailer/merchant email unset);
        # only on a fresh pay, not an idempotent replay
        if not res.get("already_paid"):
            background.add_task(_email_settlement_day_bg, s["id"], day)
        return res


@app.post("/api/settlements/{suuid}/cancel")
def cancel_settlement(suuid: str, user: dict = Depends(require_admin)):
    """Void a generated (not-yet-paid) settlement: reverse the generation and
    unlink its events so they can be re-settled (e.g. per day)."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM settlements WHERE settlement_uuid=%s", (suuid,))
        s = cur.fetchone()
        if s is None:
            err(404, "not_found", "settlement not found")
        try:
            settle_mod.cancel(conn, s["id"])
        except settle_mod.SettlementError as e:
            err(409, e.code, e.message)
        conn.commit()
        return settlement_detail(suuid, user)


@app.post("/api/settlements/{suuid}/send-confirmation")
def send_settlement_confirmation(suuid: str, user: dict = Depends(require_admin)):
    """Manually (re)send the payout-confirmation email — synchronous, returns the
    send result so the caller sees success/failure."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, state FROM settlements WHERE settlement_uuid=%s", (suuid,))
        s = cur.fetchone()
        if s is None:
            err(404, "not_found", "settlement not found")
        return settlement_email_mod.send_confirmation(conn, s["id"])


@app.post("/api/settlements/{suuid}/days/{day}/send-confirmation")
def send_settlement_day_confirmation(suuid: str, day: str, user: dict = Depends(require_admin)):
    """Manually (re)send the per-day payout report — day-only, returns send result."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM settlements WHERE settlement_uuid=%s", (suuid,))
        s = cur.fetchone()
        if s is None:
            err(404, "not_found", "settlement not found")
        return settlement_email_mod.send_day_confirmation(conn, s["id"], day)


@app.get("/api/email/status")
def email_status(user: dict = Depends(require_admin)):
    """Whether the Gmail mailer is configured (for a settings/health view)."""
    return mailer_mod.status()


# ---------------------------------------------------------------- mail settings
@app.get("/api/settings/mail")
def get_mail_settings(user: dict = Depends(require_admin)):
    """Outbound-mail config for the Settings tab. Secrets are never echoed back —
    only a set/unset flag and the source (db override vs env fallback)."""
    return {"status": mailer_mod.status(), "config": settings_store_mod.mail_overview()}


class MailSettingsBody(BaseModel):
    # All optional: a field left out (None) is UNCHANGED; an empty string CLEARS the
    # override (reverting to the env var, if any). Secrets are write-only — send a new
    # value to set/replace, omit to keep the stored one.
    from_addr: str | None = None
    enabled: bool | None = None
    client_id: str | None = None
    client_secret: str | None = None
    refresh_token: str | None = None


@app.put("/api/settings/mail")
def update_mail_settings(body: MailSettingsBody, user: dict = Depends(require_admin)):
    """Persist the sending account. Values are stored in app_settings and override
    the TW_* env vars at runtime — no redeploy needed."""
    changes: dict[str, str | None] = {}
    if body.from_addr is not None:
        changes["TW_MAIL_FROM"] = body.from_addr
    if body.client_id is not None:
        changes["TW_GMAIL_CLIENT_ID"] = body.client_id
    if body.client_secret is not None:
        changes["TW_GMAIL_CLIENT_SECRET"] = body.client_secret
    if body.refresh_token is not None:
        changes["TW_GMAIL_REFRESH_TOKEN"] = body.refresh_token
    if body.enabled is not None:
        # is_configured() treats "0" as the off-switch; clear the key to mean "on".
        changes["TW_MAIL_ENABLED"] = "" if body.enabled else "0"
    with get_pool().connection() as conn:
        settings_store_mod.save(conn, changes)
    return {"status": mailer_mod.status(), "config": settings_store_mod.mail_overview()}


class MailTestBody(BaseModel):
    to: str


@app.post("/api/settings/mail/test")
def send_mail_test(body: MailTestBody, user: dict = Depends(require_admin)):
    """Send a small test email to confirm the sending account works end-to-end."""
    html = (
        "<p>This is a test email from <b>CoreServices</b>.</p>"
        "<p>If you received this, payout-confirmation emails will send from "
        f"<b>{mailer_mod.status().get('from') or 'this account'}</b>.</p>"
    )
    return mailer_mod.send(body.to, "CoreServices — test email", html)


# ---- Gmail OAuth "Connect" flow (mint the refresh token via the live app) ----
_GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"


def _public_base(request: Request) -> str:
    """Public origin of this app (behind Caddy/Cloudflare), for the redirect URI."""
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or "app.paymentrecon.site"
    proto = request.headers.get("x-forwarded-proto") or ("http" if host.startswith("localhost") else "https")
    return f"{proto}://{host}"


def _oauth_redirect_uri(request: Request) -> str:
    return _public_base(request) + "/api/settings/mail/oauth/callback"


@app.get("/api/settings/mail/oauth/start")
def mail_oauth_start(request: Request, user: dict = Depends(require_admin)):
    """Return the Google consent URL to connect the sending account. The client id
    (and secret, used later) must already be saved in the mail settings."""
    client_id = mailer_mod._cfg("TW_GMAIL_CLIENT_ID")
    if not client_id:
        err(400, "no_client", "Save the Gmail OAuth client id and secret first.")
    redirect_uri = _oauth_redirect_uri(request)
    state = jwt.encode({"typ": "mail_oauth", "exp": int(time.time()) + 600},
                       auth_mod.SECRET, algorithm="HS256")
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
        # openid+email so the token response carries the mailbox address → we can set
        # the From automatically and the admin never types anything.
        "scope": f"openid email {_GMAIL_SEND_SCOPE}", "access_type": "offline",
        "prompt": "consent", "state": state,
    })
    return {"auth_url": auth_url, "redirect_uri": redirect_uri}


@app.get("/api/settings/mail/oauth/callback")
def mail_oauth_callback(request: Request, code: str | None = None,
                        state: str | None = None, error: str | None = None):
    """Google redirects the browser here. Exchange the code for a refresh token
    server-side and store it in the mail settings, then bounce back to /settings."""
    base = _public_base(request)

    def back(flag: str) -> RedirectResponse:
        return RedirectResponse(base + "/settings?" + flag, status_code=302)

    if error or not code or not state:
        return back("mail_error=" + urllib.parse.quote(error or "no_code"))
    try:
        jwt.decode(state, auth_mod.SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        return back("mail_error=bad_state")
    client_id = mailer_mod._cfg("TW_GMAIL_CLIENT_ID")
    client_secret = mailer_mod._cfg("TW_GMAIL_CLIENT_SECRET")
    if not client_id or not client_secret:
        return back("mail_error=no_client")
    data = urllib.parse.urlencode({
        "code": code, "client_id": client_id, "client_secret": client_secret,
        "redirect_uri": _oauth_redirect_uri(request), "grant_type": "authorization_code",
    }).encode()
    try:
        req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            tok = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return back("mail_error=exchange_failed")
    rt = tok.get("refresh_token")
    if not rt:
        return back("mail_error=no_refresh_token")
    updates = {"TW_GMAIL_REFRESH_TOKEN": rt, "TW_MAIL_ENABLED": ""}
    # Capture the authorized mailbox from the id_token and use it as the From address.
    # Always follow the account that was just connected, so reconnecting / switching
    # to a different Gmail updates the sender (previously it stuck to the first one).
    try:
        email = jwt.decode(tok.get("id_token", ""), options={"verify_signature": False}).get("email")
    except Exception:
        email = None
    if email:
        updates["TW_MAIL_FROM"] = f"CoreServices <{email}>"
    with get_pool().connection() as conn:
        settings_store_mod.save(conn, updates)
    return back("mail_connected=1")


class CycleBody(BaseModel):
    cutoff: str | None = None  # ISO date/datetime; default now (UTC)


@app.post("/api/settlements/run-cycle")
def run_settlement_cycle(body: CycleBody, user: dict = Depends(require_admin)):
    """Run one T+N settlement cycle: release due reserves, settle + pay out every
    eligible merchant×currency. Idempotent per cutoff date."""
    cutoff = None
    if body.cutoff:
        # a date-only cutoff means "settle everything through the end of that day"
        cutoff = _window_end(body.cutoff)
    with get_pool().connection() as conn:
        summary = cycle_mod.run_cycle(conn, cutoff=cutoff, generated_by=user["sub"])
        conn.commit()
        return summary


@app.get("/api/settlements/{suuid}")
def settlement_detail(suuid: str, user: dict = Depends(current_user)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT s.*, m.name AS merchant_name, m.merchant_uuid AS m_uuid
                       FROM settlements s JOIN merchants m ON m.id=s.merchant_id
                       WHERE s.settlement_uuid=%s""", (suuid,))
        s = cur.fetchone()
        if s is None or (user["role"] == "merchant" and s["merchant_id"] != user["merchant_id"]):
            err(404, "not_found", "settlement not found")
        bd = dict(s["breakdown"] or {})
        counts = bd.pop("counts", {})
        items_count = bd.pop("items_count", 0)
        cur.execute("SELECT * FROM fee_schedules WHERE merchant_id=%s", (s["merchant_id"],))
        fs = cur.fetchone() or {}
        fee_schedule = {k: v for k, v in fs.items() if k != "merchant_id"}
        return {"settlement_uuid": str(s["settlement_uuid"]),
                "confirmation_code": s.get("confirmation_code"),
                "merchant_uuid": str(s["m_uuid"]), "merchant_name": s["merchant_name"],
                "currency": s["currency"], "window_start": s["window_start"].isoformat(),
                "window_end": s["window_end"].isoformat(), "state": s["state"],
                "counts": counts, "breakdown": bd,
                "fee_schedule": fee_schedule,
                "items_count": items_count,
                "net_payout_minor": int(s["net_payout_minor"])}


@app.get("/api/settlements/{suuid}/items")
def settlement_line_items(suuid: str, user: dict = Depends(current_user)):
    """Per-transaction charge breakdown for one settlement (admin + owning merchant)."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, merchant_id FROM settlements WHERE settlement_uuid=%s", (suuid,))
        s = cur.fetchone()
        if s is None or (user["role"] == "merchant" and s["merchant_id"] != user["merchant_id"]):
            err(404, "not_found", "settlement not found")
        return {"items": settle_mod.line_items(conn, s["id"])}


# ---------------------------------------------------------------- ledger
@app.get("/api/ledger/accounts")
def ledger_accounts(user: dict = Depends(current_user), merchant_uuid: str | None = None):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        mid = scope_merchant_id(user, merchant_uuid, cur)
        where, p = ["TRUE"], {}
        if mid:
            where.append("a.merchant_id=%(mid)s"); p["mid"] = mid
        cur.execute(f"""
            SELECT a.id, a.account_type, a.currency, b.balance_minor,
                   m.merchant_uuid, m.name AS merchant_name, m.member_id
              FROM accounts a JOIN account_balances b ON b.account_id=a.id
              LEFT JOIN merchants m ON m.id=a.merchant_id
             WHERE {' AND '.join(where)}
             ORDER BY a.merchant_id NULLS FIRST, a.account_type, a.currency""", p)
        items = []
        for r in cur.fetchall():
            label = r["account_type"]
            if r["merchant_name"]:
                label += f" — {r['merchant_name']}"
            label += f" ({r['currency']})"
            items.append({"account_id": r["id"], "account_type": r["account_type"],
                          "merchant_uuid": str(r["merchant_uuid"]) if r["merchant_uuid"] else None,
                          "merchant_name": r["merchant_name"], "member_id": r["member_id"],
                          "currency": r["currency"],
                          "balance_minor": int(r["balance_minor"]), "label": label})
        return {"items": items}


@app.get("/api/ledger/accounts/{account_id}/entries")
def account_entries(account_id: int, user: dict = Depends(current_user),
                    page: int = 1, page_size: int = Query(50, le=200),
                    q: str | None = None,
                    date_from: str | None = None, date_to: str | None = None):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT merchant_id FROM accounts WHERE id=%s", (account_id,))
        a = cur.fetchone()
        if a is None or (user["role"] == "merchant" and a["merchant_id"] != user["merchant_id"]):
            err(404, "not_found", "account not found")
        where, p = ["le.account_id=%(aid)s"], {"aid": account_id}
        if date_from:
            where.append("e.occurred_at >= %(df)s"); p["df"] = date_from
        if date_to:                                    # inclusive of the whole end day
            where.append("e.occurred_at < %(dt)s::date + 1"); p["dt"] = date_to
        if q and q.strip():                            # match event type or uuid
            where.append("(e.event_type ILIKE %(q)s OR e.event_uuid::text ILIKE %(q)s)")
            p["q"] = f"%{q.strip().replace(' ', '%')}%"
        w = " AND ".join(where)
        cur.execute(f"SELECT COUNT(*) AS n FROM ledger_entries le "
                    f"JOIN ledger_events e ON e.id=le.event_id WHERE {w}", p)
        total = cur.fetchone()["n"]
        p["lim"], p["off"] = page_size, (page - 1) * page_size
        cur.execute(f"""
            SELECT le.entry_uuid, le.posted_at, e.occurred_at, le.direction, le.amount_minor,
                   le.balance_after_minor, le.currency, e.event_type, e.event_uuid
              FROM ledger_entries le JOIN ledger_events e ON e.id=le.event_id
             WHERE {w} ORDER BY le.id DESC LIMIT %(lim)s OFFSET %(off)s""", p)
        items = [{"entry_uuid": str(r["entry_uuid"]), "posted_at": r["posted_at"].isoformat(),
                  "occurred_at": r["occurred_at"].isoformat(),
                  "event_type": r["event_type"], "event_uuid": str(r["event_uuid"]),
                  "direction": r["direction"], "amount_minor": int(r["amount_minor"]),
                  "balance_after_minor": int(r["balance_after_minor"]),
                  "currency": r["currency"]} for r in cur.fetchall()]
        return {"items": items, "total": int(total), "page": page, "page_size": page_size}


# ---- per-merchant ledger view -------------------------------------------------
def _merchant_balance_sums(cur, mid_filter_sql: str, p: dict) -> dict:
    """merchant_id -> {currency -> {payable, reserve}} from account balances."""
    cur.execute(f"""
        SELECT a.merchant_id, a.account_type, a.currency, b.balance_minor
          FROM accounts a JOIN account_balances b ON b.account_id=a.id
         WHERE a.merchant_id IS NOT NULL {mid_filter_sql}""", p)
    out: dict = {}
    for r in cur.fetchall():
        c = out.setdefault(r["merchant_id"], {}).setdefault(
            r["currency"], {"currency": r["currency"], "payable_minor": 0, "reserve_minor": 0})
        if r["account_type"] == "merchant_payable":
            c["payable_minor"] = int(r["balance_minor"])
        elif r["account_type"] == "merchant_reserve":
            c["reserve_minor"] = int(r["balance_minor"])
    return out


def _merchant_paid_out(cur, mid_filter_sql: str, p: dict) -> dict:
    """Paid-out per merchant/currency from the ledger (settlement_completed events),
    so whole-settlement and per-day partial payouts both count."""
    where = mid_filter_sql.replace("merchant_id", "a.merchant_id")
    cur.execute(f"""
        SELECT a.merchant_id, a.currency, COALESCE(SUM(le.amount_minor),0) AS total
          FROM ledger_events e
          JOIN ledger_entries le ON le.event_id=e.id AND le.direction='debit'
          JOIN accounts a ON a.id=le.account_id AND a.account_type='settlement_payable'
         WHERE e.event_type='settlement_completed' {where}
         GROUP BY a.merchant_id, a.currency""", p)
    out: dict = {}
    for r in cur.fetchall():
        out.setdefault(r["merchant_id"], []).append(
            {"currency": r["currency"], "amount_minor": int(r["total"] or 0)})
    return out


def _unbalanced_merchant_ids(cur) -> set:
    """Merchant ids whose stored account balance ≠ the signed sum of its entries.
    Uses the same credit-normal account list as the global integrity check."""
    cur.execute("""
        SELECT DISTINCT a.merchant_id FROM account_balances b
          JOIN accounts a ON a.id=b.account_id
          LEFT JOIN (
            SELECT le.account_id,
                   SUM(CASE WHEN (a2.account_type IN ('merchant_payable','merchant_reserve',
                          'settlement_payable','chargeback_suspense','gateway_revenue','tax_payable'))
                            = (le.direction='credit')
                        THEN le.amount_minor ELSE -le.amount_minor END) AS s
              FROM ledger_entries le JOIN accounts a2 ON a2.id=le.account_id
             GROUP BY le.account_id) e ON e.account_id=b.account_id
         WHERE a.merchant_id IS NOT NULL AND b.balance_minor <> COALESCE(e.s, 0)""")
    return {r["merchant_id"] for r in cur.fetchall()}


@app.get("/api/ledger/merchants")
def ledger_merchants(user: dict = Depends(current_user)):
    """Ledger landing: one row per merchant (name, member id, payable, paid out,
    balanced) plus the platform (non-merchant) accounts."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        scope, p = "", {}
        if user["role"] == "merchant":
            scope = "AND m.id=%(mid)s"; p["mid"] = user["merchant_id"]
        cur.execute(f"""SELECT m.id, m.merchant_uuid, m.name, m.member_id, m.status
                          FROM merchants m
                         WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.merchant_id=m.id) {scope}
                         ORDER BY m.name""", p)
        rows = cur.fetchall()
        mid_sql = "AND merchant_id=%(mid)s" if user["role"] == "merchant" else ""
        bal = _merchant_balance_sums(cur, "AND a.merchant_id=%(mid)s" if p else "", p)
        paid = _merchant_paid_out(cur, mid_sql, p)
        unbalanced = _unbalanced_merchant_ids(cur)
        merchants = []
        for m in rows:
            ccy = sorted(bal.get(m["id"], {}).values(), key=lambda x: x["currency"])
            merchants.append({
                "merchant_uuid": str(m["merchant_uuid"]), "name": m["name"],
                "member_id": m["member_id"], "status": m["status"],
                "payable": [{"currency": c["currency"], "minor": c["payable_minor"]} for c in ccy],
                "reserve": [{"currency": c["currency"], "minor": c["reserve_minor"]} for c in ccy],
                "paid": paid.get(m["id"], []),
                "balanced": m["id"] not in unbalanced})
        platform = []
        if user["role"] != "merchant":
            cur.execute("""SELECT a.id, a.account_type, a.currency, b.balance_minor
                             FROM accounts a JOIN account_balances b ON b.account_id=a.id
                            WHERE a.merchant_id IS NULL
                            ORDER BY a.account_type, a.currency""")
            platform = [{"account_id": r["id"], "account_type": r["account_type"],
                         "currency": r["currency"], "balance_minor": int(r["balance_minor"])}
                        for r in cur.fetchall()]
        return {"merchants": merchants, "platform": platform}


@app.get("/api/ledger/merchants/{muuid}")
def ledger_merchant_detail(muuid: str, user: dict = Depends(current_user)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, merchant_uuid, name, member_id, status FROM merchants "
                    "WHERE merchant_uuid=%s", (muuid,))
        m = cur.fetchone()
        if m is None or (user["role"] == "merchant" and m["id"] != user["merchant_id"]):
            err(404, "not_found", "merchant not found")
        cur.execute("""SELECT a.id, a.account_type, a.currency, b.balance_minor
                         FROM accounts a JOIN account_balances b ON b.account_id=a.id
                        WHERE a.merchant_id=%s ORDER BY a.account_type, a.currency""", (m["id"],))
        accounts = [{"account_id": r["id"], "account_type": r["account_type"],
                     "currency": r["currency"], "balance_minor": int(r["balance_minor"])}
                    for r in cur.fetchall()]
        p = {"mid": m["id"]}
        bal = _merchant_balance_sums(cur, "AND a.merchant_id=%(mid)s", p)
        ccy = sorted(bal.get(m["id"], {}).values(), key=lambda x: x["currency"])
        paid = _merchant_paid_out(cur, "AND merchant_id=%(mid)s", p).get(m["id"], [])
        balanced = m["id"] not in _unbalanced_merchant_ids(cur)
        return {"merchant_uuid": str(m["merchant_uuid"]), "name": m["name"],
                "member_id": m["member_id"], "status": m["status"], "accounts": accounts,
                "payable": [{"currency": c["currency"], "minor": c["payable_minor"]} for c in ccy],
                "reserve": [{"currency": c["currency"], "minor": c["reserve_minor"]} for c in ccy],
                "paid": paid, "balanced": balanced}


@app.get("/api/ledger/merchants/{muuid}/entries")
def merchant_ledger_entries(muuid: str, user: dict = Depends(current_user),
                            page: int = 1, page_size: int = Query(50, le=200),
                            q: str | None = None,
                            date_from: str | None = None, date_to: str | None = None):
    """Combined ledger statement across all of a merchant's accounts."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM merchants WHERE merchant_uuid=%s", (muuid,))
        m = cur.fetchone()
        if m is None or (user["role"] == "merchant" and m["id"] != user["merchant_id"]):
            err(404, "not_found", "merchant not found")
        where, p = ["a.merchant_id=%(mid)s"], {"mid": m["id"]}
        if date_from:
            where.append("e.occurred_at >= %(df)s"); p["df"] = date_from
        if date_to:
            where.append("e.occurred_at < %(dt)s::date + 1"); p["dt"] = date_to
        if q and q.strip():                            # match event type, account, or uuid
            where.append("(e.event_type ILIKE %(q)s OR a.account_type ILIKE %(q)s "
                         "OR e.event_uuid::text ILIKE %(q)s)")
            p["q"] = f"%{q.strip().replace(' ', '%')}%"
        w = " AND ".join(where)
        cur.execute(f"""SELECT COUNT(*) AS n FROM ledger_entries le
                          JOIN ledger_events e ON e.id=le.event_id
                          JOIN accounts a ON a.id=le.account_id WHERE {w}""", p)
        total = cur.fetchone()["n"]
        p["lim"], p["off"] = page_size, (page - 1) * page_size
        cur.execute(f"""
            SELECT le.entry_uuid, le.posted_at, e.occurred_at, a.account_type, a.id AS account_id,
                   le.direction, le.amount_minor, le.balance_after_minor, le.currency,
                   e.event_type, e.event_uuid
              FROM ledger_entries le
              JOIN ledger_events e ON e.id=le.event_id
              JOIN accounts a ON a.id=le.account_id
             WHERE {w} ORDER BY le.id DESC LIMIT %(lim)s OFFSET %(off)s""", p)
        items = [{"entry_uuid": str(r["entry_uuid"]), "posted_at": r["posted_at"].isoformat(),
                  "occurred_at": r["occurred_at"].isoformat(), "account_type": r["account_type"],
                  "account_id": r["account_id"], "event_type": r["event_type"],
                  "event_uuid": str(r["event_uuid"]), "direction": r["direction"],
                  "amount_minor": int(r["amount_minor"]),
                  "balance_after_minor": int(r["balance_after_minor"]),
                  "currency": r["currency"]} for r in cur.fetchall()]
        return {"items": items, "total": int(total), "page": page, "page_size": page_size}


@app.get("/api/ledger/merchants/{muuid}/statement")
def merchant_ledger_statement(muuid: str, user: dict = Depends(current_user),
                              page: int = 1, page_size: int = Query(50, le=5000),
                              q: str | None = None, status: str | None = None,
                              currency: str | None = None,
                              date_from: str | None = None, date_to: str | None = None):
    """Merchant-facing daily ledger statement, one row per processed date/currency.

    `pay_status` per row reflects whether that day's captured transactions have been
    paid out to the merchant: 'paid' = every capture sits in a *completed* settlement
    (the payout was actually posted to the ledger), 'in_settlement' = every capture is
    attached to a settlement that is still `generated` (payout not posted yet),
    'unpaid' = some captures aren't in any settlement, 'na' = no captures that day
    (e.g. a pure payout/reserve row). `status=paid` filters to paid days; `unpaid`
    means "not yet paid out" and so covers both 'unpaid' and 'in_settlement'."""
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM merchants WHERE merchant_uuid=%s", (muuid,))
        m = cur.fetchone()
        if m is None or (user["role"] == "merchant" and m["id"] != user["merchant_id"]):
            err(404, "not_found", "merchant not found")
        where, p = ["e.merchant_id=%(mid)s"], {"mid": m["id"], "ctypes": list(settle_mod.CANDIDATE_TYPES)}
        filters = []
        if date_from:
            filters.append("processed_date >= %(df)s::date"); p["df"] = date_from
        if date_to:
            filters.append("processed_date <= %(dt)s::date"); p["dt"] = date_to
        if currency and currency.strip():
            filters.append("currency = %(ccy)s"); p["ccy"] = currency.strip().upper()
        if q and q.strip():
            p["q"] = f"%{q.strip().replace(' ', '%')}%"
            filters.append("(currency ILIKE %(q)s OR conf_code ILIKE %(q)s "
                           "OR latest_event_uuid ILIKE %(q)s OR processed_date::text ILIKE %(q)s)")
        status = (status or "").strip().lower()
        if status == "paid":
            filters.append("pay_status = 'paid'")
        elif status == "unpaid":            # "not yet paid out" — includes in-settlement days
            filters.append("pay_status IN ('unpaid', 'in_settlement')")
        elif status == "in_settlement":
            filters.append("pay_status = 'in_settlement'")
        filtered = " AND ".join(filters) if filters else "TRUE"
        w = " AND ".join(where)
        cte = f"""
            WITH daily AS (
                SELECT e.occurred_at::date AS processed_date,
                       e.currency,
                       COALESCE(SUM(CASE
                         WHEN a.account_type='clearing'
                          AND e.event_type='payment_captured'
                          AND le.direction='debit' THEN le.amount_minor ELSE 0 END),0)::bigint AS processed_minor,
                       COALESCE(SUM(CASE WHEN a.account_type='merchant_payable'
                         THEN CASE WHEN le.direction='credit' THEN le.amount_minor ELSE -le.amount_minor END
                         ELSE 0 END),0)::bigint AS payable_minor,
                       COALESCE(SUM(CASE WHEN a.account_type='merchant_reserve'
                         THEN CASE WHEN le.direction='credit' THEN le.amount_minor ELSE -le.amount_minor END
                         ELSE 0 END),0)::bigint AS reserve_minor,
                       COALESCE(SUM(CASE
                         WHEN a.account_type='settlement_payable'
                          AND e.event_type='settlement_completed'
                          AND le.direction='debit' THEN le.amount_minor ELSE 0 END),0)::bigint AS paid_minor,
                       COUNT(DISTINCT e.id)::int AS event_count,
                       (ARRAY_AGG(e.event_uuid::text ORDER BY e.occurred_at DESC, e.id DESC))[1] AS latest_event_uuid
                  FROM ledger_events e
                  JOIN ledger_entries le ON le.event_id=e.id
                  JOIN accounts a ON a.id=le.account_id
                 WHERE {w}
                 GROUP BY e.occurred_at::date, e.currency
            ), settle_status AS (
                SELECT e.occurred_at::date AS processed_date, e.currency,
                       COUNT(*) AS cap_n,
                       COUNT(si.event_id) AS n_settled,
                       COUNT(*) FILTER (WHERE s.state='completed' OR sdp.settlement_id IS NOT NULL) AS n_paid,
                       MAX(s.confirmation_code) AS conf_code
                  FROM ledger_events e
                  LEFT JOIN settlement_items si ON si.event_id=e.id
                  LEFT JOIN settlements s ON s.id=si.settlement_id
                  LEFT JOIN settlement_day_payouts sdp
                         ON sdp.settlement_id=s.id AND sdp.day=e.occurred_at::date
                 WHERE {w} AND e.event_type = ANY(%(ctypes)s) AND e.source_txn_id IS NOT NULL
                 GROUP BY 1, 2
            ), joined AS (
                SELECT d.*, ss.conf_code,
                       CASE
                         WHEN COALESCE(ss.cap_n, 0) = 0 THEN 'na'
                         WHEN ss.n_paid = ss.cap_n THEN 'paid'
                         WHEN ss.n_settled = ss.cap_n THEN 'in_settlement'
                         ELSE 'unpaid'
                       END AS pay_status
                  FROM daily d
                  LEFT JOIN settle_status ss
                    ON ss.processed_date = d.processed_date AND ss.currency = d.currency
            ), filtered AS (
                SELECT * FROM joined WHERE {filtered}
            )
        """
        cur.execute(cte + "SELECT COUNT(*) AS n FROM filtered", p)
        total = cur.fetchone()["n"]
        p["lim"], p["off"] = page_size, (page - 1) * page_size
        cur.execute(cte + """
            SELECT * FROM filtered
             ORDER BY processed_date DESC, currency
             LIMIT %(lim)s OFFSET %(off)s
        """, p)
        items = []
        for r in cur.fetchall():
            code = r.get("conf_code") or ""             # whole-settlement confirmation code
            iso = r["processed_date"].isoformat()
            day_code = f"{code}-{iso.replace('-', '')}" if code else ""
            items.append({
                "row_id": f"{iso}:{r['currency']}",
                "processed_date": iso,
                "currency": r["currency"],
                "processed_minor": int(r["processed_minor"] or 0),
                "payable_minor": int(r["payable_minor"] or 0),
                "reserve_minor": int(r["reserve_minor"] or 0),
                "paid_minor": int(r["paid_minor"] or 0),
                "event_count": int(r["event_count"] or 0),
                "pay_status": r["pay_status"],
                "confirmation": code,
                "settlement_code": code,
                "day_code": day_code,
                "confirmed": bool(code),
            })
        return {"items": items, "total": int(total), "page": page, "page_size": page_size}


@app.get("/api/ledger/events/{euuid}")
def ledger_event(euuid: str, user: dict = Depends(current_user)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, event_uuid, event_type, merchant_id, posted_at, currency "
                    "FROM ledger_events WHERE event_uuid=%s", (euuid,))
        e = cur.fetchone()
        if e is None or (user["role"] == "merchant" and e["merchant_id"] not in
                         (user["merchant_id"], None)):
            err(404, "not_found", "event not found")
        return _event_payload(cur, e)


# ---------------------------------------------------------------- integrity
@app.get("/api/integrity")
def integrity(user: dict = Depends(current_user)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        s = _integrity_summary(cur)
        checks = [
            {"name": "Every event sums to zero (double-entry)",
             "ok": s["unbalanced_events"] == 0,
             "detail": f"{s['events']:,} events / {s['entries']:,} entries checked, "
                       f"{s['unbalanced_events']} unbalanced"},
            {"name": "Account balances equal the sum of their entries",
             "ok": s["balance_mismatches"] == 0,
             "detail": f"all accounts reconciled live, {s['balance_mismatches']} mismatches"},
        ]
        # append-only: genuinely attempt an UPDATE and expect the trigger to reject it
        ok_append = False
        detail = "no entries to test"
        cur.execute("SELECT id FROM ledger_entries LIMIT 1")
        row = cur.fetchone()
        if row:
            try:
                with conn.transaction():
                    cur.execute("UPDATE ledger_entries SET amount_minor=amount_minor WHERE id=%s",
                                (row["id"],))
            except Exception as ex:
                ok_append = "append-only" in str(ex)
                detail = "UPDATE rejected by database trigger: ledger_entries is append-only"
        checks.append({"name": "Ledger is append-only (UPDATE/DELETE rejected)",
                       "ok": ok_append, "detail": detail})
        cur.execute("SELECT COUNT(*) AS n FROM posting_idempotency")
        idem = int(cur.fetchone()["n"])
        cur.execute("SELECT COUNT(*) AS n FROM posting_idempotency pi "
                    "LEFT JOIN ledger_events le ON le.id = pi.event_id WHERE le.id IS NULL")
        orphans = int(cur.fetchone()["n"])
        # Each source event is posted exactly once — a UNIQUE(source_type, source_id)
        # gate, so replayed imports post nothing. The ledger legitimately holds MORE
        # events than source keys: append-only fee reprices / reserve recalcs post
        # reversal+replay events that don't mint new source keys. So the invariant is
        # "every key resolves to a live event", NOT a 1:1 count with total events.
        extra = s["events"] - idem
        checks.append({"name": "Idempotent posting (unique source event gate)",
                       "ok": orphans == 0,
                       "detail": f"{idem:,} unique source events, each posted once; "
                                 + (f"{extra:,} append-only reversal/replay events from reprices; "
                                    if extra else "")
                                 + f"{orphans} orphaned keys"})
        return {"checks": checks, "ok": all(c["ok"] for c in checks)}


# ---------------------------------------------------------------- static frontend
# In production the built SPA is served by the API itself, so the frontend's
# relative `/api` calls hit the same origin (no CORS, no separate host). Active
# only when TW_FRONTEND_DIR points at a built dist/; in local dev the Vite dev
# server handles this instead, so this block is dormant.
import os as _os  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402

_FRONTEND_DIR = _os.environ.get("TW_FRONTEND_DIR")
if _FRONTEND_DIR and _os.path.isdir(_FRONTEND_DIR):
    _ROOT = _os.path.realpath(_FRONTEND_DIR)
    _INDEX = _os.path.join(_ROOT, "index.html")
    _assets_dir = _os.path.join(_ROOT, "assets")
    if _os.path.isdir(_assets_dir):
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def _spa(full_path: str):
        # unknown /api paths stay JSON 404s, never the SPA shell
        if full_path.startswith("api/"):
            err(404, "not_found", "not found")
        # serve a real static file if it exists and is inside the dir (no traversal)
        candidate = _os.path.realpath(_os.path.join(_ROOT, full_path))
        if full_path and _os.path.commonpath([_ROOT, candidate]) == _ROOT and _os.path.isfile(candidate):
            return FileResponse(candidate)
        # otherwise return the SPA shell and let the client router take over
        return FileResponse(_INDEX)
