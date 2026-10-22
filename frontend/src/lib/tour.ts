import type { TourStep } from '../components/Tour'

// Bump the version suffix to re-show the tour to everyone after a big change.
// v2 = the tab-by-tab walkthrough that spotlights each page's real panels.
export const TOUR_VERSION = 'v2'

// Fired by "Take a tour" / the Settings help launcher; Layout listens and opens
// the tour (optionally at a specific step) — lets any page trigger it without
// threading state through props.
export const TOUR_EVENT = 'cs:opentour'

export function openTour(startIndex = 0) {
  window.dispatchEvent(new CustomEvent(TOUR_EVENT, { detail: { startIndex } }))
}

// One-time onboarding walkthrough for a merchant's first sign-in. Each step
// opens the real page and spotlights the actual panel it describes — falling
// back to the sidebar nav item (altTarget) until the panel has loaded.
export const MERCHANT_TOUR: TourStep[] = [
  {
    title: 'Welcome to CoreServices 👋',
    placement: 'center',
    route: '/',
    body: 'This is your settlement portal — track every payout, see what’s held in reserve, and download statements any time. Let’s walk through each page (about 30 seconds). You can skip whenever you like.',
  },
  {
    target: '.money-hero',
    altTarget: '[data-tour="dashboard"]',
    route: '/',
    page: 'Dashboard',
    placement: 'bottom',
    title: 'Dashboard — your money at a glance',
    body: 'These cards are your home page. For each currency they show what’s available to withdraw, what’s still in settlement, and what we hold in reserve.',
  },
  {
    target: '[data-tour="m-settle-filters"]',
    altTarget: '[data-tour="settlements"]',
    route: '/settlements',
    page: 'Settlements',
    placement: 'bottom',
    title: 'Settlements — filter your report',
    body: 'Pick a currency and a date range here and the report below updates instantly. That’s all you need to input — no lists to dig through.',
  },
  {
    target: '[data-tour="m-settle-report"]',
    altTarget: '[data-tour="settlements"]',
    route: '/settlements',
    placement: 'top',
    title: 'Settlements — your payout statement',
    body: 'This is the full statement for the selected payout: gross, fees, reserve and net — with its confirmation code. Export it to CSV or Excel from the buttons on the right.',
  },
  {
    target: '.ledger-dashboard',
    altTarget: '[data-tour="ledger"]',
    route: '/ledger',
    page: 'Ledger',
    placement: 'bottom',
    title: 'Ledger — your running balances',
    body: 'The top panel summarises your balances and totals per currency — a quick health check before you dig into the detail.',
  },
  {
    target: '.ledger-statement-card',
    altTarget: '[data-tour="ledger"]',
    route: '/ledger',
    placement: 'top',
    title: 'Ledger — every movement, line by line',
    body: 'Every payment, fee, refund and payout, each with its settlement and day confirmation codes. Filter by currency, search, and export — so you can reconcile against your own books.',
  },
  {
    target: '.money-hero',
    altTarget: '[data-tour="reserve"]',
    route: '/reserve',
    page: 'Reserve',
    placement: 'bottom',
    title: 'Reserve — rolling reserve held',
    body: 'One card per currency shows the rolling reserve we hold. Click any card to open its full statement of holds and releases.',
  },
  {
    target: '[data-tour="account"]',
    title: 'Your account',
    body: 'Finally, set or change your password here any time. That’s it — you’re all set!',
    placement: 'bottom',
  },
]

// Admin onboarding — a guided walk through every page in the operations
// console, spotlighting the real controls and panels on each one.
export const ADMIN_TOUR: TourStep[] = [
  {
    title: 'Welcome to CoreServices ops 👋',
    placement: 'center',
    route: '/',
    body: 'Let’s walk through the operations console — one stop per page, spotlighting the panel that matters. Skip any time, and replay it (or jump to a single page) later from Settings.',
  },
  {
    target: '.dropzone',
    altTarget: '[data-tour="upload"]',
    route: '/upload',
    page: 'Upload & Verify',
    placement: 'right',
    title: 'Upload & Verify',
    body: 'Start here: drag in a processor’s CSV or settlement workbook, or click to browse. Files are validated and reconciled before anything is written, so bad rows are caught up front.',
  },
  {
    whole: true,
    altTarget: '[data-tour="dashboard"]',
    route: '/',
    page: 'Dashboard',
    title: 'Dashboard',
    body: 'Your bird’s-eye view — headline KPIs, money by currency, the daily volume chart and your top merchants, all summarised across every merchant.',
  },
  {
    whole: true,
    altTarget: '[data-tour="merchants"]',
    route: '/merchants',
    page: 'Merchants',
    title: 'Merchants — click a row to open one',
    body: 'Every merchant account. Click any merchant to open its profile — let’s open one now and see what you can configure.',
  },
  {
    target: '[data-tour="md-fees"]',
    altTarget: '[data-tour="merchants"]',
    route: '/merchants/:merchant',
    placement: 'right',
    title: 'Set the merchant’s fees',
    body: 'Inside a merchant, this is its fee schedule — approved, declined, refund and chargeback fees plus the settlement %. Click “Set fees” / “Edit fees” to change them; saving posts the merchant’s held transactions to the ledger.',
  },
  {
    target: '[data-tour="md-generate"]',
    altTarget: '[data-tour="merchants"]',
    route: '/merchants/:merchant',
    placement: 'bottom',
    title: 'Generate the settlement report',
    body: 'And right here you generate this merchant’s settlement — whole-window or day-wise — with a custom confirmation code. That produces the payout report you can send them.',
  },
  {
    whole: true,
    altTarget: '[data-tour="transactions"]',
    route: '/transactions',
    page: 'Transactions',
    title: 'Transactions',
    body: 'Every payment, refund and chargeback across all merchants. Filter with the controls up top, then click any transaction to see its exact ledger postings.',
  },
  {
    whole: true,
    altTarget: '[data-tour="settlements"]',
    route: '/settlements',
    page: 'Settlements',
    title: 'Settlements',
    body: 'Generate and manage payouts — whole-window or day-wise. Mark days paid, and send the merchant their payout confirmation with its statement PDF.',
  },
  {
    whole: true,
    altTarget: '[data-tour="rolling-reserve"]',
    route: '/rolling-reserve',
    page: 'Rolling reserve',
    title: 'Rolling reserve',
    body: 'The rolling reserve held and released per merchant and currency — the funds parked against future chargebacks. Search a merchant, or filter to just those with a reserve held.',
  },
  {
    whole: true,
    altTarget: '[data-tour="ledger"]',
    route: '/ledger',
    page: 'Ledger',
    title: 'Ledger',
    body: 'The double-entry source of truth. Open a merchant or an account to see every posting; each settlement and day code traces back to the exact entries behind it.',
  },
  {
    target: '.settings-form',
    altTarget: '[data-tour="settings"]',
    route: '/settings',
    page: 'Settings',
    placement: 'right',
    title: 'Settings',
    body: 'Configure the account that sends payout-confirmation emails, send a test, and re-open this tour any time from the help panel at the top.',
  },
  {
    title: 'You’re all set 🎉',
    placement: 'center',
    body: 'That’s the whole console. Reset the demo data any time from the top bar, and replay this tour — or any single page — from Settings.',
  },
]
