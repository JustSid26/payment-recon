# Frontend Handoff Spec — Transactworld Ledger Portals

Purpose: everything an engineer **or another LLM** needs to finish, fix, or extend
this frontend with zero other context. Read this top to bottom before touching code.

## 1. What this is

React + TypeScript + Vite SPA with two role-based portals (admin + merchant) for a
payment-gateway merchant settlement & ledger platform. The backend
(FastAPI + Postgres) is **finished and is the source of truth — never change the
backend to suit the frontend.** The API contract is frozen in
`../docs/api-demo.md`; the backend implementation is `../backend/app/api.py` (read it
if a field is ambiguous — it wins over any doc).

## 2. Run / verify

```bash
# backend must be up first:
docker start tw-pg                                  # postgres on :5455
cd ../backend && ./.venv/bin/uvicorn app.api:app --port 8000
# frontend:
npm install
npm run dev        # http://localhost:5173, /api proxied to :8000 (vite.config.ts)
npm run build      # MUST pass (tsc -b && vite build) before calling anything done
```

Demo logins (also shown as chips on /login):
- admin@transactworld.com / demo123 → admin portal
- merchant@canamoney.com / demo123 → merchant portal (CANAMONEY EXCHANGE LTD.)

The DB is loaded with real data: 47,318 transactions, 72 merchants, 6 currencies
(EUR/USD/AUD/CAD/GBP/JPY), completed settlements for GPRO (USD, net $33,136.26) and
CANAMONEY EXCHANGE LTD. (EUR, net €142,685.49), and a deficit book
("Transactworld_US") whose settlement generation returns
`{"skipped": true, "reason": "net <= 0 …"}` — the UI must show that reason inline in
the generate modal, it is a demo centerpiece, not an error.

## 3. Current file map (all under `src/`)

| File | Role |
|---|---|
| `main.tsx`, `App.tsx` | bootstrap, router, role-based route guards |
| `styles.css` | the entire design system (CSS variables, cards, tables, chips) — no UI library, keep it that way |
| `lib/api.ts` | fetch wrapper: base `/api`, JSON, `Authorization: Bearer <token>` from localStorage key, on 401 → clear token + redirect `/login`, parses error envelope `{error:{code,message}}` |
| `lib/money.ts` | `fmtMoney(minor, currency)` — **the only place money becomes a display string.** Integer minor units everywhere; JPY exponent 0, all other demo currencies 2. `currency` may be null (falls back gracefully). Also `fmtDate()` — API `window_start`/`window_end`/timestamps are full ISO strings, never render them raw. Never do float math on amounts; divide only at render |
| `lib/types.ts` | TS types mirroring the API contract |
| `lib/useApi.ts` | data-fetch hook: loading / error / stale-response guard; error toast on failure |
| `components/ui.tsx` | `MoneyCell`, `StatusChip`, `DataTable` (skeleton rows + empty states), `Pager`, `Modal`, toast system |
| `components/Layout.tsx` | sidebar shell; nav differs by role (see §5) |
| `components/LedgerEventCard.tsx` | DR/CR table per ledger event with "Balanced ✓ Σ = 0" footer — the demo centerpiece, keep it polished |
| `components/VolumeChart.tsx` | recharts daily volume bars with **per-currency selector tabs** (one series per view — currencies have different exponents, never mix them on one axis; JPY at exponent 0 dwarfs the rest) |
| `pages/*.tsx` | one file per route (see §5) |

Stack: react 19, react-router-dom 7, recharts 3. No state library — server state via
`useApi`, auth in localStorage. Filters live in URL search params (shareable).

## 4. Conventions (do not break)

1. **Money**: API sends `*_minor` integer + `currency`. Render via `fmtMoney` only.
   Negative balances render red. Money cells are right-aligned, `font-variant-numeric:
   tabular-nums`.
2. **Merchant scoping**: merchant-role users never send `merchant_uuid` params; the
   server scopes by token. Merchant portal shows no merchant selectors, no
   generate/complete buttons, no admin nav.
3. **Errors**: every failed call surfaces the envelope's `error.message` as a toast;
   404 on detail pages shows a "not found" state, not a crash.
4. **Status chips**: captured/completed/refunded=green, auth_failed/failed=red,
   generated=blue, initiated/voided=gray, partially_refunded=amber.
5. **Timestamps**: API sends ISO-8601 UTC; display `YYYY-MM-DD HH:mm` (UTC is fine).
6. Pagination is server-side (`page`, `page_size=50`, response `total`).

## 5. Routes and what each must show

**Public**: `/login` — email/password + 2 demo chips; on success route by `user.role`.

**Admin** (sidebar: Upload & Verify, Dashboard, Merchants, Transactions, Settlements, Ledger, Integrity):
- `/upload` **Upload & Verify** (admin-only) — two-column workflow. Left: drag-and-drop
  dropzone + file picker (`.csv`,`.xlsx`, multiple), selected-file list with size + remove.
  "Import & run checks" POSTs multipart (`apiUpload`, field `files`, no timeout — 15MB CSV
  takes ~15s, spinner shown) to `POST /api/admin/upload`. Right: per-file result rows
  (✓/✗, detail, delta chips), import totals grid, then the 4-check integrity panel derived
  client-side from the response's `integrity`+`stats` (same styling as `/integrity`) with a
  green banner when `integrity.ok`. Empty state before first run.
- `/` Dashboard — integrity banner (green when `integrity.ok`), per-currency stat
  cards from `GET /api/dashboard` (`volume[]`), daily volume chart (`daily_volume[]`),
  top merchants table, settlements summary cards.
- `/merchants` — table from `GET /api/merchants` with per-currency balance mini-rows.
- `/merchants/:uuid` — `GET /api/merchants/{uuid}`: balance cards
  (payable / reserve / in_settlement per currency), fee schedule card, reserve
  statement (`GET .../reserve-statement?currency=X`, currency selector), merchant's
  settlements, **Generate settlement modal** → `POST /api/settlements/generate`
  `{merchant_uuid, currency, window_start, window_end}` (dates as `YYYY-MM-DD`);
  handle `{skipped:true, reason}` inline in the modal; on success navigate to detail.
- `/transactions` — filter bar (debounced `q`, status, currency, merchant dropdown,
  date_from/date_to) + paginated table → `GET /api/transactions`. Row click →
  `/transactions/:uuid`.
- `/transactions/:uuid` — field grid, fees table, then one `LedgerEventCard` per
  entry of `ledger_events[]` (event_type + posted_at header; DR/CR rows using
  `account_label`, direction badge, amount; balanced footer).
- `/settlements` → `GET /api/settlements`; `/settlements/:uuid` — **statement card**
  in this exact row order: Gross captured / − MDR / − Approved txn fees / − Declined
  txn fees / − Refunds / − Refund fees / − Chargebacks / − Chargeback fees / − Reserve
  held / + Reserve released / ± Adjustments / = Subtotal / − Settlement fee /
  = **NET PAYOUT** (large, bold); counts row; USDC footer (`usdc.rate`, `usdc.amount`);
  "Mark completed" button when `state === 'generated'` →
  `POST /api/settlements/{uuid}/complete`.
- `/ledger` → `GET /api/ledger/accounts` (label, type, merchant, currency, balance);
  `/ledger/accounts/:id` → paginated entries with running `balance_after_minor`.
- `/integrity` → `GET /api/integrity`: big pass/fail row per check + re-run button.

**Header demo controls** (top bar, present on every page inside `Layout`):
- **Presentation mode** toggle (both roles) — adds `presentation` class to `<body>`,
  persisted in `localStorage['tw_presentation']`. CSS hides everything tagged
  `.internal-only` (raw UUIDs, member IDs, account IDs, integrity internal counts, the
  "Internal use only" footer) and bumps base font. Tag any new internal-only element with
  `className="internal-only"`.
- **Reset demo** button (admin-only) → confirm modal → `POST /api/admin/reset` wipes all
  data → success toast → navigates to `/upload`. Emptied dashboards/lists show friendly
  "No data yet — go to Upload & Verify" states (dashboard guards against NaN via empty
  `volume[]`). `GET /api/admin/status` → `{counts, empty}` is available for empty checks.
  All three admin endpoints require the admin bearer token; merchant role gets 403 and the
  merchant portal never renders Upload nav or the Reset button (`/upload` route is
  `AdminOnly`-guarded → redirects merchants to `/`).

**Merchant** (sidebar: Dashboard, Transactions, Settlements, Reserve, Ledger): same
components, scoped — dashboard balance cards come from `GET /api/ledger/accounts`;
`/reserve` is the reserve-statement page with currency selector; settlements list +
same statement detail without action buttons.

**State as of 2026-07-02:** all of §5 is built and verified against the real backend
via headless Chrome — 28/28 checks pass, zero console errors, `npm run build` clean.
Anything you change must keep that checklist green.

## 6. Definition of done / test checklist

Run through headless or by hand — all must pass:

1. `npm run build` clean (no TS errors).
2. Admin login → dashboard renders real numbers (EUR captured ≈ €1.15M, integrity
   banner green), no NaN anywhere, no console errors.
3. Transactions: search `gmail`, filter status=captured + currency=EUR, paginate
   past page 2; open a captured Canamoney transaction → 2 event cards
   (payment_captured + reserve_hold), both footed "Balanced ✓"; open an auth_failed
   Canamoney transaction → decline_fee card.
4. Settlement detail for the Canamoney EUR settlement shows every statement line and
   net €142,685.49; USDC footer present.
5. Generate modal for Transactworld_US / USD / 2026-06-09 → 2026-06-30 shows the
   skipped reason inline.
6. Integrity page: 4 green checks.
7. Merchant login: only Canamoney data (≈10,185 transactions), balance cards for
   EUR/AUD/CAD/GBP/USD, reserve page renders, **no** admin affordances; deep-linking
   to another merchant's settlement UUID shows not-found.
8. Logout → token cleared → protected routes redirect to /login.

## 7. Known gaps / nice-to-haves (safe to add, in priority order)

1. Standalone ledger-event page for `GET /api/ledger/events/{event_uuid}` (account
   statement rows currently show the event UUID as text only — could link to a modal
   reusing `LedgerEventCard`).
2. CSV client-side export button on tables (server async exports are out of demo scope).
3. `payment_mode` column on the transactions list (available in the API item).
4. Better empty state on merchant dashboard when a currency has no activity.

Do NOT add: auth flows beyond the two demo users, websockets, state libraries,
UI-kit dependencies, or any backend changes.
