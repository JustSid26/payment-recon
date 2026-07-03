# 03 — Database Schema

Full DDL in [ddl.sql](ddl.sql). This doc gives the ER view, the reasoning, and the
index plan. Conventions: every table has `BIGINT` surrogate PK (`id`) for joins +
a public `*_uuid UUID DEFAULT gen_random_uuid()` for APIs; all timestamps
`timestamptz` (UTC); money is `BIGINT` minor units + `CHAR(3)` currency; soft delete
(`deleted_at`) only on operational entities — **never** on ledger, ledger events,
posting idempotency, or audit log.

## ER overview

```
merchants ─┬─< merchant_users >── users ──< sessions(refresh tokens)
           │                       users ──< user_roles >── roles ──< role_permissions >── permissions
           ├─< fee_schedules ──< fee_schedule_items          tax_rules
           ├─< transactions ──< payments ──< refunds
           │                      payments ──< chargebacks
           ├─< adjustments        fees(applications) ──< fee_taxes
           ├─< settlements ──< settlement_items >── ledger_events
           ├─< reserve_holds (release schedule)
           └─< accounts ──1:1── account_balances
                  accounts ──< ledger_entries >── ledger_events ── posting_idempotency
audit_logs   webhook_logs   notifications   reports   export_jobs   idempotency_keys(API)
```

## Table groups

### Identity & access
- `users` — both admin staff and merchant users; `user_type` discriminates.
  PII columns (`email`, `phone`) encrypted at rest (08); `email_hash` for lookup.
- `merchant_users` — join of user↔merchant with per-merchant role; a user may belong
  to multiple merchants (agency case).
- `sessions` — server-side refresh tokens, stored **hashed**, with rotation chain
  (`replaced_by_id`), device/IP metadata, revocation.
- `roles`, `permissions`, `role_permissions`, `user_roles` — RBAC (08 has the matrix).
  Roles are seed data; permissions are code-defined strings (`settlements:generate`).

### Merchant & pricing
- `merchants` — legal entity data, status (`onboarding/active/suspended/terminated`),
  settlement config (cadence, `settle_after` delay days, min payout), `version` for
  optimistic locking.
- `fee_schedules` / `fee_schedule_items` — versioned pricing per merchant (mirrors the
  Canamoney annex): `fee_type` (`mdr`, `approved_txn`, `declined_txn`, `refund_fee`,
  `chargeback_fee`, `settlement_fee`, `platform_fee`, `convenience_fee`,
  `reserve`), optional `card_brand`/`payment_mode` qualifier, `rate_bps` and/or
  `fixed_minor + fixed_currency`, effective-dated (`effective_from/to`). Reserve items
  carry `hold_bps`, `hold_days`, `cap_minor`.
- `tax_rules` — effective-dated tax rates applied to fee types (D1).

### Ledger (the core — partitioned, append-only)
- `ledger_events` — the balanced group: `event_type`, `merchant_id` (nullable,
  denormalized for partition pruning/search), `currency`, `occurred_at`, `posted_at`
  (partition key), `reverses_event_id`, `settle_after`, `metadata JSONB`.
  **Range-partitioned monthly on `posted_at`.** PK `(id, posted_at)`.
- `ledger_entries` — legs: `event_id` + `event_posted_at` (composite FK to the
  partitioned parent), `account_id`, `direction`, `amount_minor > 0`,
  `balance_after_minor` (denormalized, statement rendering only), `posted_at`
  (partition key, same value as the event’s). Range-partitioned monthly.
- `posting_idempotency` — **unpartitioned**: `(source_type, source_id)` UNIQUE →
  `event_id`. Global uniqueness can’t live on the partitioned event table (a
  partitioned unique constraint must include the partition key), so the replay gate is
  this side table, inserted first in the posting transaction.
- `accounts` — chart of accounts; unique `(account_type, merchant_id, currency)`
  via a unique index with `COALESCE(merchant_id, zero-uuid)`.
- `account_balances` — 1:1 with accounts; `balance_minor`, `version`, `updated_at`.
  The `SELECT FOR UPDATE` target that serializes postings per account.

Append-only enforcement (both tables + audit_logs): `REVOKE UPDATE, DELETE` from the
application role, plus `BEFORE UPDATE OR DELETE` triggers on the partition roots that
`RAISE EXCEPTION`. Belt and braces; tested in Phase 1.

### Transaction domain
- `transactions` — order-level record, mirrors the processor CSV: `tracking_id`,
  `order_id`, `order_description`, customer fields (`customer_email_enc`,
  `customer_email_hash`, `customer_phone_enc`, `customer_phone_hash`, name),
  amounts rollup (authorized/captured/refunded/chargeback minor), `currency`, `status`
  rollup, MID/terminal, geo/BIN metadata in `JSONB`. **Range-partitioned monthly on
  `created_at`.**
- `payments` — processing attempt/operation with the Payment state machine (05):
  upstream `payment_id`, auth code, RRN/ARN, card fingerprint (`first_six`,
  `last_four`, brand, issuer), state, `authorized_at/captured_at/failed_at`,
  links to the capture/decline-fee ledger events.
- `refunds` — refund aggregate: amount, reason, state machine, upstream refund id,
  `ledger_event_id`.
- `chargebacks` — dispute lifecycle: reason code, scheme reference, amounts, state
  machine, `opened_event_id`, `resolved_event_id`, evidence deadline.
- `fees` — one row per fee application (fee_type, source ref, base amount, rate used,
  fee amount, entry reference) — the reporting spine for fee/tax reports;
  `fee_taxes` — tax lines per fee (rule, rate, amount).
- `adjustments` — manual adjustments: class (`goodwill`, `fee_waiver`,
  `funding_correction`), direction, amount, reason (required), maker/checker fields,
  `ledger_event_id`.

### Settlement & reserve
- `settlements` — aggregate per merchant/currency/window: state machine, counts and
  totals (derived at generation, stored for display — the linked events remain
  authoritative), fee amounts, payout reference, `attempt_count`, `version`.
- `settlement_items` — `(settlement_id, event_id)` with **`UNIQUE (event_id)`** — the
  hard guarantee that no ledger event is ever settled twice. Unpartitioned.
- `reserve_holds` — per hold: source event, amount, `release_due_at`, `released_at`,
  `release_event_id`; drives the release scheduler and the RR statement (mirrors the
  “RR Calculation” sheet).

### Platform
- `audit_logs` — who/what/when/IP/user-agent/before/after/reason (09). Monthly
  partitions, append-only.
- `webhook_logs` — raw inbound payloads, signature status, processing outcome, retry
  count. Monthly partitions.
- `idempotency_keys` — API-edge idempotency for client writes: key + user + endpoint +
  request hash + stored response; TTL-cleaned. (Distinct from `posting_idempotency`.)
- `notifications`, `reports` (saved definitions), `export_jobs` (state, params,
  object-store path, row count, expiry).

## Index plan (search + dashboards)

Search requirement: UUIDs, settlement/merchant/transaction/order ids, reference
numbers, customer, phone, email, date range, amount, status, currency.

- All `*_uuid` columns: unique B-tree.
- `transactions`: `(merchant_id, created_at DESC)` (the workhorse listing);
  `(merchant_id, status, created_at DESC)`; `(customer_email_hash)`,
  `(customer_phone_hash)` (exact search on encrypted PII via deterministic hash);
  `tracking_id`, `order_id`, `upstream payment_id` B-trees; `pg_trgm` GIN on
  `customer_name` and `order_description` for contains-search;
  `(merchant_id, currency, captured_amount_minor)` for amount-range filters.
- `ledger_events`: `(merchant_id, posted_at DESC)`, `(event_type, posted_at DESC)`;
  partial index on unsettled events `(merchant_id, currency, settle_after)
  WHERE ...` — settlement candidate selection hits only this.
- `ledger_entries`: `(account_id, posted_at DESC, id)` — statement rendering.
- `settlements`: `(merchant_id, window_end DESC)`, `(status)` partial for the
  scheduler.
- `settlement_items`: PK `(settlement_id, event_id)` + the UNIQUE on `event_id`.
- `audit_logs`: `(actor_user_id, created_at DESC)`, `(entity_type, entity_id,
  created_at DESC)`.

Partition pruning: every hot query on partitioned tables carries a `posted_at` /
`created_at` range predicate; API list endpoints default to a bounded date range.

## Partitioning & archival

- Monthly range partitions on `ledger_events`, `ledger_entries`, `transactions`,
  `audit_logs`, `webhook_logs`; managed by `pg_partman` (pre-create 3 ahead).
- Archival: partitions older than 24 months detached and dumped to object storage
  (Parquet) after a checksum reconciliation (Σ entries per account vs. a stored
  snapshot); balances are carried forward, so detached history is not needed for
  posting — only for statements/audit, served from the archive path. Exact retention
  windows: decision D13.
