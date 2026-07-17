"""Builds and sends the merchant payout-confirmation email for a settlement.

The email contains (1) a payout report — the settlement breakdown (gross, fees,
reserve, settlement fee, net payout) — and (2) the list of transactions that
make up the payout, both rendered inline and attached as a CSV.

Sending is best-effort and never raises into the caller: complete a settlement
first, then fire this; a mail failure returns a reason but doesn't roll back the
payout. Recipient is the merchant's `email`; if unset or the mailer is dormant,
it returns a skipped result.
"""
from __future__ import annotations

import csv
import io
import html as _html

import psycopg

from . import mailer
from .money import fmt
from .settle import line_items

# breakdown label → key, in report order. Rows that are zero are hidden.
_REPORT_ROWS = [
    ("Gross captured", "gross_captured_minor"),
    ("MDR", "mdr_minor"),
    ("Approved-txn fees", "approved_txn_fees_minor"),
    ("Declined-txn fees", "declined_txn_fees_minor"),
    ("Refunds", "refunds_minor"),
    ("Refund fees", "refund_fees_minor"),
    ("Chargebacks", "chargebacks_minor"),
    ("Chargeback fees", "chargeback_fees_minor"),
    ("Rolling reserve held", "reserve_held_minor"),
    ("Rolling reserve released", "reserve_released_minor"),
    ("Adjustments", "adjustments_minor"),
    ("Subtotal", "subtotal_minor"),
    ("Settlement fee", "settlement_fee_minor"),
]


def _fetch(conn: psycopg.Connection, settlement_id: int) -> dict | None:
    cur = conn.cursor()
    cur.execute(
        """SELECT s.id, s.settlement_uuid, s.currency, s.window_start, s.window_end,
                  s.state, s.net_payout_minor, s.payout_reference, s.breakdown,
                  m.name AS merchant_name, m.email AS merchant_email
             FROM settlements s JOIN merchants m ON m.id = s.merchant_id
            WHERE s.id = %s""",
        (settlement_id,),
    )
    return cur.fetchone()


def _csv_bytes(currency: str, items: list[dict]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date", "Reference", "Brand", "Last 4", "Status", "Type",
                f"Gross ({currency})", f"MDR ({currency})", f"Fees ({currency})",
                f"Reserve ({currency})", f"Net ({currency})"])
    for it in items:
        other_fees = (it["approved_fee_minor"] + it["declined_fee_minor"]
                      + it["refund_fee_minor"] + it["chargeback_fee_minor"])
        w.writerow([
            str(it["occurred_at"])[:10], it["reference"], it["brand"], it["last_four"],
            it["status"], it["type"], fmt(it["gross_minor"], currency),
            fmt(it["mdr_minor"], currency), fmt(other_fees, currency),
            fmt(it["reserve_minor"], currency), fmt(it["net_minor"], currency),
        ])
    return buf.getvalue().encode("utf-8")


def _report_html(ccy: str, bd: dict, net_minor: int) -> str:
    rows = []
    for label, key in _REPORT_ROWS:
        val = int(bd.get(key, 0) or 0)
        if val == 0 and key not in ("gross_captured_minor", "subtotal_minor"):
            continue
        strong = " style='font-weight:600;border-top:1px solid #e5e7eb'" if key == "subtotal_minor" else ""
        rows.append(
            f"<tr><td style='padding:6px 12px'{strong}>{_html.escape(label)}</td>"
            f"<td style='padding:6px 12px;text-align:right'{strong}>{fmt(val, ccy)} {ccy}</td></tr>"
        )
    return "".join(rows)


def _items_html(ccy: str, items: list[dict], limit: int = 100) -> str:
    head = ("<tr style='background:#f8fafc'>"
            "<th style='padding:6px 10px;text-align:left'>Date</th>"
            "<th style='padding:6px 10px;text-align:left'>Reference</th>"
            "<th style='padding:6px 10px;text-align:left'>Card</th>"
            "<th style='padding:6px 10px;text-align:left'>Status</th>"
            f"<th style='padding:6px 10px;text-align:right'>Gross</th>"
            f"<th style='padding:6px 10px;text-align:right'>Net ({ccy})</th></tr>")
    body = []
    for it in items[:limit]:
        card = f"{_html.escape(it['brand'] or '')} ••{_html.escape(it['last_four'] or '')}".strip()
        body.append(
            "<tr style='border-top:1px solid #eef2f7'>"
            f"<td style='padding:6px 10px'>{str(it['occurred_at'])[:10]}</td>"
            f"<td style='padding:6px 10px'>{_html.escape(str(it['reference'] or ''))}</td>"
            f"<td style='padding:6px 10px'>{card}</td>"
            f"<td style='padding:6px 10px'>{_html.escape(it['status'] or it['type'])}</td>"
            f"<td style='padding:6px 10px;text-align:right'>{fmt(it['gross_minor'], ccy)}</td>"
            f"<td style='padding:6px 10px;text-align:right'>{fmt(it['net_minor'], ccy)}</td></tr>"
        )
    extra = ""
    if len(items) > limit:
        extra = (f"<tr><td colspan='6' style='padding:8px 10px;color:#64748b'>"
                 f"…and {len(items) - limit} more — see the attached CSV for the full list.</td></tr>")
    return f"<table style='border-collapse:collapse;width:100%;font-size:13px'>{head}{''.join(body)}{extra}</table>"


def build(conn: psycopg.Connection, settlement_id: int) -> dict | None:
    """Assemble the email (to, subject, html, attachments) or None if not found."""
    s = _fetch(conn, settlement_id)
    if s is None:
        return None
    ccy = s["currency"]
    bd = dict(s["breakdown"] or {})
    bd.pop("counts", None)
    bd.pop("items_count", None)
    items = line_items(conn, settlement_id)
    net = fmt(int(s["net_payout_minor"]), ccy)
    ref = s["payout_reference"] or str(s["settlement_uuid"])[:8]
    window = f"{str(s['window_start'])[:10]} → {str(s['window_end'])[:10]}"
    merchant = _html.escape(s["merchant_name"])
    subject = f"Payout confirmation — {net} {ccy} to {s['merchant_name']}"
    html = f"""\
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:680px;margin:0 auto">
  <h2 style="margin:0 0 4px">Payout confirmation</h2>
  <p style="color:#475569;margin:0 0 16px">A settlement has been paid out to <b>{merchant}</b>.</p>
  <div style="background:#0f172a;color:#fff;border-radius:12px;padding:18px 20px;margin-bottom:20px">
    <div style="font-size:13px;opacity:.8">Net payout</div>
    <div style="font-size:28px;font-weight:700">{net} {ccy}</div>
    <div style="font-size:12px;opacity:.75;margin-top:6px">Ref {_html.escape(str(ref))} · Processing window {window} · {len(items)} transaction(s)</div>
  </div>
  <h3 style="margin:0 0 8px;font-size:15px">Payout report</h3>
  <table style="border-collapse:collapse;width:100%;font-size:13px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
    {_report_html(ccy, bd, int(s['net_payout_minor']))}
    <tr><td style="padding:8px 12px;font-weight:700;background:#f0fdf4">Net payout</td>
        <td style="padding:8px 12px;text-align:right;font-weight:700;background:#f0fdf4">{net} {ccy}</td></tr>
  </table>
  <h3 style="margin:20px 0 8px;font-size:15px">Transactions in this payout</h3>
  {_items_html(ccy, items)}
  <p style="color:#94a3b8;font-size:12px;margin-top:20px">
    This is an automated payout confirmation from TransactWorld. The full transaction list is attached as a CSV.
  </p>
</div>"""
    csv_name = f"payout-{ref}.csv".replace(" ", "_")
    attachments = [(csv_name, "text/csv", _csv_bytes(ccy, items))]
    return {"to": s["merchant_email"], "subject": subject, "html": html,
            "attachments": attachments, "merchant_email": s["merchant_email"],
            "state": s["state"]}


def send_confirmation(conn: psycopg.Connection, settlement_id: int) -> dict:
    """Build + send the payout confirmation. Returns a status dict (never raises)."""
    email = build(conn, settlement_id)
    if email is None:
        return {"sent": False, "reason": "settlement not found"}
    if not email["merchant_email"]:
        return {"sent": False, "reason": "merchant has no email on file"}
    return mailer.send(email["to"], email["subject"], email["html"], email["attachments"])
