# 10 — Reporting, Exports & Dashboards

Everything here is **derived from the ledger + aggregates**; no report maintains its
own totals.

## Dashboards

Merchant: available / pending / reserve balances (ledger queries per 02 §2), next
payout estimate (current unsettled net − expected fees), volume & success-rate
trend, refund/chargeback ratios. Admin: gross volume, gateway revenue by fee type
(`fees` spine), settlements due/failed, negative-balance merchants, chargeback
exposure (`chargeback_suspense`), exception queue.

Dashboard queries hit the read replica with bounded date ranges (partition pruning).
If p95 demands it later, add materialized daily rollups (`mv_daily_merchant_stats`)
refreshed by a job — an optimization, never a source of truth.

## Report catalog

| Key | Audience | Content |
|---|---|---|
| `merchant_settlement` | merchant/admin | One settlement, full breakdown (the “Aggregate 1” layout: gross, fees, taxes, refunds, chargebacks, RR held/released, adjustments, settlement fee, net) + item-level drill-down |
| `merchant_transactions` | merchant/admin | Transaction register w/ all search filters |
| `merchant_refunds` | merchant/admin | Refund register incl. fees |
| `merchant_ledger` | merchant/admin | Statement per account: entries, running `balance_after` |
| `reserve_statement` | merchant/admin | Opening / held / released / closing per period (the “RR Calculation” sheet) |
| `daily_settlement` | admin | All settlements per day, by state/currency |
| `gateway_revenue` | admin | Revenue by fee type, merchant, currency, period |
| `fee_report` / `tax_report` | admin | Fee & tax lines (from `fees`/`fee_taxes`) for accounting/GST filing |
| `exception_report` | admin | Failed settlements, negative balances, unmatched webhooks, stale auths, chargebacks near deadline |
| `audit_report` | admin | Filtered audit-log extract |

Reports run synchronously in the UI for bounded ranges (paginated), and as **exports**
for full extracts.

## Async export pipeline

1. `POST /exports` (report type + params + format) → validates params **and scope**
   (merchant exports get `merchant_id` stamped from the token, not the request),
   creates `export_jobs` row (`queued`), enqueues Celery task, returns `202` +
   job UUID.
2. Worker streams: **server-side cursor** (`yield_per`) over the report query →
   incremental writer → multipart upload to object storage. Never materializes the
   result set in memory; formats:
   - CSV: streamed rows, UTF-8, RFC 4180.
   - XLSX: streaming writer (openpyxl write-only mode) — sheet layouts mirror the
     existing Transactworld workbook where applicable.
   - PDF: for statements/settlement advice (templated, WeasyPrint); large registers
     are CSV/XLSX-only by design.
3. Completion: job → `completed` (row count, object path), in-app + email
   notification; download via **short-lived signed URL**; files expire (`expires_at`,
   sweeper job) — default 7 days.
4. Failure: `failed` + error, retry with backoff (idempotent — job re-runs overwrite
   their own object path).

Money in exports: formatted decimal string **and** `amount_minor` column; currency
always alongside. Timestamps in UTC ISO-8601 (+ merchant-timezone display column where
the report is merchant-facing — timezone from merchant profile).
