# Demo API Contract (frozen for 5PM demo — backend and frontend build against this)

Base URL: `/api` (frontend dev-proxied to `http://localhost:8000`).
All money = integer **minor units** in `*_minor` fields + `currency` (ISO 4217).
Frontend formats: `amount_minor / 10^exponent` (exponent 2 for all demo ccys except JPY=0).
All timestamps ISO-8601 UTC. Errors: `{"error": {"code": str, "message": str}}`.

## Auth
`POST /api/auth/login` `{email, password}` →
`{token, user: {name, role: "admin"|"merchant", merchant_uuid: str|null, merchant_name: str|null}}`
Demo accounts (show as clickable chips on login page):
- `admin@transactworld.com` / `demo123` → admin
- `merchant@canamoney.com` / `demo123` → merchant (CANAMONEY EXCHANGE LTD.)

All other endpoints require `Authorization: Bearer <token>`. 401 → redirect to login.
Merchant-role tokens are auto-scoped server-side; the frontend must NOT send
merchant_uuid filters for merchant users (server ignores/overrides them anyway).

## Dashboard
`GET /api/dashboard` →
```json
{
  "volume": [ {"currency":"USD","captured_minor":0,"refunded_minor":0,
               "fees_minor":0,"net_payable_minor":0,
               "paid_count":0,"declined_count":0} ],
  "merchant_count": 0,
  "settlements": {"generated":0,"completed":0,"total_paid_out":[{"currency":"USD","amount_minor":0}]},
  "integrity": {"events":0,"entries":0,"unbalanced_events":0,"balance_mismatches":0,"ok":true},
  "top_merchants": [ {"merchant_uuid":"","name":"","currency":"","captured_minor":0,"txn_count":0} ],
  "daily_volume": [ {"date":"2026-06-09","currency":"USD","captured_minor":0,"declined_count":0,"paid_count":0} ]
}
```
For merchant tokens the same shape, scoped to that merchant.

## Merchants (admin)
`GET /api/merchants` → `{"items":[{"merchant_uuid","name","member_id","status",
  "balances":[{"currency","payable_minor","reserve_minor","in_settlement_minor"}],
  "txn_count","captured_minor_total":[{"currency","amount_minor"}]}]}`

`GET /api/merchants/{uuid}` → same item + `"fee_schedule": {"mdr_bps":650,
  "approved_txn_fee_minor":35,"declined_txn_fee_minor":10,"fee_fixed_currency":"EUR",
  "refund_fee_minor":1000,"chargeback_fee_minor":7000,"reserve_hold_bps":1000,
  "reserve_hold_days":180,"settlement_fee_bps":100}`

`GET /api/merchants/{uuid}/reserve-statement?currency=USD` →
`{"items":[{"date","opening_minor","held_minor","released_minor","closing_minor"}],
  "currency":"USD","current_reserve_minor":0}`

## Transactions
`GET /api/transactions?merchant_uuid&status&currency&q&date_from&date_to&page&page_size`
- `status` one of: `captured, auth_failed, initiated, voided, refunded, partially_refunded`
- `q` matches tracking_id, order_id, payment_id, customer email/name, last four
- paginated: `{"items":[…],"total":n,"page":1,"page_size":50}`
- item: `{transaction_uuid, occurred_at, merchant_uuid, merchant_name, tracking_id,
   order_id, upstream_payment_id, customer_name, customer_email, payment_brand,
   payment_mode, card_last_four, currency, auth_minor, captured_minor,
   refunded_minor, chargeback_minor, status, mid, country}`

`GET /api/transactions/{uuid}` → item + :
```json
{ "fees": [ {"fee_type":"mdr","fee_minor":0,"currency":"USD"} ],
  "ledger_events": [ {"event_uuid","event_type","posted_at","currency",
     "entries":[{"account_label":"merchant_payable — CANAMONEY (USD)",
                 "account_type":"merchant_payable","direction":"credit","amount_minor":0}]} ] }
```
(`entries` per event always sum to zero: show DR/CR table with a balanced ✓.)

## Settlements
`GET /api/settlements?merchant_uuid&currency` → `{"items":[{settlement_uuid, merchant_uuid,
  merchant_name, currency, window_start, window_end, state, net_payout_minor,
  paid_count, declined_count, created_at}]}`

`POST /api/settlements/generate` `{merchant_uuid, currency, window_start, window_end}`
→ 200 settlement detail | 200 `{"skipped": true, "reason": "net <= 0" | "no candidates"}`
(admin only; idempotent — regenerating the same window returns the existing one)

`POST /api/settlements/{uuid}/complete` → marks paid out (posts completion event)

`GET /api/settlements/{uuid}` → the Excel "Aggregate 1" breakdown:
```json
{ "settlement_uuid":"", "merchant_name":"", "currency":"USD",
  "window_start":"", "window_end":"", "state":"generated",
  "counts": {"paid":0, "declined":0, "refunds":0, "chargebacks":0},
  "breakdown": {
    "gross_captured_minor":0, "mdr_minor":0, "approved_txn_fees_minor":0,
    "declined_txn_fees_minor":0, "refunds_minor":0, "refund_fees_minor":0,
    "chargebacks_minor":0, "chargeback_fees_minor":0,
    "reserve_held_minor":0, "reserve_released_minor":0, "adjustments_minor":0,
    "subtotal_minor":0, "settlement_fee_minor":0, "net_payout_minor":0 },
  "usdc": {"rate":"1.0000", "amount":"155209.58"},
  "items_count":0 }
```

## Ledger
`GET /api/ledger/accounts?merchant_uuid` → `{"items":[{account_id, account_type,
  merchant_uuid, merchant_name, currency, balance_minor, label}]}`
`GET /api/ledger/accounts/{id}/entries?page&page_size` → paginated
  `{entry items: {entry_uuid, posted_at, event_type, event_uuid, direction,
    amount_minor, balance_after_minor, currency}}`
`GET /api/ledger/events/{event_uuid}` → event with all entries (as in transaction detail)

## Integrity (the demo wow-panel)
`GET /api/integrity` → runs live checks:
```json
{ "checks": [
   {"name":"Every event sums to zero","ok":true,"detail":"45,112 events checked, 0 unbalanced"},
   {"name":"Account balances == Σ entries","ok":true,"detail":"214 accounts reconciled, 0 mismatches"},
   {"name":"Ledger is append-only","ok":true,"detail":"UPDATE/DELETE rejected by trigger"},
   {"name":"Idempotent posting","ok":true,"detail":"45,112 unique source events, replays skipped: n"}
 ], "ok": true }
```
