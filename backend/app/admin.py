"""Admin: live file upload + import, clean-slate reset, data status.

Powers the demo 'Upload & Verify' page and the 'Reset demo' button. Uploaded
files are imported through the SAME importers used by the seed script, so the
ledger invariants hold identically whether data arrives by CLI or by upload.
"""
from __future__ import annotations

import pathlib
import tempfile

from fastapi import APIRouter, Depends, File, UploadFile
from psycopg.rows import dict_row

from .auth import require_admin
from .db import get_pool
from .importer import Importer, build_name_map

router = APIRouter(prefix="/api/admin")

# every data table, child-before-parent not needed with CASCADE
_TABLES = [
    "ledger_entries", "ledger_events", "posting_idempotency", "account_balances",
    "accounts", "fees", "settlement_items", "settlements", "reserve_holds",
    "transactions", "fee_schedules", "merchants",
]


def _status(cur) -> dict:
    counts = {}
    for t in ("merchants", "transactions", "ledger_events", "ledger_entries",
              "settlements"):
        cur.execute(f"SELECT COUNT(*) AS n FROM {t}")
        counts[t] = int(cur.fetchone()["n"])
    return {"counts": counts, "empty": counts["transactions"] == 0}


def _integrity(cur) -> dict:
    from .api import _integrity_summary
    return _integrity_summary(cur)


@router.get("/status")
def status(user: dict = Depends(require_admin)):
    with get_pool().connection() as conn:
        return _status(conn.cursor())


@router.post("/reset")
def reset(user: dict = Depends(require_admin)):
    with get_pool().connection() as conn:
        cur = conn.cursor()
        cur.execute("TRUNCATE " + ", ".join(_TABLES) + " RESTART IDENTITY CASCADE")
        conn.commit()
        return {"ok": True, "status": _status(cur)}


@router.post("/upload")
def upload(user: dict = Depends(require_admin), files: list[UploadFile] = File(...)):
    """Accepts processor transaction CSVs and/or the settlement .xlsx workbook.
    Runs the importers, then reports import stats + live integrity checks."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="tw-upload-"))
    saved: list[tuple[str, pathlib.Path]] = []
    for f in files:
        dest = tmp / (f.filename or "upload.dat").replace("/", "_")
        dest.write_bytes(f.file.read())
        saved.append(((f.filename or "").lower(), dest))

    csvs = [str(p) for name, p in saved if name.endswith(".csv")]
    xlsxs = [(name, str(p)) for name, p in saved if name.endswith(".xlsx")]

    per_file: list[dict] = []
    with get_pool().connection() as conn:
        conn.row_factory = dict_row
        imp = Importer(conn)
        name_map = build_name_map(csvs) if csvs else {}
        for path in csvs:
            before = dict(imp.stats)
            try:
                imp.import_csv(path, name_map)
                ok, msg = True, "imported"
            except Exception as ex:  # keep other files going
                ok, msg = False, str(ex)[:200]
            per_file.append({"file": pathlib.Path(path).name, "ok": ok, "detail": msg,
                             "delta": _delta(before, imp.stats)})
        for name, path in xlsxs:
            before = dict(imp.stats)
            try:
                imp.import_xlsx_paid(path)
                imp.import_xlsx_refunds(path)
                ok, msg = True, "imported (Paid + Refund sheets)"
            except Exception as ex:
                ok, msg = False, str(ex)[:200]
            per_file.append({"file": pathlib.Path(path).name, "ok": ok, "detail": msg,
                             "delta": _delta(before, imp.stats)})

        cur = conn.cursor()
        integ = _integrity(cur)
        st = _status(cur)

    if not csvs and not xlsxs:
        return {"ok": False, "error": "no .csv or .xlsx files in upload",
                "files": [], "stats": {}, "integrity": integ if 'integ' in dir() else {}}
    return {"ok": all(f["ok"] for f in per_file), "files": per_file,
            "stats": imp.stats, "integrity": integ, "status": st}


def _delta(before: dict, after: dict) -> dict:
    return {k: after.get(k, 0) - before.get(k, 0) for k in after
            if after.get(k, 0) != before.get(k, 0)}
