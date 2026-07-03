# Transactworld Ledger — Demo Runbook

## Start everything (3 terminals, ~1 min)

```bash
# 1. Postgres (skip if container already running: docker start tw-pg)
docker run -d --name tw-pg -e POSTGRES_PASSWORD=tw -e POSTGRES_USER=tw \
  -e POSTGRES_DB=twledger -p 5455:5432 postgres:16-alpine

# 2. Backend API  (data is already imported; import is idempotent & re-runnable)
cd backend
./.venv/bin/python scripts/init_db.py        # no-op if schema exists
./.venv/bin/python scripts/import_data.py    # re-run safe: replays post nothing
./.venv/bin/uvicorn app.api:app --port 8000

# 3. Frontend
cd frontend && npm run dev                   # http://localhost:5173
```

Logins (chips on the login page):
- **Admin** — admin@transactworld.com / demo123
- **Merchant** — merchant@canamoney.com / demo123 (CANAMONEY EXCHANGE LTD.)

Tests: `cd backend && ./.venv/bin/python -m pytest tests/ -q` (9 ledger-invariant tests).

## What's loaded

All five `_Transactions--*.csv` processor reports **plus** the settlement workbook's
Paid&Error and Refund&Chargeback sheets: **47,318 transactions, 72 merchants,
6 currencies → 57,861 balanced ledger events / 142,134 entries.**

Fee schedules seeded from the client's own documents:
- Default (matches the Transactworld_US workbook): MDR 5%, $0.30/approved, $0 declined,
  $40 refund fee, rolling reserve 5% of net, settlement fee 1%.
- Canamoney merchants (per Annex 3): MDR 6.5%, €0.35/approved, **€0.10/declined**,
  €10 refund fee, rolling reserve 10%, settlement fee 1%.

## Suggested 10-minute demo script

1. **Login as admin → Dashboard.** Their real June data: volumes per currency, paid vs
   declined, daily chart, green "ledger integrity verified" banner.
2. **Integrity page.** Four live checks incl. "UPDATE rejected by database trigger" —
   the ledger is append-only and every event is provably balanced. This is the
   difference from a spreadsheet.
3. **Transactions.** Search anything (email, order id, last four). Open a captured
   Canamoney transaction → the ledger events cards: capture split into
   clearing / merchant payable / gateway revenue, plus the 10% reserve hold — each
   card footed "Balanced ✓ Σ = 0". Open a declined one → the €0.10 decline fee event.
4. **Merchants → CANAMONEY EXCHANGE LTD.** Balances per currency (payable, reserve,
   in-settlement), the annex fee schedule, the rolling-reserve statement
   (opening / held / released / closing — their "RR Calculation" sheet, automated).
5. **Settlements.** Open the completed EUR settlement: the statement card is their
   "Aggregate 1" sheet — gross → MDR → txn fees → decline fees → refunds → reserve →
   1% settlement fee → **net payout**, with the USDC conversion footer.
   Click *regenerate* for the same window → returns the same settlement (idempotent;
   double-settlement is impossible — DB-level unique link per ledger event).
6. **The money moment — Generate settlement for `Transactworld_US` (USD, window
   2026-06-09 → 2026-06-30).** It *refuses*: "net ≤ 0 — deficit carries to the next
   settlement." That book contains the workbook's 40 prior-period refunds with no new
   captures; the platform will never pay out a negative book and never forgets the
   deficit. This is the chargeback/claw-back behaviour from the design, running on
   their real data.
7. **Logout → login as merchant.** Same data, hard-scoped: only Canamoney's balances,
   transactions, settlements, reserve. Cross-merchant URLs return 404 (tested).

## What's demo-scope vs. the full design (docs/)

In: real double-entry ledger (all invariants enforced + tested), fee engine, reserve
holds, idempotent settlement generation/completion, deficit carry, both portals, RBAC
scoping (admin/merchant), live integrity checks.
Deferred (designed in /docs, not built yet): chargeback lifecycle UI, reserve release
scheduler, async CSV/Excel/PDF exports, audit-log browser, full RBAC matrix
(6 roles), table partitioning, Celery workers, maker–checker adjustments.
