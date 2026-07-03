"""Run one settlement cycle — the cron/Celery-beat entrypoint.

  ./.venv/bin/python scripts/run_cycle.py                # cutoff = now
  ./.venv/bin/python scripts/run_cycle.py --cutoff 2026-07-02

Schedule daily (e.g. 11:00 Europe/Nicosia) to settle T+1 and release rolling
reserves. Idempotent per cutoff date, so a missed day can be re-run safely.
"""
import argparse
import json
import pathlib
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402
from app.db import DSN  # noqa: E402
from app.cycle import run_cycle  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--cutoff", help="ISO date/datetime; default now (UTC)")
ap.add_argument("--by", default="scheduler")
args = ap.parse_args()

cutoff = None
if args.cutoff:
    cutoff = datetime.fromisoformat(args.cutoff)
    if cutoff.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=timezone.utc)

with psycopg.connect(DSN, row_factory=dict_row) as conn:
    summary = run_cycle(conn, cutoff=cutoff, generated_by=args.by)

c = summary["counts"]
print(f"cutoff {summary['cutoff']}: settled {c['settled']}, "
      f"skipped(deficit) {c['skipped']}, reserve groups released {c['reserve_groups_released']}")
print(json.dumps(summary, indent=2, default=str))
