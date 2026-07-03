-- ledger_invariants.sql
-- Core data-integrity checks for the TransactWorld ledger, meant to be run
-- against the LIVE book. It does not modify anything.
--
-- Usage (adjust container/user/db if yours differ):
--   docker exec -i tw-pg psql -U tw -d twledger < ledger_invariants.sql
--
-- PART 1 is pure schema discovery (queries information_schema only) and is
-- guaranteed to run regardless of your table/column names.
--
-- PART 2 runs the actual invariants. It GUESSES table/column names based on
-- common conventions for this kind of system. If Part 1 shows your names are
-- different, tweak the queries -- the INTENT of each is stated in its \echo
-- header, so translating is mechanical. ON_ERROR_STOP is off so that a wrong
-- name in one check does not abort the rest.
--
-- Interpretation: every check in Part 2 should return ZERO rows on a healthy
-- system (except the clearly-labeled "print for eyeballing" ones). Any rows
-- returned are a candidate finding.

\set ON_ERROR_STOP off
\pset pager off
\timing off

\echo
\echo ============================================================
\echo PART 1  --  SCHEMA DISCOVERY  (always runs)
\echo ============================================================
\echo
\echo ---- tables in schema public ----
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

\echo
\echo ---- columns per table ----
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;

\echo
\echo ---- foreign keys (to spot un-enforced references) ----
SELECT
  tc.table_name       AS child_table,
  kcu.column_name     AS child_column,
  ccu.table_name      AS parent_table,
  ccu.column_name     AS parent_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
ORDER BY child_table, child_column;


\echo
\echo ============================================================
\echo PART 2  --  INVARIANT CHECKS  (assumed names; see headers)
\echo ============================================================
\echo Every query below should return ZERO rows on a healthy book,
\echo except the two marked [EYEBALL].
\echo Assumed model: ledger_events(event_id, transaction_id, account, amount_minor)
\echo   with amount_minor SIGNED (debits +, credits -); transactions(id, payment_id,
\echo   merchant_id, ledger_posted bool); merchants(id, name, status);
\echo   fee_schedules(id, merchant_id).  Swap names as needed.

\echo
\echo ------------------------------------------------------------
\echo [I1] Per-event ledger balance != 0
\echo      (double-entry: every event's postings must net to zero)
\echo      If ANY rows -> a broken/unbalanced event exists.
\echo ------------------------------------------------------------
SELECT event_id, SUM(amount_minor) AS net_minor, COUNT(*) AS n_postings
FROM ledger_events
GROUP BY event_id
HAVING SUM(amount_minor) <> 0
ORDER BY event_id;
-- If your ledger uses separate debit_minor / credit_minor columns instead of a
-- signed amount_minor, use this form:
--   SELECT event_id, SUM(debit_minor) - SUM(credit_minor) AS net
--   FROM ledger_events GROUP BY event_id HAVING SUM(debit_minor) <> SUM(credit_minor);

\echo
\echo ------------------------------------------------------------
\echo [I2] QUARANTINED transactions that nonetheless have ledger rows
\echo      (ledger_posted = false must mean NO ledger events)
\echo      If ANY rows -> quarantine leaked into the ledger.
\echo ------------------------------------------------------------
SELECT t.id AS transaction_id, t.payment_id, t.merchant_id, COUNT(e.*) AS ledger_rows
FROM transactions t
JOIN ledger_events e ON e.transaction_id = t.id
WHERE t.ledger_posted = false
GROUP BY t.id, t.payment_id, t.merchant_id
ORDER BY t.id;

\echo
\echo ------------------------------------------------------------
\echo [I3] POSTED transactions with NO ledger rows
\echo      (ledger_posted = true must mean at least one event exists)
\echo      If ANY rows -> a settled/posted txn produced no accounting.
\echo ------------------------------------------------------------
SELECT t.id AS transaction_id, t.payment_id, t.merchant_id
FROM transactions t
LEFT JOIN ledger_events e ON e.transaction_id = t.id
WHERE t.ledger_posted = true
  AND e.transaction_id IS NULL
ORDER BY t.id;

\echo
\echo ------------------------------------------------------------
\echo [I4] ACTIVE merchants that still have UNPOSTED transactions
\echo      (an onboarded/active merchant should not have quarantined txns)
\echo      If ANY rows -> active-but-unposted inconsistency.
\echo      (Adjust the status literal to whatever "active" is in your enum.)
\echo ------------------------------------------------------------
SELECT m.id AS merchant_id, m.name, m.status, COUNT(*) AS unposted_txns
FROM merchants m
JOIN transactions t ON t.merchant_id = m.id
WHERE m.status = 'active'
  AND t.ledger_posted = false
GROUP BY m.id, m.name, m.status
ORDER BY unposted_txns DESC;

\echo
\echo ------------------------------------------------------------
\echo [I5] Duplicate fee schedules per merchant
\echo      (concurrency / double-onboard artifact -> duplicate fee rows)
\echo      If ANY rows -> more than one schedule per merchant.
\echo      If you keep history and mark one active, add: WHERE active = true
\echo ------------------------------------------------------------
SELECT merchant_id, COUNT(*) AS n_schedules
FROM fee_schedules
GROUP BY merchant_id
HAVING COUNT(*) > 1
ORDER BY n_schedules DESC;

\echo
\echo ------------------------------------------------------------
\echo [I6] Same payment_id across DIFFERENT merchants
\echo      (import collision / idempotency scope bug)
\echo      Rows here are not necessarily fatal, but show whether a payment_id
\echo      is globally unique or only per-merchant. Compare against how your
\echo      idempotency key is defined.
\echo ------------------------------------------------------------
SELECT payment_id,
       COUNT(*)                    AS rows,
       COUNT(DISTINCT merchant_id) AS distinct_merchants
FROM transactions
GROUP BY payment_id
HAVING COUNT(DISTINCT merchant_id) > 1
ORDER BY distinct_merchants DESC, payment_id;

\echo
\echo ------------------------------------------------------------
\echo [I7] Global ledger net  (whole book must net to zero)
\echo      Expected: 0. Any nonzero value -> systemic imbalance.
\echo ------------------------------------------------------------
SELECT SUM(amount_minor) AS global_net_minor FROM ledger_events;

\echo
\echo ------------------------------------------------------------
\echo [I8] Orphan ledger rows (referential integrity, in case FKs are absent)
\echo      If ANY rows -> ledger points at a missing txn or merchant.
\echo ------------------------------------------------------------
SELECT e.event_id, e.transaction_id
FROM ledger_events e
LEFT JOIN transactions t ON t.id = e.transaction_id
WHERE e.transaction_id IS NOT NULL
  AND t.id IS NULL
ORDER BY e.event_id;

\echo
\echo ------------------------------------------------------------
\echo [EYEBALL A] Balance per ledger account
\echo      Not an assertion -- inspect for anything obviously wrong
\echo      (e.g. a negative rolling-reserve balance, a payable that went
\echo      the wrong direction). Signs depend on your convention.
\echo ------------------------------------------------------------
SELECT account, SUM(amount_minor) AS balance_minor, COUNT(*) AS n
FROM ledger_events
GROUP BY account
ORDER BY account;

\echo
\echo ------------------------------------------------------------
\echo [EYEBALL B] Per-merchant payable vs settled sanity
\echo      Inspect for merchants whose net owed looks impossible
\echo      (negative payout, reserve larger than gross, etc.).
\echo      Column/account names are guesses -- adjust to your accounts.
\echo ------------------------------------------------------------
SELECT t.merchant_id,
       SUM(CASE WHEN e.account ILIKE '%payable%' THEN e.amount_minor ELSE 0 END) AS payable_minor,
       SUM(CASE WHEN e.account ILIKE '%reserve%' THEN e.amount_minor ELSE 0 END) AS reserve_minor,
       SUM(CASE WHEN e.account ILIKE '%fee%'     THEN e.amount_minor ELSE 0 END) AS fee_minor
FROM ledger_events e
JOIN transactions t ON t.id = e.transaction_id
GROUP BY t.merchant_id
ORDER BY t.merchant_id;

\echo
\echo ============================================================
\echo DONE. Zero rows on I1-I8 = clean. Investigate anything else.
\echo ============================================================
