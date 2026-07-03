-- Demo schema: real double-entry ledger, un-partitioned for demo speed.
-- Full production DDL (partitioning, RBAC tables, audit) lives in docs/ddl.sql.

CREATE TABLE IF NOT EXISTS merchants (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_uuid UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  member_id     TEXT UNIQUE,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fee_schedules (
  merchant_id             BIGINT PRIMARY KEY REFERENCES merchants(id),
  mdr_bps                 INT NOT NULL,
  approved_txn_fee_minor  BIGINT NOT NULL,
  declined_txn_fee_minor  BIGINT NOT NULL,
  refund_fee_minor        BIGINT NOT NULL,
  chargeback_fee_minor    BIGINT NOT NULL,
  reserve_hold_bps        INT NOT NULL,
  reserve_hold_days       INT NOT NULL,
  settlement_fee_bps      INT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_uuid UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  account_type TEXT NOT NULL CHECK (account_type IN
    ('clearing','merchant_payable','merchant_reserve','settlement_payable',
     'chargeback_suspense','gateway_revenue','tax_payable')),
  merchant_id  BIGINT REFERENCES merchants(id),
  currency     CHAR(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_identity
  ON accounts (account_type, COALESCE(merchant_id, 0), currency);

CREATE TABLE IF NOT EXISTS account_balances (
  account_id    BIGINT PRIMARY KEY REFERENCES accounts(id),
  balance_minor BIGINT NOT NULL DEFAULT 0,
  version       BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_events (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_uuid        UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  event_type        TEXT NOT NULL,
  merchant_id       BIGINT,
  currency          CHAR(3) NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  posted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  settle_after      TIMESTAMPTZ,
  reverses_event_id BIGINT,
  source_txn_id     BIGINT,          -- denormalized link for transaction drill-down
  metadata          JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_events_merchant ON ledger_events (merchant_id, currency, occurred_at);
CREATE INDEX IF NOT EXISTS ix_events_txn ON ledger_events (source_txn_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_uuid          UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  event_id            BIGINT NOT NULL REFERENCES ledger_events(id),
  account_id          BIGINT NOT NULL REFERENCES accounts(id),
  direction           TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  currency            CHAR(3) NOT NULL,
  balance_after_minor BIGINT NOT NULL,
  posted_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_entries_account ON ledger_entries (account_id, id);
CREATE INDEX IF NOT EXISTS ix_entries_event ON ledger_entries (event_id);

CREATE TABLE IF NOT EXISTS posting_idempotency (
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  event_id    BIGINT NOT NULL,
  PRIMARY KEY (source_type, source_id)
);

-- Append-only enforcement
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS trg_events_immutable ON ledger_events;
CREATE TRIGGER trg_events_immutable BEFORE UPDATE OR DELETE ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS trg_entries_immutable ON ledger_entries;
CREATE TRIGGER trg_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Zero-sum enforcement, deferred to commit
CREATE OR REPLACE FUNCTION assert_event_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad BIGINT;
BEGIN
  SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END),0)
    INTO bad FROM ledger_entries WHERE event_id = NEW.event_id;
  IF bad <> 0 THEN RAISE EXCEPTION 'event % unbalanced by %', NEW.event_id, bad; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_entries_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER trg_entries_balanced
  AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_event_balanced();

CREATE TABLE IF NOT EXISTS transactions (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_uuid    UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  merchant_id         BIGINT NOT NULL REFERENCES merchants(id),
  tracking_id         TEXT,
  upstream_payment_id TEXT UNIQUE,
  order_id            TEXT,
  order_description   TEXT,
  customer_name       TEXT,
  customer_email      TEXT,
  customer_phone      TEXT,
  payment_mode        TEXT,
  payment_brand       TEXT,
  first_six           TEXT,
  last_four           TEXT,
  issuing_bank        TEXT,
  country             TEXT,
  mid                 TEXT,
  currency            CHAR(3) NOT NULL,
  auth_minor          BIGINT NOT NULL DEFAULT 0,
  captured_minor      BIGINT NOT NULL DEFAULT 0,
  refunded_minor      BIGINT NOT NULL DEFAULT 0,
  chargeback_minor    BIGINT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL,
  reason              TEXT,
  occurred_at         TIMESTAMPTZ NOT NULL,
  source_file         TEXT
);
CREATE INDEX IF NOT EXISTS ix_txn_merchant_time ON transactions (merchant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_txn_status ON transactions (status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_txn_currency ON transactions (currency, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_txn_email ON transactions (customer_email);
CREATE INDEX IF NOT EXISTS ix_txn_tracking ON transactions (tracking_id);
CREATE INDEX IF NOT EXISTS ix_txn_order ON transactions (order_id);

CREATE TABLE IF NOT EXISTS fees (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id     BIGINT NOT NULL,
  transaction_id  BIGINT,
  fee_type        TEXT NOT NULL,
  currency        CHAR(3) NOT NULL,
  fee_minor       BIGINT NOT NULL,
  ledger_event_id BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_fees_event ON fees (ledger_event_id);
CREATE INDEX IF NOT EXISTS ix_fees_txn ON fees (transaction_id);

CREATE TABLE IF NOT EXISTS settlements (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_uuid  UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  merchant_id      BIGINT NOT NULL REFERENCES merchants(id),
  currency         CHAR(3) NOT NULL,
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,
  state            TEXT NOT NULL DEFAULT 'generated',
  breakdown        JSONB NOT NULL DEFAULT '{}',
  net_payout_minor BIGINT NOT NULL DEFAULT 0,
  generated_event_id BIGINT,
  completed_event_id BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_settlements_merchant ON settlements (merchant_id, window_end DESC);

CREATE TABLE IF NOT EXISTS settlement_items (
  settlement_id BIGINT NOT NULL REFERENCES settlements(id),
  event_id      BIGINT NOT NULL,
  payable_delta_minor BIGINT NOT NULL,
  PRIMARY KEY (settlement_id, event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_settlement_items_event ON settlement_items (event_id);

CREATE TABLE IF NOT EXISTS reserve_holds (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id     BIGINT NOT NULL,
  currency        CHAR(3) NOT NULL,
  amount_minor    BIGINT NOT NULL,
  hold_event_id   BIGINT NOT NULL,
  release_due_at  TIMESTAMPTZ NOT NULL,
  released_at     TIMESTAMPTZ,
  release_event_id BIGINT
);
CREATE INDEX IF NOT EXISTS ix_reserve_merchant ON reserve_holds (merchant_id, currency);
CREATE INDEX IF NOT EXISTS ix_reserve_due ON reserve_holds (release_due_at) WHERE released_at IS NULL;

-- T+N settlement engine (additive; safe on an already-populated db) -------------
-- Per-merchant settlement cadence: how many business days after capture funds
-- become eligible, and the release schedule the cycle worker honours.
ALTER TABLE fee_schedules
  ADD COLUMN IF NOT EXISTS settlement_delay_days INT  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS settlement_schedule   TEXT NOT NULL DEFAULT 'daily';

-- Payout execution metadata written by the cycle worker on completion.
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS payout_reference TEXT,
  ADD COLUMN IF NOT EXISTS settled_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cycle_date       DATE;

-- Speeds the cycle's per-event eligibility scan.
CREATE INDEX IF NOT EXISTS ix_events_settle_after
  ON ledger_events (merchant_id, currency, settle_after);

-- Quarantine: unknown merchants (no configured fee schedule) have their
-- transactions imported but NO ledger events posted until a schedule is assigned.
-- ledger_posted=false marks such quarantined rows; merchants.status='unconfigured'
-- flags the merchant. Neither settles until onboarded (a fee schedule is set).
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS ledger_posted BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS ix_txn_quarantined
  ON transactions (merchant_id) WHERE ledger_posted = FALSE;
