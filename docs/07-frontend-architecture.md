# 07 — Frontend Architecture

React 18 + TypeScript + Vite. Two portal apps in one workspace (pnpm), sharing
packages — separate apps because the audiences, navigation, and deployment (admin is
internal-only / IP-restricted) differ, while the design system and API client are
shared.

```
frontend/
├── apps/
│   ├── admin/         # ops/finance portal
│   └── merchant/      # merchant portal
└── packages/
    ├── api-client/    # generated from OpenAPI (openapi-typescript + fetch wrapper:
    │                  #   auth header, refresh-on-401, Idempotency-Key injection,
    │                  #   error-envelope parsing)
    ├── ui/            # design system: tables w/ server pagination+sort+filter,
    │                  #   money display (minor units → formatted, never float),
    │                  #   status chips bound to the state machines, date-range picker,
    │                  #   export button w/ job polling
    └── shared/        # types, money formatting, permission hooks, constants
```

Stack choices: TanStack Router (typed routes) + TanStack Query (server state; no
Redux), react-hook-form + zod (mirrors API validation), Tailwind + headless
components. Money is handled as `{ amount_minor: number, currency: string }` end to
end and formatted only at render.

## Admin portal (RBAC-gated per 08 matrix)

- **Dashboard**: volume, revenue, pending settlements, exception queue (failed
  settlements, negative balances, chargebacks nearing evidence deadline).
- **Merchants**: CRUD, status, fee schedules (effective-dated editor mirroring the
  annex structure), reserve config, settlement config.
- **Transactions / Payments / Refunds**: global search (all fields in the search
  spec), detail pages with the linked ledger events rendered as balanced DR/CR sets.
- **Settlements**: list/detail (breakdown identical to the Excel “Aggregate 1”
  layout), generate (merchant+currency+window), retry, cancel with reason.
- **Ledger**: account browser, statement view (entries + `balance_after`),
  event inspector (all legs of an event, reversal chain).
- **Adjustments**: maker form (class, direction, amount, reason) + checker approval
  queue (approver ≠ maker enforced server-side, reflected in UI).
- **Chargebacks**: queue by deadline, evidence upload, outcome recording.
- **Reports & Exports** (10), **User management**, **Audit log browser**
  (filter by actor/entity/date, before/after diff view).

## Merchant portal

- **Dashboard**: available balance, pending balance, reserve balance, next payout
  estimate, volume/refund/chargeback trends.
- **Settlements**: list + detail (the same breakdown the admin sees, scoped),
  downloadable statement.
- **Transactions / Refunds / Chargebacks**: scoped lists w/ full filtering; refund
  request flow (if enabled for the merchant role).
- **Ledger statement**: their payable/reserve accounts only.
- **Exports**: CSV/XLSX/PDF via async jobs, notification + signed download link.
- **Team**: merchant_admin manages merchant users (invite, role, disable).

Scoping: the merchant app never sends a merchant id — the server derives it from the
token (JWT `mid` claim) and every query is filtered server-side (tested per 06). The
UI additionally hides admin-only affordances by permission flags from `/me`.
