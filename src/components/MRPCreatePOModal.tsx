import { useState, useMemo } from 'react'
import { format } from 'date-fns'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { dbInsert, dbInsertSingle } from '../lib/dbWrite'
import { sanitize } from '../lib/sanitizePayload'
import { fmt$, fmtRate } from '../lib/format'
import { type MRPRow, findSupplierOptions, findDefaultSI, nextPONumber, nextShipmentNumber } from '../lib/mrp'
import { type ConversionMap, getConversionFactorWithDensity } from '../lib/conversions'
import { generatePO_PDF, type POPDFData } from '../lib/generatePO_PDF'
import Modal from './Modal'
import CPBadge from './CPBadge'
import { useToast } from './Toast'
import { FileDown, CheckCircle } from 'lucide-react'
import type {
  Ingredient,
  Supplier,
  SupplierContact,
  SupplierIngredient,
  CoPacker,
  PurchaseOrder,
  PurchaseOrderInsert,
  PurchaseOrderItemInsert,
  ShipmentToCopacker,
  ShipmentItemInsert,
} from '../types/database'

interface MRPCreatePOModalProps {
  isOpen: boolean
  onClose: () => void
  onCreated: () => void
  shortfallRows: MRPRow[]
  coPackerId: string
  cpName: string
  ingredients: Ingredient[]
  suppliers: Supplier[]
  supplierContacts: SupplierContact[]
  supplierIngredients: SupplierIngredient[]
  purchaseOrders: PurchaseOrder[]
  coPackers: CoPacker[]
  conversions: ConversionMap
  productionOrderId?: string | null
}

interface SuggestedSupplier {
  supplierId: string
  supplierName: string
  pricePerUnit: number // converted to inventory unit
}

const UNIT_OPTIONS = ['lbs', 'oz', 'g', 'kg', 'fl_oz', 'ml', 'l', 'gal', 'pcs']

interface LineItem {
  ingredientId: string
  ingredientName: string
  unit: string           // inventory (base) unit
  enteredUnit: string    // user-selected unit for ordering
  quantity: number       // quantity in enteredUnit
  supplierId: string
  unitCost: number
  suggestedSuppliers: SuggestedSupplier[] // linked suppliers sorted by price
  // Package roundup info
  rawNeed?: number       // original need before rounding
  pkgCount?: number      // number of packages
  pkgSize?: number       // size per package
  pkgName?: string       // package name (bag, box, etc.)
}

/* ── Created PO info for confirmation view ──────────────────── */

interface CreatedPO {
  id: string
  po_number: string
  supplierId: string
  supplierName: string
  itemCount: number
  totalCost: number
  pdfData: POPDFData
}

/* ════════════════════════════════════════════════════════════ */

export default function MRPCreatePOModal({
  isOpen,
  onClose,
  onCreated,
  shortfallRows,
  coPackerId,
  cpName,
  ingredients,
  suppliers,
  supplierContacts,
  supplierIngredients,
  purchaseOrders,
  coPackers,
  conversions,
  productionOrderId,
}: MRPCreatePOModalProps) {
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  const [createdPOs, setCreatedPOs] = useState<CreatedPO[]>([])

  // Build editable lines from shortfall rows
  const initialLines = useMemo((): LineItem[] => {
    return shortfallRows
      .filter((r) => r.needToOrder > 0)
      .map((r) => {
        const ing = ingredients.find((i) => i.id === r.ingredientId)

        // Find suggested suppliers (linked via supplier_ingredients)
        const opts = findSupplierOptions(
          r.ingredientId,
          r.unit,
          suppliers,
          supplierIngredients,
          conversions,
          ing?.density_g_per_ml,
        )
        const suggested: SuggestedSupplier[] = opts.map((o) => ({
          supplierId: o.supplierId,
          supplierName: o.supplierName,
          pricePerUnit: o.pricePerUnit,
        }))

        // If a preferred supplier was pre-selected in ProcurementTable, use it;
        // otherwise fall back to the cheapest (first) option
        const preferred = r.preferredSupplierId
          ? suggested.find((s) => s.supplierId === r.preferredSupplierId)
          : undefined
        const best = preferred ?? suggested[0]
        // Fallback price: last_cost -> unit_cost
        const fallbackCost = ing?.last_cost ?? ing?.unit_cost ?? r.unitCost

        // Resolve the SI to use for package info
        // If a specific package (siId) was pre-selected, use that; otherwise use the supplier's default
        let chosenSI: typeof bestSIFallback | undefined
        const bestSIFallback = best ? findDefaultSI(supplierIngredients, best.supplierId, r.ingredientId) : undefined
        if (r.preferredSiId) {
          chosenSI = supplierIngredients.find((si) => si.id === r.preferredSiId)
        }
        if (!chosenSI) chosenSI = bestSIFallback

        const rawNeed = Math.ceil(r.needToOrder)
        let quantity = rawNeed
        let pkgInfo: { pkgCount: number; pkgSize: number; pkgName: string } | null = null

        if (chosenSI?.package_size && chosenSI.package_name) {
          const pkgCount = Math.ceil(rawNeed / chosenSI.package_size)
          quantity = pkgCount * chosenSI.package_size
          pkgInfo = { pkgCount, pkgSize: chosenSI.package_size, pkgName: chosenSI.package_name }
        }

        return {
          ingredientId: r.ingredientId,
          ingredientName: r.ingredientName,
          unit: r.unit,
          enteredUnit: r.unit,
          quantity,
          supplierId: best?.supplierId ?? '',
          unitCost: best?.pricePerUnit ?? fallbackCost,
          suggestedSuppliers: suggested,
          rawNeed: pkgInfo ? rawNeed : undefined,
          pkgCount: pkgInfo?.pkgCount,
          pkgSize: pkgInfo?.pkgSize,
          pkgName: pkgInfo?.pkgName,
        }
      })
  }, [shortfallRows, suppliers, supplierIngredients, conversions, ingredients])

  const [lines, setLines] = useState<LineItem[]>(initialLines)

  // Reset lines and view when modal opens with new data
  const [prevOpen, setPrevOpen] = useState(false)
  if (isOpen && !prevOpen) {
    setLines(initialLines)
    setCreatedPOs([])
  }
  if (isOpen !== prevOpen) setPrevOpen(isOpen)

  // Look up price for a supplier + ingredient combo
  function getSupplierPrice(supplierId: string, ingredientId: string, ingredientUnit: string): number | null {
    const si = findDefaultSI(supplierIngredients, supplierId, ingredientId)
    if (!si || si.price_per_unit == null) return null

    const priceUnit = si.price_unit ?? ingredientUnit
    if (priceUnit === ingredientUnit) return si.price_per_unit

    // Convert price to inventory unit
    try {
      const ing = ingredients.find((i) => i.id === ingredientId)
      const factor = getConversionFactorWithDensity(conversions, priceUnit, ingredientUnit, ing?.density_g_per_ml)
      return si.price_per_unit / factor
    } catch {
      return si.price_per_unit
    }
  }

  /** Convert a quantity from one unit to another for a given ingredient */
  function convertQty(ingredientId: string, qty: number, from: string, to: string): number {
    if (from === to) return qty
    try {
      const ing = ingredients.find((i) => i.id === ingredientId)
      const factor = getConversionFactorWithDensity(conversions, from, to, ing?.density_g_per_ml)
      return qty * factor
    } catch {
      return qty
    }
  }

  /** Get the base-unit quantity for a line (converts enteredUnit -> unit) */
  function baseQty(line: LineItem): number {
    return convertQty(line.ingredientId, line.quantity, line.enteredUnit, line.unit)
  }

  function updateLine(idx: number, field: 'quantity' | 'supplierId' | 'unitCost' | 'enteredUnit', value: string) {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l
        if (field === 'quantity') {
          return { ...l, quantity: Number(value) || 0 }
        }
        if (field === 'unitCost') {
          return { ...l, unitCost: Number(value) || 0 }
        }
        if (field === 'enteredUnit') {
          // Auto-convert qty from old unit to new unit
          const converted = convertQty(l.ingredientId, l.quantity, l.enteredUnit, value)
          return { ...l, enteredUnit: value, quantity: Math.round(converted * 100) / 100 }
        }
        // Change supplier
        const newSupplierId = value
        const ing = ingredients.find((ig) => ig.id === l.ingredientId)

        // Try supplier-specific price, then fall back
        const supplierPrice = getSupplierPrice(newSupplierId, l.ingredientId, l.unit)
        const fallbackCost = ing?.last_cost ?? ing?.unit_cost ?? l.unitCost
        const newCost = supplierPrice ?? fallbackCost

        return {
          ...l,
          supplierId: newSupplierId,
          unitCost: newCost,
        }
      }),
    )
  }

  // Supplier name lookup helper
  function supplierName(id: string): string {
    return suppliers.find((s) => s.id === id)?.name ?? '\u2014'
  }

  // Group lines by supplier for visual grouping and PO count
  const supplierGroups = useMemo(() => {
    const groups = new Map<string, LineItem[]>()
    for (const line of lines) {
      if (!line.supplierId || line.quantity <= 0) continue
      const existing = groups.get(line.supplierId) ?? []
      existing.push(line)
      groups.set(line.supplierId, existing)
    }
    return groups
  }, [lines])

  const grandTotal = lines.reduce((s, l) => s + baseQty(l) * l.unitCost, 0)
  const poCount = supplierGroups.size
  const unassignedCount = lines.filter((l) => !l.supplierId && l.quantity > 0).length

  /* ── Build POPDFData for a created PO ──────────────────────── */

  function buildPDFData(
    poNumber: string,
    supplierId: string,
    groupLines: LineItem[],
  ): POPDFData {
    const sup = suppliers.find((s) => s.id === supplierId)
    const contact = supplierContacts.find((c) => c.supplier_id === supplierId && c.is_primary)
      ?? supplierContacts.find((c) => c.supplier_id === supplierId)
    const cp = coPackers.find((c) => c.id === coPackerId)

    return {
      po_number: poNumber,
      order_type: 'po',
      order_reference: null,
      order_date: format(new Date(), 'yyyy-MM-dd'),
      supplier_name: sup?.name ?? 'Unknown Supplier',
      contact_name: contact?.name ?? null,
      contact_email: contact?.email ?? null,
      contact_phone: contact?.phone ?? null,
      destination_type: 'copacker',
      destination_name: cp?.name ?? null,
      destination_location: cp?.location ?? null,
      receiving_hours: null,
      receiving_notes: null,
      items: groupLines.map((l) => ({
        name: l.ingredientName,
        quantity: baseQty(l),
        unit: l.unit,
        unit_cost: l.unitCost,
        package_name: l.pkgName ?? null,
        package_size: l.pkgSize ?? null,
        package_unit: l.pkgSize ? l.unit : null,
        qty_packages: l.pkgCount ?? null,
      })),
    }
  }

  /* ── Submit: create POs + shipments ────────────────────────── */

  async function handleSubmit() {
    // Validate BEFORE setting loading state
    if (supplierGroups.size === 0) {
      toast.error('No valid items to order \u2014 assign suppliers first')
      return
    }

    setSaving(true)
    try {
      const created: CreatedPO[] = []
      let currentPONumber = nextPONumber(purchaseOrders)
      const today = format(new Date(), 'yyyy-MM-dd')

      // We need shipments for numbering; fetch current shipments
      const { data: currentShipments } = await supabase.from('shipments_to_copacker').select('*')
      let shipmentList: ShipmentToCopacker[] = currentShipments ?? []

      for (const [supplierId, groupLines] of supplierGroups) {
        const poTotal = groupLines.reduce((s, l) => s + baseQty(l) * l.unitCost, 0)

        const po: PurchaseOrderInsert = {
          po_number: currentPONumber,
          supplier_id: supplierId,
          status: 'ordered',
          order_date: today,
          destination_type: 'copacker',
          destination_co_packer_id: coPackerId,
          total_cost: poTotal,
          production_order_id: productionOrderId ?? null,
        }

        const { data: inserted, error } = await dbInsertSingle('purchase_orders', sanitize('purchase_orders', po))

        if (error) throw new Error('PO save failed: ' + error.message)

        if (inserted) {
          const items = groupLines.map((l) => sanitize('purchase_order_items', {
            purchase_order_id: inserted.id,
            ingredient_id: l.ingredientId,
            quantity: baseQty(l),
            unit_cost: l.unitCost,
            quantity_unit: l.unit || null,
            qty_packages: l.pkgCount ?? null,
            package_name: l.pkgName ?? null,
            package_size: l.pkgSize ?? null,
            package_unit: l.pkgSize ? l.unit : null,
          }))
          const { error: itemsErr } = await dbInsert('purchase_order_items', items)
          if (itemsErr) throw new Error('Line items save failed: ' + itemsErr.message)

          // Auto-create shipment for this PO (non-blocking — PO already saved)
          try {
            const shipNum = nextShipmentNumber(shipmentList)
            const sup = suppliers.find((s) => s.id === supplierId)
            const { data: newShipment, error: shipErr } = await dbInsertSingle('shipments_to_copacker',
              sanitize('shipments_to_copacker', {
                shipment_number: shipNum,
                purchase_order_id: inserted.id,
                co_packer_id: coPackerId,
                supplier_id: supplierId,
                status: 'ordered',
                ship_date: null,
                total_value: poTotal,
                cp_confirmed: false,
                production_order_id: productionOrderId ?? null,
                notes: `Auto-created from PO ${currentPONumber} \u2014 ${sup?.name ?? 'Unknown supplier'}`,
              }),
            )

            if (shipErr) console.error('Auto-shipment creation failed:', shipErr)

            if (newShipment) {
              shipmentList = [...shipmentList, newShipment]

              const shipmentItems = items
                .filter((it) => it.ingredient_id)
                .map((it) => sanitize('shipment_items', {
                  shipment_id: newShipment.id,
                  ingredient_id: it.ingredient_id,
                  quantity: it.quantity,
                  value: it.quantity * it.unit_cost,
                }))
              if (shipmentItems.length > 0) {
                const { error: siErr } = await dbInsert('shipment_items', shipmentItems)
                if (siErr) console.error('Shipment items insert failed:', siErr)
              }
            }
          } catch (shipErr) {
            console.error('Auto-shipment creation failed:', shipErr)
            // Don't block — PO was already saved successfully
          }

          // Build PDF data and track created PO
          const pdfData = buildPDFData(currentPONumber, supplierId, groupLines)
          created.push({
            id: inserted.id,
            po_number: currentPONumber,
            supplierId,
            supplierName: supplierName(supplierId),
            itemCount: groupLines.length,
            totalCost: poTotal,
            pdfData,
          })
        }

        // Increment PO number for next group
        const num = parseInt(currentPONumber.replace('#', ''), 10)
        currentPONumber = `#${num + 1}`
      }

      setCreatedPOs(created)
      onCreated()
    } catch (err) {
      console.error('Create POs failed:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to create purchase orders')
    } finally {
      setSaving(false)
    }
  }

  /* ── PDF download helpers ───────────────────────────────────── */

  function handleDownloadPDF(po: CreatedPO) {
    generatePO_PDF(po.pdfData, 'download')
  }

  async function handleDownloadAllPDFs() {
    for (let i = 0; i < createdPOs.length; i++) {
      generatePO_PDF(createdPOs[i].pdfData, 'download')
      // Small delay between downloads so browser doesn't block them
      if (i < createdPOs.length - 1) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }

  /* ── Close handler ──────────────────────────────────────────── */

  function handleClose() {
    setCreatedPOs([])
    onClose()
  }

  // Build the "other suppliers" set (all suppliers NOT in suggestedSuppliers for a line)
  function renderSupplierSelect(line: LineItem, idx: number) {
    const suggestedIds = new Set(line.suggestedSuppliers.map((s) => s.supplierId))
    const otherSuppliers = suppliers.filter((s) => !suggestedIds.has(s.id))
    const hasSuggested = line.suggestedSuppliers.length > 0

    return (
      <select
        value={line.supplierId}
        onChange={(e) => updateLine(idx, 'supplierId', e.target.value)}
        className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-accent"
      >
        {!line.supplierId && (
          <option value="">Select supplier\u2026</option>
        )}
        {hasSuggested && (
          <optgroup label="Suggested">
            {line.suggestedSuppliers.map((s) => {
              const si = findDefaultSI(supplierIngredients, s.supplierId, line.ingredientId)
              const pkgHint = si?.package_size && si.package_unit && si.package_name
                ? ` · ${si.package_size}${si.package_unit} ${si.package_name}s`
                : ''
              return (
                <option key={s.supplierId} value={s.supplierId}>
                  {s.supplierName} ({fmtRate(s.pricePerUnit)}/{line.unit}{pkgHint})
                </option>
              )
            })}
          </optgroup>
        )}
        <optgroup label="All Suppliers">
          {otherSuppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </optgroup>
      </select>
    )
  }

  /* ── Confirmation view (after POs created) ──────────────────── */

  if (createdPOs.length > 0) {
    const totalCost = createdPOs.reduce((s, p) => s + p.totalCost, 0)

    return (
      <Modal isOpen={isOpen} onClose={handleClose} title="" wide>
        <div className="space-y-5">
          {/* Header */}
          <div className="flex items-center gap-3 -mt-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/15">
              <CheckCircle size={22} className="text-green-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text">
                Created {createdPOs.length} Purchase Order{createdPOs.length > 1 ? 's' : ''}
              </h2>
              <p className="text-xs text-muted">
                Total: <span className="font-mono font-medium text-text">{fmt$(totalCost)}</span>
              </p>
            </div>
          </div>

          {/* Status reminder */}
          <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">
            POs created as <span className="font-medium">ordered</span> with shipment tracking auto-created.
          </div>

          {/* PO list */}
          <div className="space-y-2">
            {createdPOs.map((po) => (
              <div
                key={po.id}
                className="flex items-center justify-between rounded-lg border border-border bg-surface/30 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono font-semibold text-accent">{po.po_number}</span>
                  <span className="text-sm text-text">{po.supplierName}</span>
                  <CPBadge coPackerId={coPackerId} />
                  <span className="text-xs text-muted">{po.itemCount} item{po.itemCount > 1 ? 's' : ''}</span>
                  <span className="font-mono text-sm font-medium text-text">{fmt$(po.totalCost)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDownloadPDF(po)}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
                >
                  <FileDown size={14} /> Download PDF
                </button>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between border-t border-border pt-4">
            <Link
              to="/suppliers"
              onClick={handleClose}
              className="text-xs text-accent hover:underline"
            >
              View in Purchase Orders &rarr;
            </Link>
            <div className="flex gap-3">
              {createdPOs.length > 1 && (
                <button
                  type="button"
                  onClick={handleDownloadAllPDFs}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-hover"
                >
                  <FileDown size={16} /> Download All PDFs
                </button>
              )}
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
              >
                Continue Planning
              </button>
            </div>
          </div>
        </div>
      </Modal>
    )
  }

  /* ── Creation form view ─────────────────────────────────────── */

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Purchase Orders" wide>
      <div className="space-y-4">
        <p className="text-xs text-muted">
          Creating POs for shortfall items destined for{' '}
          <span className="font-medium text-text">{cpName}</span>. Items assigned to the same supplier will be grouped into a single PO.
        </p>

        {/* Line items table */}
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border bg-surface/50 text-muted">
                <th className="px-3 py-2 font-medium">Ingredient</th>
                <th className="px-3 py-2 font-medium text-right" style={{ width: 170 }}>Qty</th>
                <th className="px-3 py-2 font-medium" style={{ width: 200 }}>Supplier</th>
                <th className="px-3 py-2 font-medium text-right" style={{ width: 110 }}>Cost/{'{'}unit{'}'}</th>
                <th className="px-3 py-2 font-medium text-right" style={{ width: 100 }}>Line Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => {
                const isConverted = line.enteredUnit !== line.unit
                const bq = baseQty(line)
                return (
                  <tr key={line.ingredientId} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium text-text">
                      {line.ingredientName}{' '}
                      <span className="text-muted font-normal">({line.unit})</span>
                      {line.pkgCount != null && line.rawNeed != null && (
                        <p className="mt-0.5 text-[10px] text-accent font-normal">
                          Need {line.rawNeed.toLocaleString()} {line.unit} → {line.pkgCount} × {line.pkgSize} {line.unit} {line.pkgName}s ({line.quantity.toLocaleString()} {line.unit})
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={line.quantity}
                          onChange={(e) => updateLine(idx, 'quantity', e.target.value)}
                          className="w-20 rounded border border-border bg-surface px-2 py-1 text-right text-xs font-mono text-text outline-none focus:border-accent"
                        />
                        <select
                          value={line.enteredUnit}
                          onChange={(e) => updateLine(idx, 'enteredUnit', e.target.value)}
                          className="w-16 rounded border border-border bg-surface px-1 py-1 text-xs text-text outline-none focus:border-accent"
                        >
                          {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </div>
                      {isConverted && (
                        <p className="mt-0.5 text-[10px] text-accent text-right">
                          = {Math.round(bq * 100) / 100} {line.unit}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {renderSupplierSelect(line, idx)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <span className="text-muted text-[10px]">$</span>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={line.unitCost}
                          onChange={(e) => updateLine(idx, 'unitCost', e.target.value)}
                          className="w-16 rounded border border-border bg-surface px-2 py-1 text-right text-xs font-mono text-text outline-none focus:border-accent"
                        />
                        <span className="text-muted text-[10px]">/{line.unit}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-medium text-text">
                      {fmt$(bq * line.unitCost)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* PO grouping preview */}
        {supplierGroups.size > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">
              PO Preview
            </p>
            {Array.from(supplierGroups.entries()).map(([supId, groupLines]) => (
              <div
                key={supId}
                className="rounded-lg border border-border bg-surface/30 px-3 py-2"
              >
                <p className="text-xs font-medium text-accent">
                  PO to {supplierName(supId)}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {groupLines.map((l) => (
                    <li key={l.ingredientId} className="flex items-center justify-between text-[11px] text-muted">
                      <span>
                        {l.ingredientName} \u2014 {l.quantity.toLocaleString()} {l.enteredUnit}
                        {l.enteredUnit !== l.unit && <span className="text-accent"> ({Math.round(baseQty(l)).toLocaleString()} {l.unit})</span>}
                      </span>
                      <span className="font-mono text-text">{fmt$(baseQty(l) * l.unitCost)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {unassignedCount > 0 && (
              <p className="text-[11px] text-amber-400">
                {unassignedCount} item{unassignedCount > 1 ? 's' : ''} still need a supplier assigned
              </p>
            )}
          </div>
        )}

        {/* Grand total */}
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-sm text-muted">Grand Total</span>
          <span className="font-mono text-lg font-semibold text-text">{fmt$(grandTotal)}</span>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between border-t border-border pt-4">
          <p className="text-[11px] text-muted">
            Don't see your supplier?{' '}
            <Link to="/suppliers" onClick={onClose} className="text-accent hover:underline">
              Add them on the Suppliers & POs page.
            </Link>
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving || poCount === 0}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Creating\u2026' : `Create ${poCount} PO${poCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
