# 06 — Backend Architecture & Folder Structure

Python 3.12 · FastAPI · SQLAlchemy 2.x (typed) · Alembic · Celery/Redis · pytest.

## Monorepo layout

```
transact-world/
├── docs/                          # this design
├── backend/
│   ├── pyproject.toml             # uv/poetry; ruff + mypy strict on money/ledger
│   ├── alembic/                   #   migrations (authoritative schema)
│   ├── app/
│   │   ├── main.py                # FastAPI app factory, middleware stack
│   │   ├── config.py              # pydantic-settings; env-driven
│   │   ├── db/
│   │   │   ├── engine.py          # sync engine (posting path) + async engine (reads)
│   │   │   ├── base.py            # DeclarativeBase, naming conventions
│   │   │   └── partitions.py      # pg_partman helpers / test bootstrap
│   │   ├── money/                 # ← ALL money math lives here
│   │   │   ├── money.py           # Money value type (minor units + currency)
│   │   │   ├── currencies.py      # ISO 4217 exponents
│   │   │   └── fees.py            # bps math, single rounding policy, tax calc
│   │   ├── ledger/                # ← THE CORE (Phase 1)
│   │   │   ├── models.py          # accounts, balances, events, entries, idempotency
│   │   │   ├── accounts.py        # chart-of-accounts resolution / auto-provisioning
│   │   │   ├── posting.py         # post_event() — the only ledger writer
│   │   │   ├── legs.py            # leg builders per event type (02 §3, typed)
│   │   │   └── queries.py         # balances, statements, unsettled-events queries
│   │   ├── domain/
│   │   │   ├── statemachine.py    # guarded transition engine (05)
│   │   │   ├── payments/          # service + models + state machine bindings
│   │   │   ├── refunds/
│   │   │   ├── chargebacks/
│   │   │   ├── settlements/       # generation algorithm (04 §2), lifecycle
│   │   │   ├── reserves/
│   │   │   ├── adjustments/       # maker-checker
│   │   │   ├── merchants/
│   │   │   └── pricing/           # fee schedule resolution (effective-dated)
│   │   ├── api/
│   │   │   ├── deps.py            # auth, RBAC, merchant scoping, pagination
│   │   │   ├── errors.py          # consistent error envelope + exception handlers
│   │   │   ├── idempotency.py     # Idempotency-Key middleware for writes
│   │   │   └── v1/                # routers: auth, merchants, transactions,
│   │   │                          #   payments, refunds, settlements, chargebacks,
│   │   │                          #   adjustments, ledger, fees, reports, exports,
│   │   │                          #   users, audit, webhooks
│   │   ├── auth/                  # JWT issue/verify, refresh rotation, RBAC core
│   │   ├── audit/                 # audit writer (called by services & transitions)
│   │   ├── ingestion/             # webhook handlers + CSV report importer
│   │   ├── jobs/                  # Celery app + tasks:
│   │   │                          #   settlements.generate, reserves.release,
│   │   │                          #   exports.run, payments.expire_auths,
│   │   │                          #   notifications.send
│   │   ├── exports/               # streaming CSV/XLSX/PDF writers → object store
│   │   └── security/              # PII crypto (enc/hash), rate limiting
│   └── tests/
│       ├── ledger/                # invariant suite (Phase 1 gate)
│       ├── domain/                # per-event posting + state machine tests
│       ├── api/
│       └── conftest.py            # per-test PG schema/db, factories
├── frontend/                      # see 07
│   ├── apps/admin/
│   ├── apps/merchant/
│   └── packages/{ui,api-client,shared}/
├── docker-compose.yml             # pg16, redis, minio, api, workers, portals
└── Makefile                       # dev, test, lint, migrate
```

## Rules of the module graph

- `money/` depends on nothing. `ledger/` depends only on `money/` + `db/`.
- `domain/*` orchestrates aggregates and calls `ledger.posting.post_event` — it never
  touches ledger tables directly.
- `api/` calls `domain/` services; it contains zero business or money logic.
- `jobs/` tasks are thin wrappers over the same `domain/` services (identical code
  path for scheduled vs. manual settlement generation).
- Anything importing `ledger/models` outside `ledger/` fails an import-linter contract
  in CI.

## Transactions & sessions

- **Posting path (correctness-critical): synchronous SQLAlchemy sessions** on the
  primary. `SELECT FOR UPDATE` + short transactions; per-account serialization means
  worker concurrency scales across merchants, not within one.
- **Read path: async sessions**, replica-aware, for list endpoints/dashboards/reports.
- Unit of work: services open the transaction; posting engine and audit writer join
  it (never commit). One HTTP request / task = at most one write transaction.

## Error envelope (all endpoints)

```json
{ "error": { "code": "settlement_conflict", "message": "…", "details": [ … ],
             "request_id": "…" } }
```

Validation → 422 with field details; RBAC → 403; scoping miss → 404 (no existence
leaks across merchants); state-machine violation → 409; idempotency replay with a
different body → 422 `idempotency_key_reuse`; optimistic-lock (version mismatch) →
409 `stale_version`.

## Testing strategy (gates per phase)

- Phase 1 gate: the ledger invariant suite (02 §4) green, including the concurrency
  test (threads × postings against one account) and append-only rejection tests run
  against a real Postgres (testcontainers), not SQLite.
- Property-based tests (hypothesis) for leg builders: any fee schedule × amount →
  balanced events, non-negative fees, rounding stable.
- Every state machine: full transition matrix test (valid edges succeed, all others
  raise).
- API tests: RBAC matrix and merchant row-scoping (merchant A token must 404 on
  merchant B resources) — enforced by fixtures that create two merchants by default.
