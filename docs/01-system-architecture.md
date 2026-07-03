# 01 — System Architecture

## Components

```
                        ┌─────────────────────────────────────────────┐
                        │                 Upstream                    │
                        │  Processor webhooks / report ingestion      │
                        │  (captures, declines, refunds, chargebacks) │
                        └───────────────┬─────────────────────────────┘
                                        │ signed webhooks / CSV import
                                        ▼
┌──────────────┐   HTTPS   ┌────────────────────────┐        ┌──────────────────┐
│ Admin Portal │──────────▶│      FastAPI API        │◀──────▶│  PostgreSQL 16   │
│ (React/Vite) │           │  /api/v1/...            │        │  (single primary │
├──────────────┤           │  ┌───────────────────┐  │        │   + read replica)│
│ Merchant     │──────────▶│  │  Domain services  │  │        │                  │
│ Portal       │           │  │  ───────────────  │  │        │  - ledger (part.)│
│ (React/Vite) │           │  │  POSTING ENGINE   │──┼───────▶│  - balances      │
└──────────────┘           │  │  (only writer to  │  │  ACID  │  - aggregates    │
                           │  │   the ledger)     │  │  txns  │  - audit (part.) │
                           │  └───────────────────┘  │        └──────────────────┘
                           └───────┬─────────────────┘
                                   │ enqueue                    ┌──────────────┐
                                   ▼                            │ Object store │
                           ┌──────────────┐    ┌─────────────┐  │ (S3/minio)   │
                           │    Redis     │───▶│Celery workers│─▶│ export files │
                           │ queue + rate │    │ settlements, │  └──────────────┘
                           │ limit + cache│    │ exports,     │
                           └──────────────┘    │ reserve rel.,│
                                               │ notifications│
                                               └─────────────┘
```

## Key architectural rules

1. **The ledger is the single source of truth.** Balances, settlement figures,
   dashboards and reports are all derived from `ledger_events`/`ledger_entries`.
   Aggregates (payments, refunds, settlements, chargebacks) hold *state*, never
   authoritative *amounts owed*.
2. **One writer.** Every financial event flows through the posting engine
   (`app/ledger/posting.py`). No other module inserts ledger rows. HTTP handlers and
   Celery tasks call domain services; domain services call the posting engine.
3. **Everything financial is transactional.** A financial event = one DB transaction
   containing: aggregate state transition + ledger event + entries + balance updates +
   idempotency record + audit row. It commits or none of it does.
4. **Async only for throughput, never for correctness.** Settlement generation and
   exports run on Celery, but the postings they perform use the same engine and the
   same transactional guarantees. A crashed worker leaves no half-posted event.
5. **Reads scale separately.** Dashboards/reports/exports read from a replica;
   anything that feeds a *posting decision* (e.g. settlement candidate selection)
   reads from the primary inside the posting transaction.

## Event ingestion

Two ingestion paths, both terminating at the same domain services:

- **Webhooks** (`webhook_logs` first, then process): payload stored verbatim, then a
  worker maps it to a domain command (capture, decline, refund update, chargeback).
  Replays are harmless — posting idempotency is keyed on the upstream event id.
- **Report/CSV import** (matches the `_Transactions-- *.csv` files): batch importer
  with the same idempotency keys (upstream Payment ID + operation type), used for
  backfill and reconciliation against webhook-driven state.

## Stack (per requirements)

- PostgreSQL 16 (partitioning, `SELECT FOR UPDATE`, `JSONB`, `BIGINT` minor units, pg_trgm)
- Python 3.12, FastAPI, SQLAlchemy 2.x (typed, async for reads / sync sessions for
  posting transactions — see 06), Alembic
- Celery + Redis (queues: `settlements`, `exports`, `notifications`, `ingestion`)
- React 18 + TypeScript + Vite; TanStack Query + Router; two portal apps in a monorepo
- JWT access (15 min) + rotating refresh tokens (server-side, revocable); RBAC per 08
