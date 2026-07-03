# 08 — Security Architecture

## Authentication

- **Access token**: JWT, 15 min TTL, RS256 (key rotation via `kid`), claims:
  `sub` (user_uuid), `typ` (admin|merchant), `mid` (merchant_uuid for merchant users),
  `roles`, `perms` (permission codes), `sid` (session id for revocation checks on
  sensitive routes).
- **Refresh token**: opaque 256-bit random, 30 days, stored **hashed** in `sessions`,
  **rotated on every use**; reuse of a rotated token revokes the whole chain
  (theft detection). Logout / password change / admin action revokes sessions.
- Passwords: argon2id. Optional TOTP MFA (required for admin roles — recommended
  default on). Account lockout with exponential backoff on `failed_logins`.

## Authorization (RBAC)

Permissions are code-defined strings checked by a FastAPI dependency
(`require("settlements:generate")`). Roles are seed data mapping to permission sets:

| Permission group | Super Admin | Finance | Operations | Support | Merchant Admin | Merchant RO |
|---|---|---|---|---|---|---|
| merchants: read / write | ✓ / ✓ | ✓ / — | ✓ / ✓ | ✓ / — | own / own-profile | own / — |
| fee schedules: read / write | ✓ / ✓ | ✓ / ✓ | ✓ / — | — | own / — | — |
| transactions+refunds: read | ✓ | ✓ | ✓ | ✓ | own | own |
| refunds: create | ✓ | ✓ | ✓ | — | own (if enabled) | — |
| settlements: read / generate / retry / cancel | ✓ all | ✓ all | read+retry | read | own read | own read |
| adjustments: create (maker) / approve (checker) | ✓ / ✓ | ✓ / ✓ | ✓ / — | — | — | — |
| ledger: read (all) / read (own) | ✓ | ✓ | ✓ | — | own | own |
| chargebacks: read / manage | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | ✓ / — | own / evidence | own / — |
| users+roles: manage | ✓ | — | — | — | own merchant users | — |
| audit log: read | ✓ | ✓ | ✓ | — | — | — |
| exports: run | ✓ | ✓ | ✓ | ✓ | own | own |

Maker–checker: adjustment approval requires `adjustments:approve` **and**
`approved_by ≠ created_by` (DB CHECK + service guard). Same pattern reserved for
manual settlement release if D10 says yes.

## Merchant row-scoping

- Merchant tokens carry `mid`; a scoping dependency injects `merchant_id` into every
  repository call — handlers cannot forget it because merchant-scope repositories
  *require* it in their constructors.
- Cross-merchant access returns **404**, not 403 (no existence leaks).
- Defense-in-depth option: Postgres RLS policies on merchant-scoped tables keyed off
  `SET LOCAL app.merchant_id` — decision D12 (adds safety, costs some query planning
  flexibility). App-layer scoping + the two-merchant test fixture is mandatory
  regardless.

## Data protection

- **PII encrypted at rest, application-layer** (AES-256-GCM via a versioned key from
  KMS/env): customer/user email, phone, cardholder name. Deterministic
  HMAC-SHA256 `*_hash` columns support exact search without decryption.
- **Card data**: PAN never stored — only `first_six`/`last_four`/brand (not PCI CHD).
  RRN/ARN stored plain (needed for reconciliation, not sensitive alone).
- TLS everywhere; HSTS; secrets via env/secret manager, never in code or logs;
  structured logs redact PII fields by serializer policy.

## API hardening

- **Idempotency keys** (`Idempotency-Key` header) required on all mutating endpoints;
  key + user + endpoint + request-hash stored; same key + different body → 422;
  replay returns the stored response. (Posting-level idempotency exists independently
  underneath — the DB is safe even if the edge is bypassed.)
- **Optimistic locking**: mutable aggregates carry `version`; writes require the
  client’s last-seen version; mismatch → 409 `stale_version`.
- **Rate limiting**: Redis token-bucket per user + per IP; stricter buckets on auth
  endpoints and exports; 429 with `Retry-After`.
- **Input validation**: Pydantic v2 models everywhere, amounts accepted as integer
  minor units (or decimal strings, parsed by the Money type), currencies validated
  against ISO 4217, date ranges bounded.
- **SQL**: SQLAlchemy Core/ORM bound parameters only. No string-built SQL; the two
  places using textual SQL (partition maintenance, advisory locks) take no user input
  and are code-reviewed exceptions.
- **Webhooks**: HMAC signature verification, timestamp tolerance, raw payload stored
  before processing, processing idempotent on upstream event id.
- CORS locked to portal origins; admin portal additionally IP-allowlisted at the
  proxy (11).
