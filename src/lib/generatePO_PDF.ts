import jsPDF from 'jspdf'
import { fmt$, fmtRate } from './format'

/* ── Types ──────────────────────────────────────────────────── */

export interface POPDFData {
  po_number: string
  order_type?: string              // defaults to 'po'
  order_reference?: string | null
  order_date: string | null       // ISO "YYYY-MM-DD"
  supplier_name: string
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  destination_type: 'warehouse' | 'copacker' | string
  destination_name: string | null // co-packer name
  destination_location: string | null // co-packer location
  receiving_hours: string | null
  receiving_notes: string | null
  items: {
    name: string
    supplier_item_name?: string | null
    supplier_sku?: string | null
    quantity: number
    unit: string
    unit_cost: number
    package_name?: string | null
    package_size?: number | null
    package_unit?: string | null
    qty_packages?: number | null
  }[]
  shipping_cost?: number | null
  shipping_method?: string | null
  shipping_carrier?: string | null
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

/* ── PDF generator ───────────────────────────────────────────── */

export function generatePO_PDF(data: POPDFData, action: 'download' | 'print' = 'download') {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 20
  const contentW = pageW - margin * 2
  const bottomLimit = pageH - 25 // leave room for page number

  // Colors
  const brand = '#E91E7B'
  const black = '#333333'
  const grey = '#666666'
  const headerBg = brand
  const altRowBg = '#F9FAFB'
  const lineBorder = '#D1D5DB'

  const isNonPO = data.order_type && data.order_type !== 'po'
  const docTitle = isNonPO ? 'ORDER CONFIRMATION' : 'PURCHASE ORDER'

  /* ── SECTION 1: HEADER ──────────────────────────────────────── */

  let y = margin

  // Left: FitBake
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(brand)
  doc.text('FitBake', margin, y + 6)

  // Right: Document title
  doc.setFontSize(16)
  doc.text(docTitle, pageW - margin, y + 6, { align: 'right' })

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

  // Right: PO info (fixed right column, same vertical area as address)
  const infoBlockX = pageW - margin - 75
  const infoValX = infoBlockX + 32
  let infoY = margin + 12
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(black)
  doc.text(isNonPO ? 'Order #:' : 'P.O. #:', infoBlockX, infoY)
  doc.setFont('helvetica', 'normal')
  doc.text(data.po_number, infoValX, infoY)

  infoY += 5
  doc.setFont('helvetica', 'bold')
  doc.text('Date:', infoBlockX, infoY)
  doc.setFont('helvetica', 'normal')
  doc.text(fmtDateMMDDYYYY(data.order_date), infoValX, infoY)

  if (data.order_reference) {
    infoY += 5
    doc.setFont('helvetica', 'bold')
    doc.text('Reference:', infoBlockX, infoY)
    doc.setFont('helvetica', 'normal')
    doc.text(data.order_reference, infoValX, infoY)
  }

  // Ensure y is past both address and PO info blocks
  y = Math.max(y, infoY) + 5

  /* ── SECTION 2: HORIZONTAL DIVIDER ──────────────────────────── */

  y += 3
  doc.setDrawColor(brand)
  doc.setLineWidth(0.3)
  doc.line(margin, y, pageW - margin, y)
  y += 8

  /* ── SECTION 3: VENDOR / SHIP TO ────────────────────────────── */

  const leftColX = margin
  const rightColX = pageW / 2 + 10

  // VENDOR label
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(black)
  doc.text('VENDOR', leftColX, y)

  // SHIP TO label
  doc.text('SHIP TO', rightColX, y)

  y += 6

  // Vendor details
  let vendorY = y
  doc.setFontSize(9)
  if (data.supplier_name) {
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(black)
    doc.text(data.supplier_name, leftColX, vendorY)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(grey)
    vendorY += 4.5
  }
  if (data.contact_name) {
    doc.text(data.contact_name, leftColX, vendorY)
    vendorY += 4.5
  }
  if (data.contact_email) {
    doc.text(data.contact_email, leftColX, vendorY)
    vendorY += 4.5
  }
  if (data.contact_phone) {
    doc.text(data.contact_phone, leftColX, vendorY)
    vendorY += 4.5
  }

  // Ship To details
  let shipY = y
  if (data.destination_name) {
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(black)
    doc.text(data.destination_name, rightColX, shipY)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(grey)
    shipY += 4.5
    doc.text('Attn: FitBake', rightColX, shipY)
    shipY += 4.5
    if (data.destination_location) {
      doc.text(data.destination_location, rightColX, shipY)
      shipY += 4.5
    }
    if (data.receiving_hours) {
      shipY += 1
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(black)
      doc.text('Receiving Hours:', rightColX, shipY)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(grey)
      shipY += 4.5
      doc.text(data.receiving_hours, rightColX, shipY)
      shipY += 4.5
    }
    if (data.receiving_notes) {
      doc.setFont('helvetica', 'italic')
      doc.text(data.receiving_notes, rightColX, shipY)
      doc.setFont('helvetica', 'normal')
      shipY += 4.5
    }
  } else {
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(black)
    doc.text('FitBake', rightColX, shipY)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(grey)
    shipY += 4.5
  }

  y = Math.max(vendorY, shipY) + 10

  /* ── SECTION 4: ITEMS TABLE ─────────────────────────────────── */

  // Check if any items have package info — use expanded columns if so
  const anyPkg = data.items.some((it) => it.qty_packages != null && it.qty_packages > 0 && it.package_size != null && it.package_name)

  const cols: { label: string; w: number; align: 'left' | 'right' }[] = anyPkg
    ? [
        { label: 'ITEM', w: contentW * 0.30, align: 'left' },
        { label: 'PKG', w: contentW * 0.15, align: 'left' },
        { label: 'QTY (PKGS)', w: contentW * 0.12, align: 'right' },
        { label: 'QTY (WEIGHT)', w: contentW * 0.15, align: 'right' },
        { label: 'RATE/PKG', w: contentW * 0.14, align: 'right' },
        { label: 'AMOUNT', w: contentW * 0.14, align: 'right' },
      ]
    : [
        { label: 'ITEM', w: contentW * 0.55, align: 'left' },
        { label: 'QTY', w: contentW * 0.15, align: 'right' },
        { label: 'RATE', w: contentW * 0.15, align: 'right' },
        { label: 'AMOUNT', w: contentW * 0.15, align: 'right' },
      ]

  const headerH = 7
  const cellPad = 2

  function drawTableHeader() {
    doc.setFillColor(headerBg)
    doc.rect(margin, y, contentW, headerH, 'F')
    doc.setDrawColor(lineBorder)
    doc.setLineWidth(0.2)
    doc.line(margin, y + headerH, pageW - margin, y + headerH)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(anyPkg ? 7 : 8)
    doc.setTextColor('#FFFFFF')

    let cx = margin
    for (const col of cols) {
      const tx = col.align === 'right' ? cx + col.w - cellPad : cx + cellPad
      doc.text(col.label, tx, y + headerH - 2, { align: col.align === 'right' ? 'right' : 'left' })
      cx += col.w
    }
    y += headerH
  }

  drawTableHeader()

  // Draw item rows
  let grandTotal = 0

  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i]
    const amount = item.quantity * item.unit_cost
    grandTotal += amount

    // Build display name
    let displayName = item.supplier_item_name ?? item.name
    if (item.supplier_sku) {
      displayName += ` (SKU: ${item.supplier_sku})`
    }

    const hasPkg = item.qty_packages != null && item.qty_packages > 0 && item.package_size != null && item.package_name
    const itemColW = cols[0].w - cellPad * 2
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    const nameLines = doc.splitTextToSize(displayName, itemColW) as string[]
    const nameH = nameLines.length * 4
    const rowH = Math.max(7, 3 + nameH + 2)

    // Page overflow: add new page and repeat header
    if (y + rowH > bottomLimit) {
      doc.addPage()
      y = margin
      drawTableHeader()
    }

    // Alternating row background
    if (i % 2 === 1) {
      doc.setFillColor(altRowBg)
      doc.rect(margin, y, contentW, rowH, 'F')
    }

    // Bottom border
    doc.setDrawColor(lineBorder)
    doc.setLineWidth(0.1)
    doc.line(margin, y + rowH, pageW - margin, y + rowH)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(black)

    if (anyPkg) {
      // Expanded 6-column layout
      let cx = margin

      // Col 0: ITEM
      const tx0 = cx + cellPad
      let textY = y + 5
      for (const nameLine of nameLines) {
        doc.text(nameLine, tx0, textY, { align: 'left' })
        textY += 4
      }
      cx += cols[0].w

      // Col 1: PKG
      const tx1 = cx + cellPad
      const cellY = y + rowH / 2 + 1.5
      if (hasPkg) {
        doc.setFontSize(8)
        doc.text(`${item.package_size} ${item.package_unit ?? item.unit} ${item.package_name}`, tx1, cellY, { align: 'left' })
        doc.setFontSize(9)
      } else {
        doc.setFontSize(8)
        doc.setTextColor(grey)
        doc.text('\u2014', tx1, cellY, { align: 'left' })
        doc.setTextColor(black)
        doc.setFontSize(9)
      }
      cx += cols[1].w

      // Col 2: QTY (PKGS)
      const tx2 = cx + cols[2].w - cellPad
      if (hasPkg) {
        doc.text(String(item.qty_packages), tx2, cellY, { align: 'right' })
      } else {
        doc.setTextColor(grey)
        doc.text('\u2014', tx2, cellY, { align: 'right' })
        doc.setTextColor(black)
      }
      cx += cols[2].w

      // Col 3: QTY (WEIGHT)
      const tx3 = cx + cols[3].w - cellPad
      const qtyStr = item.quantity.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + ' ' + item.unit
      doc.text(qtyStr, tx3, cellY, { align: 'right' })
      cx += cols[3].w

      // Col 4: RATE/PKG
      const tx4 = cx + cols[4].w - cellPad
      if (hasPkg) {
        const ratePerPkg = item.unit_cost * item.package_size!
        doc.text(fmtCurrency(ratePerPkg), tx4, cellY, { align: 'right' })
      } else {
        doc.text(fmtUnitCost(item.unit_cost) + '/' + item.unit, tx4, cellY, { align: 'right' })
      }
      cx += cols[4].w

      // Col 5: AMOUNT
      const tx5 = cx + cols[5].w - cellPad
      doc.text(fmtCurrency(amount), tx5, cellY, { align: 'right' })
    } else {
      // Original 4-column layout
      const qtyStr = item.quantity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + item.unit
      const rate = fmtUnitCost(item.unit_cost) + '/' + item.unit
      const values = [displayName, qtyStr, rate, fmtCurrency(amount)]

      let cx = margin
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c]
        const tx = col.align === 'right' ? cx + col.w - cellPad : cx + cellPad

        if (c === 0) {
          let textY = y + 5
          for (const nameLine of nameLines) {
            doc.text(nameLine, tx, textY, { align: 'left' })
            textY += 4
          }
        } else {
          const cellY = y + rowH / 2 + 1.5
          doc.text(values[c], tx, cellY, { align: col.align === 'right' ? 'right' : 'left' })
        }
        cx += col.w
      }
    }
    y += rowH
  }

  // Totals area
  const totalValueX = margin + contentW - cellPad
  const totalLabelX = totalValueX - 40
  const hasShipping = data.shipping_cost != null && data.shipping_cost > 0

  // Check for page overflow before totals
  const totalsHeight = hasShipping ? 24 : 10
  if (y + totalsHeight > bottomLimit) {
    doc.addPage()
    y = margin
  }

  if (hasShipping) {
    // Subtotal
    y += 3
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(grey)
    doc.text('Subtotal', totalLabelX, y, { align: 'right' })
    doc.setTextColor(black)
    doc.text(fmtCurrency(grandTotal), totalValueX, y, { align: 'right' })
    y += 5

    // Shipping
    const shippingLabel = data.shipping_method
      ? `Shipping (${data.shipping_method}${data.shipping_carrier ? ' \u2014 ' + data.shipping_carrier : ''})`
      : 'Shipping'
    doc.setTextColor(grey)
    doc.text(shippingLabel, totalLabelX, y, { align: 'right' })
    doc.setTextColor(black)
    doc.text(fmtCurrency(data.shipping_cost!), totalValueX, y, { align: 'right' })
    y += 3

    // Divider line above total
    doc.setDrawColor(lineBorder)
    doc.setLineWidth(0.3)
    doc.line(totalLabelX - 20, y, pageW - margin, y)
    y += 5

    // Grand total
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(brand)
    doc.text('TOTAL', totalLabelX, y, { align: 'right' })
    doc.setTextColor(black)
    doc.text(fmtCurrency(grandTotal + data.shipping_cost!), totalValueX, y, { align: 'right' })
    y += 15
  } else {
    // Divider line
    y += 2
    doc.setDrawColor(lineBorder)
    doc.setLineWidth(0.3)
    doc.line(totalLabelX - 20, y, pageW - margin, y)
    y += 5

    // Total
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(brand)
    doc.text('TOTAL', totalLabelX, y, { align: 'right' })
    doc.setTextColor(black)
    doc.text(fmtCurrency(grandTotal), totalValueX, y, { align: 'right' })
    y += 15
  }

  /* ── SECTION 5: FOOTER ──────────────────────────────────────── */

  // Check for page overflow
  if (y + 35 > bottomLimit) {
    doc.addPage()
    y = margin
  }

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(black)
  doc.text('Approved By: ___________________________', margin, y)
  doc.text('Date: _______________', pageW - margin - 60, y)

  y += 20

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

  const safeName = data.supplier_name.replace(/[^a-zA-Z0-9]/g, '_')
  const poNum = data.po_number.replace('#', '')
  const filePrefix = isNonPO ? 'ORD' : 'PO'
  const filename = `${filePrefix}${poNum}_FitBake_${safeName}.pdf`

  if (action === 'print') {
    const blob = doc.output('blob')
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
  } else {
    doc.save(filename)
  }
}
