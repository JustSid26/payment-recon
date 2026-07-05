"""Settlement generation — idempotent, concurrency-safe, references ledger events.

Mirrors docs/04-settlement-flow.md: candidates are unsettled payable-touching events
with settle_after <= window_end (including pre-window backlog / negative events, which
is how settled-funds chargebacks and decline-fee deficits self-recover). If the net
is <= 0, nothing links and nothing posts.
"""
from __future__ import annotations

from datetime import datetime, timezone

import psycopg

from .ledger import Leg, DEBIT, CREDIT, post_event
from .money import bps_of

CANDIDATE_TYPES = (
    "payment_captured", "decline_fee", "refund", "standalone_fee", "reserve_hold",
    "reserve_release", "manual_adjustment", "chargeback_opened", "chargeback_won",
    "reversal",
)


class SettlementError(Exception):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message
        super().__init__(message)


def generate(conn: psycopg.Connection, *, merchant_id: int, currency: str,
             window_start: datetime, window_end: datetime,
             generated_by: str = "admin") -> dict:
    """Returns {'settlement_id': ...} or {'skipped': True, 'reason': ...}."""
    with conn.transaction():
        cur = conn.cursor()
        # serialize per merchant+currency
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))",
                    (f"settle:{merchant_id}:{currency}",))

        run_key = f"{merchant_id}:{currency}:{window_end.date()}"
        cur.execute(
            "SELECT event_id FROM posting_idempotency WHERE source_type='settlement_run' "
            "AND source_id=%s", (run_key,),
        )
        prior = cur.fetchone()
        if prior:
            cur.execute(
                "SELECT id FROM settlements WHERE generated_event_id=%s", (prior["event_id"],),
            )
            s = cur.fetchone()
            if s:
                return {"settlement_id": s["id"], "existing": True}

        cur.execute("SELECT id FROM accounts WHERE account_type='merchant_payable' "
                    "AND merchant_id=%s AND currency=%s", (merchant_id, currency))
        acct = cur.fetchone()
        if acct is None:
            return {"skipped": True, "reason": "no ledger activity for this merchant/currency"}

        # candidates: payable deltas of unsettled events past settle_after
        cur.execute(
            """SELECT e.id AS event_id, e.event_type,
                      SUM(CASE WHEN le.direction='credit' THEN le.amount_minor
                               ELSE -le.amount_minor END) AS delta
                 FROM ledger_events e
                 JOIN ledger_entries le ON le.event_id = e.id AND le.account_id = %s
                 LEFT JOIN settlement_items si ON si.event_id = e.id
                WHERE e.merchant_id = %s AND e.currency = %s
                  AND e.event_type = ANY(%s)
                  AND e.settle_after <= %s
                  AND si.event_id IS NULL
                GROUP BY e.id, e.event_type
               HAVING SUM(CASE WHEN le.direction='credit' THEN le.amount_minor
                               ELSE -le.amount_minor END) <> 0""",
            (acct["id"], merchant_id, currency, list(CANDIDATE_TYPES), window_end),
        )
        cands = [{**c, "delta": int(c["delta"])} for c in cur.fetchall()]
        if not cands:
            return {"skipped": True, "reason": "no unsettled events in window"}

        n_window = sum(c["delta"] for c in cands)
        cur.execute("SELECT settlement_fee_bps FROM fee_schedules WHERE merchant_id=%s",
                    (merchant_id,))
        fee_bps = (cur.fetchone() or {"settlement_fee_bps": 100})["settlement_fee_bps"]
        sf = bps_of(max(n_window, 0), fee_bps)
        net = n_window - sf
        if net <= 0:
            return {"skipped": True,
                    "reason": f"net <= 0 (window nets to {n_window} minor units before fees); "
                              "deficit carries to the next settlement"}

        breakdown = _breakdown(cur, [c["event_id"] for c in cands], merchant_id, currency,
                               window_start, window_end)
        breakdown["subtotal_minor"] = n_window
        breakdown["settlement_fee_minor"] = sf
        breakdown["net_payout_minor"] = net

        cur.execute(
            """INSERT INTO settlements (merchant_id, currency, window_start, window_end,
                 state, breakdown, net_payout_minor)
               VALUES (%s,%s,%s,%s,'generated',%s,%s) RETURNING id""",
            (merchant_id, currency, window_start, window_end,
             psycopg.types.json.Json(breakdown), net),
        )
        sid = cur.fetchone()["id"]
        cur.executemany(
            "INSERT INTO settlement_items (settlement_id, event_id, payable_delta_minor) "
            "VALUES (%s,%s,%s)",
            [(sid, c["event_id"], c["delta"]) for c in cands],
        )

        legs = [Leg("merchant_payable", merchant_id, DEBIT, net + sf),
                Leg("settlement_payable", merchant_id, CREDIT, net)]
        if sf:
            legs.append(Leg("gateway_revenue", None, CREDIT, sf))
        event_id, _ = post_event(
            conn, event_type="settlement_generated", source_type="settlement_run",
            source_id=run_key, merchant_id=merchant_id, currency=currency,
            occurred_at=datetime.now(timezone.utc), legs=legs,
            metadata={"settlement_id": sid, "generated_by": generated_by},
        )
        cur.execute("UPDATE settlements SET generated_event_id=%s WHERE id=%s",
                    (event_id, sid))
        if sf:
            cur.execute(
                "INSERT INTO fees (merchant_id, fee_type, currency, fee_minor, ledger_event_id) "
                "VALUES (%s,'settlement_fee',%s,%s,%s)", (merchant_id, currency, sf, event_id),
            )
        return {"settlement_id": sid}


def _breakdown(cur, event_ids: list[int], merchant_id: int, currency: str,
               window_start: datetime, window_end: datetime) -> dict:
    cur.execute(
        """SELECT e.event_type,
                  COUNT(*) AS n,
                  SUM(CASE WHEN le.direction='debit' THEN le.amount_minor ELSE 0 END) AS dr,
                  SUM(CASE WHEN le.direction='credit' THEN le.amount_minor ELSE 0 END) AS cr
             FROM ledger_events e
             JOIN ledger_entries le ON le.event_id = e.id
             JOIN accounts a ON a.id = le.account_id AND a.account_type='clearing'
            WHERE e.id = ANY(%s) GROUP BY e.event_type""",
        (event_ids,),
    )
    clearing = {r["event_type"]: r for r in cur.fetchall()}
    cur.execute(
        """SELECT f.fee_type, COALESCE(SUM(f.fee_minor),0) AS total
             FROM fees f WHERE f.ledger_event_id = ANY(%s) GROUP BY f.fee_type""",
        (event_ids,),
    )
    fee_totals = {r["fee_type"]: r["total"] for r in cur.fetchall()}
    cur.execute(
        """SELECT e.event_type,
                  SUM(CASE WHEN le.direction='credit' THEN le.amount_minor
                           ELSE -le.amount_minor END) AS delta
             FROM ledger_events e
             JOIN ledger_entries le ON le.event_id = e.id
             JOIN accounts a ON a.id = le.account_id AND a.account_type='merchant_reserve'
            WHERE e.id = ANY(%s) GROUP BY e.event_type""",
        (event_ids,),
    )
    reserve = {r["event_type"]: r["delta"] for r in cur.fetchall()}
    cur.execute(
        """SELECT COUNT(*) FILTER (WHERE status='auth_failed') AS declined,
                  COUNT(*) FILTER (WHERE status IN ('captured','refunded',
                                                    'partially_refunded')) AS paid
             FROM transactions WHERE merchant_id=%s AND currency=%s
              AND occurred_at >= %s AND occurred_at < %s""",
        (merchant_id, currency, window_start, window_end),
    )
    counts = cur.fetchone()
    cap = clearing.get("payment_captured", {})
    ref = clearing.get("refund", {})
    return {
        "gross_captured_minor": int(cap.get("dr") or 0),
        "mdr_minor": int(fee_totals.get("mdr", 0)),
        "approved_txn_fees_minor": int(fee_totals.get("approved_txn", 0)),
        "declined_txn_fees_minor": int(fee_totals.get("declined_txn", 0)),
        "refunds_minor": int(ref.get("cr") or 0),
        "refund_fees_minor": int(fee_totals.get("refund_fee", 0)),
        "chargebacks_minor": 0,
        "chargeback_fees_minor": int(fee_totals.get("chargeback_fee", 0)),
        "reserve_held_minor": int(reserve.get("reserve_hold", 0)),
        "reserve_released_minor": int(-reserve.get("reserve_release", 0)) if reserve.get("reserve_release") else 0,
        "adjustments_minor": 0,
        "counts": {"paid": int(counts["paid"] or 0), "declined": int(counts["declined"] or 0),
                   "refunds": int(ref.get("n") or 0), "chargebacks": 0},
        "items_count": len(event_ids),
    }


# Event-type priority for a grouped row's display label (highest wins).
_TYPE_PRIORITY = (
    "chargeback_opened", "chargeback_won", "refund", "payment_captured",
    "decline_fee", "standalone_fee", "manual_adjustment", "reversal",
    "reserve_release", "reserve_hold",
)


def line_items(conn: psycopg.Connection, settlement_id: int) -> list[dict]:
    """Per-transaction charge breakdown for a settlement statement.

    One row per settled transaction: a capture and its reserve hold (separate
    ledger events sharing a source_txn_id) collapse into a single line showing
    gross, each fee type, reserve delta and the net payable effect. Events with
    no linked transaction (standalone fees, adjustments) stand alone.
    `net_minor` sums the underlying settlement_items.payable_delta_minor.
    """
    cur = conn.cursor()
    cur.execute(
        """SELECT si.event_id, si.payable_delta_minor, e.event_type, e.occurred_at,
                  e.source_txn_id,
                  t.upstream_payment_id, t.tracking_id, t.order_id, t.payment_brand,
                  t.payment_mode, t.last_four, t.status
             FROM settlement_items si
             JOIN ledger_events e ON e.id = si.event_id
             LEFT JOIN transactions t ON t.id = e.source_txn_id
            WHERE si.settlement_id = %s
            ORDER BY e.occurred_at, e.id""",
        (settlement_id,),
    )
    rows = cur.fetchall()
    if not rows:
        return []
    ids = [r["event_id"] for r in rows]

    cur.execute(
        """SELECT ledger_event_id, fee_type, SUM(fee_minor) AS total
             FROM fees WHERE ledger_event_id = ANY(%s)
            GROUP BY ledger_event_id, fee_type""",
        (ids,),
    )
    fees: dict[int, dict[str, int]] = {}
    for f in cur.fetchall():
        fees.setdefault(f["ledger_event_id"], {})[f["fee_type"]] = int(f["total"])

    cur.execute(
        """SELECT le.event_id,
                  SUM(CASE WHEN le.direction='credit' THEN le.amount_minor
                           ELSE -le.amount_minor END) AS delta
             FROM ledger_entries le
             JOIN accounts a ON a.id = le.account_id AND a.account_type='merchant_reserve'
            WHERE le.event_id = ANY(%s) GROUP BY le.event_id""",
        (ids,),
    )
    reserve = {r["event_id"]: int(r["delta"]) for r in cur.fetchall()}

    cur.execute(
        """SELECT le.event_id,
                  SUM(CASE WHEN le.direction='debit' THEN le.amount_minor
                           ELSE -le.amount_minor END) AS gross
             FROM ledger_entries le
             JOIN accounts a ON a.id = le.account_id AND a.account_type='clearing'
            WHERE le.event_id = ANY(%s) GROUP BY le.event_id""",
        (ids,),
    )
    gross = {r["event_id"]: int(r["gross"]) for r in cur.fetchall()}

    prio = {t: i for i, t in enumerate(_TYPE_PRIORITY)}
    groups: dict = {}
    order: list = []
    for r in rows:
        ev = r["event_id"]
        key = ("t", r["source_txn_id"]) if r["source_txn_id"] else ("e", ev)
        g = groups.get(key)
        if g is None:
            g = {"occurred_at": r["occurred_at"], "type": r["event_type"],
                 "reference": "", "brand": "", "last_four": "", "status": "",
                 "gross_minor": 0, "mdr_minor": 0, "approved_fee_minor": 0,
                 "declined_fee_minor": 0, "refund_fee_minor": 0,
                 "chargeback_fee_minor": 0, "reserve_minor": 0, "net_minor": 0}
            groups[key] = g
            order.append(key)
        if r["occurred_at"] < g["occurred_at"]:
            g["occurred_at"] = r["occurred_at"]
        if prio.get(r["event_type"], 99) < prio.get(g["type"], 99):
            g["type"] = r["event_type"]
        if r["source_txn_id"]:
            g["reference"] = r["upstream_payment_id"] or r["tracking_id"] or r["order_id"] or g["reference"]
            g["brand"] = r["payment_brand"] or r["payment_mode"] or g["brand"]
            g["last_four"] = r["last_four"] or g["last_four"]
            g["status"] = r["status"] or g["status"]
        fmap = fees.get(ev, {})
        g["gross_minor"] += gross.get(ev, 0)
        g["mdr_minor"] += fmap.get("mdr", 0)
        g["approved_fee_minor"] += fmap.get("approved_txn", 0)
        g["declined_fee_minor"] += fmap.get("declined_txn", 0)
        g["refund_fee_minor"] += fmap.get("refund_fee", 0)
        g["chargeback_fee_minor"] += fmap.get("chargeback_fee", 0)
        g["reserve_minor"] += reserve.get(ev, 0)
        g["net_minor"] += int(r["payable_delta_minor"])

    out = []
    for key in order:
        g = groups[key]
        g["occurred_at"] = g["occurred_at"].isoformat()
        out.append(g)
    return out


def complete(conn: psycopg.Connection, settlement_id: int) -> dict:
    with conn.transaction():
        cur = conn.cursor()
        cur.execute("SELECT * FROM settlements WHERE id=%s FOR UPDATE", (settlement_id,))
        s = cur.fetchone()
        if s is None:
            raise SettlementError("not_found", "settlement not found")
        if s["state"] != "generated":
            raise SettlementError("invalid_state", f"cannot complete from '{s['state']}'")
        event_id, _ = post_event(
            conn, event_type="settlement_completed", source_type="settlement_completed",
            source_id=str(settlement_id), merchant_id=s["merchant_id"],
            currency=s["currency"], occurred_at=datetime.now(timezone.utc),
            legs=[Leg("settlement_payable", s["merchant_id"], DEBIT, s["net_payout_minor"]),
                  Leg("clearing", None, CREDIT, s["net_payout_minor"])],
            metadata={"settlement_id": settlement_id},
        )
        cur.execute(
            "UPDATE settlements SET state='completed', completed_event_id=%s WHERE id=%s",
            (event_id, settlement_id),
        )
        return {"settlement_id": settlement_id, "state": "completed"}
