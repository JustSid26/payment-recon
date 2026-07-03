# 12 — Open Decisions (needed before Phase 1–3)

Defaults are what the design assumes if you say “go”. **D1, D2, D6 block Phase 1**
(they shape the money module and event legs); the rest block Phase 3 or are
policy toggles.

| # | Decision | Options | Default assumed | Blocks |
|---|---|---|---|---|
| **D1** | **Tax regime.** The build prompt says GST (India); the reference docs (Cyprus gateway, EUR/USD, Canamoney annex) show **no tax lines at all**. | (a) GST 18% on all fees; (b) EU VAT per rule; (c) no tax by default, engine supports tax rules when configured | **(c)** — tax engine built and tested, zero-rate default; enabling GST is a `tax_rules` row | Phase 1 (leg builders, rounding tests) |
| **D2** | **Settlement/payout currency & USDC.** Workbook converts net to USDC at a snapshot rate with 1% “crypto settlement” fee. Is FX conversion ledgered? | (a) ledger stays in processing currency; USDC rate/amount recorded on the settlement row as metadata; (b) full FX events + `fx_gain_loss` account | **(a)** — bank/crypto rail is out of scope by your own brief | Phase 3 |
| **D3** | **Chargeback recovery order** when payable goes negative. | (a) payable goes negative, next settlement nets it (reserve untouched until termination); (b) auto-offset from rolling reserve immediately | **(a)** — per 04 §4; (b) is a config flag we can add | Phase 3 |
| **D4** | **Reserve cap semantics** (annex: “10% for 6 months, capped at 250k”). | (a) stop holding once reserve balance ≥ cap, resume when releases drop it below; (b) hold always, release excess above cap | **(a)** | Phase 2/3 |
| **D5** | Settlement cadence & hold defaults. | per-merchant config exists; need platform defaults | weekly cadence, T+2 `settle_after`, min payout 0 | Phase 3 |
| **D6** | **Decline-fee posting granularity.** Annex charges €0.10/decline; the workbook bills them in aggregate. | (a) one ledger event per decline, real-time; (b) daily aggregated fee event per merchant | **(a)** — cleaner audit trail; reports aggregate anyway | Phase 1/2 |
| **D7** | Flat fees priced in a currency ≠ processing currency (annex: €10 refund fee, merchant processes USD). | (a) require per-currency fee schedule rows (fail loud if missing); (b) convert at a configured rate | **(a)** — no FX in the fee path | Phase 2 |
| **D8** | Chargeback fee refundable if merchant wins? | keep / refund | **keep** (industry norm; annex silent) | Phase 3 |
| **D9** | Settlement fee on a failed settlement. | keep (retry doesn’t re-charge) / reverse & re-charge on retry | **keep** | Phase 3 |
| **D10** | Maker–checker beyond adjustments — also for manual settlement generation/cancel and fee-schedule changes? | yes / no | **adjustments only**; others audited but single-actor | Phase 4 |
| **D11** | **Multi-entity gateway.** References show TW Cyprus *and* “Transactworld_US”. One legal entity in the ledger, or per-entity gateway accounts? | (a) single entity; (b) `gateway_entity` dimension on accounts | **(a)** — (b) is an additive migration later, but say so now if it’s real | Phase 1 (account identity) |
| **D12** | Postgres RLS as defense-in-depth on merchant-scoped tables (beyond app-layer scoping). | yes / no | **no** initially; app-layer scoping + mandatory two-merchant tests | Phase 4/5 |
| **D13** | Retention: hot partitions 24 months, archive ≥ 7 years — confirm regulatory numbers. | — | 24 mo hot / 7 y archive | Phase 6 / ops |
| **D14** | **Historical import**: should Phase 2 include importing the existing CSV/Excel books (opening balances + transaction history) as ledgered opening events? | yes (opening-balance events + register import) / no (start clean) | **yes, opening balances at minimum** — otherwise reserve balances (e.g. the 228k RR in the workbook) don’t exist | Phase 2/3 |
| **D15** | Refund initiation from the merchant portal (vs. upstream/processor-only ingestion). | portal-initiated + upstream sync / read-only mirror | **portal-initiated allowed for merchant_admin**, toggle per merchant | Phase 2/5 |
