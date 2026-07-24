"""Cancelling a generated settlement frees its events so they can be re-settled
per day. Runs on its own isolated database.
"""
import pathlib
import sys
from datetime import datetime, timezone

import psycopg
import pytest
from psycopg.rows import dict_row

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from app.ledger import Leg, DEBIT, CREDIT, post_event  # noqa: E402
from app import settle as settle_mod  # noqa: E402

ADMIN_DSN = "postgresql://tw:tw@localhost:5455/twledger"
DSN = "postgresql://tw:tw@localhost:5455/twledger_cancel_test"

DAY_A = datetime(2026, 6, 9, 10, 0, tzinfo=timezone.utc)
DAY_B = datetime(2026, 6, 10, 10, 0, tzinfo=timezone.utc)
PAST = datetime(2026, 6, 1, tzinfo=timezone.utc)   # settle_after in the past → matured
NOW = datetime(2026, 6, 30, tzinfo=timezone.utc)


def day_window(d: datetime):
    """Inclusive single-day window [00:00, 23:59:59.999999], as the API builds it."""
    start = d.replace(hour=0, minute=0, second=0, microsecond=0)
    end = d.replace(hour=23, minute=59, second=59, microsecond=999999)
    return start, end


@pytest.fixture(scope="module", autouse=True)
def db():
    with psycopg.connect(ADMIN_DSN, autocommit=True) as c:
        c.execute("DROP DATABASE IF EXISTS twledger_cancel_test (FORCE)")
        c.execute("CREATE DATABASE twledger_cancel_test")
    schema = (pathlib.Path(__file__).resolve().parents[1] / "schema.sql").read_text()
    with psycopg.connect(DSN) as c:
        c.execute(schema)
        c.execute("INSERT INTO merchants (member_id, name) VALUES ('x1','Cancel Co')")
        c.execute("""INSERT INTO fee_schedules (merchant_id, mdr_bps, approved_txn_fee_minor,
                       declined_txn_fee_minor, refund_fee_minor, chargeback_fee_minor,
                       reserve_hold_bps, reserve_hold_days, settlement_fee_bps,
                       settlement_delay_days, settlement_schedule)
                     VALUES (1,500,30,0,4000,7000,500,180,100,0,'daily')""")
        c.commit()
    yield


@pytest.fixture
def conn():
    with psycopg.connect(DSN, row_factory=dict_row) as c:
        yield c


def _capture(conn, pid, occurred):
    gross, fee = 100_000, 5_030
    post_event(conn, event_type="payment_captured", source_type="capture", source_id=pid,
               merchant_id=1, currency="EUR", occurred_at=occurred, settle_after=PAST,
               legs=[Leg("clearing", None, DEBIT, gross),
                     Leg("merchant_payable", 1, CREDIT, gross - fee),
                     Leg("gateway_revenue", None, CREDIT, fee)])
    conn.commit()


def _payable(conn):
    cur = conn.cursor()
    cur.execute("""SELECT COALESCE(b.balance_minor,0) v FROM accounts a
                     LEFT JOIN account_balances b ON b.account_id=a.id
                    WHERE a.merchant_id=1 AND a.account_type='merchant_payable' AND a.currency='EUR'""")
    return int(cur.fetchone()["v"])


def _unbalanced(conn):
    cur = conn.cursor()
    cur.execute("""SELECT COUNT(*) n FROM (
        SELECT event_id FROM ledger_entries GROUP BY event_id
        HAVING SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END)<>0) x""")
    return cur.fetchone()["n"]


def _items(conn, sid):
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) n FROM settlement_items WHERE settlement_id=%s", (sid,))
    return cur.fetchone()["n"]


def test_cancel_frees_events_then_resettle_per_day(conn):
    _capture(conn, "a", DAY_A)
    _capture(conn, "b", DAY_B)
    payable_before = _payable(conn)

    # lumped settlement over both days
    res = settle_mod.generate(conn, merchant_id=1, currency="EUR",
                              window_start=DAY_A, window_end=DAY_B, cutoff=NOW)
    conn.commit()
    lumped = res["settlement_id"]
    assert _items(conn, lumped) == 2
    assert _payable(conn) < payable_before          # payable moved into settlement

    # cancel it
    out = settle_mod.cancel(conn, lumped)
    conn.commit()
    assert out["state"] == "cancelled"
    assert _items(conn, lumped) == 0                 # events freed
    assert _payable(conn) == payable_before          # payable fully restored
    assert _unbalanced(conn) == 0                    # ledger still balances

    # now settle DAY_A alone and pay it out; DAY_B stays unsettled
    ws_a, we_a = day_window(DAY_A)
    res_a = settle_mod.generate(conn, merchant_id=1, currency="EUR",
                                window_start=ws_a, window_end=we_a, cutoff=NOW,
                                scope_by_occurred=True)
    conn.commit()
    assert "settlement_id" in res_a
    sid_a = res_a["settlement_id"]
    assert _items(conn, sid_a) == 1                  # exactly DAY_A's one event

    settle_mod.complete(conn, sid_a)
    conn.commit()
    cur = conn.cursor()
    cur.execute("SELECT state FROM settlements WHERE id=%s", (sid_a,))
    assert cur.fetchone()["state"] == "completed"
    assert _unbalanced(conn) == 0

    # DAY_B is still settleable on its own (was not swept by DAY_A's settlement)
    ws_b, we_b = day_window(DAY_B)
    res_b = settle_mod.generate(conn, merchant_id=1, currency="EUR",
                                window_start=ws_b, window_end=we_b, cutoff=NOW,
                                scope_by_occurred=True)
    conn.commit()
    assert "settlement_id" in res_b and res_b["settlement_id"] != sid_a


def test_cannot_cancel_completed(conn):
    day_c = datetime(2026, 6, 15, 10, 0, tzinfo=timezone.utc)  # own day → own run-key
    _capture(conn, "c", day_c)
    ws, we = day_window(day_c)
    res = settle_mod.generate(conn, merchant_id=1, currency="EUR",
                              window_start=ws, window_end=we, cutoff=NOW,
                              scope_by_occurred=True)
    conn.commit()
    sid = res["settlement_id"]
    settle_mod.complete(conn, sid)
    conn.commit()
    with pytest.raises(settle_mod.SettlementError):
        settle_mod.cancel(conn, sid)
