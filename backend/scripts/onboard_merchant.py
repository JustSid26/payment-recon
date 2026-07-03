"""Onboard a quarantined (unknown) merchant: assign a fee schedule and replay
their quarantined transactions into the ledger.

  # list who is awaiting onboarding
  ./.venv/bin/python scripts/onboard_merchant.py --list

  # assign a named preset
  ./.venv/bin/python scripts/onboard_merchant.py --merchant <member_id|uuid> --preset annex

  # assign custom rates (fields you omit default to 0 / T+0 / 180d reserve)
  ./.venv/bin/python scripts/onboard_merchant.py --merchant <id> --mdr-bps 300 \
      --settlement-fee-bps 100 --reserve-hold-bps 500
"""
import argparse
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402
from app.db import DSN  # noqa: E402
from app import onboarding as ob  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--list", action="store_true", help="list unconfigured merchants and exit")
ap.add_argument("--merchant", help="merchant member_id or merchant_uuid")
ap.add_argument("--preset", choices=list(ob.PRESETS), help="named rate card")
ap.add_argument("--mdr-bps", type=int)
ap.add_argument("--approved-txn-fee-minor", type=int)
ap.add_argument("--declined-txn-fee-minor", type=int)
ap.add_argument("--refund-fee-minor", type=int)
ap.add_argument("--chargeback-fee-minor", type=int)
ap.add_argument("--reserve-hold-bps", type=int)
ap.add_argument("--reserve-hold-days", type=int)
ap.add_argument("--settlement-fee-bps", type=int)
ap.add_argument("--settlement-delay-days", type=int)
ap.add_argument("--settlement-schedule")
args = ap.parse_args()

with psycopg.connect(DSN, row_factory=dict_row) as conn:
    if args.list or not args.merchant:
        rows = ob.unconfigured_merchants(conn)
        if not rows:
            print("No unconfigured merchants — everyone imported has a fee schedule.")
        for r in rows:
            print(f"  {r['member_id'] or r['merchant_uuid']}  {r['name']}  "
                  f"— {r['quarantined']} quarantined txns")
        if args.list or not args.merchant:
            sys.exit(0)

    cur = conn.cursor()
    cur.execute("SELECT id FROM merchants WHERE member_id=%s OR merchant_uuid::text=%s",
                (args.merchant, args.merchant))
    m = cur.fetchone()
    if m is None:
        sys.exit(f"merchant not found: {args.merchant}")

    overrides = {k: v for k, v in {
        "mdr_bps": args.mdr_bps,
        "approved_txn_fee_minor": args.approved_txn_fee_minor,
        "declined_txn_fee_minor": args.declined_txn_fee_minor,
        "refund_fee_minor": args.refund_fee_minor,
        "chargeback_fee_minor": args.chargeback_fee_minor,
        "reserve_hold_bps": args.reserve_hold_bps,
        "reserve_hold_days": args.reserve_hold_days,
        "settlement_fee_bps": args.settlement_fee_bps,
        "settlement_delay_days": args.settlement_delay_days,
        "settlement_schedule": args.settlement_schedule,
    }.items() if v is not None}

    rates = ob.resolve_rates(preset=args.preset, overrides=overrides)
    summary = ob.assign_fee_schedule(conn, m["id"], rates)
    print(f"onboarded merchant {args.merchant}: "
          f"{summary['transactions_posted']} quarantined transactions posted to the ledger")
