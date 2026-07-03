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
from .ledger import BulkPoster

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
    return base


def assign_fee_schedule(conn: psycopg.Connection, merchant_id: int, rates: dict,
                        *, reprocess: bool = True) -> dict:
    """Set (or replace) a merchant's fee schedule and activate them. By default
    replays their quarantined transactions into the ledger. Rates changes only
    affect not-yet-posted transactions — the ledger is append-only."""
    with conn.transaction():
        cur = conn.cursor()
        cur.execute("SELECT id FROM merchants WHERE id=%s FOR UPDATE", (merchant_id,))
        if cur.fetchone() is None:
            raise ValueError("merchant not found")
        cur.execute("DELETE FROM fee_schedules WHERE merchant_id=%s", (merchant_id,))
        insert_fee_schedule(cur, merchant_id, rates)
        cur.execute("UPDATE merchants SET status='active' WHERE id=%s", (merchant_id,))
    posted = reprocess_merchant(conn, merchant_id) if reprocess else 0
    return {"merchant_id": merchant_id, "transactions_posted": posted}


def reprocess_merchant(conn: psycopg.Connection, merchant_id: int) -> int:
    """Post ledger events for a merchant's quarantined transactions. Idempotent —
    the ledger's source-id replay gate prevents double posting. Returns the count
    of transactions moved out of quarantine."""
    imp = Importer(conn)  # reuse _post_transaction / _flush_and_link (and its stats)
    with conn.transaction():
        cur = conn.cursor()
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
