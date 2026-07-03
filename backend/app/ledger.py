"""Posting engine — the only writer to the ledger.

post_event(): single-event path with SELECT FOR UPDATE serialization per account.
BulkPoster: high-throughput import path with identical invariants (used by the CSV
importer); it locks all touched balances up front and maintains running balances
in memory so balance_after stays correct.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable
import json

import psycopg

DEBIT = "debit"
CREDIT = "credit"

# credit-normal account types (balance = credits - debits)
CREDIT_NORMAL = {
    "merchant_payable", "merchant_reserve", "settlement_payable",
    "chargeback_suspense", "gateway_revenue", "tax_payable",
}


def signed_delta(account_type: str, direction: str, amount: int) -> int:
    """Balance delta by natural side (docs/02-ledger-model.md §1)."""
    if account_type in CREDIT_NORMAL:
        return amount if direction == CREDIT else -amount
    return amount if direction == DEBIT else -amount


@dataclass(frozen=True)
class Leg:
    account_type: str
    merchant_id: int | None
    direction: str
    amount_minor: int


class UnbalancedEvent(Exception):
    pass


def _validate(legs: list[Leg]) -> None:
    if len(legs) < 2:
        raise UnbalancedEvent("event needs >= 2 legs")
    total = sum(l.amount_minor if l.direction == DEBIT else -l.amount_minor for l in legs)
    if total != 0:
        raise UnbalancedEvent(f"legs sum to {total}, expected 0")
    if any(l.amount_minor <= 0 for l in legs):
        raise UnbalancedEvent("non-positive leg amount")


class AccountCache:
    """Resolves (type, merchant_id, currency) -> account row, creating on first use."""

    def __init__(self) -> None:
        self._cache: dict[tuple, dict] = {}

    def get(self, cur: psycopg.Cursor, account_type: str, merchant_id: int | None,
            currency: str) -> dict:
        key = (account_type, merchant_id, currency)
        if key in self._cache:
            return self._cache[key]
        cur.execute(
            """SELECT id, account_type FROM accounts
               WHERE account_type=%s AND COALESCE(merchant_id,0)=COALESCE(%s,0) AND currency=%s""",
            (account_type, merchant_id, currency),
        )
        row = cur.fetchone()
        if row is None:
            cur.execute(
                """INSERT INTO accounts (account_type, merchant_id, currency)
                   VALUES (%s,%s,%s)
                   ON CONFLICT (account_type, COALESCE(merchant_id, 0::bigint), currency) DO NOTHING
                   RETURNING id, account_type""",
                (account_type, merchant_id, currency),
            )
            row = cur.fetchone()
            if row is None:  # lost a race; re-read
                cur.execute(
                    """SELECT id, account_type FROM accounts
                       WHERE account_type=%s AND COALESCE(merchant_id,0)=COALESCE(%s,0) AND currency=%s""",
                    (account_type, merchant_id, currency),
                )
                row = cur.fetchone()
            else:
                cur.execute(
                    "INSERT INTO account_balances (account_id) VALUES (%s) ON CONFLICT DO NOTHING",
                    (row["id"],),
                )
        self._cache[key] = row
        return row


def post_event(
    conn: psycopg.Connection,
    *,
    event_type: str,
    source_type: str,
    source_id: str,
    merchant_id: int | None,
    currency: str,
    occurred_at: datetime,
    legs: Iterable[Leg],
    settle_after: datetime | None = None,
    reverses_event_id: int | None = None,
    source_txn_id: int | None = None,
    metadata: dict | None = None,
    accounts: AccountCache | None = None,
) -> tuple[int, bool]:
    """Post one balanced event inside the caller's transaction.

    Returns (event_id, created). created=False means idempotent replay: the
    original event id is returned and nothing was written.
    """
    legs = list(legs)
    _validate(legs)
    accounts = accounts or AccountCache()
    cur = conn.cursor()

    # 1) replay gate
    cur.execute(
        """INSERT INTO posting_idempotency (source_type, source_id, event_id)
           VALUES (%s,%s,0) ON CONFLICT DO NOTHING RETURNING source_id""",
        (source_type, source_id),
    )
    if cur.fetchone() is None:
        cur.execute(
            "SELECT event_id FROM posting_idempotency WHERE source_type=%s AND source_id=%s",
            (source_type, source_id),
        )
        return cur.fetchone()["event_id"], False

    # 2) resolve accounts, lock balances in deterministic order
    resolved = [(accounts.get(cur, l.account_type, l.merchant_id, currency), l) for l in legs]
    ids = sorted({acc["id"] for acc, _ in resolved})
    cur.execute(
        "SELECT account_id, balance_minor FROM account_balances WHERE account_id = ANY(%s) "
        "ORDER BY account_id FOR UPDATE",
        (ids,),
    )
    balances = {r["account_id"]: r["balance_minor"] for r in cur.fetchall()}

    # 3) event
    cur.execute(
        """INSERT INTO ledger_events
             (event_type, merchant_id, currency, occurred_at, settle_after,
              reverses_event_id, source_txn_id, metadata)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
        (event_type, merchant_id, currency, occurred_at, settle_after,
         reverses_event_id, source_txn_id, json.dumps(metadata or {})),
    )
    event_id = cur.fetchone()["id"]

    # 4) entries with balance_after computed under the lock
    for acc, leg in resolved:
        balances[acc["id"]] += signed_delta(acc["account_type"], leg.direction, leg.amount_minor)
        cur.execute(
            """INSERT INTO ledger_entries
                 (event_id, account_id, direction, amount_minor, currency, balance_after_minor)
               VALUES (%s,%s,%s,%s,%s,%s)""",
            (event_id, acc["id"], leg.direction, leg.amount_minor, currency, balances[acc["id"]]),
        )

    # 5) balances
    for aid in ids:
        cur.execute(
            "UPDATE account_balances SET balance_minor=%s, version=version+1, updated_at=now() "
            "WHERE account_id=%s",
            (balances[aid], aid),
        )
    cur.execute(
        "UPDATE posting_idempotency SET event_id=%s WHERE source_type=%s AND source_id=%s",
        (event_id, source_type, source_id),
    )
    return event_id, True


class BulkPoster:
    """Import-speed posting with the same invariants.

    Usage: one instance per chunk transaction. add() events, then flush().
    Skips events whose (source_type, source_id) already exist (returns count).
    """

    def __init__(self, conn: psycopg.Connection):
        self.conn = conn
        self.cur = conn.cursor()
        self.accounts = AccountCache()
        self.events: list[dict] = []
        self.skipped = 0

    def add(self, *, event_type: str, source_type: str, source_id: str,
            merchant_id: int | None, currency: str, occurred_at: datetime,
            legs: list[Leg], settle_after: datetime | None = None,
            source_txn_id: int | None = None, metadata: dict | None = None) -> None:
        _validate(legs)
        self.events.append(dict(
            event_type=event_type, source_type=source_type, source_id=source_id,
            merchant_id=merchant_id, currency=currency, occurred_at=occurred_at,
            legs=legs, settle_after=settle_after or occurred_at,
            source_txn_id=source_txn_id, metadata=metadata or {},
        ))

    def flush(self) -> dict[str, int]:
        """Insert everything in the current transaction. Returns per-source event ids."""
        if not self.events:
            return {}
        cur = self.cur
        # replay gate for the whole batch
        cur.execute(
            "SELECT pi.source_type, pi.source_id FROM posting_idempotency pi "
            "JOIN (SELECT unnest(%s::text[]) AS st, unnest(%s::text[]) AS si) k "
            "ON pi.source_type = k.st AND pi.source_id = k.si",
            ([e["source_type"] for e in self.events],
             [e["source_id"] for e in self.events]),
        )
        existing = {(r["source_type"], r["source_id"]) for r in cur.fetchall()}
        todo = [e for e in self.events if (e["source_type"], e["source_id"]) not in existing]
        self.skipped += len(self.events) - len(todo)
        self.events = []
        if not todo:
            return {}

        # resolve accounts + lock all touched balances once
        for e in todo:
            e["resolved"] = [
                (self.accounts.get(cur, l.account_type, l.merchant_id, e["currency"]), l)
                for l in e["legs"]
            ]
        ids = sorted({acc["id"] for e in todo for acc, _ in e["resolved"]})
        cur.execute(
            "SELECT account_id, balance_minor FROM account_balances WHERE account_id = ANY(%s) "
            "ORDER BY account_id FOR UPDATE", (ids,),
        )
        balances = {r["account_id"]: r["balance_minor"] for r in cur.fetchall()}

        result: dict[tuple[str, str], int] = {}
        ev_rows, en_rows, idem_rows = [], [], []
        # allocate event ids in bulk
        cur.execute(
            "SELECT nextval(pg_get_serial_sequence('ledger_events','id')) AS id "
            "FROM generate_series(1, %s)", (len(todo),),
        )
        alloc = [r["id"] for r in cur.fetchall()]
        for e, eid in zip(todo, alloc):
            result[(e["source_type"], e["source_id"])] = eid
            ev_rows.append((eid, e["event_type"], e["merchant_id"], e["currency"],
                            e["occurred_at"], e["settle_after"], e["source_txn_id"],
                            json.dumps(e["metadata"])))
            idem_rows.append((e["source_type"], e["source_id"], eid))
            for acc, leg in e["resolved"]:
                balances[acc["id"]] += signed_delta(acc["account_type"], leg.direction,
                                                    leg.amount_minor)
                en_rows.append((eid, acc["id"], leg.direction, leg.amount_minor,
                                e["currency"], balances[acc["id"]]))

        with cur.copy(
            "COPY ledger_events (id, event_type, merchant_id, currency, occurred_at, "
            "settle_after, source_txn_id, metadata) FROM STDIN"
        ) as cp:
            for r in ev_rows:
                cp.write_row(r)
        with cur.copy(
            "COPY ledger_entries (event_id, account_id, direction, amount_minor, currency, "
            "balance_after_minor) FROM STDIN"
        ) as cp:
            for r in en_rows:
                cp.write_row(r)
        cur.executemany(
            "INSERT INTO posting_idempotency (source_type, source_id, event_id) VALUES (%s,%s,%s)",
            idem_rows,
        )
        for aid in ids:
            cur.execute(
                "UPDATE account_balances SET balance_minor=%s, version=version+1, updated_at=now() "
                "WHERE account_id=%s", (balances[aid], aid),
            )
        return result
