"""One running settlement per merchant×currency: repeated uploads APPEND into a
single settlement (new days added, paid days locked), and stray duplicate
settlements MERGE into one. Runs on its own isolated database.
"""
import pathlib
import sys
from datetime import datetime, time, timezone

import psycopg
import pytest
from psycopg.rows import dict_row

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from app.ledger import Leg, DEBIT, CREDIT, post_event  # noqa: E402
from app import cycle as cycle_mod  # noqa: E402
from app import settle as settle_mod  # noqa: E402

ADMIN_DSN = "postgresql://tw:tw@localhost:5455/twledger"
DSN = "postgresql://tw:tw@localhost:5455/twledger_consolidate_test"

NOW = datetime(2026, 8, 25, 12, 0, tzinfo=timezone.utc)
DAY19 = datetime(2026, 8, 19, 10, 0, tzinfo=timezone.utc)
DAY20 = datetime(2026, 8, 20, 22, 0, tzinfo=timezone.utc)   # late UTC — off-by-one bait
DAY21 = datetime(2026, 8, 21, 9, 0, tzinfo=timezone.utc)
DAY22 = datetime(2026, 8, 22, 9, 0, tzinfo=timezone.utc)
MATURED = datetime(2026, 8, 1, 0, 0, tzinfo=timezone.utc)   # settle_after in the past


@pytest.fixture(scope="module", autouse=True)
def db():
    with psycopg.connect(ADMIN_DSN, autocommit=True) as c:
        c.execute("DROP DATABASE IF EXISTS twledger_consolidate_test (FORCE)")
        c.execute("CREATE DATABASE twledger_consolidate_test")
    schema = (pathlib.Path(__file__).resolve().parents[1] / "schema.sql").read_text()
    with psycopg.connect(DSN) as c:
        c.execute(schema)
        c.execute("INSERT INTO merchants (member_id, name) VALUES ('c1','Consolidate Merchant')")
        c.execute(
            """INSERT INTO fee_schedules (merchant_id, mdr_bps, approved_txn_fee_minor,
                 declined_txn_fee_minor, refund_fee_minor, chargeback_fee_minor,
                 reserve_hold_bps, reserve_hold_days, settlement_fee_bps,
                 settlement_delay_days, settlement_schedule)
               VALUES (1,500,30,0,4000,7000,0,180,100,1,'daily')""")
        c.commit()
    yield


@pytest.fixture
def conn():
    with psycopg.connect(DSN, row_factory=dict_row) as c:
        yield c


def _capture(conn, pid, occurred, ccy="EUR"):
    """A 1000.00 capture that matured long ago (settle_after in the past)."""
    gross, mdr, appfee = 100_000, 5_000, 30
    payable = gross - mdr - appfee
    post_event(conn, event_type="payment_captured", source_type="capture", source_id=pid,
               merchant_id=1, currency=ccy, occurred_at=occurred, settle_after=MATURED,
               legs=[Leg("clearing", None, DEBIT, gross),
                     Leg("merchant_payable", 1, CREDIT, payable),
                     Leg("gateway_revenue", None, CREDIT, mdr + appfee)])
    conn.commit()


def _live(conn, ccy="EUR"):
    """All non-cancelled settlements for the merchant in a currency."""
    cur = conn.cursor()
    cur.execute("SELECT id, state, window_start, window_end, net_payout_minor FROM settlements "
                "WHERE state <> 'cancelled' AND merchant_id=1 AND currency=%s ORDER BY id", (ccy,))
    return cur.fetchall()


def _day_bounds(d):
    ds = datetime.combine(d.date(), time(0, 0), tzinfo=timezone.utc)
    de = datetime.combine(d.date(), time(23, 59, 59, 999999), tzinfo=timezone.utc)
    return ds, de


def test_first_upload_creates_one(conn):
    _capture(conn, "p19", DAY19)
    r = cycle_mod.generate_pending(conn, cutoff=NOW)
    assert r["generated"] == 1
    assert len(_live(conn)) == 1


def test_second_upload_appends(conn):
    net1 = _live(conn)[0]["net_payout_minor"]
    _capture(conn, "p20", DAY20)
    _capture(conn, "p21", DAY21)
    r = cycle_mod.generate_pending(conn, cutoff=NOW)
    live = _live(conn)
    assert len(live) == 1, "still ONE settlement after a second upload"
    assert r["appended"] == 1
    s = live[0]
    # window spans first→last actual transaction date (UTC), not stretched a day.
    assert s["window_start"].astimezone(timezone.utc).date() == DAY19.date()
    assert s["window_end"].astimezone(timezone.utc).date() == DAY21.date()
    assert s["net_payout_minor"] > net1
    dp = settle_mod.day_payouts(conn, s["id"])
    assert dp["days_total"] == 3
    assert sum(d["payout_minor"] for d in dp["days"]) == s["net_payout_minor"]


def test_rerun_with_no_new_data_is_noop(conn):
    before = _live(conn)[0]
    r = cycle_mod.generate_pending(conn, cutoff=NOW)
    after = _live(conn)
    assert len(after) == 1 and after[0]["id"] == before["id"]
    assert r["generated"] == 0 and r["appended"] == 0


def test_pay_a_day_then_append_keeps_one_card(conn):
    s = _live(conn)[0]
    dp = settle_mod.day_payouts(conn, s["id"])
    day0, pay0 = dp["days"][0]["day"], dp["days"][0]["payout_minor"]
    settle_mod.complete_day(conn, s["id"], day0)
    conn.commit()

    # a new upload folds into the SAME settlement (reopening it), paid day untouched.
    _capture(conn, "p22", DAY22)
    r = cycle_mod.generate_pending(conn, cutoff=NOW)
    assert r["appended"] == 1
    live = _live(conn)
    assert len(live) == 1, "one settlement even after a day was paid + new upload"
    s2 = live[0]
    assert s2["id"] == s["id"] and s2["state"] == "generated"
    dp2 = settle_mod.day_payouts(conn, s2["id"])
    assert dp2["days_total"] == 4
    paid = next(d for d in dp2["days"] if d["day"] == day0)
    assert paid["paid"] and paid["payout_minor"] == pay0, "paid day locked at its amount"
    assert dp2["days_paid"] == 1
    # day payouts still sum exactly to net
    assert sum(d["payout_minor"] for d in dp2["days"]) == s2["net_payout_minor"]


def test_merge_collapses_duplicate_settlements(conn):
    # Build two separate USD settlements the old per-window way, then confirm the
    # auto path merges them into one running settlement.
    _capture(conn, "u19", DAY19, ccy="USD")
    _capture(conn, "u20", DAY20, ccy="USD")
    ds, de = _day_bounds(DAY19)
    settle_mod.generate(conn, merchant_id=1, currency="USD", window_start=ds, window_end=de,
                        cutoff=NOW, scope_by_occurred=True)
    ds, de = _day_bounds(DAY20)
    settle_mod.generate(conn, merchant_id=1, currency="USD", window_start=ds, window_end=de,
                        cutoff=NOW, scope_by_occurred=True)
    conn.commit()
    assert len(_live(conn, "USD")) == 2, "two separate settlements to start"

    r = cycle_mod.generate_pending(conn, cutoff=NOW)
    assert r["merged"] >= 1
    usd = _live(conn, "USD")
    assert len(usd) == 1, "merged into one running settlement"
    dp = settle_mod.day_payouts(conn, usd[0]["id"])
    assert dp["days_total"] == 2
    assert sum(d["payout_minor"] for d in dp["days"]) == usd[0]["net_payout_minor"]
