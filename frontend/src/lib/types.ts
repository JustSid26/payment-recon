// ---- Auth ----
export interface User {
  name: string
  role: 'admin' | 'merchant'
  merchant_uuid: string | null
  merchant_name: string | null
}

export interface LoginResponse {
  token: string
  user: User
}

// ---- Dashboard ----
export interface VolumeRow {
  currency: string
  captured_minor: number
  refunded_minor: number
  fees_minor: number
  net_payable_minor: number
  paid_count: number
  declined_count: number
}

export interface CurrencyAmount {
  currency: string
  amount_minor: number
}

export interface DailyVolumeRow {
  date: string
  currency: string
  captured_minor: number
  declined_count: number
  paid_count: number
}

export interface TopMerchant {
  merchant_uuid: string
  name: string
  currency: string
  captured_minor: number
  txn_count: number
}

export interface Dashboard {
  volume: VolumeRow[]
  merchant_count: number
  quarantine?: { unconfigured_merchants: number; quarantined_transactions: number }
  settlements: { generated: number; completed: number; total_paid_out: CurrencyAmount[] }
  integrity: { events: number; entries: number; unbalanced_events: number; balance_mismatches: number; ok: boolean }
  top_merchants: TopMerchant[]
  daily_volume: DailyVolumeRow[]
}

// ---- Merchants ----
export interface MerchantBalance {
  currency: string
  payable_minor: number
  reserve_minor: number
  in_settlement_minor: number
  paid_minor: number
}

export interface Merchant {
  merchant_uuid: string
  name: string
  member_id: string
  status: string
  email?: string | null
  balances: MerchantBalance[]
  txn_count: number
  quarantined_count?: number
  captured_minor_total: CurrencyAmount[]
}

export interface FeeSchedule {
  mdr_bps: number
  approved_txn_fee_minor: number
  declined_txn_fee_minor: number
  fee_fixed_currency?: string | null
  refund_fee_minor: number
  chargeback_fee_minor: number
  reserve_hold_bps: number
  reserve_hold_days: number
  settlement_fee_bps: number
  settlement_delay_days: number
}

export interface MerchantDetail extends Merchant {
  fee_schedule: FeeSchedule
}

export interface SavedPreset {
  name: string
  mdr_bps: number
  approved_txn_fee_minor: number
  declined_txn_fee_minor: number
  refund_fee_minor: number
  chargeback_fee_minor: number
  reserve_hold_bps: number
  reserve_hold_days: number
  settlement_fee_bps: number
  settlement_delay_days: number
  settlement_schedule: string
}

export interface ReserveStatementRow {
  date: string
  opening_minor: number
  held_minor: number
  released_minor: number
  closing_minor: number
}

export interface ReserveStatement {
  items: ReserveStatementRow[]
  currency: string
  current_reserve_minor: number
}

// ---- Transactions ----
export type TxnStatus =
  | 'captured'
  | 'auth_failed'
  | 'initiated'
  | 'voided'
  | 'refunded'
  | 'partially_refunded'

export interface Transaction {
  transaction_uuid: string
  occurred_at: string
  merchant_uuid: string
  merchant_name: string
  tracking_id: string
  order_id: string
  upstream_payment_id: string
  customer_name: string
  customer_email: string
  payment_brand: string
  payment_mode: string
  card_last_four: string
  currency: string
  auth_minor: number
  captured_minor: number
  refunded_minor: number
  chargeback_minor: number
  status: TxnStatus
  mid: string
  country: string
}

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface Fee {
  fee_type: string
  fee_minor: number
  currency: string
}

export interface LedgerEntry {
  account_label: string
  account_type: string
  direction: 'debit' | 'credit'
  amount_minor: number
}

export interface LedgerEvent {
  event_uuid: string
  event_type: string
  posted_at: string
  currency: string
  entries: LedgerEntry[]
}

export interface TransactionDetail extends Transaction {
  fees: Fee[]
  ledger_events: LedgerEvent[]
}

// ---- Settlements ----
export interface Settlement {
  settlement_uuid: string
  merchant_uuid: string
  merchant_name: string
  currency: string
  window_start: string
  window_end: string
  state: string
  net_payout_minor: number
  paid_count: number
  declined_count: number
  created_at: string
}

export interface SettlementBreakdown {
  gross_captured_minor: number
  mdr_minor: number
  approved_txn_fees_minor: number
  declined_txn_fees_minor: number
  refunds_minor: number
  refund_fees_minor: number
  chargebacks_minor: number
  chargeback_fees_minor: number
  reserve_held_minor: number
  reserve_released_minor: number
  adjustments_minor: number
  subtotal_minor: number
  settlement_fee_minor: number
  net_payout_minor: number
}

export interface SettlementLineItem {
  occurred_at: string
  type: string
  reference: string
  brand: string
  last_four: string
  status: string
  gross_minor: number
  mdr_minor: number
  approved_fee_minor: number
  declined_fee_minor: number
  refund_fee_minor: number
  chargeback_fee_minor: number
  reserve_minor: number
  net_minor: number
}

export type DailyStatus = 'paid' | 'in_settlement' | 'pending' | 'partial'

export interface DailySettlementRow {
  date: string
  approved_count: number
  declined_count: number
  volume: number
  gross_captured_minor: number
  fees_minor: number
  reserve_minor: number
  net_payable_minor: number
  status: DailyStatus
  settlement_uuid: string | null
}

export interface DailySettlementResp {
  currency: string
  currencies: string[]
  days: DailySettlementRow[]
  totals: {
    volume: number
    approved: number
    declined: number
    gross_captured_minor: number
    fees_minor: number
    net_payable_minor: number
    paid_net_minor: number
    remaining_net_minor: number
  }
}

export interface SettlementDetail {
  settlement_uuid: string
  merchant_uuid?: string
  merchant_name: string
  currency: string
  window_start: string
  window_end: string
  state: string
  counts: { paid: number; declined: number; refunds: number; chargebacks: number }
  breakdown: SettlementBreakdown
  fee_schedule?: FeeSchedule
  usdc: { rate: string; amount: string }
  items_count: number
}

export interface GenerateSkipped {
  skipped: true
  reason: string
}

// ---- Ledger ----
export interface LedgerAccount {
  account_id: number | string
  account_type: string
  merchant_uuid: string | null
  merchant_name: string | null
  member_id: string | null
  currency: string
  balance_minor: number
  label: string
}

export interface AccountEntry {
  entry_uuid: string
  posted_at: string
  occurred_at: string
  event_type: string
  event_uuid: string
  direction: 'debit' | 'credit'
  amount_minor: number
  balance_after_minor: number
  currency: string
}

// ---- Ledger, grouped by merchant ----
export interface CcyAmount {
  currency: string
  minor: number
}
export interface LedgerMerchantRow {
  merchant_uuid: string
  name: string
  member_id: string
  status: string
  payable: CcyAmount[]
  reserve: CcyAmount[]
  paid: { currency: string; amount_minor: number }[]
  balanced: boolean
}
export interface PlatformAccount {
  account_id: number
  account_type: string
  currency: string
  balance_minor: number
}
export interface LedgerMerchantsResp {
  merchants: LedgerMerchantRow[]
  platform: PlatformAccount[]
}
export interface LedgerMerchantDetail {
  merchant_uuid: string
  name: string
  member_id: string
  status: string
  accounts: PlatformAccount[]
  payable: CcyAmount[]
  reserve: CcyAmount[]
  paid: { currency: string; amount_minor: number }[]
  balanced: boolean
}
export interface MerchantLedgerEntry extends AccountEntry {
  account_type: string
  account_id: number
}

// 'in_settlement' = every capture that day is attached to a settlement that is still
// `generated` — the payout hasn't been posted to the ledger yet, so it isn't 'paid'.
export type LedgerPayStatus = 'paid' | 'in_settlement' | 'unpaid' | 'na'

export interface MerchantLedgerStatementRow {
  row_id: string
  processed_date: string
  currency: string
  processed_minor: number
  payable_minor: number
  reserve_minor: number
  paid_minor: number
  event_count: number
  pay_status: LedgerPayStatus
  confirmation: string
  confirmed: boolean
}

export interface FxRatesResp {
  base: string
  source: string
  as_of: string
  fallback: boolean
  rates: Record<string, number>
}

// ---- Integrity ----
export interface IntegrityCheck {
  name: string
  ok: boolean
  detail: string
}

export interface IntegrityReport {
  checks: IntegrityCheck[]
  ok: boolean
}

// ---- Admin: status / reset / upload ----
export interface AdminStatus {
  counts: {
    merchants: number
    transactions: number
    ledger_events: number
    ledger_entries: number
    settlements: number
  }
  empty: boolean
}

export interface UploadFileResult {
  file: string
  ok: boolean
  detail: string
  delta?: { txns?: number; captures?: number; declines?: number; refunds?: number }
}

export interface UploadStats {
  txns: number
  captures: number
  declines: number
  refunds: number
  skipped_dupes: number
  unmatched_refunds: number
  quarantined: number
  quarantined_merchants: number
}

export interface UploadIntegrity {
  events: number
  entries: number
  unbalanced_events: number
  balance_mismatches: number
  ok: boolean
}

export interface UploadResult {
  ok: boolean
  files: UploadFileResult[]
  stats: UploadStats
  integrity: UploadIntegrity
  status: AdminStatus
}
