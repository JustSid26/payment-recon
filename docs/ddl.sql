-- ============================================================================
-- Payment Gateway Merchant Settlement & Ledger Platform — Reference DDL
-- PostgreSQL 16. Alembic migrations (Phase 1+) are authoritative; this file is
-- the reviewed design. All timestamps timestamptz (UTC). Money: BIGINT minor
-- units + CHAR(3) ISO 4217. No FLOAT/REAL anywhere in the money path.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid, pgp_sym for PII
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- contains-search on names/descriptions

-- ---------------------------------------------------------------------------
-- Roles: the app connects as app_rw, which has NO update/delete on the ledger.
-- ---------------------------------------------------------------------------
-- CREATE ROLE app_rw LOGIN;
-- CREATE ROLE app_readonly LOGIN;   -- replica / reporting connections

-- ============================================================================
-- ENUM types (Alembic will manage as native enums; transitions enforced in code)
-- ============================================================================
CREATE TYPE account_type AS ENUM (
  'clearing', 'merchant_payable', 'merchant_reserve', 'settlement_payable',
  'chargeback_suspense', 'gateway_revenue', 'tax_payable');

CREATE TYPE entry_direction AS ENUM ('debit', 'credit');

CREATE TYPE ledger_event_type AS ENUM (
  'payment_captured', 'decline_fee', 'refund', 'standalone_fee',
  'reserve_hold', 'reserve_release',
  'settlement_generated', 'settlement_completed', 'settlement_failed',
  'settlement_retry', 'manual_adjustment',
  'chargeback_opened', 'chargeback_won', 'chargeback_lost', 'reversal');

CREATE TYPE payment_state AS ENUM (
  'initiated', 'authorized', 'captured', 'auth_failed', 'voided', 'expired');

CREATE TYPE refund_state AS ENUM (
  'requested', 'processing', 'completed', 'failed');

CREATE TYPE settlement_state AS ENUM (
  'draft', 'generated', 'processing', 'completed', 'failed', 'retry_scheduled',
  'cancelled');

CREATE TYPE chargeback_state AS ENUM (
  'opened', 'evidence_submitted', 'under_review', 'won', 'lost', 'accepted');

CREATE TYPE fee_type AS ENUM (
  'mdr', 'approved_txn', 'declined_txn', 'refund_fee', 'chargeback_fee',
  'settlement_fee', 'platform_fee', 'convenience_fee');

-- ============================================================================
-- Identity & access
-- ============================================================================
CREATE TABLE users (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_uuid        UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  user_type        TEXT NOT NULL CHECK (user_type IN ('admin', 'merchant')),
  email_enc        BYTEA NOT NULL,          -- encrypted at rest
  email_hash       BYTEA NOT NULL UNIQUE,   -- HMAC-SHA256 for lookup/login
  phone_enc        BYTEA,
  phone_hash       BYTEA,
  full_name        TEXT NOT NULL,
  password_hash    TEXT NOT NULL,           -- argon2id
  mfa_secret_enc   BYTEA,
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('invited', 'active', 'locked', 'disabled')),
  failed_logins    INT NOT NULL DEFAULT 0,
  last_login_at    TIMESTAMPTZ,
  version          INT NOT NULL DEFAULT 1,   -- optimistic locking
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);

CREATE TABLE roles (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_uuid   UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  name        TEXT NOT NULL UNIQUE,   -- super_admin, finance, operations, support,
                                      -- merchant_admin, merchant_readonly
  scope       TEXT NOT NULL CHECK (scope IN ('admin', 'merchant')),
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE permissions (
  id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE          -- e.g. 'settlements:generate'
);

CREATE TABLE role_permissions (
  role_id       BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id  BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_uuid       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  user_id            BIGINT NOT NULL REFERENCES users(id),
  refresh_token_hash BYTEA NOT NULL UNIQUE,        -- SHA-256; raw token never stored
  replaced_by_id     BIGINT REFERENCES sessions(id),
  ip                 INET,
  user_agent         TEXT,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_sessions_user ON sessions (user_id, created_at DESC);

-- ============================================================================
-- Merchants & pricing
-- ============================================================================
CREATE TABLE merchants (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_uuid         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  legal_name            TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  registration_number   TEXT,
  country               CHAR(2) NOT NULL,
  status                TEXT NOT NULL DEFAULT 'onboarding'
                          CHECK (status IN ('onboarding','active','suspended','terminated')),
  -- settlement configuration
  settlement_cadence    TEXT NOT NULL DEFAULT 'weekly'
                          CHECK (settlement_cadence IN ('daily','weekly','biweekly','monthly','manual')),
  settle_after_days     INT NOT NULL DEFAULT 2,          -- T+n hold before settleable
  min_payout_minor      BIGINT NOT NULL DEFAULT 0,
  payout_currency       CHAR(3),                          -- D2: processing ccy vs USDC
  contact_email_enc     BYTEA,
  metadata              JSONB NOT NULL DEFAULT '{}',
  version               INT NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);

CREATE TABLE merchant_users (
  merchant_id BIGINT NOT NULL REFERENCES merchants(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  role_id     BIGINT NOT NULL REFERENCES roles(id),   -- merchant-scoped role
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, user_id)
);

CREATE TABLE fee_schedules (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fee_uuid       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  merchant_id    BIGINT NOT NULL REFERENCES merchants(id),
  name           TEXT NOT NULL,                        -- e.g. 'Annex 3 — Corservices'
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to   TIMESTAMPTZ,                          -- NULL = open-ended
  created_by     BIGINT NOT NULL REFERENCES users(id),
  version        INT NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_fee_schedules_merchant
  ON fee_schedules (merchant_id, effective_from DESC);

CREATE TABLE fee_schedule_items (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fee_schedule_id BIGINT NOT NULL REFERENCES fee_schedules(id) ON DELETE CASCADE,
  fee_type        fee_type NOT NULL,
  card_brand      TEXT,                 -- 'visa','mastercard', NULL = any
  payment_mode    TEXT,                 -- 'CC','APM', NULL = any
  currency        CHAR(3),              -- NULL = any processing currency
  rate_bps        INT CHECK (rate_bps >= 0),          -- e.g. MDR 6.5% = 650
  fixed_minor     BIGINT CHECK (fixed_minor >= 0),    -- e.g. refund fee 1000 = €10.00
  fixed_currency  CHAR(3),
  -- reserve-specific (fee_type is not used for reserve; kept on schedule for cohesion)
  reserve_hold_bps  INT,
  reserve_hold_days INT,
  reserve_cap_minor BIGINT,
  CHECK (rate_bps IS NOT NULL OR fixed_minor IS NOT NULL OR reserve_hold_bps IS NOT NULL)
);

CREATE TABLE tax_rules (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           TEXT NOT NULL,           -- 'GST 18%', 'VAT 19%', 'none'
  jurisdiction   TEXT NOT NULL,
  applies_to     fee_type[] NOT NULL,
  rate_bps       INT NOT NULL CHECK (rate_bps >= 0),
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to   TIMESTAMPTZ
);

-- ============================================================================
-- LEDGER — append-only core
-- ============================================================================
CREATE TABLE accounts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_uuid UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  account_type account_type NOT NULL,
  merchant_id  BIGINT REFERENCES merchants(id),   -- NULL for gateway-level accounts
  currency     CHAR(3) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((account_type IN ('merchant_payable','merchant_reserve','settlement_payable'))
         = (merchant_id IS NOT NULL))
);
CREATE UNIQUE INDEX ux_accounts_identity
  ON accounts (account_type, COALESCE(merchant_id, 0), currency);

CREATE TABLE account_balances (
  account_id    BIGINT PRIMARY KEY REFERENCES accounts(id),
  balance_minor BIGINT NOT NULL DEFAULT 0,   -- signed by natural side (02 §1)
  version       BIGINT NOT NULL DEFAULT 0,   -- bumped every posting; sanity checks
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Balanced event group. Monthly range partitions on posted_at.
CREATE TABLE ledger_events (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY,
  event_uuid         UUID NOT NULL DEFAULT gen_random_uuid(),
  event_type         ledger_event_type NOT NULL,
  merchant_id        BIGINT,                    -- denormalized; NULL for gateway-only
  currency           CHAR(3) NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL,      -- source event time
  posted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),   -- partition key
  settle_after       TIMESTAMPTZ,               -- when payable delta becomes settleable
  reverses_event_id  BIGINT,                    -- reversal linkage (02 §3 #19)
  metadata           JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, posted_at)
) PARTITION BY RANGE (posted_at);
CREATE UNIQUE INDEX ux_ledger_events_uuid ON ledger_events (event_uuid, posted_at);
CREATE INDEX ix_ledger_events_merchant ON ledger_events (merchant_id, posted_at DESC);
CREATE INDEX ix_ledger_events_type     ON ledger_events (event_type, posted_at DESC);
-- Settlement candidate scan: unsettled linkage is via settlement_items anti-join;
-- this index narrows by merchant/currency/settleability first.
CREATE INDEX ix_ledger_events_settleable
  ON ledger_events (merchant_id, currency, settle_after)
  WHERE merchant_id IS NOT NULL AND settle_after IS NOT NULL;
-- An event is reversed at most once:
CREATE UNIQUE INDEX ux_ledger_events_reversal
  ON ledger_events (reverses_event_id, posted_at) WHERE reverses_event_id IS NOT NULL;
  -- NOTE: partition key forced into the index; true global once-only enforcement
  -- is done in the posting engine under the idempotency row (source_type='reversal',
  -- source_id=<original event id>) — which IS globally unique.

-- Entry legs. Same partition scheme; event FK carries the partition key.
CREATE TABLE ledger_entries (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY,
  entry_uuid          UUID NOT NULL DEFAULT gen_random_uuid(),
  event_id            BIGINT NOT NULL,
  account_id          BIGINT NOT NULL REFERENCES accounts(id),
  direction           entry_direction NOT NULL,
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  currency            CHAR(3) NOT NULL,
  balance_after_minor BIGINT NOT NULL,   -- statement rendering ONLY (02 §4.8)
  posted_at           TIMESTAMPTZ NOT NULL,   -- = event posted_at
  PRIMARY KEY (id, posted_at),
  FOREIGN KEY (event_id, posted_at) REFERENCES ledger_events (id, posted_at)
) PARTITION BY RANGE (posted_at);
CREATE UNIQUE INDEX ux_ledger_entries_uuid ON ledger_entries (entry_uuid, posted_at);
CREATE INDEX ix_ledger_entries_account ON ledger_entries (account_id, posted_at DESC, id);
CREATE INDEX ix_ledger_entries_event   ON ledger_entries (event_id, posted_at);

-- Replay gate. Unpartitioned so (source_type, source_id) is globally unique.
CREATE TABLE posting_idempotency (
  source_type TEXT NOT NULL,     -- 'capture','webhook','settlement_run','refund',...
  source_id   TEXT NOT NULL,     -- upstream id / settlement_id:attempt / etc.
  event_id    BIGINT NOT NULL,
  posted_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_type, source_id)
);

-- Append-only enforcement: no UPDATE/DELETE for the app role, plus triggers.
REVOKE UPDATE, DELETE ON ledger_events, ledger_entries, posting_idempotency FROM app_rw;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER trg_ledger_events_immutable
  BEFORE UPDATE OR DELETE ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Deferred zero-sum check per event (belt & braces; engine validates first).
CREATE FUNCTION assert_event_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad BIGINT;
BEGIN
  SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount_minor
                                     ELSE -amount_minor END), 0)
    INTO bad
    FROM ledger_entries
   WHERE event_id = NEW.event_id AND posted_at = NEW.posted_at;
  IF bad <> 0 THEN
    RAISE EXCEPTION 'event % unbalanced by %', NEW.event_id, bad;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_event_balanced();

-- ============================================================================
-- Transaction domain
-- ============================================================================
CREATE TABLE transactions (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY,
  transaction_uuid    UUID NOT NULL DEFAULT gen_random_uuid(),
  merchant_id         BIGINT NOT NULL,
  tracking_id         TEXT,                -- processor tracking id
  order_id            TEXT,                -- merchant order id
  order_description   TEXT,
  customer_ref        TEXT,                -- upstream customer id
  customer_name       TEXT,
  customer_email_enc  BYTEA,
  customer_email_hash BYTEA,
  customer_phone_enc  BYTEA,
  customer_phone_hash BYTEA,
  currency            CHAR(3) NOT NULL,
  authorized_minor    BIGINT NOT NULL DEFAULT 0,
  captured_minor      BIGINT NOT NULL DEFAULT 0,
  refunded_minor      BIGINT NOT NULL DEFAULT 0,
  chargeback_minor    BIGINT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL,        -- rollup: derived from payments/refunds
  mid                 TEXT,
  terminal_id         TEXT,
  geo                 JSONB NOT NULL DEFAULT '{}',   -- ISO country, IPs, bin data
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),   -- partition key
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  version             INT NOT NULL DEFAULT 1,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE UNIQUE INDEX ux_transactions_uuid ON transactions (transaction_uuid, created_at);
CREATE INDEX ix_txn_merchant_time  ON transactions (merchant_id, created_at DESC);
CREATE INDEX ix_txn_merchant_state ON transactions (merchant_id, status, created_at DESC);
CREATE INDEX ix_txn_tracking ON transactions (tracking_id);
CREATE INDEX ix_txn_order    ON transactions (order_id);
CREATE INDEX ix_txn_email    ON transactions (customer_email_hash);
CREATE INDEX ix_txn_phone    ON transactions (customer_phone_hash);
CREATE INDEX ix_txn_amount   ON transactions (merchant_id, currency, captured_minor);
CREATE INDEX gx_txn_custname ON transactions USING gin (customer_name gin_trgm_ops);

CREATE TABLE payments (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_uuid         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  transaction_id       BIGINT NOT NULL,
  transaction_created_at TIMESTAMPTZ NOT NULL,
  merchant_id          BIGINT NOT NULL,
  upstream_payment_id  TEXT UNIQUE,          -- processor Payment ID
  state                payment_state NOT NULL DEFAULT 'initiated',
  currency             CHAR(3) NOT NULL,
  amount_minor         BIGINT NOT NULL CHECK (amount_minor > 0),
  payment_mode         TEXT,                 -- CC / APM
  card_brand           TEXT,                 -- visa / mastercard
  first_six            TEXT,
  last_four            TEXT,
  issuing_bank         TEXT,
  auth_code            TEXT,
  rrn                  TEXT,
  arn                  TEXT,
  authorized_at        TIMESTAMPTZ,
  captured_at          TIMESTAMPTZ,
  failed_at            TIMESTAMPTZ,
  failure_reason       TEXT,
  capture_event_id     BIGINT,               -- → ledger_events (soft ref, see note)
  decline_fee_event_id BIGINT,
  version              INT NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (transaction_id, transaction_created_at)
    REFERENCES transactions (id, created_at)
);
-- NOTE: ledger_event refs from aggregates are (event_id, event_posted_at) pairs in
-- Alembic (composite FK to the partitioned parent); abbreviated here for readability.
CREATE INDEX ix_payments_txn      ON payments (transaction_id);
CREATE INDEX ix_payments_merchant ON payments (merchant_id, created_at DESC);
CREATE INDEX ix_payments_rrn ON payments (rrn);
CREATE INDEX ix_payments_arn ON payments (arn);

CREATE TABLE refunds (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_uuid         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  payment_id          BIGINT NOT NULL REFERENCES payments(id),
  merchant_id         BIGINT NOT NULL,
  upstream_refund_id  TEXT UNIQUE,
  state               refund_state NOT NULL DEFAULT 'requested',
  currency            CHAR(3) NOT NULL,
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  reason              TEXT NOT NULL DEFAULT '',
  requested_by        BIGINT REFERENCES users(id),   -- NULL if upstream-initiated
  ledger_event_id     BIGINT,
  failure_reason      TEXT,
  version             INT NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_refunds_payment  ON refunds (payment_id);
CREATE INDEX ix_refunds_merchant ON refunds (merchant_id, created_at DESC);

CREATE TABLE chargebacks (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chargeback_uuid     UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  payment_id          BIGINT NOT NULL REFERENCES payments(id),
  merchant_id         BIGINT NOT NULL,
  scheme_reference    TEXT UNIQUE,            -- case / ARN reference
  reason_code         TEXT NOT NULL,
  state               chargeback_state NOT NULL DEFAULT 'opened',
  currency            CHAR(3) NOT NULL,
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  evidence_due_at     TIMESTAMPTZ,
  opened_event_id     BIGINT,                 -- claw-back posting
  fee_event_id        BIGINT,
  resolved_event_id   BIGINT,                 -- won-reversal or lost posting
  resolved_at         TIMESTAMPTZ,
  version             INT NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_cb_merchant ON chargebacks (merchant_id, created_at DESC);
CREATE INDEX ix_cb_payment  ON chargebacks (payment_id);

-- Fee applications: reporting spine (every fee leg has a row here).
CREATE TABLE fees (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fee_uuid         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  merchant_id      BIGINT NOT NULL,
  fee_type         fee_type NOT NULL,
  source_type      TEXT NOT NULL,       -- payment / refund / chargeback / settlement
  source_id        BIGINT NOT NULL,
  fee_schedule_item_id BIGINT REFERENCES fee_schedule_items(id),
  currency         CHAR(3) NOT NULL,
  base_minor       BIGINT NOT NULL,     -- amount the rate applied to
  rate_bps_used    INT,
  fixed_minor_used BIGINT,
  fee_minor        BIGINT NOT NULL,
  ledger_event_id  BIGINT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_fees_merchant ON fees (merchant_id, created_at DESC);
CREATE INDEX ix_fees_type     ON fees (fee_type, created_at DESC);

CREATE TABLE fee_taxes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fee_id       BIGINT NOT NULL REFERENCES fees(id),
  tax_rule_id  BIGINT NOT NULL REFERENCES tax_rules(id),
  rate_bps     INT NOT NULL,
  tax_minor    BIGINT NOT NULL,
  currency     CHAR(3) NOT NULL
);

CREATE TABLE adjustments (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  adjustment_uuid  UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  merchant_id      BIGINT NOT NULL,
  class            TEXT NOT NULL
                     CHECK (class IN ('goodwill','fee_waiver','funding_correction')),
  direction        TEXT NOT NULL CHECK (direction IN ('credit_merchant','debit_merchant')),
  currency         CHAR(3) NOT NULL,
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  reason           TEXT NOT NULL CHECK (length(reason) >= 10),
  status           TEXT NOT NULL DEFAULT 'pending_approval'
                     CHECK (status IN ('pending_approval','approved','rejected','posted')),
  created_by       BIGINT NOT NULL REFERENCES users(id),   -- maker
  approved_by      BIGINT REFERENCES users(id),            -- checker (≠ maker)
  ledger_event_id  BIGINT,
  version          INT NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE INDEX ix_adjustments_merchant ON adjustments (merchant_id, created_at DESC);

-- ============================================================================
-- Settlements & reserve
-- ============================================================================
CREATE TABLE settlements (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_uuid    UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  merchant_id        BIGINT NOT NULL REFERENCES merchants(id),
  currency           CHAR(3) NOT NULL,
  window_start       TIMESTAMPTZ NOT NULL,
  window_end         TIMESTAMPTZ NOT NULL,
  state              settlement_state NOT NULL DEFAULT 'draft',
  -- display totals, derived at generation; settlement_items remain authoritative
  gross_minor        BIGINT NOT NULL DEFAULT 0,
  fees_minor         BIGINT NOT NULL DEFAULT 0,
  taxes_minor        BIGINT NOT NULL DEFAULT 0,
  refunds_minor      BIGINT NOT NULL DEFAULT 0,
  chargebacks_minor  BIGINT NOT NULL DEFAULT 0,
  reserve_held_minor BIGINT NOT NULL DEFAULT 0,
  reserve_released_minor BIGINT NOT NULL DEFAULT 0,
  adjustments_minor  BIGINT NOT NULL DEFAULT 0,
  settlement_fee_minor BIGINT NOT NULL DEFAULT 0,
  net_payout_minor   BIGINT NOT NULL DEFAULT 0,
  payout_reference   TEXT,               -- external payout id (bank layer OOS)
  generated_event_id BIGINT,
  completed_event_id BIGINT,
  attempt_count      INT NOT NULL DEFAULT 0,
  failure_reason     TEXT,
  generated_by       BIGINT REFERENCES users(id),   -- NULL = scheduler
  version            INT NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_settlements_merchant ON settlements (merchant_id, window_end DESC);
CREATE INDEX ix_settlements_state ON settlements (state)
  WHERE state IN ('generated','processing','retry_scheduled');

-- THE double-settlement guard: an event links to at most one settlement, ever.
CREATE TABLE settlement_items (
  settlement_id BIGINT NOT NULL REFERENCES settlements(id),
  event_id      BIGINT NOT NULL,
  event_posted_at TIMESTAMPTZ NOT NULL,
  payable_delta_minor BIGINT NOT NULL,   -- signed payable effect, cached at link time
  PRIMARY KEY (settlement_id, event_id),
  FOREIGN KEY (event_id, event_posted_at) REFERENCES ledger_events (id, posted_at)
);
CREATE UNIQUE INDEX ux_settlement_items_event ON settlement_items (event_id);

CREATE TABLE reserve_holds (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id       BIGINT NOT NULL REFERENCES merchants(id),
  currency          CHAR(3) NOT NULL,
  amount_minor      BIGINT NOT NULL CHECK (amount_minor > 0),
  hold_event_id     BIGINT NOT NULL,
  source_payment_id BIGINT REFERENCES payments(id),
  release_due_at    TIMESTAMPTZ NOT NULL,
  released_at       TIMESTAMPTZ,
  release_event_id  BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_reserve_due
  ON reserve_holds (release_due_at) WHERE released_at IS NULL;
CREATE INDEX ix_reserve_merchant ON reserve_holds (merchant_id, created_at DESC);

-- ============================================================================
-- Platform: audit, webhooks, notifications, exports, API idempotency
-- ============================================================================
CREATE TABLE audit_logs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY,
  audit_uuid     UUID NOT NULL DEFAULT gen_random_uuid(),
  actor_user_id  BIGINT,                 -- NULL for system/scheduler actions
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('user','system','webhook')),
  action         TEXT NOT NULL,          -- 'settlement.generate', 'adjustment.approve'
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  merchant_id    BIGINT,
  before         JSONB,
  after          JSONB,
  reason         TEXT,
  ip             INET,
  user_agent     TEXT,
  request_id     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ix_audit_actor  ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX ix_audit_entity ON audit_logs (entity_type, entity_id, created_at DESC);
REVOKE UPDATE, DELETE ON audit_logs FROM app_rw;
CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE webhook_logs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY,
  webhook_uuid   UUID NOT NULL DEFAULT gen_random_uuid(),
  provider       TEXT NOT NULL,
  upstream_event_id TEXT,
  signature_valid BOOLEAN,
  payload        JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received','processed','failed','skipped')),
  attempts       INT NOT NULL DEFAULT 0,
  error          TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);
CREATE INDEX ix_webhooks_upstream ON webhook_logs (provider, upstream_event_id);
CREATE INDEX ix_webhooks_status ON webhook_logs (status, received_at)
  WHERE status IN ('received','failed');

CREATE TABLE notifications (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT REFERENCES users(id),
  merchant_id   BIGINT,
  channel       TEXT NOT NULL CHECK (channel IN ('in_app','email')),
  template      TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','failed','read')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ
);

CREATE TABLE reports (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_uuid  UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  name         TEXT NOT NULL,
  report_type  TEXT NOT NULL,      -- catalog key, see 10-reporting-exports
  owner_id     BIGINT NOT NULL REFERENCES users(id),
  merchant_id  BIGINT,             -- NULL = admin-scope report
  params       JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE export_jobs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  export_uuid   UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  requested_by  BIGINT NOT NULL REFERENCES users(id),
  merchant_id   BIGINT,            -- scope guard: merchant exports always set this
  report_type   TEXT NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('csv','xlsx','pdf')),
  params        JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','completed','failed','expired')),
  row_count     BIGINT,
  object_path   TEXT,              -- object-store key; served via signed URL
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ
);
CREATE INDEX ix_export_jobs_user ON export_jobs (requested_by, created_at DESC);

-- API-edge idempotency for client writes (distinct from posting_idempotency).
CREATE TABLE idempotency_keys (
  key            TEXT NOT NULL,
  user_id        BIGINT NOT NULL,
  endpoint       TEXT NOT NULL,
  request_hash   BYTEA NOT NULL,
  response_code  INT,
  response_body  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id, endpoint)
);
