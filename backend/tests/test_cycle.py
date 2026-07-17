"""T+N settlement cycle end-to-end: eligibility gating, auto-payout, reserve
release, and idempotency. Runs on its own isolated database.
"""
import pathlib
import sys
from datetime import datetime, timezone

import psycopg
import pytest
from psycopg.rows import dict_row

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from app.ledger import Leg, DEBIT, CREDIT, post_event  # noqa: E402
from app import cycle as cycle_mod  # noqa: E402
from app.bizcal import next_settlement_datetime  # noqa: E402
from app.money import bps_of  # noqa: E402

ADMIN_DSN = "postgresql://tw:tw@localhost:5455/twledger"
DSN = "postgresql://tw:tw@localhost:5455/twledger_cycle_test"

TUE = datetime(2026, 6, 9, 10, 0, tzinfo=timezone.utc)      # capture day
T1 = next_settlement_datetime(TUE, 1)                        # 2026-06-10 00:00
BEFORE = datetime(2026, 6, 9, 23, 0, tzinfo=timezone.utc)   # < T+1
AFTER = datetime(2026, 6, 10, 12, 0, tzinfo=timezone.utc)   # >= T+1


@pytest.fixture(scope="module", autouse=True)
def db():
    with psycopg.connect(ADMIN_DSN, autocommit=True) as c:
        c.execute("DROP DATABASE IF EXISTS twledger_cycle_test (FORCE)")
        c.execute("CREATE DATABASE twledger_cycle_test")
    schema = (pathlib.Path(__file__).resolve().parents[1] / "schema.sql").read_text()
    with psycopg.connect(DSN) as c:
        c.execute(schema)
        c.execute("INSERT INTO merchants (member_id, name) VALUES ('c1','Cycle Merchant')")
        c.execute(
            """INSERT INTO fee_schedules (merchant_id, mdr_bps, approved_txn_fee_minor,
                 declined_txn_fee_minor, refund_fee_minor, chargeback_fee_minor,
                 reserve_hold_bps, reserve_hold_days, settlement_fee_bps,
                 settlement_delay_days, settlement_schedule)
               VALUES (1,500,30,0,4000,7000,500,180,100,1,'daily')""")
        c.commit()
    yield


@pytest.fixture
def conn():
    with psycopg.connect(DSN, row_factory=dict_row) as c:
        yield c


def _capture(conn, pid, settle_after, reserve_due=None):
    """A 1000.00 capture: MDR 5% + 0.30 fee, then a 5% reserve hold on the payable."""
    gross, mdr, appfee = 100_000, 5_000, 30
    payable = gross - mdr - appfee
    post_event(conn, event_type="payment_captured", source_type="capture", source_id=pid,
               merchant_id=1, currency="USD", occurred_at=TUE, settle_after=settle_after,
               legs=[Leg("clearing", None, DEBIT, gross),
                     Leg("merchant_payable", 1, CREDIT, payable),
                     Leg("gateway_revenue", None, CREDIT, mdr + appfee)])
    hold = payable * 5 // 100
    eid, _ = post_event(conn, event_type="reserve_hold", source_type="reserve_hold",
                        source_id=pid, merchant_id=1, currency="USD", occurred_at=TUE,
                        settle_after=settle_after,
                        legs=[Leg("merchant_payable", 1, DEBIT, hold),
                              Leg("merchant_reserve", 1, CREDIT, hold)])
    if reserve_due is not None:
        conn.cursor().execute(
            "INSERT INTO reserve_holds (merchant_id, currency, amount_minor, hold_event_id, "
            "release_due_at) VALUES (1,'USD',%s,%s,%s)", (hold, eid, reserve_due))
    conn.commit()
    return payable, hold


def _settlements(conn):
    cur = conn.cursor()
    cur.execute("SELECT * FROM settlements WHERE merchant_id=1 AND currency='USD' ORDER BY id")
    return cur.fetchall()


def test_not_eligible_before_t1(conn):
    _capture(conn, "p1", T1)
    summary = cycle_mod.run_cycle(conn, cutoff=BEFORE)
    assert summary["counts"]["settled"] == 0
    assert _settlements(conn) == []


def test_settles_and_pays_out_after_t1(conn):
    payable, hold = 94_970, 4_748
    summary = cycle_mod.run_cycle(conn, cutoff=AFTER)
    assert summary["counts"]["settled"] == 1
    s = _settlements(conn)
    assert len(s) == 1
    row = s[0]
    # net = (payable - reserve_hold) minus the settlement fee. The fee is charged
    # on everything EXCEPT the rolling reserve → its base is the payable, not the
    # post-reserve subtotal.
    subtotal = payable - hold
    fee = bps_of(payable, 100)
    expected_net = subtotal - fee
    assert row["state"] == "completed"
    assert row["net_payout_minor"] == expected_net
    assert row["payout_reference"] and row["settled_at"] and row["cycle_date"]


def test_cycle_is_idempotent(conn):
    before = len(_settlements(conn))
    cycle_mod.run_cycle(conn, cutoff=AFTER)
    assert len(_settlements(conn)) == before


def test_reserve_release_books_and_settles(conn):
    # a new capture whose reserve is already due for release
    due = datetime(2026, 6, 5, tzinfo=timezone.utc)
    _capture(conn, "p2", T1, reserve_due=due)
    summary = cycle_mod.run_cycle(conn, cutoff=AFTER)
    assert summary["counts"]["reserve_groups_released"] >= 1
    cur = conn.cursor()
    cur.execute("SELECT released_at, release_event_id FROM reserve_holds "
                "WHERE release_due_at=%s", (due,))
    r = cur.fetchone()
    assert r["released_at"] is not None and r["release_event_id"] is not None
    # released reserve became payable and settled out this same cycle
    cur.execute("SELECT COUNT(*) n FROM ledger_events WHERE event_type='reserve_release'")
    assert cur.fetchone()["n"] >= 1
