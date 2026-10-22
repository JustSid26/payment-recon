"""Unknown merchants are quarantined (no 5% default), and onboarding replays
their transactions into the ledger at the configured rate. Isolated database.
"""
import pathlib
import sys

import psycopg
import pytest
from psycopg.rows import dict_row

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from datetime import datetime, timezone  # noqa: E402

from app.importer import Importer  # noqa: E402
from app import onboarding as ob  # noqa: E402
from app import cycle as cycle_mod  # noqa: E402

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


def test_fee_config_remembered_and_reapplied(conn):
    from app.importer import remembered_rates
    # onboard an unknown merchant at custom rates → the config is remembered
    Importer(conn)._commit_chunk([row("mem1", "55001", "Remember Co")], "t.csv", {})
    mid = one(conn, "SELECT id FROM merchants WHERE member_id='55001'")["id"]
    ob.assign_fee_schedule(conn, mid, ob.resolve_rates(
        overrides={"mdr_bps": 300, "settlement_fee_bps": 100}))

    # remembered under both member_id and (normalised) name
    cur = conn.cursor()
    assert remembered_rates(cur, "55001", "irrelevant")["mdr_bps"] == 300
    assert remembered_rates(cur, "nomatch", "REMEMBER CO")["mdr_bps"] == 300
    assert remembered_rates(cur, "nope", "no such name") is None

    # a NEW merchant (different id) with the SAME name auto-configures from memory —
    # active, booked at the remembered 3% MDR, NOT quarantined
    imp = Importer(conn)
    imp._commit_chunk([row("mem2", "55002", "Remember Co")], "t.csv", {})
    m2 = one(conn, "SELECT id, status FROM merchants WHERE member_id='55002'")
    assert m2["status"] == "active"
    assert imp.stats["remembered_merchants"] == 1
    assert one(conn, "SELECT ledger_posted FROM transactions WHERE upstream_payment_id='mem2'"
               )["ledger_posted"] is True
    assert one(conn, "SELECT fee_minor FROM fees WHERE merchant_id=%s AND fee_type='mdr'",
               (m2["id"],))["fee_minor"] == 3000  # 3% of 1000.00, not quarantined


def test_onboarding_is_idempotent(conn):
    mid = one(conn, "SELECT id FROM merchants WHERE member_id='99002'")["id"]
    assert ob.reprocess_merchant(conn, mid) == 0  # nothing left quarantined


def _reserve(conn, mid):
    return one(conn, "SELECT COALESCE(b.balance_minor,0) AS v FROM accounts a "
               "LEFT JOIN account_balances b ON b.account_id=a.id "
               "WHERE a.merchant_id=%s AND a.account_type='merchant_reserve'", (mid,))["v"]


def test_reserve_is_percent_of_gross_captured(conn):
    """The rolling reserve is held on the GROSS capture — the annex rate card reads
    against processing volume, so MDR and the approved-txn fee must not shrink it."""
    Importer(conn)._commit_chunk([row("rr1", "88001", "Reserve Base Co")], "t.csv", {})
    mid = one(conn, "SELECT id FROM merchants WHERE member_id='88001'")["id"]
    ob.assign_fee_schedule(conn, mid, ob.resolve_rates(
        overrides={"mdr_bps": 650, "approved_txn_fee_minor": 35, "reserve_hold_bps": 1000}))
    # 10% of the 100000 gross capture — NOT 10% of the 93465 net-of-fees payable
    assert _reserve(conn, mid) == 10_000


def test_changing_rate_reprices_the_ledger(conn):
    # 1000.00 capture, onboard at 5% rolling reserve
    Importer(conn)._commit_chunk([row("rp1", "77001", "Reprice Co")], "t.csv", {})
    mid = one(conn, "SELECT id FROM merchants WHERE member_id='77001'")["id"]
    ob.assign_fee_schedule(conn, mid,
                           ob.resolve_rates(overrides={"mdr_bps": 300, "reserve_hold_bps": 500}))
    assert _reserve(conn, mid) == 5_000       # 5% of the 100000 gross capture

    # change rolling reserve 5% -> 20%: must RE-PRICE, not stack on the old hold
    summary = ob.assign_fee_schedule(conn, mid,
                                     ob.resolve_rates(overrides={"mdr_bps": 300, "reserve_hold_bps": 2000}))
    assert summary["transactions_repriced"] >= 1
    assert _reserve(conn, mid) == 20_000      # now 20% of gross, old hold reversed (not stacked)


def test_recalculate_reposts_at_current_schedule(conn):
    """A formula change is picked up by re-posting at the SAME schedule."""
    mid = one(conn, "SELECT id FROM merchants WHERE member_id='77001'")["id"]
    summary = ob.recalculate(conn, mid)
    assert summary["transactions_repriced"] >= 1
    assert _reserve(conn, mid) == 20_000      # unchanged rates → unchanged result
    # ledger still balances after the reverse+replay
    bad = one(conn, """SELECT COUNT(*) AS n FROM (
        SELECT event_id FROM ledger_entries GROUP BY event_id
        HAVING SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0) x""")
    assert bad["n"] == 0


def test_delay_only_change_allowed_after_settlement(conn):
    """A settlement-timing-only edit (T+days) must succeed even once the merchant's
    transactions are already settled — it moves no posted money, it only governs
    when FUTURE events settle. An AMOUNT change on the same settled merchant must
    still be refused by the append-only re-price guard. (Regression: the fee modal
    returned 400 for any save on a merchant that already had a settlement.)"""
    Importer(conn)._commit_chunk([row("d1", "55001", "Delay Co")], "t.csv", {})
    mid = one(conn, "SELECT id FROM merchants WHERE member_id='55001'")["id"]
    ob.assign_fee_schedule(conn, mid, ob.resolve_rates(
        overrides={"mdr_bps": 300, "settlement_delay_days": 0}))
    # settle everything (cutoff well past the June capture date)
    cycle_mod.generate_pending(conn, cutoff=datetime(2026, 12, 1, tzinfo=timezone.utc),
                               merchant_ids=[mid])
    assert one(conn, """SELECT COUNT(*) c FROM settlement_items si
                          JOIN ledger_events e ON e.id=si.event_id
                         WHERE e.merchant_id=%s""", (mid,))["c"] >= 1

    # delay-only change (same amounts, T+0 -> T+1): allowed, no reverse attempted
    summary = ob.assign_fee_schedule(conn, mid, ob.resolve_rates(
        overrides={"mdr_bps": 300, "settlement_delay_days": 1}))
    assert summary["transactions_repriced"] == 0
    assert one(conn, "SELECT settlement_delay_days d FROM fee_schedules WHERE merchant_id=%s",
               (mid,))["d"] == 1

    # an AMOUNT change on the settled merchant is still refused
    with pytest.raises(ValueError, match="already"):
        ob.assign_fee_schedule(conn, mid, ob.resolve_rates(
            overrides={"mdr_bps": 500, "settlement_delay_days": 1}))
