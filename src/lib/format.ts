import { format } from 'date-fns'

/** Format number with commas: 12345 → "12,345" */
export function fmtNum(v: number | null | undefined): string {
  if (v == null) return '—'
  return v.toLocaleString('en-US')
}

/** Format currency: 1234.5 → "$1,234.50" (always 2 decimals — for totals, amounts) */
export function fmt$(v: number | null | undefined): string {
  if (v == null) return '—'
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Format unit cost with full precision: $3.20, $3.1845, $0.048 (up to 4 decimals, no trailing zeros — for rates) */
export function fmtRate(v: number | null | undefined): string {
  if (v == null) return '—'
  // Determine how many decimals we need (min 2, max 4, strip trailing zeros beyond 2)
  const s = v.toFixed(4)
  const trimmed = s.replace(/0+$/, '')
  const dotIdx = trimmed.indexOf('.')
  const decimals = dotIdx >= 0 ? trimmed.length - dotIdx - 1 : 0
  const dp = Math.max(2, decimals)
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}

/** Format percentage: 2.345 → "2.3%" */
export function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${v.toFixed(1)}%`
}

/** Format quantity with unit: fmtQty(750, 'lbs') → "750 lbs", fmtQty(12.345, 'oz') → "12.3 oz" */
export function fmtQty(v: number, unit: string): string {
  if (unit === 'pcs' || unit === 'each') {
    return `${Math.round(v).toLocaleString('en-US')} ${unit}`
  }
  const formatted = v % 1 === 0
    ? v.toLocaleString('en-US')
    : v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return `${formatted} ${unit}`
}

/** Format procurement quantity: 0 → null, else "500.0 lbs" / "12 pcs" */
export function fmtProcQty(v: number, unit: string): string | null {
  if (!v || v === 0) return null
  if (unit === 'pcs' || unit === 'each') return `${Math.round(v).toLocaleString('en-US')} ${unit}`
  return `${v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`
}

/** Format date string: "2026-02-12" → "Feb 12, 2026" */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  return format(new Date(d + 'T00:00:00'), 'MMM d, yyyy')
}

/** Format date from Date or ISO string */
export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  return format(date, 'MMM d, yyyy')
}
