# 04 — Settlement Flow

A settlement **references** ledger events (via `settlement_items`); it never copies
financial data. Totals stored on the settlement row are display caches derived at
generation time from the linked events, and re-derivable at any time.

This flow reproduces the Transactworld_US Excel workbook (“Aggregate 1” sheet):
gross captures − refunds − fees − chargebacks − reserve withheld + reserve released
± adjustments − settlement fee (1%) = amount to be settled.

## 1. What gets settled

A ledger event is a **settlement candidate** for merchant M, currency C when:

1. it touches M’s `merchant_payable` account in C (its payable delta ≠ 0),
2. `settle_after <= window_end` (T+n hold has passed; fees/chargebacks get
   `settle_after = posted_at` so they net immediately),
3. it is not yet linked in `settlement_items` (the `UNIQUE (event_id)` is the
   hard guarantee against double-settlement),
4. its event type participates in settlement: captures, refunds, decline fees,
   standalone fees, reserve holds/releases, chargeback events, adjustments,
   reversals of any of these. (Settlement-lifecycle events themselves never link.)

Candidates from **before** the window are included too (late releases, old unsettled
events, prior-period deficits) — the selection predicate is `settle_after <=
window_end AND unlinked`, not a window intersection. This is what makes negative
balances self-recovering (§4).

## 2. Generation algorithm (idempotent, concurrency-safe)

Runs per `(merchant, currency)` from the scheduler (per merchant cadence) or manually
from the admin portal. One DB transaction:

```
1. source = ('settlement_run', f'{merchant_uuid}:{currency}:{window_end date}')
   → posting_idempotency makes rerunning this exact run a no-op (returns existing).
2. pg_advisory_xact_lock(hash(merchant_id, currency))
   → two concurrent runs for the same merchant/currency serialize; the loser
     re-reads and finds candidates already linked.
3. SELECT candidate events (predicate in §1) FOR UPDATE-free — the advisory lock +
   UNIQUE(event_id) on settlement_items make row locks unnecessary.
4. N_window = Σ payable_delta(candidates).
   Skip if no candidates.
5. Compute settlement fee: SF = settlement_fee_bps × max(N_window_before_fee, 0),
   tax T on SF (fee schedule effective at window_end).
   N = N_window − SF − T.
6. If N <= 0  → do NOT create a payout settlement, do NOT link events (see §4).
   If N < min_payout_minor → same: leave for next window.
7. INSERT settlements (state='generated', display totals per event-type breakdown).
8. INSERT settlement_items for every candidate (UNIQUE(event_id) is the backstop
   if the advisory lock is ever bypassed — the txn aborts, nothing half-links).
9. post_event(settlement_generated):
     DR merchant_payable  SF+T   → CR gateway_revenue SF, CR tax_payable T
     DR merchant_payable  N      → CR settlement_payable N
10. Audit log row; commit.
```

Failure anywhere = full rollback; rerun is safe (step 1/2).

## 3. Payout & lifecycle

- `generated → processing`: payout instruction handed to the (out-of-scope) payment
  rail; `payout_reference` stored.
- `processing → completed`: rail confirms. Post `settlement_completed`
  (DR `settlement_payable` N, CR `clearing` N), idempotency
  `('settlement_completed', settlement_id)`.
- `processing → failed`: post `settlement_failed` — reversal of the *net move* only
  (DR `settlement_payable` N, CR `merchant_payable` N, `reverses_event_id` set).
  Settlement fee is **not** reversed (D9). Funds are back in available balance, but
  linked events **stay linked** — the settlement will be retried, never regenerated,
  so the UNIQUE(event_id) invariant holds across retries.
- `failed → retry_scheduled → processing`: retry re-posts the net move
  (`settlement_retry`, source `settlement_id:attempt_N`), no new fee.
- `cancelled` (admin, only from `generated`/`failed`): reversal of the net move (if
  outstanding) **and** delete of `settlement_items` rows (operational links, not
  ledger) so the events become candidates again. Requires reason + audit.

## 4. Negative balance / settled-funds chargeback recovery

The clawback event (`chargeback_opened`: DR `merchant_payable` C + fee) is itself a
settlement candidate with `settle_after = posted_at`. Two cases:

- **Merchant still has unsettled volume ≥ C:** next run nets it automatically —
  the chargeback event links into the settlement alongside new captures and reduces N.
  This is the normal path and needs no special handling.
- **Funds already settled / insufficient volume (N ≤ 0):** rule §2.6 — no settlement
  is created and *nothing links*. The negative events stay outstanding and
  `merchant_payable` stays negative. Every subsequent run re-selects them until new
  captures push N above zero; the first positive run sweeps the whole backlog into one
  settlement. The deficit is never forgiven, never duplicated, and requires no
  carry-forward bookkeeping — the unlinked events *are* the carry-forward.
  (The Excel’s “Prior Period Adjustment” line becomes automatic; manual prior-period
  corrections use the Adjustment aggregate instead.)
- Recovery from `merchant_reserve` (e.g. on merchant termination or by policy) is a
  Reserve Release event followed by normal netting — whether this happens
  automatically is decision D3.

## 5. Reserve lifecycle

- **Hold:** posted with each capture (10% of net-of-fee capture per the annex),
  recorded in `reserve_holds` with `release_due_at = captured_at + hold_days`
  (180 days). Cap handling (stop-at-cap vs keep-holding, 250k per annex): D4.
- **Release:** a scheduled Celery task (daily) selects due, unreleased holds
  (`ix_reserve_due`), posts `reserve_release` per hold (idempotency
  `('reserve_release', hold_id)`), stamps `released_at`/`release_event_id`.
  The release credits `merchant_payable` and is then swept by the next settlement —
  matching the “Released Rolling Reserve” line in the workbook.
- Reserve statement (opening / held / released / closing per period) is a query over
  the `merchant_reserve` account entries — mirrors the “RR Calculation” sheet.

## 6. Settlement currency

Processing currencies are EUR/USD/CAD/AUD; the reference workbook converts the net to
**USDC** for crypto payout at a snapshot rate. Design default: the ledger and the
settlement net stay in processing currency; conversion happens at payout execution and
is recorded on the settlement row (`payout_reference`, rate, converted amount in
`metadata`) — the bank/crypto rail is out of scope. If FX gain/loss must be *ledgered*,
that adds an `fx_gain_loss` account and conversion events — decision D2 before Phase 3.
