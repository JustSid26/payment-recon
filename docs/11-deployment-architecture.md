# 11 — Deployment Architecture

## Topology (prod)

```
            ┌────────────┐        ┌─────────────────────────────┐
 users ────▶│  CDN / WAF │───────▶│ nginx / ingress             │
            └────────────┘        │  admin.* (IP-allowlist)     │
                                  │  portal.*  api.*            │
                                  └──────┬──────────────────────┘
                                         ▼
                        ┌────────────────────────────┐
                        │ api (FastAPI, N replicas,  │
                        │ stateless, health-checked) │
                        └───┬────────────────────┬───┘
                            ▼                    ▼
                  ┌──────────────────┐   ┌──────────────┐
                  │ PostgreSQL 16    │   │ Redis        │
                  │ primary + sync   │   │ (queue, rate │
                  │ standby (HA) +   │   │  limit)      │
                  │ read replica     │   └──────┬───────┘
                  │ PgBouncer (txn   │          ▼
                  │ pooling; posting │   ┌──────────────────────┐
                  │ path = session   │   │ celery workers       │
                  │ pool)            │   │  q: settlements(x2)  │
                  └──────────────────┘   │  q: exports(x2)      │
                  ┌──────────────────┐   │  q: ingestion(x4)    │
                  │ Object store S3  │◀──│  q: notifications    │
                  │ (exports+archive)│   │ + beat (scheduler)   │
                  └──────────────────┘   └──────────────────────┘
```

- Everything containerized; deployable on ECS/EKS/Fly/compose-on-VM — no cloud-locked
  services beyond Postgres/Redis/S3-compatible store.
- Portals: static builds on CDN; admin origin IP-restricted.
- Scheduler: Celery beat (settlement cadence ticks, reserve releases, auth expiry,
  export expiry, partition maintenance) — beat is single-instance; every task is
  idempotent (posting idempotency), so a duplicate tick is harmless.

## Environments & pipeline

`dev` (docker-compose: pg16, redis, minio, api, workers, both portals, seed data) →
`staging` (prod-shaped, masked data) → `prod`. CI: ruff + mypy + import-linter →
unit/property tests → integration tests against real Postgres (testcontainers) →
migration check (alembic upgrade+downgrade on a scratch DB) → build/push images.
Deploys run `alembic upgrade` as a pre-deploy job; migrations are always
backward-compatible one release back (expand→migrate→contract) for zero-downtime.

## Postgres operations

- HA: streaming replication + automatic failover (Patroni or managed equivalent);
  `synchronous_commit = on` for the posting path.
- Backups: nightly base + WAL archiving (PITR); **restore drill** quarterly; a ledger
  reconciliation job (Σ entries vs `account_balances`, per 02 §4.2) runs nightly and
  after every restore.
- Partitions: pg_partman keeps 3 future monthly partitions on
  ledger_events/entries, transactions, audit_logs, webhook_logs.
- **Archival**: partitions > 24 months → checksum reconciliation → dump to Parquet in
  object storage → detach + drop. Balances carry forward, so posting never needs
  archived rows; statements/audit older than the window are served from archive via
  the export pipeline. (Retention windows: D13.)

## Observability

- Structured JSON logs (request_id propagated API → jobs → audit), PII-redacting
  serializers.
- Metrics (Prometheus/OTel): posting latency, postings/s, settlement run duration &
  failures, queue depth, export durations, DB lock waits, replica lag.
- Alerts: **ledger reconciliation mismatch (page immediately)**, settlement run
  failure, negative `clearing` anomalies, webhook backlog, failed-login spikes,
  replica lag > threshold.
- Sentry (or equiv.) for exceptions, release-tagged.
