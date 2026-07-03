"""Ledger invariant suite (docs/02-ledger-model.md §4) against a real Postgres.

Runs on an isolated database (twledger_test), created/reset per session.
"""
import pathlib
import sys
import threading
from datetime import datetime, timezone

import psycopg
import pytest
from psycopg.rows import dict_row

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from app.ledger import Leg, DEBIT, CREDIT, post_event, UnbalancedEvent  # noqa: E402

ADMIN_DSN = "postgresql://tw:tw@localhost:5455/twledger"
TEST_DSN = "postgresql://tw:tw@localhost:5455/twledger_test"
NOW = datetime(2026, 6, 15, tzinfo=timezone.utc)


@pytest.fixture(scope="session", autouse=True)
def test_db():
    with psycopg.connect(ADMIN_DSN, autocommit=True) as conn:
        conn.execute("DROP DATABASE IF EXISTS twledger_test (FORCE)")
        conn.execute("CREATE DATABASE twledger_test")
    schema = (pathlib.Path(__file__).resolve().parents[1] / "schema.sql").read_text()
    with psycopg.connect(TEST_DSN) as conn:
        conn.execute(schema)
        conn.execute("INSERT INTO merchants (member_id, name) VALUES ('t1','Test Merchant')")
        conn.commit()


@pytest.fixture
def conn():
    with psycopg.connect(TEST_DSN, row_factory=dict_row) as c:
        yield c
        c.rollback()


def capture_legs(mid=1, gross=100_000, fee=2_000, tax=360):
    # the canonical example: 1000.00 capture, 20.00 fee, 3.60 tax
    return [
        Leg("clearing", None, DEBIT, gross),
        Leg("merchant_payable", mid, CREDIT, gross - fee - tax),
        Leg("gateway_revenue", None, CREDIT, fee),
        Leg("tax_payable", None, CREDIT, tax),
    ]


def post(conn, source_id, legs=None, **kw):
    return post_event(
        conn, event_type=kw.pop("event_type", "payment_captured"),
        source_type=kw.pop("source_type", "test"), source_id=source_id,
        merchant_id=1, currency="USD", occurred_at=NOW,
        legs=legs or capture_legs(), **kw,
    )


def balances(conn):
    cur = conn.execute("""
        SELECT a.account_type, b.balance_minor FROM accounts a
        JOIN account_balances b ON b.account_id=a.id WHERE a.currency='USD'""")
    return {r["account_type"]: r["balance_minor"] for r in cur.fetchall()}


# --- invariant 1: zero-sum -----------------------------------------------------
def test_unbalanced_event_rejected_in_code(conn):
    with pytest.raises(UnbalancedEvent):
        post(conn, "unbal-1", legs=[
            Leg("clearing", None, DEBIT, 100_000),
            Leg("merchant_payable", 1, CREDIT, 99_999),
        ])


def test_unbalanced_event_rejected_by_db_trigger(conn):
    """Even if code validation were bypassed, the deferred trigger rejects at commit."""
    cur = conn.cursor()
    cur.execute("""INSERT INTO ledger_events (event_type, merchant_id, currency, occurred_at)
                   VALUES ('payment_captured', 1, 'USD', %s) RETURNING id""", (NOW,))
    eid = cur.fetchone()["id"]
    cur.execute("SELECT id FROM accounts LIMIT 1")
    aid = conn.execute(
        "INSERT INTO accounts (account_type, merchant_id, currency) "
        "VALUES ('clearing', NULL, 'USD') "
        "ON CONFLICT (account_type, COALESCE(merchant_id, 0::bigint), currency) "
        "DO UPDATE SET currency=EXCLUDED.currency RETURNING id").fetchone()["id"]
    cur.execute("""INSERT INTO ledger_entries (event_id, account_id, direction,
                   amount_minor, currency, balance_after_minor)
                   VALUES (%s,%s,'debit',12345,'USD',0)""", (eid, aid))
    with pytest.raises(psycopg.errors.RaiseException, match="unbalanced"):
        conn.commit()


def test_single_leg_rejected(conn):
    with pytest.raises(UnbalancedEvent):
        post(conn, "single-1", legs=[Leg("clearing", None, DEBIT, 0)])


# --- invariant 2: balance == sum of entries ------------------------------------
def test_balances_equal_sum_of_entries(conn):
    for i in range(25):
        post(conn, f"recon-{i}", legs=capture_legs(gross=10_000 + i * 7))
    conn.commit()
    cur = conn.execute("""
        SELECT a.id, a.account_type, b.balance_minor,
               COALESCE(SUM(CASE WHEN (a.account_type IN ('merchant_payable','merchant_reserve',
                     'settlement_payable','chargeback_suspense','gateway_revenue','tax_payable'))
                     = (le.direction='credit') THEN le.amount_minor ELSE -le.amount_minor END),0) AS s
          FROM accounts a JOIN account_balances b ON b.account_id=a.id
          LEFT JOIN ledger_entries le ON le.account_id=a.id
         GROUP BY a.id, a.account_type, b.balance_minor""")
    for r in cur.fetchall():
        assert r["balance_minor"] == r["s"], f"{r['account_type']} balance drift"


def test_balance_after_matches_running_sum(conn):
    conn.commit()
    cur = conn.execute("""
        SELECT le.account_id, le.direction, le.amount_minor, le.balance_after_minor,
               a.account_type
          FROM ledger_entries le JOIN accounts a ON a.id=le.account_id
         ORDER BY le.account_id, le.id""")
    running: dict[int, int] = {}
    for r in cur.fetchall():
        credit_normal = r["account_type"] in (
            "merchant_payable", "merchant_reserve", "settlement_payable",
            "chargeback_suspense", "gateway_revenue", "tax_payable")
        delta = r["amount_minor"] if (r["direction"] == "credit") == credit_normal \
            else -r["amount_minor"]
        running[r["account_id"]] = running.get(r["account_id"], 0) + delta
        assert running[r["account_id"]] == r["balance_after_minor"]


# --- invariant 3: append-only --------------------------------------------------
def test_update_rejected(conn):
    with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
        conn.execute("UPDATE ledger_entries SET amount_minor = amount_minor + 1")


def test_delete_rejected(conn):
    with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
        conn.execute("DELETE FROM ledger_events")


# --- invariant 4: idempotent posting -------------------------------------------
def test_replay_does_not_double_post(conn):
    eid1, created1 = post(conn, "idem-1")
    conn.commit()
    before = balances(conn)
    eid2, created2 = post(conn, "idem-1")
    conn.commit()
    assert created1 is True and created2 is False and eid1 == eid2
    assert balances(conn) == before
    n = conn.execute("SELECT COUNT(*) AS n FROM posting_idempotency "
                     "WHERE source_id='idem-1'").fetchone()["n"]
    assert n == 1


# --- invariant 5: concurrent postings serialize per account --------------------
def test_concurrent_postings_serialize():
    THREADS, EACH, AMOUNT = 8, 20, 1_000

    def worker(t):
        with psycopg.connect(TEST_DSN, row_factory=dict_row) as c:
            for i in range(EACH):
                post_event(
                    c, event_type="payment_captured", source_type="conc",
                    source_id=f"conc-{t}-{i}", merchant_id=1, currency="EUR",
                    occurred_at=NOW,
                    legs=[Leg("clearing", None, DEBIT, AMOUNT),
                          Leg("merchant_payable", 1, CREDIT, AMOUNT)],
                )
                c.commit()

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(THREADS)]
    [t.start() for t in threads]
    [t.join() for t in threads]

    with psycopg.connect(TEST_DSN, row_factory=dict_row) as c:
        bal = c.execute("""
            SELECT b.balance_minor FROM accounts a
            JOIN account_balances b ON b.account_id=a.id
            WHERE a.account_type='merchant_payable' AND a.currency='EUR'""").fetchone()
        assert bal["balance_minor"] == THREADS * EACH * AMOUNT
        n = c.execute("SELECT COUNT(*) AS n FROM ledger_entries le JOIN accounts a "
                      "ON a.id=le.account_id WHERE a.currency='EUR'").fetchone()["n"]
        assert n == THREADS * EACH * 2
