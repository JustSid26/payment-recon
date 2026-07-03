# 09 — Audit Architecture

## What gets audited

Every state-changing action, with emphasis on admin actions:

- **Auth**: login success/failure, refresh rotation, session revocation, password/MFA
  changes.
- **Admin actions** (all): merchant CRUD + status changes, fee schedule changes,
  settlement generate/retry/cancel, adjustment create/approve/reject, chargeback
  outcome recording, refund creation, user/role management, export requests.
- **System actions**: scheduled settlement runs, reserve releases, auth expiries,
  webhook-driven postings (actor_type = `system` / `webhook`).
- **Reads are not audited** except audit-log access itself and PII-revealing exports.

## Record shape (`audit_logs`, DDL in 03)

who (`actor_user_id`, `actor_type`) · what (`action`, `entity_type`, `entity_id`,
`merchant_id`) · when (`created_at`) · where (`ip`, `user_agent`, `request_id`) ·
change (`before`, `after` JSONB) · why (`reason` — **required** for adjustments,
cancellations, fee changes, manual retries; enforced by the service layer).

- `before`/`after` are the aggregate’s API-shaped snapshots with PII redacted
  (hashes retained for correlation). For ledger postings, `after` carries the event
  UUID + leg summary — the ledger itself is the financial audit trail.
- `request_id` ties the audit row to structured logs and the client response header.

## Write path

- Audit rows are written **in the same DB transaction** as the change (an action that
  rolls back leaves no audit row; an action cannot commit without one). The state
  machine engine and the service decorators call the audit writer automatically —
  auditing is not left to endpoint authors’ discipline.
- Append-only: same enforcement as the ledger — `REVOKE UPDATE, DELETE` + raising
  trigger; monthly partitions; retention per D13 (financial-audit norm: ≥ 7 years,
  archived to object storage after 24 months).

## Access

- Browsable in the admin portal (Super Admin, Finance, Operations) with filters:
  actor, entity, merchant, action, date range; before/after diff rendering.
- Exportable via the async export pipeline (audit report type) — itself audited.
