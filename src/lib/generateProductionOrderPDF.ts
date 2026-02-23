import jsPDF from 'jspdf'
import { fmt$, fmtRate } from './format'

/* ── Types ──────────────────────────────────────────────────── */

export interface ProductionOrderPDFData {
  order_number: string
  order_date: string | null
  co_packer_name: string
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  co_packer_location: string | null
  receiving_hours: string | null
  receiving_notes: string | null
  priority: string
  notes: string | null
  cp_fee_per_unit: number
  items: {
    sku: string
    product_name: string
    quantity: number
    image_url?: string | null
    co_packer_color?: string | null
  }[]
}

/* ── Helpers ─────────────────────────────────────────────────── */

function fmtCurrency(v: number): string {
  return fmt$(v)
}

function fmtUnitCost(v: number): string {
  return fmtRate(v)
}

function fmtDateMMDDYYYY(iso: string | null): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${m}/${d}/${y}`
}

function drawLetterPlaceholder(
  doc: jsPDF,
  item: { product_name: string; co_packer_color?: string | null },
  x: number,
  y: number,
  size: number,
) {
  const hex = item.co_packer_color ?? '#3B82F6'
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  doc.setFillColor(r, g, b)
  doc.roundedRect(x, y, size, size, 1, 1, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(255, 255, 255)
  const letter = (item.product_name[0] ?? '?').toUpperCase()
  doc.text(letter, x + size / 2, y + size / 2 + 2, { align: 'center' })
}

/* ── PDF generator ───────────────────────────────────────────── */

async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

export async function generateProductionOrderPDF(
  data: ProductionOrderPDFData,
  action: 'download' | 'print' = 'download',
) {
  // Pre-fetch all item images
  const imageDataUrls = await Promise.all(
    data.items.map((item) =>
      item.image_url ? fetchImageAsDataUrl(item.image_url) : Promise.resolve(null),
    ),
  )
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 20
  const contentW = pageW - margin * 2
  let y = margin

  const brand = '#E91E7B'
  const black = '#333333'
  const grey = '#666666'
  const headerBg = brand
  const altRowBg = '#F5F5F5'
  const lineBorder = '#CCCCCC'

  const headerH = 8
  const cellPad = 2

  /* ── SECTION 1: HEADER ────────────────────────────────────── */

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(brand)
  doc.text('FitBake', margin, y + 6)

  doc.setFontSize(16)
  doc.text('PRODUCTION ORDER', pageW - margin, y + 6, { align: 'right' })

  y += 12

  // Left: Company address
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(black)
  const addressLines = [
    '32 Traveler St, Ph 5',
    'Boston, MA 02118-2844 USA',
    'info@shopfitbake.com',
    'www.shopfitbake.com',
  ]
  for (const line of addressLines) {
    doc.text(line, margin, y)
    y += 4
  }

  // Right: Order info (same vertical area as address)
  const infoX = pageW - margin - 75
  const infoValX = infoX + 32
  let infoY = margin + 12

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(black)
  doc.text('Order #:', infoX, infoY)
  doc.setFont('helvetica', 'normal')
  doc.text(data.order_number, infoValX, infoY)

  infoY += 5
  doc.setFont('helvetica', 'bold')
  doc.text('Date:', infoX, infoY)
  doc.setFont('helvetica', 'normal')
  doc.text(fmtDateMMDDYYYY(data.order_date), infoValX, infoY)

  if (data.priority !== 'normal') {
    infoY += 5
    doc.setFont('helvetica', 'bold')
    doc.text('Priority:', infoX, infoY)
    doc.setFont('helvetica', 'normal')
    doc.text(data.priority.toUpperCase(), infoValX, infoY)
  }

  y = Math.max(y, infoY) + 5

  /* ── SECTION 2: DIVIDER ─────────────────────────────────────── */

  y += 3
  doc.setDrawColor(brand)
  doc.setLineWidth(0.3)
  doc.line(margin, y, pageW - margin, y)
  y += 8

  /* ── SECTION 3: TO (co-packer) ──────────────────────────────── */

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(black)
  doc.text('TO', margin, y)

  y += 6
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.text(data.co_packer_name, margin, y)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(grey)
  y += 4.5

  if (data.contact_name) {
    doc.text(data.contact_name, margin, y)
    y += 4.5
  }
  if (data.contact_email) {
    doc.text(data.contact_email, margin, y)
    y += 4.5
  }
  if (data.contact_phone) {
    doc.text(data.contact_phone, margin, y)
    y += 4.5
  }
  if (data.co_packer_location) {
    doc.text(data.co_packer_location, margin, y)
    y += 4.5
  }
  if (data.receiving_hours) {
    y += 1
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(black)
    doc.text('Receiving Hours:', margin, y)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(grey)
    y += 4.5
    doc.text(data.receiving_hours, margin, y)
    y += 4.5
  }
  if (data.receiving_notes) {
    doc.setFont('helvetica', 'italic')
    doc.text(data.receiving_notes, margin, y)
    doc.setFont('helvetica', 'normal')
    y += 4.5
  }

  y += 8

  /* ── ITEMS TABLE ───────────────────────────────────────────── */

  const imgColW = 14
  const tableW = contentW - imgColW
  const cols: { label: string; w: number; align: 'left' | 'right' }[] = [
    { label: 'SKU', w: tableW * 0.15, align: 'left' },
    { label: 'PRODUCT NAME', w: tableW * 0.35, align: 'left' },
    { label: 'QTY (UNITS)', w: tableW * 0.18, align: 'right' },
    { label: 'COST/UNIT', w: tableW * 0.16, align: 'right' },
    { label: 'LINE TOTAL', w: tableW * 0.16, align: 'right' },
  ]

  const productRowH = 12 // taller for thumbnails

  // Header row
  doc.setFillColor(headerBg)
  doc.rect(margin, y, contentW, headerH, 'F')
  doc.setDrawColor(lineBorder)
  doc.rect(margin, y, contentW, headerH, 'S')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor('#FFFFFF')

  let colX = margin + imgColW
  for (const col of cols) {
    const tx = col.align === 'right' ? colX + col.w - cellPad : colX + cellPad
    doc.text(col.label, tx, y + headerH - 2.5, { align: col.align === 'right' ? 'right' : 'left' })
    colX += col.w
  }
  y += headerH

  // Data rows
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  let grandTotal = 0
  let totalUnits = 0

  const imgSize = 10
  const imgPad = (productRowH - imgSize) / 2
  const cpFee = data.cp_fee_per_unit

  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i]
    const costPerUnit = cpFee
    const lineTotal = item.quantity * costPerUnit
    grandTotal += lineTotal
    totalUnits += item.quantity

    if (y + productRowH > pageH - 25) {
      doc.addPage()
      y = margin
    }

    if (i % 2 === 1) {
      doc.setFillColor(altRowBg)
      doc.rect(margin, y, contentW, productRowH, 'F')
    }
    doc.setDrawColor(lineBorder)
    doc.rect(margin, y, contentW, productRowH, 'S')

    // Image thumbnail or letter placeholder
    const imgX = margin + (imgColW - imgSize) / 2
    const imgY = y + imgPad
    const dataUrl = imageDataUrls[i]
    if (dataUrl) {
      try {
        doc.addImage(dataUrl, imgX, imgY, imgSize, imgSize)
      } catch {
        drawLetterPlaceholder(doc, item, imgX, imgY, imgSize)
      }
    } else {
      drawLetterPlaceholder(doc, item, imgX, imgY, imgSize)
    }

    doc.setTextColor(black)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    colX = margin + imgColW

    const values = [
      item.sku,
      item.product_name,
      item.quantity.toLocaleString(),
      fmtUnitCost(costPerUnit),
      fmtCurrency(lineTotal),
    ]

    for (let c = 0; c < cols.length; c++) {
      const col = cols[c]
      const tx = col.align === 'right' ? colX + col.w - cellPad : colX + cellPad
      doc.text(values[c], tx, y + productRowH / 2 + 1.5, { align: col.align === 'right' ? 'right' : 'left' })
      colX += col.w
    }
    y += productRowH
  }

  // Total row
  const totalRowH = productRowH + 1
  doc.setFillColor(headerBg)
  doc.rect(margin, y, contentW, totalRowH, 'F')
  doc.setDrawColor(lineBorder)
  doc.rect(margin, y, contentW, totalRowH, 'S')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor('#FFFFFF')

  const dataColStart = margin + imgColW
  const qtyX = dataColStart + cols[0].w + cols[1].w + cols[2].w - cellPad
  doc.text(totalUnits.toLocaleString(), qtyX, y + totalRowH / 2 + 1.5, { align: 'right' })

  const totalLabelX = dataColStart + cols[0].w + cols[1].w - cellPad
  doc.text('TOTAL', totalLabelX, y + totalRowH / 2 + 1.5, { align: 'right' })

  const totalValueX = margin + contentW - cellPad
  doc.text(fmtCurrency(grandTotal), totalValueX, y + totalRowH / 2 + 1.5, { align: 'right' })

  y += totalRowH + 10

  /* ── NOTES ─────────────────────────────────────────────────── */

  if (data.notes) {
    if (y + 20 > pageH - 25) { doc.addPage(); y = margin }
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(black)
    doc.text('Notes:', margin, y)
    y += 5
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(grey)
    const noteLines = doc.splitTextToSize(data.notes, contentW)
    doc.text(noteLines, margin, y)
    y += noteLines.length * 4 + 6
  }

  /* ── FOOTER ────────────────────────────────────────────────── */

  if (y + 35 > pageH - 25) { doc.addPage(); y = margin }

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(black)
  doc.text('Approved By: ___________________________', margin, y)
  y += 8
  doc.text('Date: ___________________________', margin, y)
  y += 12

  doc.setFont('helvetica', 'italic')
  doc.setFontSize(10)
  doc.setTextColor(grey)
  doc.text('Thank you for your business!', pageW / 2, y, { align: 'center' })

  // Page numbers on all pages
  const totalPages = doc.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(grey)
    doc.text(`Page ${p} of ${totalPages}`, pageW / 2, pageH - 10, { align: 'center' })
  }

  /* ── Output ────────────────────────────────────────────────── */

  const safeCPName = data.co_packer_name.replace(/[^a-zA-Z0-9]/g, '_')
  const orderNum = data.order_number.replace(/[^a-zA-Z0-9-]/g, '')
  const filename = `${orderNum}_FitBake_${safeCPName}.pdf`

  if (action === 'print') {
    const blob = doc.output('blob')
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
  } else {
    doc.save(filename)
  }
}
