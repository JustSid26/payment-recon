/** Currency exponent: minor units per major. JPY = 0, everything else in the demo = 2. */
export function currencyExponent(currency: string): number {
  return currency === 'JPY' ? 0 : 2
}

/**
 * Format integer minor units as a currency string, e.g. fmtMoney(123456, 'EUR') → "€1,234.56".
 * Division happens only here, at display time — never do float math on amounts.
 */
export function fmtMoney(minor: number, currency?: string | null): string {
  const exp = currencyExponent(currency ?? '')
  const value = minor / 10 ** exp
  if (!currency) {
    return value.toLocaleString('en-US', { minimumFractionDigits: exp, maximumFractionDigits: exp })
  }
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: exp,
      maximumFractionDigits: exp,
    }).format(value)
  } catch {
    return `${currency} ${value.toLocaleString('en-US', {
      minimumFractionDigits: exp,
      maximumFractionDigits: exp,
    })}`
  }
}

/** Format with an explicit sign for statement rows, e.g. "− €12.00". */
export function fmtMoneySigned(minor: number, currency: string): string {
  const abs = fmtMoney(Math.abs(minor), currency)
  return minor < 0 ? `−${abs}` : abs
}

/** Compact major-unit number for chart axes (no currency symbol). */
export function fmtCompact(minor: number, currency: string): string {
  const value = minor / 10 ** currencyExponent(currency)
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function fmtDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function fmtDateTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }) + ' UTC'
}

export function fmtInt(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}
