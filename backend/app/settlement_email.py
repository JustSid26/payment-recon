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
from .money import fmt, exponent
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
                  s.state, s.net_payout_minor, s.payout_reference, s.confirmation_code,
                  s.breakdown, m.name AS merchant_name, m.email AS merchant_email
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


# ---- attachments: PDF report + Excel transaction list (no third-party deps) ----
def _pdf(content: str) -> bytes:
    """Minimal single-page PDF from a content stream (Courier / Courier-Bold)."""
    objs = [
        "<</Type/Catalog/Pages 2 0 R>>",
        "<</Type/Pages/Kids[3 0 R]/Count 1>>",
        "<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]"
        "/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>",
        ("stream", content.encode("latin-1", "replace")),
        "<</Type/Font/Subtype/Type1/BaseFont/Courier>>",
        "<</Type/Font/Subtype/Type1/BaseFont/Courier-Bold>>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, o in enumerate(objs, start=1):
        offsets.append(len(out))
        if isinstance(o, tuple):
            s = o[1]
            out += f"{i} 0 obj\n<</Length {len(s)}>>\nstream\n".encode("latin-1")
            out += s + b"\nendstream\nendobj\n"
        else:
            out += f"{i} 0 obj\n{o}\nendobj\n".encode("latin-1")
    xref = len(out)
    n = len(objs) + 1
    out += f"xref\n0 {n}\n0000000000 65535 f \n".encode("latin-1")
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode("latin-1")
    out += f"trailer\n<</Size {n}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF".encode("latin-1")
    return out


def _pdf_report(merchant: str, ccy: str, code: str, window: str,
                counts: dict, bd: dict, net_minor: int) -> bytes:
    ops: list[str] = []

    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    def txt(x: float, y: float, s: str, size: int = 10, bold: bool = False) -> None:
        ops.append(f"BT {'/F2' if bold else '/F1'} {size} Tf {x:.2f} {y:.2f} Td ({esc(s)}) Tj ET")

    def right(y: float, s: str, size: int = 10, bold: bool = False) -> None:
        txt(545 - len(s) * size * 0.6, y, s, size, bold)  # Courier is fixed-width

    y = 800
    txt(50, y, "TransactWorld  -  Settlement statement", 15, True); y -= 26
    txt(50, y, f"Merchant: {merchant}", 10); y -= 15
    txt(50, y, f"Currency: {ccy}    Window: {window}", 10); y -= 15
    txt(50, y, f"Confirmation code: {code}", 11, True); y -= 15
    txt(50, y, f"Counts: Paid {counts.get('paid', 0)}   Declined {counts.get('declined', 0)}"
               f"   Refunds {counts.get('refunds', 0)}   Chargebacks {counts.get('chargebacks', 0)}", 10)
    y -= 12
    ops.append(f"BT /F1 10 Tf 50 {y:.2f} Td (" + "-" * 78 + ") Tj ET"); y -= 16
    for label, key in _REPORT_ROWS:
        val = int(bd.get(key, 0) or 0)
        if val == 0 and key not in ("gross_captured_minor", "subtotal_minor"):
            continue
        bold = key == "subtotal_minor"
        txt(55, y, label, 10, bold)
        right(y, f"{fmt(val, ccy)} {ccy}", 10, bold)
        y -= 15
    y -= 4
    ops.append(f"BT /F1 10 Tf 50 {y:.2f} Td (" + "-" * 78 + ") Tj ET"); y -= 18
    txt(55, y, "NET PAYOUT", 13, True)
    right(y, f"{fmt(net_minor, ccy)} {ccy}", 13, True); y -= 26
    txt(50, y, "Automated payout confirmation from TransactWorld.", 9)
    y -= 12
    txt(50, y, f"Quote confirmation code {code} for any query about this settlement.", 9)
    return _pdf("\n".join(ops))


def _xls_bytes(ccy: str, items: list[dict]) -> bytes:
    """Transaction list as a SpreadsheetML .xls (opens natively in Excel)."""
    e = exponent(ccy)

    def major(m) -> float:
        return int(m) / (10 ** e)

    def cell(v) -> str:
        if isinstance(v, (int, float)):
            return f'<Cell ss:StyleID="num"><Data ss:Type="Number">{v}</Data></Cell>'
        return f'<Cell><Data ss:Type="String">{_html.escape(str(v))}</Data></Cell>'

    header = ["Date", "Reference", "Brand", "Last 4", "Status", "Type",
              f"Gross ({ccy})", f"MDR ({ccy})", f"Approved fee ({ccy})",
              f"Declined fee ({ccy})", f"Refund fee ({ccy})", f"Chargeback fee ({ccy})",
              f"Reserve ({ccy})", f"Net ({ccy})"]
    rows = [header]
    for it in items:
        rows.append([
            str(it["occurred_at"])[:10], it["reference"], it["brand"], it["last_four"],
            it["status"], it["type"],
            major(it["gross_minor"]), major(it["mdr_minor"]), major(it["approved_fee_minor"]),
            major(it["declined_fee_minor"]), major(it["refund_fee_minor"]),
            major(it["chargeback_fee_minor"]), major(it["reserve_minor"]), major(it["net_minor"]),
        ])
    body = "".join("<Row>" + "".join(cell(c) for c in r) + "</Row>" for r in rows)
    xml = ('<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n'
           '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" '
           'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
           '<Styles><Style ss:ID="num"><NumberFormat ss:Format="#,##0.00"/></Style></Styles>'
           f'<Worksheet ss:Name="Transactions"><Table>{body}</Table></Worksheet></Workbook>')
    return xml.encode("utf-8")


def build(conn: psycopg.Connection, settlement_id: int) -> dict | None:
    """Assemble the email (to, subject, html, attachments) or None if not found."""
    s = _fetch(conn, settlement_id)
    if s is None:
        return None
    ccy = s["currency"]
    bd = dict(s["breakdown"] or {})
    counts = dict(bd.get("counts") or {})
    bd.pop("counts", None)
    bd.pop("items_count", None)
    items = line_items(conn, settlement_id)
    net = fmt(int(s["net_payout_minor"]), ccy)
    code = s["confirmation_code"] or ("TW-" + str(s["settlement_uuid"]).replace("-", "")[:10].upper())
    ref = s["payout_reference"] or str(s["settlement_uuid"])[:8]
    window = f"{str(s['window_start'])[:10]} → {str(s['window_end'])[:10]}"
    merchant = _html.escape(s["merchant_name"])
    subject = f"Payout confirmation {code} — {net} {ccy} to {s['merchant_name']}"
    html = f"""\
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:680px;margin:0 auto">
  <h2 style="margin:0 0 4px">Payout confirmation</h2>
  <p style="color:#475569;margin:0 0 16px">A settlement has been paid out to <b>{merchant}</b>.</p>
  <div style="background:#0f172a;color:#fff;border-radius:12px;padding:18px 20px;margin-bottom:20px">
    <div style="font-size:13px;opacity:.8">Net payout</div>
    <div style="font-size:28px;font-weight:700">{net} {ccy}</div>
    <div style="font-size:12px;opacity:.75;margin-top:6px">Processing window {window} · {len(items)} transaction(s)</div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.15)">
      <span style="font-size:12px;opacity:.8">Settlement confirmation code</span><br>
      <span style="font-size:18px;font-weight:700;letter-spacing:.05em">{_html.escape(code)}</span>
    </div>
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
    This is an automated payout confirmation from TransactWorld. Quote confirmation code
    <b>{_html.escape(code)}</b> for any query about this settlement. Attached: the settlement
    <b>report (PDF)</b> and the full <b>transaction list (Excel)</b>.
  </p>
</div>"""
    window_full = f"{str(s['window_start'])[:10]} to {str(s['window_end'])[:10]}"
    attachments = [
        (f"settlement-report-{code}.pdf".replace(" ", "_"), "application/pdf",
         _pdf_report(s["merchant_name"], ccy, code, window_full, counts, bd,
                     int(s["net_payout_minor"]))),
        (f"transactions-{code}.xls".replace(" ", "_"), "application/vnd.ms-excel",
         _xls_bytes(ccy, items)),
    ]
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
