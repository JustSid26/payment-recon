# Payment Gateway Merchant Settlement & Ledger Platform — Design (Phase 0)

Scope: the money relationship between the gateway (Transactworld-style entity) and its
merchants. The bank/scheme settlement layer is out of scope; it appears only as the
`clearing` contra account.

## Documents

| Doc | Contents |
|---|---|
| [01-system-architecture.md](01-system-architecture.md) | Component view, data flow, tech stack |
| [02-ledger-model.md](02-ledger-model.md) | **The core.** Account model, per-event debit/credit legs, invariants, posting engine design |
| [03-database-schema.md](03-database-schema.md) | ER model, table-by-table notes, partitioning, search indexes |
| [ddl.sql](ddl.sql) | Full PostgreSQL DDL (reference; Alembic migrations are authoritative in Phase 1+) |
| [04-settlement-flow.md](04-settlement-flow.md) | Settlement generation, netting, negative-balance recovery, retry, reserve release |
| [05-state-machines.md](05-state-machines.md) | Payment, Refund, Settlement, Chargeback state machines |
| [06-backend-architecture.md](06-backend-architecture.md) | Folder structure, module boundaries, posting engine placement, jobs |
| [07-frontend-architecture.md](07-frontend-architecture.md) | Admin + merchant portals, shared packages |
| [08-security-architecture.md](08-security-architecture.md) | AuthN/Z, RBAC matrix, PII encryption, rate limiting, idempotency |
| [09-audit-architecture.md](09-audit-architecture.md) | Audit log design, capture points, immutability |
| [10-reporting-exports.md](10-reporting-exports.md) | Dashboards, reports, async export pipeline |
| [11-deployment-architecture.md](11-deployment-architecture.md) | Environments, containers, Postgres topology, archival |
| [12-open-decisions.md](12-open-decisions.md) | **Decisions needed before Phase 1** |

## Reference material driving this design

Real artifacts found in the repo root and reflected in the design:

- `Annex Canamoney - Corservices.docx` — merchant fee schedule: MDR 6.5% (Visa/MC),
  rolling reserve 10% / 6 months / capped at 250k, settlement cost 1%, €0.35 per
  approved transaction, €0.10 per **declined** transaction, €10 refund fee, €70
  chargeback fee.
- `Transactworld_US - 09th June to 11th June'26.xlsx` — the manual settlement workbook
  this platform replaces: gross → prior-period adjustment → released rolling reserve →
  1% settlement fee → amount to be settled; separate rolling-reserve balance sheet.
- `_Transactions-- *.csv` — upstream processor transaction reports (source-of-truth
  fields for the Transaction schema and the search requirements).
