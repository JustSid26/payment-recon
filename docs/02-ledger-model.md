# 02 — Ledger Model (the core)

Double-entry, append-only, integer minor units. Every financial event posts ≥ 2 entries
that sum to zero per `(event_id, currency)`. This document defines the accounts, the
sign convention, the exact legs per event type, and the posting engine contract.

## 1. Sign convention

Each entry has `direction ∈ {debit, credit}` and `amount_minor > 0` (BIGINT).
Signed amount = `+amount` for debit, `−amount` for credit. **Σ signed = 0 per event.**

Account balances are stored *signed by natural side*:

- **Debit-normal** accounts (assets): balance = Σ debits − Σ credits.
- **Credit-normal** accounts (liabilities/revenue): balance = Σ credits − Σ debits.

So `merchant_payable.balance = 45000` means the gateway owes the merchant ₹/€/$ 450.00,
and a *negative* `merchant_payable` balance means the merchant owes the gateway
(the chargeback-after-settlement case).

## 2. Chart of accounts

Accounts are rows in `accounts`, unique on `(account_type, merchant_id, currency)`.
One account **per currency**; merchant-scoped types get one per merchant per currency.

| account_type | Scope | Normal side | Meaning |
|---|---|---|---|
| `clearing` | gateway, per currency | debit | Contra account for the outside world: funds receivable from schemes on capture, funds paid out on refund/settlement/chargeback-loss. The out-of-scope bank layer lives behind this account. |
| `merchant_payable` | per merchant, per currency | credit | What the gateway currently owes the merchant (unsettled). **May go negative.** |
| `merchant_reserve` | per merchant, per currency | credit | Rolling reserve held from the merchant. |
| `settlement_payable` | per merchant, per currency | credit | Netted settlement amounts generated but not yet paid out. Keeps in-flight payouts out of “available balance”. |
| `chargeback_suspense` | gateway, per currency | credit | Disputed funds held while a chargeback is open (clawed from merchant, not yet returned to scheme or released back). |
| `gateway_revenue` | gateway, per currency | credit | All fees earned: MDR, approved/declined txn fees, refund/chargeback fees, settlement fees, platform/convenience fees. Fee subtype lives on the entry’s metadata + the `fees` aggregate. |
| `tax_payable` | gateway, per currency | credit | Tax collected on fees (GST/VAT — see decision D1). |

Derived merchant-facing figures (queries, not accounts):

- **Available balance** = `merchant_payable` deltas of events whose `settle_after` has
  passed and that are not linked to a settlement.
- **Pending balance** = `merchant_payable` deltas of events with `settle_after` in the
  future.
- **Reserve balance** = `merchant_reserve` account balance.
- (`account_balances.merchant_payable` = available + pending; the split is a query over
  unsettled events, tested against the account balance.)

## 3. Per-event debit/credit legs

Notation: amounts in integer minor units. `G` gross, `F` MDR fee, `A` approved-txn fee,
`D` declined-txn fee, `R` refund amount, `RF` refund fee, `C` chargeback amount,
`CF` chargeback fee, `H` reserve hold, `N` settlement net, `SF` settlement fee,
`T` tax on the fees in that event. DR = debit, CR = credit.

Every event: Σ DR = Σ CR (enforced + tested).

| # | Event type | Legs | Notes |
|---|---|---|---|
| 1 | **Payment Authorized** | *no ledger posting* | No money has moved. State change on the Payment aggregate only; auth recorded for audit. |
| 2 | **Payment Captured** | DR `clearing` G · CR `merchant_payable` G−F−A−T · CR `gateway_revenue` F+A · CR `tax_payable` T | The canonical example: G=100000, F=2000, T=360, A=0 → payable 97640. Convenience/platform fee charged to the *customer* adds to G and to the `gateway_revenue` leg (see #6). |
| 3 | **Payment Failed (declined)** | DR `merchant_payable` D+T · CR `gateway_revenue` D · CR `tax_payable` T | Per the Canamoney annex (€0.10/decline). **No principal moves.** Pure fee event; can push payable negative. Posted per decline (see decision D6). If D=0 for the merchant, no posting. |
| 4 | **Refund / Partial Refund** | DR `merchant_payable` R · CR `clearing` R — plus fee legs: DR `merchant_payable` RF+T · CR `gateway_revenue` RF · CR `tax_payable` T | One event, up to 5 legs. Partial refund identical with R < captured; engine validates Σ refunds ≤ captured amount against the Payment aggregate. |
| 5 | **Gateway Fee / Platform Fee (merchant-borne, standalone)** | DR `merchant_payable` F+T · CR `gateway_revenue` F · CR `tax_payable` T | Generic fee event for fees not embedded in another event (e.g. monthly platform fee, retro fee corrections). `fee_type` in metadata + `fees` row. |
| 6 | **Convenience Fee (customer-borne)** | Folded into Payment Captured: G includes the fee; the fee amount is CR’d to `gateway_revenue` instead of `merchant_payable` | Never a standalone posting; it only exists at capture time. |
| 7 | **GST / Tax** | Never standalone: every fee-bearing event carries its own `tax_payable` leg | Tax rows in `fee_taxes` reference the entry for reporting. |
| 8 | **Reserve Hold** | DR `merchant_payable` H · CR `merchant_reserve` H | H = reserve% × (G−F−A−T) capped by the schedule (10% / cap 250k in the annex — see D4). Posted in the same DB transaction as the capture, as a second event sharing the capture’s source id (`source_type='capture_reserve'`). |
| 9 | **Reserve Release** | DR `merchant_reserve` H · CR `merchant_payable` H | Scheduled job when `release_due_at` (hold date + 6 months) passes. Released amount then settles through the normal flow. |
| 10 | **Settlement Generated** | DR `merchant_payable` N · CR `settlement_payable` N — preceded in the same event by fee legs: DR `merchant_payable` SF+T · CR `gateway_revenue` SF · CR `tax_payable` T | N = Σ payable-deltas of the events linked into the settlement, minus SF+T. Only posted when N > 0 (see 04-settlement-flow for the N ≤ 0 rule). |
| 11 | **Settlement Completed** | DR `settlement_payable` N · CR `clearing` N | Money left the gateway. Terminal for that settlement’s funds. |
| 12 | **Settlement Failed** | Reversal of #10’s *net move*: DR `settlement_payable` N · CR `merchant_payable` N (`reverses_event_id` → the Generated event) | Settlement fee is **not** reversed by default (D9). Funds return to available balance; linked events stay linked to the settlement (it will be retried, not regenerated). |
| 13 | **Settlement Retry** | Re-posts #10’s net move (new event, `source_id = settlement_id:attempt_n`), without re-charging SF | Same settlement row, next attempt. |
| 14 | **Manual Adjustment (credit merchant)** | DR `gateway_revenue` *or* `clearing` X · CR `merchant_payable` X | Adjustment class chosen by admin: `goodwill`/`fee_waiver` hits `gateway_revenue`; `funding_correction` hits `clearing`. Maker-checker per D10. |
| 15 | **Manual Adjustment (debit merchant)** | DR `merchant_payable` X · CR `gateway_revenue` / `clearing` X | Same classes, opposite direction. |
| 16 | **Chargeback (opened)** | DR `merchant_payable` C · CR `chargeback_suspense` C — plus fee: DR `merchant_payable` CF+T · CR `gateway_revenue` CF · CR `tax_payable` T | **Settled-funds case:** if the original capture was already settled, `merchant_payable` simply goes negative. The deficit is recovered by the next settlement run netting it against new captures (04 §4). Fee is charged at open and kept regardless of outcome (D8). |
| 17 | **Chargeback Won** | DR `chargeback_suspense` C · CR `merchant_payable` C (`reverses_event_id` → the open event) | Disputed funds return to the merchant. |
| 18 | **Chargeback Lost** | DR `chargeback_suspense` C · CR `clearing` C | Scheme pulls the funds; the claw-back from the merchant already happened at open. |
| 19 | **Correction / Reversal** | Exact mirror of the original event’s legs, same amounts, opposite directions, `reverses_event_id` set | The *only* correction mechanism. An event may be reversed at most once (partial corrections are a reversal + a new correct event). |

## 4. Invariants (each one gets a test in Phase 1)

1. **Zero-sum:** for every `event_id` and currency, Σ signed amounts = 0. Enforced in
   the posting engine before flush *and* by a deferred DB trigger; property-tested.
2. **Balance = Σ entries:** for any account,
   `account_balances.balance_minor == Σ signed entries` (by natural side). Updated
   under `SELECT FOR UPDATE` on the balance row in the posting transaction;
   reconciliation test samples accounts after randomized concurrent postings.
3. **Append-only:** `UPDATE`/`DELETE` on `ledger_events`/`ledger_entries` revoked from
   the app role **and** blocked by triggers that `RAISE`. Test attempts both and
   expects failure.
4. **Idempotent posting:** unique `(source_type, source_id)` in `posting_idempotency`
   (side table — partitioned tables can’t carry that global unique). Replaying a
   webhook/settlement run/refund posts nothing and returns the original event.
5. **Serialized per account:** concurrent postings to one account produce a correct
   final balance (test: N threads × M postings, assert balance and entry count).
6. **Positive amounts:** `CHECK (amount_minor > 0)`; zero-amount legs are omitted,
   zero-amount events are not posted.
7. **Reversal integrity:** a reversal’s legs mirror the original exactly; an event
   cannot be reversed twice (partial unique index on `reverses_event_id`).
8. **`balance_after` consistency:** the denormalized `balance_after` on each entry
   (computed under the same lock, for statement rendering only) always equals the
   running Σ — asserted in the reconciliation test. Never read for business logic.

## 5. Posting engine contract

```python
class Posting(NamedTuple):
    account: AccountRef          # (account_type, merchant_id | None)
    direction: Direction         # DEBIT | CREDIT
    amount: Money                # Money(minor: int, currency: Currency) — see money module

def post_event(
    session: Session,            # caller-owned transaction; engine never commits
    *,
    event_type: EventType,
    source: SourceRef,           # (source_type, source_id) — idempotency identity
    merchant_id: UUID | None,
    currency: Currency,
    occurred_at: datetime,       # source event time (UTC, aware)
    postings: Sequence[Posting], # ≥ 2, same currency, Σ signed == 0 (validated)
    reverses_event_id: int | None = None,
    metadata: dict | None = None,
) -> PostResult:                 # (event, created: bool) — created=False on replay
```

Engine steps, all inside the caller’s transaction:

1. Insert `posting_idempotency (source_type, source_id)` — on conflict, load and
   return the existing event (`created=False`). This is the replay gate.
2. Validate: same currency across legs, Σ signed = 0, amounts > 0, accounts exist
   (auto-provision merchant-scoped accounts on first use).
3. Lock balance rows: `SELECT ... FOR UPDATE` on the affected `account_balances`
   **in account_id order** (deterministic order prevents deadlocks between
   concurrent multi-account events).
4. Insert `ledger_events` row, then `ledger_entries` rows with `balance_after`
   computed from the locked balances.
5. Update `account_balances` (+ `version`, `updated_at`).

`occurred_at` (source time) and `posted_at` (DB time, set by the engine) are stored
separately, both UTC timezone-aware.

## 6. Money

- `Money` value type: `(minor_units: int, currency: str)` — construction from decimal
  strings only; arithmetic ops type-checked; cross-currency ops raise.
- Currency exponent table (ISO 4217): 2 for EUR/USD/INR/CAD/AUD, 0 for JPY, etc.
- Percentage fees computed in basis points with a single rounding policy
  (**round half-even on the fee, tax rounded per line** — confirm in D1) implemented
  once in `app/money/fees.py`. No arithmetic on floats anywhere in the money path;
  API serialization uses strings for decimal display plus `amount_minor` integers.

## 7. Facts vs. state

Ledger events/entries: immutable facts, no status column. Payments, refunds,
settlements, chargebacks: mutable aggregates with state machines (05) that *reference*
ledger events (`ledger_event_id` FKs point from aggregate → ledger, never the reverse,
except the denormalized `merchant_id`/`source` columns on events used for partitioning
and search).
