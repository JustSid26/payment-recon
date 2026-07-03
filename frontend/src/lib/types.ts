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
}

export interface Merchant {
  merchant_uuid: string
  name: string
  member_id: string
  status: string
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
}

export interface MerchantDetail extends Merchant {
  fee_schedule: FeeSchedule
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
  currency: string
  balance_minor: number
  label: string
}

export interface AccountEntry {
  entry_uuid: string
  posted_at: string
  event_type: string
  event_uuid: string
  direction: 'debit' | 'credit'
  amount_minor: number
  balance_after_minor: number
  currency: string
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
