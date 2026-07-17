"""The T+N settlement worker — what a scheduler (cron / Celery beat) runs each
business day to move money the way Stripe/Razorpay do.

A cycle, for a given `cutoff` datetime, does two things per merchant×currency:

  1. release_due_reserves  — rolling-reserve holds whose release_due_at has arrived
     are released back to payable (reserve_release event), so they settle this cycle.
  2. settle + pay out       — every unsettled payable event with settle_after <= cutoff
     is netted into a settlement (settle.generate) and immediately paid out
     (settle.complete) with a payout reference. Deficit books (net <= 0) are skipped
     and carry, exactly like the on-demand path.

Idempotent per cutoff date: generate()/complete()/reserve_release all key their
idempotency on the cycle date, so re-running a cycle is a no-op. Payouts here are
*simulated* — the ledger moves (settlement_payable -> clearing) and a reference is
recorded; wiring a real rail (SEPA/USDC) is the only remaining piece.
"""
from __future__ import annotations

from datetime import datetime, timezone

import psycopg

from . import settle as settle_mod
from .ledger import Leg, DEBIT, CREDIT, post_event


def _now() -> datetime:
    return datetime.now(timezone.utc)


def release_due_reserves(conn: psycopg.Connection, cutoff: datetime) -> list[dict]:
    """Release every reserve hold with release_due_at <= cutoff, aggregated per
    merchant×currency into one reserve_release event. Returns per-group results."""
    results: list[dict] = []
    cur = conn.cursor()
    cur.execute(
        """SELECT merchant_id, currency,
                  SUM(amount_minor) AS total, array_agg(id) AS ids
             FROM reserve_holds
            WHERE released_at IS NULL AND release_due_at <= %s
            GROUP BY merchant_id, currency""",
        (cutoff,),
    )
    groups = cur.fetchall()
    for g in groups:
        mid, ccy, total, ids = g["merchant_id"], g["currency"], int(g["total"]), g["ids"]
        with conn.transaction():
            c = conn.cursor()
            c.execute("SELECT pg_advisory_xact_lock(hashtext(%s))",
                      (f"reserve_release:{mid}:{ccy}",))
            event_id, created = post_event(
                conn, event_type="reserve_release", source_type="reserve_release",
                source_id=f"{mid}:{ccy}:{cutoff.date()}", merchant_id=mid, currency=ccy,
                occurred_at=cutoff, settle_after=cutoff,
                legs=[Leg("merchant_reserve", mid, DEBIT, total),
                      Leg("merchant_payable", mid, CREDIT, total)],
                metadata={"hold_ids": ids, "released_by": "cycle"},
            )
            if created:
                c.execute(
                    "UPDATE reserve_holds SET released_at=%s, release_event_id=%s "
                    "WHERE id = ANY(%s) AND released_at IS NULL",
                    (cutoff, event_id, ids),
                )
        results.append({"merchant_id": mid, "currency": ccy,
                        "released_minor": total, "holds": len(ids), "replayed": not created})
    return results


def _eligible_pairs(conn: psycopg.Connection, cutoff: datetime) -> list[tuple[int, str]]:
    cur = conn.cursor()
    cur.execute(
        """SELECT DISTINCT e.merchant_id, e.currency
             FROM ledger_events e
             JOIN ledger_entries le ON le.event_id = e.id
             JOIN accounts a ON a.id = le.account_id AND a.account_type='merchant_payable'
             LEFT JOIN settlement_items si ON si.event_id = e.id
            WHERE e.event_type = ANY(%s)
              AND e.settle_after <= %s
              AND si.event_id IS NULL
              AND e.merchant_id IS NOT NULL""",
        (list(settle_mod.CANDIDATE_TYPES), cutoff),
    )
    return [(r["merchant_id"], r["currency"]) for r in cur.fetchall()]


def _window_start(conn: psycopg.Connection, merchant_id: int, currency: str) -> datetime:
    """Continue from the last settled window; else start before all data."""
    cur = conn.cursor()
    cur.execute(
        "SELECT MAX(window_end) AS we FROM settlements WHERE merchant_id=%s AND currency=%s",
        (merchant_id, currency),
    )
    row = cur.fetchone()
    return row["we"] if row and row["we"] else datetime(2000, 1, 1, tzinfo=timezone.utc)


def run_cycle(conn: psycopg.Connection, *, cutoff: datetime | None = None,
              generated_by: str = "scheduler") -> dict:
    """Run one settlement cycle. Returns a summary of releases, payouts, and skips."""
    now = _now()
    cutoff = cutoff or now
    # A future cutoff would release rolling reserves before their hold has elapsed
    # (reserves exist to cover future chargebacks) — clamp it to now.
    if cutoff > now:
        cutoff = now
    released = release_due_reserves(conn, cutoff)

    settled, skipped = [], []
    for mid, ccy in _eligible_pairs(conn, cutoff):
        ws = _window_start(conn, mid, ccy)
        # the cycle drains ALL matured backlog (not just one processing window)
        res = settle_mod.generate(conn, merchant_id=mid, currency=ccy,
                                  window_start=ws, window_end=cutoff,
                                  cutoff=cutoff, scope_by_occurred=False,
                                  generated_by=generated_by)
        if res.get("skipped"):
            skipped.append({"merchant_id": mid, "currency": ccy, "reason": res["reason"]})
            continue
        sid = res["settlement_id"]
        # simulated payout: complete() moves settlement_payable -> clearing
        if not res.get("existing"):
            settle_mod.complete(conn, sid)
        ref = f"PO-{cutoff.date():%Y%m%d}-{sid}"
        with conn.transaction():
            conn.cursor().execute(
                "UPDATE settlements SET payout_reference=COALESCE(payout_reference,%s), "
                "settled_at=COALESCE(settled_at,%s), cycle_date=%s WHERE id=%s",
                (ref, cutoff, cutoff.date(), sid),
            )
        settled.append({"merchant_id": mid, "currency": ccy, "settlement_id": sid,
                        "net_payout_minor": _net(conn, sid), "payout_reference": ref})

    return {
        "cutoff": cutoff.isoformat(),
        "reserves_released": released,
        "settled": settled,
        "skipped_deficit": skipped,
        "counts": {"settled": len(settled), "skipped": len(skipped),
                   "reserve_groups_released": len(released)},
    }


def _net(conn: psycopg.Connection, settlement_id: int) -> int:
    cur = conn.cursor()
    cur.execute("SELECT net_payout_minor FROM settlements WHERE id=%s", (settlement_id,))
    return int(cur.fetchone()["net_payout_minor"])
