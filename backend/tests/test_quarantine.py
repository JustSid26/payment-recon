"""Unknown merchants are quarantined (no 5% default), and onboarding replays
their transactions into the ledger at the configured rate. Isolated database.
"""
import pathlib
import sys

import psycopg
import pytest
from psycopg.rows import dict_row

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from app.importer import Importer  # noqa: E402
from app import onboarding as ob  # noqa: E402

ADMIN_DSN = "postgresql://tw:tw@localhost:5455/twledger"
DSN = "postgresql://tw:tw@localhost:5455/twledger_quarantine_test"


@pytest.fixture(scope="module", autouse=True)
def db():
    with psycopg.connect(ADMIN_DSN, autocommit=True) as c:
        c.execute("DROP DATABASE IF EXISTS twledger_quarantine_test (FORCE)")
        c.execute("CREATE DATABASE twledger_quarantine_test")
    schema = (pathlib.Path(__file__).resolve().parents[1] / "schema.sql").read_text()
    with psycopg.connect(DSN) as c:
        c.execute(schema)
        c.commit()
    yield


@pytest.fixture
def conn():
    with psycopg.connect(DSN, row_factory=dict_row) as c:
        yield c


def row(pid, member, name, status="Capture Successful", captured="1000.00", ccy="USD"):
    return {"Payment ID": pid, "Tracking ID": pid, "Member ID": member,
            "Merchant Company Name": name, "Currency": ccy,
            "Transaction Date(MM/DD/YYYY)": "09-06-2026 10:00", "Status": status,
            "Auth Amount": captured, "Captured Amount": captured,
            "Refund Amount": "0", "Chargeback Amount": "0"}


def one(conn, sql, args=()):
    return conn.cursor().execute(sql, args).fetchone()


def test_unknown_merchant_is_quarantined_no_default_mdr(conn):
    Importer(conn)._commit_chunk([row("u1", "99001", "Random Merchant Ltd")], "t.csv", {})
    m = one(conn, "SELECT id, status FROM merchants WHERE member_id='99001'")
    assert m["status"] == "unconfigured"
    assert one(conn, "SELECT count(*) c FROM fee_schedules WHERE merchant_id=%s",
               (m["id"],))["c"] == 0
    # transaction imported but quarantined; NO ledger events, NO fees (no 5% MDR)
    assert one(conn, "SELECT ledger_posted FROM transactions WHERE upstream_payment_id='u1'"
               )["ledger_posted"] is False
    assert one(conn, "SELECT count(*) c FROM ledger_events WHERE merchant_id=%s",
               (m["id"],))["c"] == 0
    assert one(conn, "SELECT count(*) c FROM fees WHERE merchant_id=%s", (m["id"],))["c"] == 0


def test_known_merchant_still_books(conn):
    Importer(conn)._commit_chunk([row("k1", "cana1", "CANAMONEY EXCHANGE LTD")], "t.csv", {})
    m = one(conn, "SELECT id, status FROM merchants WHERE member_id='cana1'")
    assert m["status"] == "active"
    assert one(conn, "SELECT count(*) c FROM ledger_events WHERE merchant_id=%s",
               (m["id"],))["c"] > 0
    # canamoney books its annex rate (6.5%), not a generic default
    mdr = one(conn, "SELECT fee_minor FROM fees WHERE merchant_id=%s AND fee_type='mdr'",
              (m["id"],))
    assert mdr["fee_minor"] == 6_500  # 6.5% of 1000.00


def test_onboarding_posts_at_configured_rate(conn):
    Importer(conn)._commit_chunk([row("u2", "99002", "Another Unknown")], "t.csv", {})
    mid = one(conn, "SELECT id FROM merchants WHERE member_id='99002'")["id"]
    rates = ob.resolve_rates(overrides={"mdr_bps": 300, "settlement_fee_bps": 100})
    summary = ob.assign_fee_schedule(conn, mid, rates)
    assert summary["transactions_posted"] == 1
    assert one(conn, "SELECT status FROM merchants WHERE id=%s", (mid,))["status"] == "active"
    assert one(conn, "SELECT ledger_posted FROM transactions WHERE upstream_payment_id='u2'"
               )["ledger_posted"] is True
    # MDR booked at 3% (3000 minor), NOT the old 5% default (5000)
    assert one(conn, "SELECT fee_minor FROM fees WHERE transaction_id="
               "(SELECT id FROM transactions WHERE upstream_payment_id='u2') AND fee_type='mdr'"
               )["fee_minor"] == 3_000


def test_onboarding_is_idempotent(conn):
    mid = one(conn, "SELECT id FROM merchants WHERE member_id='99002'")["id"]
    assert ob.reprocess_merchant(conn, mid) == 0  # nothing left quarantined


def _reserve(conn, mid):
    return one(conn, "SELECT COALESCE(b.balance_minor,0) AS v FROM accounts a "
               "LEFT JOIN account_balances b ON b.account_id=a.id "
               "WHERE a.merchant_id=%s AND a.account_type='merchant_reserve'", (mid,))["v"]


def test_changing_rate_reprices_the_ledger(conn):
    # 1000.00 capture, onboard at 5% rolling reserve
    Importer(conn)._commit_chunk([row("rp1", "77001", "Reprice Co")], "t.csv", {})
    mid = one(conn, "SELECT id FROM merchants WHERE member_id='77001'")["id"]
    ob.assign_fee_schedule(conn, mid,
                           ob.resolve_rates(overrides={"mdr_bps": 300, "reserve_hold_bps": 500}))
    assert _reserve(conn, mid) == 4_850       # 5% of net-of-fees payable (100000 - 3000 MDR)

    # change rolling reserve 5% -> 20%: must RE-PRICE, not stack on the old hold
    summary = ob.assign_fee_schedule(conn, mid,
                                     ob.resolve_rates(overrides={"mdr_bps": 300, "reserve_hold_bps": 2000}))
    assert summary["transactions_repriced"] >= 1
    assert _reserve(conn, mid) == 19_400      # now 20% of net-of-fees payable, old hold reversed (not stacked)
    # ledger still balances after the reverse+replay
    bad = one(conn, """SELECT COUNT(*) AS n FROM (
        SELECT event_id FROM ledger_entries GROUP BY event_id
        HAVING SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0) x""")
    assert bad["n"] == 0
