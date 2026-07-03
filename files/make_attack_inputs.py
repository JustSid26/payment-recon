#!/usr/bin/env python3
"""
make_attack_inputs.py -- generate adversarial import files for the TransactWorld
importer by MUTATING one known-good CSV. Deriving every variant from your real
file guarantees the columns match your importer, so each file tests the PARSER /
ingestion logic rather than accidentally failing on a header mismatch.

Stdlib only. Run with your venv python or system python 3.8+.

    python make_attack_inputs.py path/to/known_good.csv
    python make_attack_inputs.py good.csv --outdir attack-inputs --collision-token CanAm

Then feed the files in ./attack-inputs/ through your normal import flow and watch
for: 500s, silent coercion, wraparound, cross-merchant merges, name-based rate
inheritance, or anything landing in the ledger that should have been quarantined.

Column auto-detection is fuzzy (case-insensitive substring). If it guesses wrong,
override with --id-col / --amount-col / --currency-col / --date-col / --merchant-col
(pass the EXACT header text). A variant is skipped (with a warning) if the column
it needs was not found.
"""

import argparse
import csv
import copy
import os
import sys

# ----- candidate header names for fuzzy detection -----
CANDIDATES = {
    "id":       ["payment_id", "payment id", "paymentid", "txn_id", "transaction_id",
                 "reference", "ref", "id"],
    "amount":   ["capture_amount", "capture", "amount_minor", "amount", "gross",
                 "value", "total", "minor"],
    "currency": ["currency", "ccy", "curr"],
    "date":     ["captured_at", "created_at", "txn_date", "timestamp", "datetime",
                 "date", "time"],
    "merchant": ["merchant_name", "merchant", "seller", "account_name", "payee",
                 "client", "counterparty"],
}


def find_col(fieldnames, key, override):
    if override:
        if override not in fieldnames:
            sys.exit(f"[fatal] --{key}-col '{override}' is not a header in the input. "
                     f"Headers are: {fieldnames}")
        return override
    lowered = {f.lower(): f for f in fieldnames}
    # exact-ish match first, then substring
    for cand in CANDIDATES[key]:
        if cand in lowered:
            return lowered[cand]
    for cand in CANDIDATES[key]:
        for lf, orig in lowered.items():
            if cand in lf:
                return orig
    return None


def write_csv(path, fieldnames, rows):
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)


def write_raw(path, fieldnames, rows):
    """Write with NO header row (values only, in column order)."""
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        for r in rows:
            w.writerow([r.get(fn, "") for fn in fieldnames])


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="path to a KNOWN-GOOD input CSV")
    ap.add_argument("--outdir", default="attack-inputs")
    ap.add_argument("--collision-token", default="CanAm",
                    help="substring of a known client name to test name-collision "
                         "(default: CanAm, from merchant@canamoney.com)")
    ap.add_argument("--id-col")
    ap.add_argument("--amount-col")
    ap.add_argument("--currency-col")
    ap.add_argument("--date-col")
    ap.add_argument("--merchant-col")
    args = ap.parse_args()

    with open(args.input, newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            sys.exit("[fatal] input has no header row / is empty.")
        fieldnames = list(reader.fieldnames)
        rows = [dict(r) for r in reader]

    if not rows:
        sys.exit("[fatal] input has a header but no data rows -- give me a real sample.")

    col = {
        "id":       find_col(fieldnames, "id", args.id_col),
        "amount":   find_col(fieldnames, "amount", args.amount_col),
        "currency": find_col(fieldnames, "currency", args.currency_col),
        "date":     find_col(fieldnames, "date", args.date_col),
        "merchant": find_col(fieldnames, "merchant", args.merchant_col),
    }

    os.makedirs(args.outdir, exist_ok=True)
    print(f"input rows      : {len(rows)}")
    print(f"headers         : {fieldnames}")
    print("detected columns:")
    for k, v in col.items():
        print(f"    {k:9s} -> {v if v else '(not found -- dependent variants skipped)'}")
    print()

    manifest = []  # (filename, probes, expected_safe_behavior)

    def emit(name, fns, rws, probes, expected, raw=False):
        path = os.path.join(args.outdir, name)
        (write_raw if raw else write_csv)(path, fns, rws)
        manifest.append((name, probes, expected))
        print(f"  wrote {name}")

    def clone():
        return [copy.deepcopy(r) for r in rows]

    # 0) baseline sanity -- should import cleanly (posts if merchant known,
    #    quarantines if not). If THIS misbehaves, the harness itself is wrong.
    emit("00_baseline.csv", fieldnames, clone(),
         "sanity: unmodified file",
         "imports normally; known merchant -> posts, unknown -> quarantined")

    # 1) renamed headers -- opaque names for the key columns
    if any(col[k] for k in ("id", "amount", "currency", "date", "merchant")):
        rename = {}
        i = 1
        for k in ("id", "amount", "currency", "date", "merchant"):
            if col[k]:
                rename[col[k]] = f"field{i}"
                i += 1
        new_fields = [rename.get(fn, fn) for fn in fieldnames]
        rws = clone()
        rws = [{rename.get(k, k): v for k, v in r.items()} for r in rws]
        emit("01_headers_renamed.csv", new_fields, rws,
             "header auto-detection: key columns renamed to fieldN",
             "graceful rejection or quarantine with a clear error -- NOT a 500 and "
             "NOT importing garbage under wrong column meanings")

    # 2) missing columns -- drop currency and date entirely
    drop = [c for c in (col["currency"], col["date"]) if c]
    if drop:
        new_fields = [fn for fn in fieldnames if fn not in drop]
        rws = [{k: v for k, v in r.items() if k not in drop} for r in clone()]
        emit("02_headers_missing_cols.csv", new_fields, rws,
             f"missing required columns: {drop}",
             "clear validation error; must not silently default currency/date or "
             "partially post")

    # 3) no header row at all
    emit("03_no_header_row.csv", fieldnames, clone(),
         "no header line (values only)",
         "clean 'missing/invalid header' error; must not treat the first data row "
         "as headers and drop a real transaction", raw=True)

    # 4) bad date formats
    if col["date"]:
        bad = ["31/02/2026", "2026-13-01", "not-a-date", "07-03-2026",
               "1719960000", "", "2026/07/03 25:61:00"]
        rws = clone()
        for i, r in enumerate(rws):
            r[col["date"]] = bad[i % len(bad)]
        emit("04_bad_dates.csv", fieldnames, rws,
             "invalid/ambiguous/impossible dates",
             "reject or quarantine per row; must NOT crash and must NOT coerce a "
             "bad date to now() or to a wrong settlement window")

    # 5) unknown / wrong-case currencies
    if col["currency"]:
        bad = ["usd", "eur ", "XYZ", "", "US Dollar", "inr", "us$", "123"]
        rws = clone()
        for i, r in enumerate(rws):
            r[col["currency"]] = bad[i % len(bad)]
        emit("05_currency_unknown_case.csv", fieldnames, rws,
             "lowercase / unknown / blank currencies",
             "deterministic normalization OR quarantine; must never misprice or "
             "mix currencies silently in one balance")

    # 6) huge amounts -- probe integer-minor-unit overflow / precision
    if col["amount"]:
        bad = ["99999999999999999999", "1000000000000.00", "1e309",
               "9" * 40, "2147483648", "9223372036854775808"]  # > int32, > int64
        rws = clone()
        for i, r in enumerate(rws):
            r[col["amount"]] = bad[i % len(bad)]
        emit("06_huge_amounts.csv", fieldnames, rws,
             "amounts beyond int32/int64 and non-integer minor units",
             "reject overflow or carry as bigint minor units; NO wraparound, NO "
             "float precision loss, ledger still nets to zero")

    # 7) negative amounts
    if col["amount"]:
        bad = ["-1", "-9999999999", "-0", "-0.01", "-100"]
        rws = clone()
        for i, r in enumerate(rws):
            r[col["amount"]] = bad[i % len(bad)]
        emit("07_negative_amounts.csv", fieldnames, rws,
             "negative capture amounts",
             "reject, or treat explicitly as refunds with correct signs; ledger "
             "must still balance and reserves must not go impossibly negative")

    # 8) same payment_id across different merchants
    if col["id"] and col["merchant"]:
        base = clone()[: min(5, len(rows))]
        dup = []
        for i, r in enumerate(base):
            r2 = copy.deepcopy(r)
            r2[col["merchant"]] = f"OTHER-MERCHANT-{i}"
            dup.append(r2)
        rws = clone() + dup  # original ids now appear under 2+ merchants
        emit("08_dup_ids_cross_merchant.csv", fieldnames, rws,
             "identical payment_id under different merchants",
             "idempotency scoped correctly (per merchant+id) OR globally deduped; "
             "must not double-post and must not merge two merchants' money")

    # 9) merchant name merely CONTAINING a known client's name
    if col["merchant"]:
        tok = args.collision_token
        variants = [f"{tok} Money Reunion Ltd", f"X{tok}MoneyX",
                    f"Not {tok} Money", f"{tok}MoneyGlobal Pvt"]
        rws = clone()
        for i, r in enumerate(rws):
            r[col["merchant"]] = variants[i % len(variants)]
        emit("09_name_collision.csv", fieldnames, rws,
             f"merchant names containing the token '{tok}'",
             "matched by merchant id, NOT by name substring; a look-alike name must "
             "NOT inherit the real client's fee schedule / settlement config")

    # ----- manifest -----
    man_path = os.path.join(args.outdir, "MANIFEST.txt")
    with open(man_path, "w") as f:
        f.write("Adversarial import files -- what each one probes\n")
        f.write("=" * 60 + "\n\n")
        for name, probes, expected in manifest:
            f.write(f"{name}\n  probes  : {probes}\n  safe if : {expected}\n\n")
    print(f"\nwrote {len(manifest)} files + MANIFEST.txt to ./{args.outdir}/")
    print("Feed each through your import flow, then run ledger_invariants.sql "
          "and confirm nothing leaked into the ledger.")


if __name__ == "__main__":
    main()
