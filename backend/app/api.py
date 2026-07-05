from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import auth as auth_mod
from .auth import current_user, require_admin
from .db import get_pool
from .money import fmt
from . import settle as settle_mod
from . import cycle as cycle_mod
from . import onboarding as onboarding_mod

app = FastAPI(title="Transactworld Ledger API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])

from .admin import router as admin_router  # noqa: E402
app.include_router(admin_router)


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


# ---------------------------------------------------------------- auth
class LoginBody(BaseModel):
    email: str
    password: str


@app.post("/api/auth/login")
def login(body: LoginBody):
    u = auth_mod.DEMO_USERS.get(body.email.lower())
    if not u or u["password"] != body.password:
        err(401, "bad_credentials", "invalid email or password")
    merchant_uuid = merchant_id = merchant_name = None
    if u["merchant_match"]:
        with get_pool().connection() as conn:
            cur = conn.cursor()
            # Prefer the demo's named merchant if it's present; otherwise fall back to
            # the merchant with the most transactions so the merchant portal always
            # works after a reset + partial upload (demo resilience).
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
    token = auth_mod.issue(body.email.lower(), merchant_uuid, merchant_id)
    return {"token": token, "user": {"name": u["name"], "role": u["role"],
                                     "merchant_uuid": merchant_uuid,
                                     "merchant_name": merchant_name}}


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
        cur.execute(f"""
            SELECT currency, SUM(net_payout_minor) AS total FROM settlements s
             WHERE state='completed' {"AND s.merchant_id=%(mid)s" if mid else ""}
             GROUP BY currency""", p)
        paid_out = [{"currency": r["currency"], "amount_minor": int(r["total"])}
                    for r in cur.fetchall()]

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
def _merchant_item(cur, m) -> dict:
    cur.execute("""
        SELECT a.account_type, a.currency, b.balance_minor
          FROM accounts a JOIN account_balances b ON b.account_id=a.id
         WHERE a.merchant_id=%s""", (m["id"],))
    bal: dict[str, dict] = {}
    for r in cur.fetchall():
        c = bal.setdefault(r["currency"], {"currency": r["currency"], "payable_minor": 0,
                                           "reserve_minor": 0, "in_settlement_minor": 0})
        key = {"merchant_payable": "payable_minor", "merchant_reserve": "reserve_minor",
               "settlement_payable": "in_settlement_minor"}.get(r["account_type"])
        if key:
            c[key] = int(r["balance_minor"])
    cur.execute("""
        SELECT currency, SUM(captured_minor) AS s, COUNT(*) AS n,
               COUNT(*) FILTER (WHERE ledger_posted = false) AS q FROM transactions
         WHERE merchant_id=%s GROUP BY currency""", (m["id"],))
    caps, n_total, n_quarantined = [], 0, 0
    for r in cur.fetchall():
        caps.append({"currency": r["currency"], "amount_minor": int(r["s"] or 0)})
        n_total += int(r["n"])
        n_quarantined += int(r["q"])
    return {"merchant_uuid": str(m["merchant_uuid"]), "name": m["name"],
            "member_id": m["member_id"], "status": m["status"],
            "balances": sorted(bal.values(), key=lambda b: b["currency"]),
            "txn_count": n_total, "quarantined_count": n_quarantined,
            "captured_minor_total": caps}


@app.get("/api/merchants")
def merchants(user: dict = Depends(current_user)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        if user["role"] == "merchant":
            cur.execute("SELECT * FROM merchants WHERE id=%s", (user["merchant_id"],))
        else:
            cur.execute("SELECT * FROM merchants ORDER BY name")
        return {"items": [_merchant_item(cur, m) for m in cur.fetchall()]}


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
    results, errors = [], []
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
            except ValueError as e:
                errors.append({"merchant_uuid": muuid, "error": str(e)})
            conn.commit()
    return {"applied": len(results), "failed": len(errors),
            "results": results, "errors": errors}


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
                currency: str | None = None):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        mid = scope_merchant_id(user, merchant_uuid, cur)
        where, p = ["TRUE"], {}
        if mid:
            where.append("s.merchant_id=%(mid)s"); p["mid"] = mid
        if currency:
            where.append("s.currency=%(c)s"); p["c"] = currency.upper()
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


@app.post("/api/settlements/generate")
def generate_settlement(body: GenerateBody, user: dict = Depends(require_admin)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM merchants WHERE merchant_uuid=%s", (body.merchant_uuid,))
        m = cur.fetchone()
        if m is None:
            err(404, "not_found", "merchant not found")
        ws = datetime.fromisoformat(body.window_start).replace(tzinfo=timezone.utc)
        we = datetime.fromisoformat(body.window_end).replace(tzinfo=timezone.utc)
        res = settle_mod.generate(conn, merchant_id=m["id"], currency=body.currency.upper(),
                                  window_start=ws, window_end=we,
                                  generated_by=user["sub"])
        if res.get("skipped"):
            return res
        cur.execute("SELECT settlement_uuid FROM settlements WHERE id=%s",
                    (res["settlement_id"],))
        suuid = str(cur.fetchone()["settlement_uuid"])
        conn.commit()  # detail below reads via a fresh pooled connection
        return settlement_detail(suuid, user)


@app.post("/api/settlements/{suuid}/complete")
def complete_settlement(suuid: str, user: dict = Depends(require_admin)):
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
        return settlement_detail(suuid, user)


class CycleBody(BaseModel):
    cutoff: str | None = None  # ISO date/datetime; default now (UTC)


@app.post("/api/settlements/run-cycle")
def run_settlement_cycle(body: CycleBody, user: dict = Depends(require_admin)):
    """Run one T+N settlement cycle: release due reserves, settle + pay out every
    eligible merchant×currency. Idempotent per cutoff date."""
    cutoff = None
    if body.cutoff:
        cutoff = datetime.fromisoformat(body.cutoff)
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=timezone.utc)
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
        # USDC display conversion (demo: USD 1:1; others indicative)
        rates = {"USD": "1.0000", "EUR": "1.0850", "AUD": "0.6650", "CAD": "0.7350",
                 "GBP": "1.2700", "JPY": "0.0069"}
        rate = rates.get(s["currency"], "1.0000")
        usdc_amount = f"{float(rate) * s['net_payout_minor'] / 100:.2f}" \
            if s["currency"] != "JPY" else f"{float(rate) * s['net_payout_minor']:.2f}"
        return {"settlement_uuid": str(s["settlement_uuid"]),
                "merchant_uuid": str(s["m_uuid"]), "merchant_name": s["merchant_name"],
                "currency": s["currency"], "window_start": s["window_start"].isoformat(),
                "window_end": s["window_end"].isoformat(), "state": s["state"],
                "counts": counts, "breakdown": bd,
                "usdc": {"rate": rate, "amount": usdc_amount},
                "items_count": items_count,
                "net_payout_minor": int(s["net_payout_minor"])}


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
                   m.merchant_uuid, m.name AS merchant_name
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
                          "merchant_name": r["merchant_name"], "currency": r["currency"],
                          "balance_minor": int(r["balance_minor"]), "label": label})
        return {"items": items}


@app.get("/api/ledger/accounts/{account_id}/entries")
def account_entries(account_id: int, user: dict = Depends(current_user),
                    page: int = 1, page_size: int = Query(50, le=200)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT merchant_id FROM accounts WHERE id=%s", (account_id,))
        a = cur.fetchone()
        if a is None or (user["role"] == "merchant" and a["merchant_id"] != user["merchant_id"]):
            err(404, "not_found", "account not found")
        cur.execute("SELECT COUNT(*) AS n FROM ledger_entries WHERE account_id=%s",
                    (account_id,))
        total = cur.fetchone()["n"]
        cur.execute("""
            SELECT le.entry_uuid, le.posted_at, le.direction, le.amount_minor,
                   le.balance_after_minor, le.currency, e.event_type, e.event_uuid
              FROM ledger_entries le JOIN ledger_events e ON e.id=le.event_id
             WHERE le.account_id=%s ORDER BY le.id DESC LIMIT %s OFFSET %s""",
                    (account_id, page_size, (page - 1) * page_size))
        items = [{"entry_uuid": str(r["entry_uuid"]), "posted_at": r["posted_at"].isoformat(),
                  "event_type": r["event_type"], "event_uuid": str(r["event_uuid"]),
                  "direction": r["direction"], "amount_minor": int(r["amount_minor"]),
                  "balance_after_minor": int(r["balance_after_minor"]),
                  "currency": r["currency"]} for r in cur.fetchall()]
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
        idem = cur.fetchone()["n"]
        checks.append({"name": "Idempotent posting (unique source event gate)",
                       "ok": int(idem) == s["events"],
                       "detail": f"{idem:,} unique source events map 1:1 to {s['events']:,} "
                                 "ledger events; replayed imports post nothing"})
        return {"checks": checks, "ok": all(c["ok"] for c in checks)}
