"""Regression tests for the adversarial-review fixes: dates, rate validation,
onboarding atomicity, payable clamp, import robustness, and cutoff clamp.
"""
import pathlib
import sys
from datetime import datetime, timezone

import psycopg
import pytest
from psycopg.rows import dict_row

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from app.importer import Importer, parse_dt  # noqa: E402
from app.money import to_minor  # noqa: E402
from app import onboarding as ob  # noqa: E402
from app import cycle  # noqa: E402

ADMIN_DSN = "postgresql://tw:tw@localhost:5455/twledger"
DSN = "postgresql://tw:tw@localhost:5455/twledger_harden_test"


# ---- pure functions (no DB) ------------------------------------------------
def test_parse_dt_iso_first():
    # the real CSV format that used to fall through to now()
    assert parse_dt("2026-06-10 23:57:08") == datetime(2026, 6, 10, 23, 57, 8, tzinfo=timezone.utc)
    assert parse_dt("10-06-2026 14:30").month == 6  # DD-MM fallback still works
    assert parse_dt("") is None
    assert parse_dt("not a date") is None


def test_to_minor_guards_overflow_and_garbage():
    assert to_minor("1e309", "USD") == 0            # quantize overflow
    assert to_minor("99999999999999999999", "USD") == 0  # exceeds bigint
    assert to_minor("garbage", "USD") == 0
    assert to_minor("146.48", "USD") == 14648       # normal still works


def test_resolve_rates_rejects_hostile():
    for bad in ({"mdr_bps": 15000}, {"mdr_bps": -100}, {"reserve_hold_bps": -1},
                {"settlement_fee_bps": 20000}, {"refund_fee_minor": -5}):
        with pytest.raises(ValueError):
            ob.resolve_rates(preset="workbook", overrides=bad)
    ob.resolve_rates(preset="workbook")  # sane baseline still resolves


# ---- DB-backed -------------------------------------------------------------
@pytest.fixture(scope="module", autouse=True)
def db():
    with psycopg.connect(ADMIN_DSN, autocommit=True) as c:
        c.execute("DROP DATABASE IF EXISTS twledger_harden_test (FORCE)")
        c.execute("CREATE DATABASE twledger_harden_test")
    schema = (pathlib.Path(__file__).resolve().parents[1] / "schema.sql").read_text()
    with psycopg.connect(DSN) as c:
        c.execute(schema)
        c.commit()
    yield


@pytest.fixture
def conn():
    with psycopg.connect(DSN, row_factory=dict_row) as c:
        yield c


def row(pid, member, name, cap="1000.00", ccy="USD", status="Capture Successful"):
    return {"Payment ID": pid, "Tracking ID": pid, "Member ID": member,
            "Merchant Company Name": name, "Currency": ccy,
            "Transaction Date(MM/DD/YYYY)": "2026-06-10 10:00:00", "Status": status,
            "Auth Amount": cap, "Captured Amount": cap, "Refund Amount": "0",
            "Chargeback Amount": "0"}


def one(conn, sql, args=()):
    return conn.cursor().execute(sql, args).fetchone()


def test_poison_row_does_not_abort_chunk(conn):
    # a bad-currency, an overflow amount, and a good row in the SAME chunk
    imp = Importer(conn)
    imp._commit_chunk([
        row("good", "P1", "Good Merchant"),
        {**row("bad1", "P1", "Good Merchant"), "Currency": "US Dollar"},   # 9-char ccy
        {**row("bad2", "P1", "Good Merchant"), "Captured Amount": "1e309"},  # overflow
    ], "t.csv", {})
    # the good row survived; poison rows were skipped, not fatal
    assert one(conn, "SELECT count(*) c FROM transactions WHERE upstream_payment_id='good'")["c"] == 1
    assert imp.stats["skipped_bad_currency"] == 1
    assert one(conn, "SELECT count(*) c FROM transactions WHERE upstream_payment_id='bad1'")["c"] == 0


def test_bad_date_skipped_not_stamped_now(conn):
    imp = Importer(conn)
    imp._commit_chunk([{**row("nd", "P2", "NoDate"), "Transaction Date(MM/DD/YYYY)": "??"}], "t.csv", {})
    assert imp.stats["skipped_bad_date"] == 1
    assert one(conn, "SELECT count(*) c FROM transactions WHERE upstream_payment_id='nd'")["c"] == 0


def test_cross_merchant_shared_payment_id_both_kept(conn):
    imp = Importer(conn)
    imp._commit_chunk([row("SHARED", "M1", "MerchOne", cap="10.00")], "a.csv", {})
    imp._commit_chunk([row("SHARED", "M2", "MerchTwo", cap="20.00")], "b.csv", {})
    n = one(conn, "SELECT count(*) c FROM transactions WHERE upstream_payment_id='SHARED'")["c"]
    assert n == 2  # both merchants' transactions survive (was 1 before the fix)


def test_hostile_onboard_does_not_strand(conn):
    Importer(conn)._commit_chunk([row("h", "H1", "Hostile")], "t.csv", {})
    mid = one(conn, "SELECT id FROM merchants WHERE member_id='H1'")["id"]
    with pytest.raises(ValueError):
        ob.assign_fee_schedule(conn, mid, ob.resolve_rates(overrides={"mdr_bps": 15000}))
    # activation rolled back with the failed replay — not stranded active/empty
    assert one(conn, "SELECT status FROM merchants WHERE id=%s", (mid,))["status"] == "unconfigured"
    assert one(conn, "SELECT count(*) c FROM fee_schedules WHERE merchant_id=%s", (mid,))["c"] == 0


def test_small_capture_clamps_instead_of_crashing(conn):
    # a $0.20 capture under a preset whose fixed fee (0.35) exceeds it
    Importer(conn)._commit_chunk([row("sm", "S1", "SmallTicket", cap="0.20")], "t.csv", {})
    mid = one(conn, "SELECT id FROM merchants WHERE member_id='S1'")["id"]
    res = ob.assign_fee_schedule(conn, mid, ob.resolve_rates(preset="annex"))
    assert res["transactions_posted"] == 1  # no crash
    pay = one(conn, "SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_minor "
              "ELSE -amount_minor END),0) b FROM ledger_entries le JOIN accounts a "
              "ON a.id=le.account_id WHERE a.account_type='merchant_payable' AND a.merchant_id=%s",
              (mid,))["b"]
    assert pay == 0  # merchant nets zero, no negative leg booked


def test_run_cycle_clamps_future_cutoff(conn):
    cur = conn.cursor()
    cur.execute("INSERT INTO merchants (member_id,name,status) VALUES ('RC','Res','active') RETURNING id")
    mid = cur.fetchone()["id"]
    cur.execute("INSERT INTO accounts (account_type,merchant_id,currency) VALUES ('merchant_reserve',%s,'USD')", (mid,))
    cur.execute("INSERT INTO ledger_events (event_type,merchant_id,currency,occurred_at) "
                "VALUES ('reserve_hold',%s,'USD',now()) RETURNING id", (mid,))
    eid = cur.fetchone()["id"]
    cur.execute("INSERT INTO reserve_holds (merchant_id,currency,amount_minor,hold_event_id,release_due_at) "
                "VALUES (%s,'USD',1000,%s,now()+interval '180 days')", (mid, eid))
    conn.commit()
    cycle.run_cycle(conn, cutoff=datetime(2035, 1, 1, tzinfo=timezone.utc))
    held = one(conn, "SELECT count(*) c FROM reserve_holds WHERE merchant_id=%s AND released_at IS NULL", (mid,))["c"]
    assert held == 1  # not released early despite the far-future cutoff
