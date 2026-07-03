"""Import the client's processor CSV reports + the settlement workbook refunds.

Every financial row becomes properly balanced ledger events through BulkPoster:
  Capture Successful -> payment_captured (+ reserve_hold)
  Auth Failed        -> decline_fee (only if the merchant's schedule charges one)
  Refund Amount>0 / workbook Refund sheet -> refund (principal + refund fee)
Idempotent: re-running an import posts nothing (source_id = upstream payment id).
"""
from __future__ import annotations

import csv
import re
import zipfile
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET

import psycopg

from .bizcal import next_settlement_datetime
from .ledger import BulkPoster, Leg, DEBIT, CREDIT
from .money import to_minor, bps_of

# Fee schedule defaults.
# WORKBOOK_RATES reproduce the client's own settlement Excel (Transactworld_US book):
#   MDR 5%, $0.30/approved txn, no decline fee, $40 refund fee, RR 5% of net, 1% settlement.
# ANNEX_RATES follow 'Annex Canamoney - Corservices.docx':
#   MDR 6.5%, 0.35 approved, 0.10 declined, 10.00 refund, 70.00 chargeback, RR 10%/6mo, 1%.
WORKBOOK_RATES = dict(mdr_bps=500, approved_txn_fee_minor=30, declined_txn_fee_minor=0,
                      refund_fee_minor=4000, chargeback_fee_minor=7000,
                      reserve_hold_bps=500, reserve_hold_days=180, settlement_fee_bps=100,
                      settlement_delay_days=0, settlement_schedule="daily")
ANNEX_RATES = dict(mdr_bps=650, approved_txn_fee_minor=35, declined_txn_fee_minor=10,
                   refund_fee_minor=1000, chargeback_fee_minor=7000,
                   reserve_hold_bps=1000, reserve_hold_days=180, settlement_fee_bps=100,
                   settlement_delay_days=0, settlement_schedule="daily")

FEE_COLUMNS = ("mdr_bps", "approved_txn_fee_minor", "declined_txn_fee_minor",
               "refund_fee_minor", "chargeback_fee_minor", "reserve_hold_bps",
               "reserve_hold_days", "settlement_fee_bps", "settlement_delay_days",
               "settlement_schedule")


def known_rates(member_id: str, name: str) -> dict | None:
    """A merchant is auto-configured ONLY if we actually hold a rate card for
    them (documented clients). Everyone else is unknown → quarantined, never
    defaulted to 5% MDR. Onboard them later by assigning a schedule."""
    text = f"{member_id} {name}".lower()
    if "canamoney" in text:
        return ANNEX_RATES
    if "transactworld_us" in text:
        return WORKBOOK_RATES
    return None


def insert_fee_schedule(cur, merchant_id: int, rates: dict) -> None:
    cols = ", ".join(FEE_COLUMNS)
    vals = ", ".join(f"%({c})s" for c in FEE_COLUMNS)
    cur.execute(
        f"INSERT INTO fee_schedules (merchant_id, {cols}) "
        f"VALUES (%(m)s, {vals}) ON CONFLICT (merchant_id) DO NOTHING",
        dict(m=merchant_id, **{c: rates[c] for c in FEE_COLUMNS}),
    )

STATUS_MAP = {
    "Capture Successful": "captured",
    "Auth Failed": "auth_failed",
    "Failed": "auth_failed",
    "Begun Processing": "initiated",
    "Auth Started 3D": "initiated",
    "Cancelled Transactions": "voided",
    "Reversal Request Sent": "captured",   # refund pending; principal was captured
    "Reversed": "captured",                # refund handled via Refund Amount column
}


def clean(v: str) -> str:
    v = (v or "").strip().lstrip("'").strip()
    return "" if v in ("-", "N/A") else v


def parse_dt(v: str) -> datetime | None:
    v = clean(v)
    for f in ("%d-%m-%Y %H:%M", "%m-%d-%Y %H:%M", "%d-%m-%Y", "%m-%d-%Y"):
        try:
            d = datetime.strptime(v, f)
            # files are labelled June 2026; DD-MM is the primary format
            return d.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _rows(path: str):
    """Yield dict rows from a processor CSV, skipping the 'Report Criteria' preamble."""
    with open(path, encoding="utf-8-sig", newline="") as fh:
        rdr = csv.reader(fh)
        idx = None
        for row in rdr:
            if idx is None:
                if row and "Transaction Date" in row[0]:
                    idx = {c.strip(): i for i, c in enumerate(row) if c.strip()}
                continue
            if len(row) < 20:
                continue
            yield {k: clean(row[i]) if i < len(row) else "" for k, i in idx.items()}


class Importer:
    def __init__(self, conn: psycopg.Connection):
        self.conn = conn
        self.merchants: dict[str, dict] = {}   # member_id -> {id, name}
        self.schedules: dict[int, dict] = {}
        self.stats = dict(txns=0, captures=0, declines=0, refunds=0, skipped_dupes=0,
                          unmatched_refunds=0, quarantined=0, quarantined_merchants=0)

    # -- merchants -----------------------------------------------------------
    def merchant_for(self, cur, member_id: str, name: str) -> dict:
        member_id = member_id or f"name:{name}"
        if member_id in self.merchants:
            return self.merchants[member_id]
        cur.execute("SELECT id, name FROM merchants WHERE member_id=%s", (member_id,))
        row = cur.fetchone()
        if row is None:
            display = name or f"Member {member_id}"
            rates = known_rates(member_id, display)
            status = "active" if rates else "unconfigured"
            cur.execute(
                "INSERT INTO merchants (member_id, name, status) VALUES (%s,%s,%s) "
                "RETURNING id, name",
                (member_id, display, status),
            )
            row = cur.fetchone()
            if rates:
                insert_fee_schedule(cur, row["id"], rates)
            else:
                self.stats["quarantined_merchants"] += 1
        self.merchants[member_id] = row
        return row

    def schedule_for(self, cur, merchant_id: int) -> dict:
        if merchant_id not in self.schedules:
            cur.execute("SELECT * FROM fee_schedules WHERE merchant_id=%s", (merchant_id,))
            self.schedules[merchant_id] = cur.fetchone()
        return self.schedules[merchant_id]

    # -- one CSV file --------------------------------------------------------
    def import_csv(self, path: str, name_map: dict[str, str], chunk: int = 4000) -> None:
        batch: list[dict] = []
        for r in _rows(path):
            batch.append(r)
            if len(batch) >= chunk:
                self._commit_chunk(batch, path, name_map)
                batch = []
        if batch:
            self._commit_chunk(batch, path, name_map)

    def _commit_chunk(self, rows: list[dict], path: str, name_map: dict[str, str]) -> None:
        with self.conn.transaction():
            cur = self.conn.cursor()
            poster = BulkPoster(self.conn)
            fee_rows = []       # (payment_id, merchant_id, fee_type, ccy, minor, kind)
            reserve_rows = []   # (payment_id, merchant_id, ccy, minor, due)
            for r in rows:
                pay_id = r.get("Payment ID") or r.get("Tracking ID")
                if not pay_id:
                    continue
                ccy = r.get("Currency", "").upper()
                if not ccy:
                    continue
                member = r.get("Member ID", "")
                mname = r.get("Merchant Company Name") or name_map.get(member, "")
                merchant = self.merchant_for(cur, member, mname)
                mid = merchant["id"]
                sched = self.schedule_for(cur, mid)
                configured = sched is not None
                occurred = parse_dt(r.get("Transaction Date(MM/DD/YYYY)", "")) or \
                    datetime.now(timezone.utc)
                status = STATUS_MAP.get(r.get("Status", ""), "initiated")
                auth = to_minor(r.get("Auth Amount", "0"), ccy)
                captured = to_minor(r.get("Captured Amount", "0"), ccy)
                refunded = to_minor(r.get("Refund Amount", "0"), ccy)
                cb = to_minor(r.get("Chargeback Amount", "0"), ccy)

                # transaction row (idempotent on upstream payment id). Unknown
                # merchants have no fee schedule yet: the row is imported but marked
                # ledger_posted=false (quarantined) and NO ledger events are booked
                # until the merchant is onboarded (a schedule assigned).
                cur.execute(
                    """INSERT INTO transactions (merchant_id, tracking_id, upstream_payment_id,
                         order_id, order_description, customer_name, customer_email,
                         customer_phone, payment_mode, payment_brand, first_six, last_four,
                         issuing_bank, country, mid, currency, auth_minor, captured_minor,
                         refunded_minor, chargeback_minor, status, reason, occurred_at,
                         source_file, ledger_posted)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (upstream_payment_id) DO NOTHING RETURNING id""",
                    (mid, r.get("Tracking ID"), pay_id, r.get("Order ID"),
                     r.get("Order Description"), r.get("Card Holder's Name"),
                     (r.get("Customer Email") or "").lower(), r.get("Phone Number"),
                     r.get("Payment Mode"), r.get("Payment Brand"), r.get("First Six"),
                     r.get("Last four"), r.get("Issuing Bank Name"),
                     r.get("Transaction Country") or r.get("ISO Country"), r.get("MID"),
                     ccy, auth, captured, refunded, cb, status, r.get("Reason"),
                     occurred, path.rsplit("/", 1)[-1], configured),
                )
                row = cur.fetchone()
                if row is None:
                    self.stats["skipped_dupes"] += 1
                    continue
                txn_id = row["id"]
                self.stats["txns"] += 1

                if not configured:
                    self.stats["quarantined"] += 1
                    continue

                self._post_transaction(
                    poster, fee_rows, reserve_rows, sched,
                    pay_id=pay_id, mid=mid, ccy=ccy, occurred=occurred,
                    status=status, captured=captured, refunded=refunded, txn_id=txn_id,
                )

            self._flush_and_link(cur, poster, fee_rows, reserve_rows)

    def _post_transaction(self, poster, fee_rows, reserve_rows, sched, *,
                          pay_id, mid, ccy, occurred, status, captured, refunded,
                          txn_id) -> None:
        """Emit the ledger events for one configured-merchant transaction. Shared
        by the file importer and the onboarding reprocessor."""
        settle_after = next_settlement_datetime(
            occurred, sched.get("settlement_delay_days", 1))
        if status == "captured" and captured > 0:
            mdr = bps_of(captured, sched["mdr_bps"])
            app_fee = sched["approved_txn_fee_minor"]
            payable = captured - mdr - app_fee
            poster.add(
                event_type="payment_captured", source_type="capture",
                source_id=pay_id, merchant_id=mid, currency=ccy,
                occurred_at=occurred, settle_after=settle_after, source_txn_id=txn_id,
                legs=[
                    Leg("clearing", None, DEBIT, captured),
                    Leg("merchant_payable", mid, CREDIT, payable),
                    Leg("gateway_revenue", None, CREDIT, mdr + app_fee),
                ],
            )
            fee_rows.append((pay_id, mid, "mdr", ccy, mdr, txn_id))
            if app_fee:
                fee_rows.append((pay_id, mid, "approved_txn", ccy, app_fee, txn_id))
            self.stats["captures"] += 1

            hold = bps_of(payable, sched["reserve_hold_bps"])
            if hold > 0:
                poster.add(
                    event_type="reserve_hold", source_type="reserve_hold",
                    source_id=pay_id, merchant_id=mid, currency=ccy,
                    occurred_at=occurred, settle_after=settle_after, source_txn_id=txn_id,
                    legs=[
                        Leg("merchant_payable", mid, DEBIT, hold),
                        Leg("merchant_reserve", mid, CREDIT, hold),
                    ],
                )
                due = occurred + timedelta(days=sched["reserve_hold_days"])
                reserve_rows.append((pay_id, mid, ccy, hold, due))

            if refunded > 0:
                self._add_refund(poster, fee_rows, sched, pay_id, mid, ccy,
                                 occurred, txn_id, refunded, settle_after=settle_after)

        elif status == "auth_failed" and sched["declined_txn_fee_minor"] > 0:
            d = sched["declined_txn_fee_minor"]
            poster.add(
                event_type="decline_fee", source_type="decline_fee",
                source_id=pay_id, merchant_id=mid, currency=ccy,
                occurred_at=occurred, settle_after=settle_after, source_txn_id=txn_id,
                legs=[
                    Leg("merchant_payable", mid, DEBIT, d),
                    Leg("gateway_revenue", None, CREDIT, d),
                ],
            )
            fee_rows.append((pay_id, mid, "declined_txn", ccy, d, txn_id))
            self.stats["declines"] += 1
        elif status == "auth_failed":
            self.stats["declines"] += 1

    def _flush_and_link(self, cur, poster, fee_rows, reserve_rows) -> None:
        """Flush the batch and attach fee + reserve-hold records to the event ids."""
        ids = poster.flush()
        self.stats["skipped_dupes"] += poster.skipped
        SRC = {"mdr": "capture", "approved_txn": "capture",
               "declined_txn": "decline_fee", "refund_fee": "refund"}
        for pay_id, m, ftype, ccy, minor, txn in fee_rows:
            sid = f"{pay_id}:rf" if ftype == "refund_fee" else pay_id
            eid = ids.get((SRC[ftype], sid))
            if eid:
                cur.execute(
                    "INSERT INTO fees (merchant_id, transaction_id, fee_type, currency, "
                    "fee_minor, ledger_event_id) VALUES (%s,%s,%s,%s,%s,%s)",
                    (m, txn, ftype, ccy, minor, eid),
                )
        for pay_id, m, ccy, minor, due in reserve_rows:
            eid = ids.get(("reserve_hold", pay_id))
            if eid:
                cur.execute(
                    "INSERT INTO reserve_holds (merchant_id, currency, amount_minor, "
                    "hold_event_id, release_due_at) VALUES (%s,%s,%s,%s,%s)",
                    (m, ccy, minor, eid, due),
                )

    def _add_refund(self, poster, fee_rows, sched, pay_id, mid, ccy, occurred, txn_id,
                    amount: int, settle_after=None) -> None:
        rf = sched["refund_fee_minor"]
        settle_after = settle_after or next_settlement_datetime(
            occurred, sched.get("settlement_delay_days", 1))
        legs = [Leg("merchant_payable", mid, DEBIT, amount + rf),
                Leg("clearing", None, CREDIT, amount)]
        if rf:
            legs.append(Leg("gateway_revenue", None, CREDIT, rf))
        poster.add(event_type="refund", source_type="refund", source_id=f"{pay_id}:rf",
                   merchant_id=mid, currency=ccy, occurred_at=occurred,
                   settle_after=settle_after, source_txn_id=txn_id, legs=legs)
        if rf:
            fee_rows.append((pay_id, mid, "refund_fee", ccy, rf, txn_id))
        self.stats["refunds"] += 1

    # -- workbook sheets -------------------------------------------------------
    def _sheet_rows(self, path: str, sheet: str) -> list[dict]:
        NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
        z = zipfile.ZipFile(path)
        sst = ET.fromstring(z.read("xl/sharedStrings.xml"))
        strings = ["".join(t.text or "" for t in si.iter(NS + "t")) for si in sst]
        root = ET.fromstring(z.read(sheet))

        def col(ref: str) -> str:
            return re.match(r"([A-Z]+)", ref).group(1)

        out = []
        header: dict[str, str] = {}
        for row in root.findall(f".//{NS}row"):
            vals = {}
            for c in row.findall(f"{NS}c"):
                v = c.find(f"{NS}v")
                if v is None:
                    continue
                val = v.text
                if c.get("t") == "s":
                    val = strings[int(val)]
                vals[col(c.get("r"))] = val
            if not header:
                header = {v: k for k, v in vals.items()}
                continue
            out.append({name: vals.get(cl, "") for name, cl in header.items()})
        return out

    def import_xlsx_paid(self, path: str, chunk: int = 4000) -> None:
        """'Paid&Error Purchase' sheet -> transactions + captures for the
        Transactworld_US book (the merchant the settlement workbook is about)."""
        rows = self._sheet_rows(path, "xl/worksheets/sheet1.xml")
        batch = []
        for r in rows:
            pid = r.get("Txn ID", "")
            ccy = (r.get("Currency", "") or "").upper()
            status = r.get("Status", "")
            if not pid or not ccy or status not in ("PAID", "ERROR"):
                continue
            occurred = None
            d = r.get("Date", "")
            try:
                occurred = datetime.strptime(d[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except ValueError:
                occurred = datetime.now(timezone.utc)
            amt = str(r.get("Amount", "0"))
            batch.append({
                "Payment ID": pid, "Tracking ID": pid, "Member ID": "transactworld_us",
                "Merchant Company Name": "Transactworld_US",
                "Currency": ccy, "Status": "Capture Successful" if status == "PAID"
                else "Auth Failed",
                "Auth Amount": amt, "Captured Amount": amt if status == "PAID" else "0",
                "Refund Amount": "0", "Chargeback Amount": "0",
                "Payment Brand": r.get("Payment Mode", ""), "Payment Mode": "CC",
                "Transaction Date(MM/DD/YYYY)": occurred.strftime("%d-%m-%Y %H:%M"),
                "Order ID": "", "Order Description": "", "Card Holder's Name": "",
                "Customer Email": "", "Phone Number": "", "First Six": "",
                "Last four": "", "Issuing Bank Name": "", "Transaction Country": "",
                "ISO Country": "", "MID": "TW-US", "Reason": "",
            })
            if len(batch) >= chunk:
                self._commit_chunk(batch, path, {})
                batch = []
        if batch:
            self._commit_chunk(batch, path, {})

    def import_xlsx_refunds(self, path: str) -> None:
        rows = self._sheet_rows(path, "xl/worksheets/sheet2.xml")  # Refund&Chargeback
        with self.conn.transaction():
            cur = self.conn.cursor()
            poster = BulkPoster(self.conn)
            pending = []
            for r in rows:
                pid = r.get("Purchase ID", "")
                ccy = (r.get("Currency", "") or "").upper()
                amt_raw = r.get("Amount", "")
                if not pid or not ccy or not amt_raw:
                    continue
                amount = to_minor(str(amt_raw), ccy)
                cur.execute(
                    "SELECT id, merchant_id, occurred_at, currency FROM transactions "
                    "WHERE upstream_payment_id=%s", (pid,),
                )
                txn = cur.fetchone()
                if txn is None:
                    # Refund of a purchase captured before the report window (real
                    # occurrence in the workbook): book it to the Transactworld_US
                    # book as a prior-period refund — payable goes negative and the
                    # deficit carries to the next settlement (docs/04 §4).
                    m = self.merchant_for(cur, "transactworld_us", "Transactworld_US")
                    occurred = None
                    try:
                        occurred = datetime.strptime(str(r.get("Date", ""))[:10],
                                                     "%Y-%m-%d").replace(tzinfo=timezone.utc)
                    except ValueError:
                        occurred = datetime.now(timezone.utc)
                    cur.execute(
                        """INSERT INTO transactions (merchant_id, upstream_payment_id,
                             currency, refunded_minor, status, occurred_at, reason,
                             payment_brand, source_file, mid)
                           VALUES (%s,%s,%s,0,'refunded',%s,
                                   'prior-period purchase (before report window)',
                                   %s,%s,'TW-US')
                           ON CONFLICT (upstream_payment_id) DO NOTHING RETURNING id""",
                        (m["id"], pid, ccy, occurred,
                         r.get("Payment Method", ""), path.rsplit("/", 1)[-1]),
                    )
                    stub = cur.fetchone()
                    if stub is None:
                        self.stats["skipped_dupes"] += 1
                        continue
                    txn = {"id": stub["id"], "merchant_id": m["id"],
                           "occurred_at": occurred, "currency": ccy}
                    self.stats["unmatched_refunds"] += 1
                elif txn["currency"] != ccy:
                    continue
                raw_sched = self.schedule_for(cur, txn["merchant_id"])
                if raw_sched is None:
                    # unconfigured merchant — record the refund but quarantine it;
                    # onboarding reprocess will book it once a schedule is assigned.
                    cur.execute(
                        "UPDATE transactions SET refunded_minor = refunded_minor + %s, "
                        "status='refunded', ledger_posted=false WHERE id=%s",
                        (amount, txn["id"]),
                    )
                    self.stats["quarantined"] += 1
                    continue
                sched = dict(raw_sched)
                fee_cell = str(r.get("Refund Fee", "") or "").strip()
                if fee_cell:  # the workbook's own per-row fee wins over the schedule
                    sched["refund_fee_minor"] = to_minor(fee_cell, ccy)
                self._add_refund(poster, pending, sched, pid, txn["merchant_id"], ccy,
                                 txn["occurred_at"], txn["id"], amount)
                cur.execute(
                    "UPDATE transactions SET refunded_minor = refunded_minor + %s, "
                    "status='refunded' WHERE id=%s", (amount, txn["id"]),
                )
            ids = poster.flush()
            self.stats["skipped_dupes"] += poster.skipped
            for pay_id, m, ftype, ccy, minor, txn in pending:
                eid = ids.get(("refund", f"{pay_id}:rf"))
                if eid:
                    cur.execute(
                        "INSERT INTO fees (merchant_id, transaction_id, fee_type, currency, "
                        "fee_minor, ledger_event_id) VALUES (%s,%s,%s,%s,%s,%s)",
                        (m, txn, ftype, ccy, minor, eid),
                    )


def build_name_map(paths: list[str]) -> dict[str, str]:
    """Member ID -> merchant name, from files that carry both columns."""
    out: dict[str, str] = {}
    for p in paths:
        for r in _rows(p):
            m, n = r.get("Member ID", ""), r.get("Merchant Company Name", "")
            if m and n and m not in out:
                out[m] = n
    return out
