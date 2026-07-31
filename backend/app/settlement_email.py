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
from .settle import line_items, day_payouts

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
                  s.breakdown, m.name AS merchant_name, m.email AS merchant_email,
                  fs.mdr_bps, fs.approved_txn_fee_minor, fs.declined_txn_fee_minor,
                  fs.refund_fee_minor, fs.chargeback_fee_minor, fs.reserve_hold_bps,
                  fs.settlement_fee_bps
             FROM settlements s JOIN merchants m ON m.id = s.merchant_id
             LEFT JOIN fee_schedules fs ON fs.merchant_id = s.merchant_id
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


# ---- attachments: PDF report (mirrors the UI statement) + real .xlsx (no deps) --
_SYM = {"EUR": "€", "USD": "$", "GBP": "£", "JPY": "¥", "AUD": "A$", "CAD": "C$"}
_USDC_RATES = {"USD": "1.0000", "EUR": "1.0850", "AUD": "0.6650", "CAD": "0.7350",
               "GBP": "1.2700", "JPY": "0.0069"}
_RED = "0.70 0.11 0.09"
_GRAY = "0.42 0.45 0.50"


def _money(minor, ccy: str) -> str:
    """Currency-symbol money with thousands separators, e.g. -€17,710.71 (as the UI)."""
    e = exponent(ccy)
    v = int(minor) / (10 ** e)
    return f"{'-' if v < 0 else ''}{_SYM.get(ccy, ccy + ' ')}{abs(v):,.{e}f}"


def _pdf(content: str) -> bytes:
    """Minimal single-page PDF (Courier / Courier-Bold, WinAnsi so € £ ¥ render)."""
    objs = [
        "<</Type/Catalog/Pages 2 0 R>>",
        "<</Type/Pages/Kids[3 0 R]/Count 1>>",
        "<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]"
        "/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>",
        ("stream", content.encode("cp1252", "replace")),
        "<</Type/Font/Subtype/Type1/BaseFont/Courier/Encoding/WinAnsiEncoding>>",
        "<</Type/Font/Subtype/Type1/BaseFont/Courier-Bold/Encoding/WinAnsiEncoding>>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, o in enumerate(objs, start=1):
        offsets.append(len(out))
        if isinstance(o, tuple):
            s = o[1]
            out += f"{i} 0 obj\n<</Length {len(s)}>>\nstream\n".encode("cp1252")
            out += s + b"\nendstream\nendobj\n"
        else:
            out += f"{i} 0 obj\n{o}\nendobj\n".encode("cp1252")
    xref = len(out)
    n = len(objs) + 1
    out += f"xref\n0 {n}\n0000000000 65535 f \n".encode("cp1252")
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode("cp1252")
    out += f"trailer\n<</Size {n}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF".encode("cp1252")
    return out


def _pdf_report(merchant: str, ccy: str, code: str, window: str, counts: dict,
                bd: dict, net_minor: int, fs: dict, usdc: dict, items_count: int) -> bytes:
    ops: list[str] = []

    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    def txt(x, y, s, size=10, bold=False, color=None) -> None:
        # always set an explicit fill colour — PDF graphics state persists across
        # text objects, so an unset colour would inherit the previous (red) one.
        col = f"{color or '0 0 0'} rg "
        ops.append(f"BT {'/F2' if bold else '/F1'} {size} Tf {col}{x:.2f} {y:.2f} Td ({esc(s)}) Tj ET")

    def right(y, s, size=10, bold=False, color=None) -> None:
        txt(545 - len(s) * size * 0.6, y, s, size, bold, color)

    def rule(y) -> None:
        ops.append(f"0.8 w 0.85 0.87 0.90 RG 50 {y:.2f} m 545 {y:.2f} l S")

    pct = lambda bps: f"({bps / 100:.2f}%)" if bps is not None else ""      # noqa: E731
    amt = lambda m: f"({_money(m, ccy)})" if m is not None else ""          # noqa: E731

    y = 802
    txt(50, y, "SETTLEMENT STATEMENT", 9, False, _GRAY); y -= 20
    txt(50, y, merchant, 17, True); y -= 17
    txt(50, y, f"Window {window}   ·   Currency {ccy}", 10, False, _GRAY); y -= 15
    txt(50, y, f"Confirmation code {code}", 11, True); y -= 14
    txt(50, y, f"Counts: Paid {counts.get('paid', 0)} · Declined {counts.get('declined', 0)} · "
               f"Refunds {counts.get('refunds', 0)} · Chargebacks {counts.get('chargebacks', 0)}",
        9, False, _GRAY); y -= 14
    rule(y); y -= 18

    # (label, signed value, basis, bold, hide-if-zero, is-subtotal)
    rows = [
        ("Gross captured", int(bd.get("gross_captured_minor", 0) or 0), "", True, False, False),
        ("MDR", -abs(int(bd.get("mdr_minor", 0) or 0)), pct(fs.get("mdr_bps")), False, False, False),
        ("Approved transaction fees", -abs(int(bd.get("approved_txn_fees_minor", 0) or 0)), amt(fs.get("approved_txn_fee_minor")), False, False, False),
        ("Declined transaction fees", -abs(int(bd.get("declined_txn_fees_minor", 0) or 0)), amt(fs.get("declined_txn_fee_minor")), False, True, False),
        ("Refunds", -abs(int(bd.get("refunds_minor", 0) or 0)), "", False, True, False),
        ("Refund fees", -abs(int(bd.get("refund_fees_minor", 0) or 0)), amt(fs.get("refund_fee_minor")), False, True, False),
        ("Chargebacks", -abs(int(bd.get("chargebacks_minor", 0) or 0)), "", False, True, False),
        ("Chargeback fees", -abs(int(bd.get("chargeback_fees_minor", 0) or 0)), amt(fs.get("chargeback_fee_minor")), False, True, False),
        ("Reserve held", -abs(int(bd.get("reserve_held_minor", 0) or 0)), pct(fs.get("reserve_hold_bps")), False, False, False),
        ("Reserve released", abs(int(bd.get("reserve_released_minor", 0) or 0)), "", False, True, False),
        ("Adjustments", int(bd.get("adjustments_minor", 0) or 0), "", False, True, False),
        ("Subtotal", int(bd.get("subtotal_minor", 0) or 0), "", True, False, True),
        ("Settlement fee", -abs(int(bd.get("settlement_fee_minor", 0) or 0)), pct(fs.get("settlement_fee_bps")), False, False, False),
    ]
    for label, val, basis, bold, hide_zero, is_sub in rows:
        if hide_zero and val == 0:
            continue
        if is_sub:
            rule(y + 11)
        txt(55, y, label + (f"   {basis}" if basis else ""), 10, bold)
        right(y, _money(val, ccy), 10, bold, _RED if val < 0 else None)
        y -= 15
    y -= 3
    rule(y + 10)
    txt(55, y, "NET PAYOUT", 13, True)
    right(y, _money(net_minor, ccy), 13, True); y -= 26
    if usdc:
        txt(50, y, f"USDC conversion @ rate {usdc['rate']}", 9, False, _GRAY)
        right(y, f"{usdc['amount']} USDC", 10, True); y -= 16
    txt(50, y, f"Statement covers {items_count} settled items · quote code {code} for any query.",
        9, False, _GRAY)
    return _pdf("\n".join(ops))


def _xlsx_col(n: int) -> str:
    r = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        r = chr(65 + rem) + r
    return r


def _xlsx_bytes(rows: list[list]) -> bytes:
    """A genuine .xlsx (OOXML) so Excel opens it without a format warning."""
    import zipfile

    def cell(v, ref: str) -> str:
        if isinstance(v, bool):
            v = str(v)
        if isinstance(v, (int, float)):
            return f'<c r="{ref}"><v>{v}</v></c>'
        t = _html.escape(str(v))
        return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{t}</t></is></c>'

    sheet_rows = "".join(
        f'<row r="{i}">' + "".join(cell(v, f"{_xlsx_col(j)}{i}") for j, v in enumerate(row, 1)) + "</row>"
        for i, row in enumerate(rows, 1)
    )
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             f'<sheetData>{sheet_rows}</sheetData></worksheet>')
    ctypes = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
              '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
              '<Default Extension="xml" ContentType="application/xml"/>'
              '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
              '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
              '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="Transactions" sheetId="1" r:id="rId1"/></sheets></workbook>')
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
               '</Relationships>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ctypes)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()


def _txn_rows(ccy: str, items: list[dict]) -> list[list]:
    e = exponent(ccy)
    major = lambda m: int(m) / (10 ** e)   # noqa: E731
    rows = [["Date", "Reference", "Brand", "Last 4", "Status", "Type",
             f"Gross ({ccy})", f"MDR ({ccy})", f"Approved fee ({ccy})", f"Declined fee ({ccy})",
             f"Refund fee ({ccy})", f"Chargeback fee ({ccy})", f"Reserve ({ccy})", f"Net ({ccy})"]]
    for it in items:
        rows.append([
            str(it["occurred_at"])[:10], it["reference"], it["brand"], it["last_four"],
            it["status"], it["type"],
            major(it["gross_minor"]), major(it["mdr_minor"]), major(it["approved_fee_minor"]),
            major(it["declined_fee_minor"]), major(it["refund_fee_minor"]),
            major(it["chargeback_fee_minor"]), major(it["reserve_minor"]), major(it["net_minor"]),
        ])
    return rows


def _usdc(ccy: str, net_minor: int) -> dict:
    rate = _USDC_RATES.get(ccy, "1.0000")
    e = exponent(ccy)
    amount = f"{float(rate) * net_minor / (10 ** e):,.2f}"
    return {"rate": rate, "amount": amount}


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
  <p style="color:#94a3b8;font-size:12px;margin-top:20px">
    Automated payout confirmation from TransactWorld. Quote confirmation code
    <b>{_html.escape(code)}</b> for any query about this settlement. Attached: the full settlement
    <b>report (PDF)</b> and the <b>{len(items)} transactions (Excel)</b>.
  </p>
</div>"""
    fs = {k: s.get(k) for k in ("mdr_bps", "approved_txn_fee_minor", "declined_txn_fee_minor",
                                "refund_fee_minor", "chargeback_fee_minor", "reserve_hold_bps",
                                "settlement_fee_bps")}
    window_full = f"{str(s['window_start'])[:10]} to {str(s['window_end'])[:10]}"
    attachments = [
        (f"settlement-report-{code}.pdf".replace(" ", "_"), "application/pdf",
         _pdf_report(s["merchant_name"], ccy, code, window_full, counts, bd,
                     int(s["net_payout_minor"]), fs, _usdc(ccy, int(s["net_payout_minor"])), len(items))),
        (f"transactions-{code}.xlsx".replace(" ", "_"),
         "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
         _xlsx_bytes(_txn_rows(ccy, items))),
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


# ---- per-day payout email (fired when a single processing day is confirmed) ----
def _day_breakdown(items: list[dict]) -> dict:
    """Aggregate one day's line items into the settlement-statement breakdown shape."""
    b = dict(gross_captured_minor=0, mdr_minor=0, approved_txn_fees_minor=0,
             declined_txn_fees_minor=0, refunds_minor=0, refund_fees_minor=0,
             chargebacks_minor=0, chargeback_fees_minor=0, reserve_held_minor=0,
             reserve_released_minor=0, adjustments_minor=0)
    for it in items:
        g = int(it["gross_minor"]); t = str(it.get("type") or "")
        if g > 0:
            b["gross_captured_minor"] += g
        elif t.startswith("chargeback"):
            b["chargebacks_minor"] += -g
        elif g < 0:
            b["refunds_minor"] += -g
        b["mdr_minor"] += int(it["mdr_minor"])
        b["approved_txn_fees_minor"] += int(it["approved_fee_minor"])
        b["declined_txn_fees_minor"] += int(it["declined_fee_minor"])
        b["refund_fees_minor"] += int(it["refund_fee_minor"])
        b["chargeback_fees_minor"] += int(it["chargeback_fee_minor"])
        r = int(it["reserve_minor"])
        if r > 0:
            b["reserve_held_minor"] += r
        elif r < 0:
            b["reserve_released_minor"] += -r
    return b


def build_day(conn: psycopg.Connection, settlement_id: int, day: str) -> dict | None:
    """Assemble the per-day payout email (that day's report PDF + that day's Excel)."""
    s = _fetch(conn, settlement_id)
    if s is None:
        return None
    ccy = s["currency"]
    code = s["confirmation_code"] or ("TW-" + str(s["settlement_uuid"]).replace("-", "")[:10].upper())
    items = [it for it in line_items(conn, settlement_id) if str(it["occurred_at"])[:10] == day]
    row = next((d for d in day_payouts(conn, settlement_id)["days"] if d["day"] == day), None)
    if row is None:
        return None
    net = int(row["payout_minor"])
    bd = _day_breakdown(items)
    bd["subtotal_minor"] = int(row["subtotal_minor"])
    bd["settlement_fee_minor"] = int(row["fee_minor"])
    counts = {
        "paid": sum(1 for it in items if it.get("type") == "payment_captured" or int(it["gross_minor"]) > 0),
        "declined": sum(1 for it in items if it.get("type") == "decline_fee" or it.get("status") == "auth_failed"),
        "refunds": sum(1 for it in items if it.get("type") == "refund"),
        "chargebacks": sum(1 for it in items if str(it.get("type") or "").startswith("chargeback")),
    }
    fs = {k: s.get(k) for k in ("mdr_bps", "approved_txn_fee_minor", "declined_txn_fee_minor",
                                "refund_fee_minor", "chargeback_fee_minor", "reserve_hold_bps",
                                "settlement_fee_bps")}
    net_str = fmt(net, ccy)
    merchant = _html.escape(s["merchant_name"])
    subject = f"Payout confirmation {code} — {day} — {net_str} {ccy} to {s['merchant_name']}"
    html = f"""\
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:680px;margin:0 auto">
  <h2 style="margin:0 0 4px">Payout confirmation — {day}</h2>
  <p style="color:#475569;margin:0 0 16px">A single-day payout has been made to <b>{merchant}</b>.</p>
  <div style="background:#0f172a;color:#fff;border-radius:12px;padding:18px 20px;margin-bottom:20px">
    <div style="font-size:13px;opacity:.8">Day net payout</div>
    <div style="font-size:28px;font-weight:700">{net_str} {ccy}</div>
    <div style="font-size:12px;opacity:.75;margin-top:6px">Processing day {day} · {len(items)} transaction(s)</div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.15)">
      <span style="font-size:12px;opacity:.8">Settlement confirmation code</span><br>
      <span style="font-size:18px;font-weight:700;letter-spacing:.05em">{_html.escape(code)}</span>
    </div>
  </div>
  <h3 style="margin:0 0 8px;font-size:15px">Day payout report</h3>
  <table style="border-collapse:collapse;width:100%;font-size:13px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
    {_report_html(ccy, bd, net)}
    <tr><td style="padding:8px 12px;font-weight:700;background:#f0fdf4">Day net payout</td>
        <td style="padding:8px 12px;text-align:right;font-weight:700;background:#f0fdf4">{net_str} {ccy}</td></tr>
  </table>
  <p style="color:#94a3b8;font-size:12px;margin-top:20px">
    Automated payout confirmation from TransactWorld for <b>{day}</b>. Quote confirmation code
    <b>{_html.escape(code)}</b> for any query. Attached: the day <b>report (PDF)</b> and its
    <b>{len(items)} transactions (Excel)</b>.
  </p>
</div>"""
    attachments = [
        (f"settlement-report-{code}-{day}.pdf".replace(" ", "_"), "application/pdf",
         _pdf_report(s["merchant_name"], ccy, code, day, counts, bd, net, fs, _usdc(ccy, net), len(items))),
        (f"transactions-{code}-{day}.xlsx".replace(" ", "_"),
         "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
         _xlsx_bytes(_txn_rows(ccy, items))),
    ]
    return {"to": s["merchant_email"], "subject": subject, "html": html,
            "attachments": attachments, "merchant_email": s["merchant_email"]}


def send_day_confirmation(conn: psycopg.Connection, settlement_id: int, day: str) -> dict:
    """Build + send the per-day payout confirmation. Never raises."""
    email = build_day(conn, settlement_id, day)
    if email is None:
        return {"sent": False, "reason": "settlement/day not found"}
    if not email["merchant_email"]:
        return {"sent": False, "reason": "merchant has no email on file"}
    return mailer.send(email["to"], email["subject"], email["html"], email["attachments"])
