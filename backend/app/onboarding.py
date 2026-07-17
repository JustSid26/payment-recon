"""Merchant onboarding: turn a quarantined (unknown) merchant into a live one.

Unknown merchants imported from a real-world sheet land 'unconfigured' — their
transactions are visible but carry NO ledger events (they are never defaulted to
5% MDR). Assigning a fee schedule activates them and replays their quarantined
transactions through the exact same posting path the importer uses, so the
resulting ledger is identical to having known the merchant up front.
"""
from __future__ import annotations

import psycopg

from .importer import Importer, insert_fee_schedule, WORKBOOK_RATES, ANNEX_RATES, FEE_COLUMNS
from .ledger import BulkPoster, AccountCache, Leg, DEBIT, CREDIT, post_event

# Named rate cards the onboarding UI/CLI can pick from, plus fully custom rates.
PRESETS = {"workbook": WORKBOOK_RATES, "annex": ANNEX_RATES}

# Sensible defaults so a caller can pass only the fields they care about.
_DEFAULTS = dict(approved_txn_fee_minor=0, declined_txn_fee_minor=0, refund_fee_minor=0,
                 chargeback_fee_minor=0, reserve_hold_bps=0, reserve_hold_days=180,
                 settlement_fee_bps=0, settlement_delay_days=0, settlement_schedule="daily")


def resolve_rates(*, preset: str | None = None, overrides: dict | None = None) -> dict:
    """Build a full rate dict from a preset name and/or explicit field overrides."""
    base = dict(_DEFAULTS)
    if preset:
        if preset not in PRESETS:
            raise ValueError(f"unknown preset '{preset}' (have: {', '.join(PRESETS)})")
        base.update(PRESETS[preset])
    if overrides:
        base.update({k: v for k, v in overrides.items() if k in FEE_COLUMNS})
    missing = [c for c in FEE_COLUMNS if c not in base]
    if missing:
        raise ValueError(f"missing required rate fields: {', '.join(missing)}")
    _validate_rates(base)
    return base


def _validate_rates(r: dict) -> None:
    """Reject hostile/degenerate schedules before they reach the ledger."""
    for k in ("mdr_bps", "reserve_hold_bps", "settlement_fee_bps"):
        if not (0 <= r[k] <= 10000):
            raise ValueError(f"{k} must be 0–10000 bps (0–100%), got {r[k]}")
    for k in ("approved_txn_fee_minor", "declined_txn_fee_minor", "refund_fee_minor",
              "chargeback_fee_minor", "reserve_hold_days", "settlement_delay_days"):
        if r[k] < 0:
            raise ValueError(f"{k} must be non-negative, got {r[k]}")


def assign_fee_schedule(conn: psycopg.Connection, merchant_id: int, rates: dict,
                        *, reprocess: bool = True) -> dict:
    """Set (or replace) a merchant's fee schedule and activate them.

    If the merchant already has posted (but unsettled) transactions, they are
    RE-PRICED: the old ledger events are reversed and the transactions replayed
    under the new schedule, so a rate change (e.g. rolling reserve 5%→20%) is
    actually reflected. Refuses if any transaction is already settled."""
    # Activation, re-price and replay run in ONE transaction: if anything fails
    # (e.g. a bad schedule) it all rolls back, so a merchant is never stranded.
    with conn.transaction():
        cur = conn.cursor()
        cur.execute("SELECT id FROM merchants WHERE id=%s FOR UPDATE", (merchant_id,))
        if cur.fetchone() is None:
            raise ValueError("merchant not found")
        cur.execute("DELETE FROM fee_schedules WHERE merchant_id=%s", (merchant_id,))
        insert_fee_schedule(cur, merchant_id, rates)
        cur.execute("UPDATE merchants SET status='active' WHERE id=%s", (merchant_id,))
        repriced = _reverse_posted(conn, cur, merchant_id) if reprocess else 0
        posted = _reprocess_body(conn, cur, merchant_id) if reprocess else 0
    return {"merchant_id": merchant_id, "transactions_posted": posted,
            "transactions_repriced": repriced}


def _reverse_posted(conn: psycopg.Connection, cur, merchant_id: int) -> int:
    """Reverse a merchant's already-posted transaction events so they can be
    replayed under a new schedule. Append-only safe (posts reversal events, never
    deletes). Refuses if any of those events are already in a settlement."""
    cur.execute("""SELECT COUNT(*) AS n FROM settlement_items si
                     JOIN ledger_events e ON e.id=si.event_id
                    WHERE e.merchant_id=%s""", (merchant_id,))
    if cur.fetchone()["n"] > 0:
        raise ValueError(
            "cannot change rates: some of this merchant's transactions are already "
            "settled. Reset the demo (or re-import) and set the rate before settling.")
    # posting events (linked to a transaction) not already reversed
    cur.execute("""SELECT e.id, e.currency, e.occurred_at, e.source_txn_id
                     FROM ledger_events e
                    WHERE e.merchant_id=%s AND e.source_txn_id IS NOT NULL
                      AND e.reverses_event_id IS NULL
                      AND NOT EXISTS (SELECT 1 FROM ledger_events r
                                       WHERE r.reverses_event_id=e.id)
                    ORDER BY e.id""", (merchant_id,))
    events = cur.fetchall()
    if not events:
        return 0
    accts = AccountCache()
    for ev in events:
        cur.execute("""SELECT a.account_type, a.merchant_id, le.direction, le.amount_minor
                         FROM ledger_entries le JOIN accounts a ON a.id=le.account_id
                        WHERE le.event_id=%s""", (ev["id"],))
        legs = [Leg(r["account_type"], r["merchant_id"],
                    CREDIT if r["direction"] == DEBIT else DEBIT, int(r["amount_minor"]))
                for r in cur.fetchall()]
        post_event(conn, event_type="reversal", source_type="reprice_reversal",
                   source_id=str(ev["id"]), merchant_id=merchant_id, currency=ev["currency"],
                   occurred_at=ev["occurred_at"], legs=legs, reverses_event_id=ev["id"],
                   source_txn_id=ev["source_txn_id"], accounts=accts,
                   metadata={"repriced": True})
    eids = [e["id"] for e in events]
    cur.execute("DELETE FROM fees WHERE ledger_event_id = ANY(%s)", (eids,))
    cur.execute("DELETE FROM reserve_holds WHERE hold_event_id = ANY(%s)", (eids,))
    cur.execute("DELETE FROM posting_idempotency WHERE event_id = ANY(%s)", (eids,))
    cur.execute("UPDATE transactions SET ledger_posted=false "
                "WHERE merchant_id=%s AND ledger_posted=true", (merchant_id,))
    return len(events)


def reprocess_merchant(conn: psycopg.Connection, merchant_id: int) -> int:
    """Post ledger events for a merchant's quarantined transactions. Idempotent —
    the ledger's source-id replay gate prevents double posting. Returns the count
    of transactions moved out of quarantine."""
    with conn.transaction():
        return _reprocess_body(conn, conn.cursor(), merchant_id)


def _reprocess_body(conn: psycopg.Connection, cur, merchant_id: int) -> int:
    """Replay a merchant's quarantined transactions into the ledger. Runs inside
    the caller's transaction (shared by onboarding so it is atomic)."""
    imp = Importer(conn)  # reuse _post_transaction / _flush_and_link
    sched = imp.schedule_for(cur, merchant_id)
    if sched is None:
        raise ValueError("merchant has no fee schedule; assign one first")
    cur.execute(
        "SELECT id, upstream_payment_id, currency, occurred_at, status, "
        "captured_minor, refunded_minor FROM transactions "
        "WHERE merchant_id=%s AND ledger_posted=false ORDER BY id",
        (merchant_id,),
    )
    txns = cur.fetchall()
    poster = BulkPoster(conn)
    fee_rows: list = []
    reserve_rows: list = []
    for t in txns:
        imp._post_transaction(
            poster, fee_rows, reserve_rows, sched,
            pay_id=t["upstream_payment_id"], mid=merchant_id, ccy=t["currency"],
            occurred=t["occurred_at"], status=t["status"],
            captured=t["captured_minor"], refunded=t["refunded_minor"], txn_id=t["id"],
        )
    imp._flush_and_link(cur, poster, fee_rows, reserve_rows)
    cur.execute(
        "UPDATE transactions SET ledger_posted=true "
        "WHERE merchant_id=%s AND ledger_posted=false",
        (merchant_id,),
    )
    return len(txns)


def unconfigured_merchants(conn: psycopg.Connection) -> list[dict]:
    """Merchants awaiting onboarding, with how many transactions are quarantined."""
    cur = conn.cursor()
    cur.execute(
        """SELECT m.id, m.merchant_uuid, m.member_id, m.name,
                  COUNT(t.id) FILTER (WHERE t.ledger_posted = false) AS quarantined,
                  COALESCE(SUM(t.captured_minor) FILTER (WHERE t.ledger_posted = false), 0)
                    AS quarantined_captured_minor
             FROM merchants m
             LEFT JOIN transactions t ON t.merchant_id = m.id
            WHERE m.status = 'unconfigured'
            GROUP BY m.id, m.merchant_uuid, m.member_id, m.name
            ORDER BY quarantined DESC""",
    )
    return cur.fetchall()
