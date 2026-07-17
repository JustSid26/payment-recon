/**
 * Zero-dependency exporters for settlement statements and line items.
 *  - CSV  → text/csv, opens in Excel/Sheets/Numbers
 *  - Excel → SpreadsheetML 2003 (.xls) — a genuine workbook (bold header, number
 *            formats), not an HTML-table hack. Opens natively in Excel.
 *  - PDF  → the browser's own print-to-PDF, scoped to the statement via @media print.
 * Money cells are passed as major-unit numbers so spreadsheets treat them as numbers.
 */
import { currencyExponent } from './money'

/** Integer minor units → major-unit number (e.g. 123456 EUR → 1234.56). */
export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency)
}

type Cell = string | number

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function downloadCSV(filename: string, rows: Cell[][]) {
  const esc = (v: Cell) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n')
  // BOM so Excel reads UTF-8 correctly
  triggerDownload(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }), filename)
}

const xmlEsc = (v: Cell) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * One-sheet Excel workbook. Row 0 is treated as a bold header. Numeric cells get a
 * thousands + 2-decimal format; pass money as major-unit numbers (see toMajor).
 */
export function downloadExcel(filename: string, sheetName: string, rows: Cell[][]) {
  const cell = (v: Cell, header: boolean) => {
    const isNum = typeof v === 'number' && Number.isFinite(v)
    const type = isNum ? 'Number' : 'String'
    const style = header ? ' ss:StyleID="hdr"' : isNum ? ' ss:StyleID="num"' : ''
    return `<Cell${style}><Data ss:Type="${type}">${xmlEsc(v)}</Data></Cell>`
  }
  const body = rows
    .map((r, i) => `<Row>${r.map((c) => cell(c, i === 0)).join('')}</Row>`)
    .join('')
  const xml =
    `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ` +
    `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n` +
    `<Styles>` +
    `<Style ss:ID="hdr"><Font ss:Bold="1"/>` +
    `<Interior ss:Color="#F2F4F7" ss:Pattern="Solid"/></Style>` +
    `<Style ss:ID="num"><NumberFormat ss:Format="#,##0.00"/></Style>` +
    `</Styles>\n` +
    `<Worksheet ss:Name="${xmlEsc(sheetName).slice(0, 31)}"><Table>${body}</Table></Worksheet>\n` +
    `</Workbook>`
  triggerDownload(new Blob([xml], { type: 'application/vnd.ms-excel' }), filename)
}

/**
 * Print-to-PDF. Adds a body class so @media print isolates the element with
 * `data-print="statement"`, opens the print dialog, then restores. The user picks
 * "Save as PDF" (every modern browser/OS offers this).
 */
export function printToPDF() {
  document.body.classList.add('printing-statement')
  const cleanup = () => {
    document.body.classList.remove('printing-statement')
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  window.print()
  // The class only affects @media print, so a lingering value is harmless if
  // afterprint never fires — no timed cleanup needed (it could race the dialog).
}

/** Print-to-PDF scoped to an open Modal (isolates `.modal-overlay` via @media print). */
export function printModal() {
  document.body.classList.add('printing-modal')
  const cleanup = () => {
    document.body.classList.remove('printing-modal')
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  window.print()
}
