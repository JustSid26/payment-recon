# 05 — State Machines

Implemented as a single guarded transition engine (`app/domain/statemachine.py`):
each aggregate declares `TRANSITIONS: dict[(from, to)] -> Guard`, and
`transition(aggregate, to, actor, reason)` (1) validates the edge exists,
(2) runs the guard, (3) applies side effects (ledger postings via the posting
engine) in the same DB transaction, (4) writes the audit row. Invalid transitions
raise `InvalidTransition` → HTTP 409. No scattered `if` checks.

Ledger postings attached to a transition are listed as “posts: …” (legs in 02 §3).

## Payment

```
                 ┌─────────────┐
   initiated ───▶│ authorized  │───▶ captured           (terminal for money;
       │         └─────┬───────┘        refund/chargeback lifecycles reference it)
       │               │ void          posts: payment_captured (+ reserve_hold)
       │               ▼
       │           voided
       │               
       ├──▶ auth_failed        posts: decline_fee (if schedule has one)
       │
       └──(authorized, TTL passed)──▶ expired
```

| From | To | Guard | Posts |
|---|---|---|---|
| initiated | authorized | upstream auth success | — (no money moved) |
| initiated | auth_failed | upstream decline | `decline_fee` (if configured) |
| authorized | captured | capture confirmation; amount ≤ authorized | `payment_captured` + `reserve_hold` |
| authorized | voided | merchant/gateway void before capture | — |
| authorized | expired | auth TTL passed (scheduled sweep) | — |

Transaction-level `status` (PAID / partially_refunded / refunded / charged_back) is a
rollup derived from payments + refunds + chargebacks, recomputed on each child change —
display only, never a guard input.

## Refund

```
requested ──▶ processing ──▶ completed     posts: refund (principal + fee)
    │             └────────▶ failed        (posted on completed only)
    └──▶ failed (validation)
```

| From | To | Guard |
|---|---|---|
| requested | processing | payment is `captured`; Σ(existing completed+processing refunds) + amount ≤ captured amount; requester authorized for merchant |
| processing | completed | upstream confirmation → post `refund` event |
| requested/processing | failed | upstream rejection / validation failure; no posting (or reversal if already posted — must not happen: posting occurs on `completed` only) |

A failed refund may be re-requested as a **new** refund aggregate (new idempotency
identity); failed rows are never reused.

## Settlement

```
draft ──▶ generated ──▶ processing ──▶ completed
              │              │
              │              └──▶ failed ──▶ retry_scheduled ──▶ processing
              │                     │
              └──▶ cancelled ◀──────┘        (admin, reason required)
```

| From | To | Guard | Posts |
|---|---|---|---|
| draft | generated | generation transaction succeeded (04 §2) | `settlement_generated` |
| generated | processing | payout dispatched to rail | — |
| processing | completed | rail confirmation | `settlement_completed` |
| processing | failed | rail failure | `settlement_failed` (net-move reversal) |
| failed | retry_scheduled | retry policy / admin action | — |
| retry_scheduled | processing | retry dispatched | `settlement_retry` (re-post net move) |
| generated, failed | cancelled | admin + reason; posts net-move reversal if outstanding; unlinks `settlement_items` | reversal |

(`draft` exists only inside the generation transaction — externally settlements first
appear as `generated`.)

## Chargeback

```
opened ──▶ evidence_submitted ──▶ under_review ──▶ won
   │                                   │
   ├──▶ accepted (merchant concedes)   └──▶ lost
   ├──▶ won  (issuer withdraws)
   └──▶ lost (no evidence by deadline)
```

| From | To | Guard | Posts |
|---|---|---|---|
| — | opened | scheme notification (webhook/import); payment is `captured` | `chargeback_opened` (claw-back + fee) |
| opened | evidence_submitted | merchant/admin uploads before `evidence_due_at` | — |
| evidence_submitted | under_review | representment filed | — |
| under_review / opened | won | scheme rules in merchant favour | `chargeback_won` (suspense → payable) |
| under_review / opened | lost | scheme rules against; or deadline passed | `chargeback_lost` (suspense → clearing) |
| opened | accepted | merchant concedes liability | `chargeback_lost` legs |

`won` and `lost`/`accepted` are terminal. Second-cycle disputes (pre-arb/arbitration)
are modelled as a **new** chargeback row referencing the first (`metadata.prior_case`)
— keeps the money movements per-case and reversible.
