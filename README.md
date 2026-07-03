# TransactWorld — Settlement & Ledger Platform

A merchant settlement and reconciliation platform for a card/online payment gateway.
Money arrives from acquiring banks and must be paid out to merchants — minus gateway
fees, with a rolling reserve withheld against chargebacks — on a settlement cadence.
This service does that on a **real append-only double-entry ledger**, so every figure
is provable and nothing can be paid twice or paid out of thin air.

> Runbook and demo script: **[`README-DEMO.md`](README-DEMO.md)**.
> Full Phase-0 design (13 architecture docs + production DDL): **[`docs/`](docs/)**.

---

## What it does

- **Ingests** processor CSV/xlsx reports into transactions and balanced ledger events
  (idempotent — re-running an import posts nothing new).
- **Books every event double-entry** on Postgres: capture splits into clearing /
  merchant-payable / gateway-revenue, plus a rolling-reserve hold; declines, refunds and
  fees each post their own balanced event.
- **Quarantines unknown merchants.** A merchant with no configured rate card is imported
  but its transactions carry **no ledger events** (never defaulted to a house MDR) until
  it is **onboarded** — assigning a fee schedule replays its held transactions into the
  ledger at the configured rate.
- **Settles automatically.** A business-day-aware cycle worker nets each merchant×currency,
  executes a payout, and releases rolling reserves once their hold elapses. Deficit books
  (net ≤ 0) refuse to pay out and carry.
- **Serves two portals** (admin + merchant) over a FastAPI JSON API, with RBAC scoping.

## Architecture

| Layer | Stack | Location |
|---|---|---|
| Ledger + services | Python / FastAPI, psycopg | [`backend/app/`](backend/app/) |
| Database | PostgreSQL (double-entry, DB-enforced invariants) | [`backend/schema.sql`](backend/schema.sql) |
| Portals | React + Vite | [`frontend/`](frontend/) |

Core modules: `ledger.py` (double-entry poster + invariants), `importer.py` (ingestion +
quarantine), `settle.py` / `cycle.py` (settlement + T+N cycle worker), `onboarding.py`
(assign schedule + replay), `money.py` (integer minor-unit math), `bizcal.py` (business-day
calendar), `api.py` (endpoints), `auth.py` (JWT auth + RBAC).

## Integrity guarantees

- **Append-only.** `UPDATE`/`DELETE` on ledger entries are rejected by database triggers.
- **Every event sums to zero**, enforced both in code (`_validate`) and by a deferred DB
  constraint — an unbalanced event can never commit.
- **Idempotent** posting and settlement: replays post nothing; double-settlement is blocked
  by a unique event→settlement link.
- **Integer money only** — minor units and basis points, banker's rounding, no floats.

## Security & robustness hardening

This codebase was put through an adversarial review; the double-entry core held, and the
surrounding logic was hardened (see the fix commits):

- Transaction dates parsed correctly (ISO), undateable rows skipped rather than stamped with
  import time.
- Fee schedules validated (no negative/out-of-range rates); merchant onboarding is atomic
  (activation + ledger replay in one transaction, so a failed onboard never strands a
  merchant "active" with no events); a capture smaller than its fees clamps to zero instead
  of crashing.
- Per-merchant payment-id idempotency (a shared processor id across merchants is no longer
  silently dropped).
- Import is poison-row tolerant (bad currency / overflow / negative amounts are skipped, not
  fatal to the batch).
- JWT signing has no hardcoded fallback secret; the settlement cycle clamps a future cutoff
  so rolling reserves can't be released early.

## Running it

See **[`README-DEMO.md`](README-DEMO.md)**. In short: Postgres (Docker), then from `backend/`
`python scripts/init_db.py` → `python scripts/import_data.py` → `uvicorn app.api:app`, and
`npm run dev` in `frontend/`.

```bash
cd backend && ./.venv/bin/python -m pytest tests/ -q   # ledger invariants + quarantine + cycle + hardening
```

## Repository layout

```
backend/
  app/        ledger, importer, settle, cycle, onboarding, money, bizcal, api, auth
  scripts/    init_db, import_data, run_cycle, onboard_merchant
  tests/      invariants, quarantine, cycle, hardening
  schema.sql
frontend/     React admin + merchant portals
docs/         Phase-0 architecture (13 docs) + production DDL
files/        adversarial QA harness (ledger-invariant SQL + attack-input generator)
```

## Notes

Demo/reference project. Raw transaction data is **not** committed (it contains cardholder
PII); the importer reads it from local files. Auth ships two demo accounts; set
`TW_JWT_SECRET` for any real deployment.
