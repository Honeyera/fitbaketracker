import { useEffect, useMemo, useState } from 'react'
import { fmt$, fmtProcQty } from '../lib/format'
import { ShoppingCart, ExternalLink } from 'lucide-react'
import {
  resolveIngredientSupplier,
  buildPackageOptionsForSupplier,
  type ResolvedSupplierInfo,
  type PackageOption,
} from '../lib/mrp'
import type { ProcurementRow, ProcurementSummary, ProcurementStatus } from '../lib/procurement'
import type {
  ProductionOrder,
  PurchaseOrder,
  Supplier,
  SupplierContact,
  SupplierIngredient,
  Ingredient,
} from '../types/database'
import SupplierPopover from './SupplierPopover'
import StatusDropdown, { type StatusOption } from './StatusDropdown'
import type { ConversionMap } from '../lib/conversions'

/* ── Procurement status transitions ───────────────────────── */

const PROC_TRANSITIONS: Record<ProcurementStatus, ProcurementStatus[]> = {
  NOT_ORDERED: [],
  DRAFT: ['ORDERED'],
  PARTIAL: ['ORDERED'],
  ORDERED: ['IN_TRANSIT', 'RECEIVED'],
  IN_TRANSIT: ['RECEIVED'],
  RECEIVED: [],
  READY: [],
  CP_PROVIDED: [],
}

/* ── Status color configs ─────────────────────────────────── */

const PROC_BORDER: Record<ProcurementStatus, string> = {
  READY: '#22C55E',
  RECEIVED: '#22C55E',
  ORDERED: '#3B82F6',
  IN_TRANSIT: '#06B6D4',
  PARTIAL: '#F59E0B',
  DRAFT: '#7A8599',
  NOT_ORDERED: '#EF4444',
  CP_PROVIDED: '#F59E0B',
}
const PROC_LABEL: Record<ProcurementStatus, string> = {
  READY: 'READY', RECEIVED: 'RECEIVED', ORDERED: 'ORDERED', IN_TRANSIT: 'IN TRANSIT', PARTIAL: 'PARTIAL', DRAFT: 'DRAFT', NOT_ORDERED: 'NOT ORDERED', CP_PROVIDED: 'CP PROVIDED',
}
const PROC_DOT: Record<ProcurementStatus, string> = {
  READY: '#22C55E', RECEIVED: '#22C55E', ORDERED: '#3B82F6', IN_TRANSIT: '#06B6D4', PARTIAL: '#F59E0B', DRAFT: '#7A8599', NOT_ORDERED: '#EF4444', CP_PROVIDED: '#F59E0B',
}
const PROC_ICON: Record<ProcurementStatus, string> = {
  NOT_ORDERED: '\u26A0',  // ⚠
  DRAFT: '',
  PARTIAL: '\u26A0',      // ⚠
  ORDERED: '',
  IN_TRANSIT: '\uD83D\uDE9A', // 🚚
  RECEIVED: '\u2713',     // ✓
  READY: '\u2713',        // ✓
  CP_PROVIDED: '',
}

/* ── Props ─────────────────────────────────────────────────── */

/** Selection data passed alongside ProcurementRow when ordering */
export interface ProcurementSelection {
  supplierId: string | null
  siId: string | null
}

interface ProcurementTableProps {
  procRows: ProcurementRow[]
  procSummary: ProcurementSummary
  order: ProductionOrder
  purchaseOrders?: PurchaseOrder[]
  suppliers: Supplier[]
  supplierContacts?: SupplierContact[]
  supplierIngredients: SupplierIngredient[]
  ingredients: Ingredient[]
  conversions: ConversionMap
  onOrderRow?: (row: ProcurementRow, selection: ProcurementSelection) => void
  onOrderAll?: (rows: ProcurementRow[], selections: Map<string, ProcurementSelection>) => void
  onStatusChange?: (ingredientId: string, newStatus: string, linkedPOIds: string[]) => void
  onETAChange?: (poId: string, newDate: string | null) => void
}

/* ── Enriched row type ─────────────────────────────────────── */

interface EnrichedRow extends ProcurementRow {
  supplierInfo: ResolvedSupplierInfo
  currentPackageOptions: PackageOption[]
  pkgsToOrder: number | null
  orderQty: number | null
  orderQtyExtra: number | null
  estCost: number | null
  selectedPkgName: string | null
}

/* ── Selection state type ──────────────────────────────────── */

type RowSelection = { supplierId: string; siId: string }

/* ── Helpers ───────────────────────────────────────────────── */

const TH = 'px-2 py-3 text-[13px] font-semibold uppercase tracking-wider text-muted'

/* ── Tracking URL builders ─────────────────────────────────── */

const CARRIER_URLS: Record<string, (t: string) => string> = {
  fedex: (t) => `https://www.fedex.com/fedextrack/?trknbr=${t}`,
  ups: (t) => `https://www.ups.com/track?tracknum=${t}`,
  usps: (t) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`,
}

function getTrackingUrl(carrier: string | null, tracking: string): string | null {
  if (!carrier) return null
  const key = carrier.toLowerCase()
  for (const [name, builder] of Object.entries(CARRIER_URLS)) {
    if (key.includes(name)) return builder(tracking)
  }
  return null
}

/* ── Component ─────────────────────────────────────────────── */

export default function ProcurementTable({
  procRows,
  procSummary,
  order,
  purchaseOrders = [],
  suppliers,
  supplierContacts = [],
  supplierIngredients,
  ingredients,
  conversions,
  onOrderRow,
  onOrderAll,
  onStatusChange,
  onETAChange,
}: ProcurementTableProps) {
  const missingCount = procSummary.notOrdered + procSummary.partial
  const readyTotal = procSummary.ready + procSummary.received
  const yourTotal = procSummary.total - procSummary.cpCount
  const missingRows = procRows.filter((r) => r.status === 'NOT_ORDERED' || r.status === 'PARTIAL')

  /* ── Ephemeral supplier/package selections ─────────────── */

  const defaultSelections = useMemo(() => {
    const map = new Map<string, RowSelection>()
    for (const row of procRows) {
      if (row.providedBy === 'copacker') continue
      const ing = ingredients.find((i) => i.id === row.ingredientId)
      const info = resolveIngredientSupplier(
        row.ingredientId, row.unit, suppliers, supplierIngredients,
        conversions, ing?.density_g_per_ml,
      )
      if (info.selectedSupplierId && info.selectedSiId) {
        map.set(row.ingredientId, {
          supplierId: info.selectedSupplierId,
          siId: info.selectedSiId,
        })
      }
    }
    return map
  }, [procRows, suppliers, supplierIngredients, ingredients, conversions])

  const [selections, setSelections] = useState<Map<string, RowSelection>>(new Map())

  // Seed selections from defaults whenever procRows change
  useEffect(() => {
    setSelections(defaultSelections)
  }, [defaultSelections])

  /* ── Enriched rows ─────────────────────────────────────── */

  const enrichedRows = useMemo((): EnrichedRow[] => {
    return procRows.map((row): EnrichedRow => {
      const isCp = row.providedBy === 'copacker'

      if (isCp) {
        const cpCost = (row.cpChargePerUnit ?? 0) * row.needed
        return {
          ...row,
          supplierInfo: { supplierOptions: [], packageOptions: [], selectedSupplierId: null, selectedSiId: null, selectedPackageSize: null, selectedPackageName: null, selectedPricePerPackage: null },
          currentPackageOptions: [],
          pkgsToOrder: null,
          orderQty: null,
          orderQtyExtra: null,
          estCost: cpCost > 0 ? cpCost : null,
          selectedPkgName: null,
        }
      }

      const ing = ingredients.find((i) => i.id === row.ingredientId)
      const info = resolveIngredientSupplier(
        row.ingredientId, row.unit, suppliers, supplierIngredients,
        conversions, ing?.density_g_per_ml,
      )

      const sel = selections.get(row.ingredientId)

      // Determine current package options based on selected supplier
      const currentSupplierId = sel?.supplierId ?? info.selectedSupplierId
      const currentPkgOptions = currentSupplierId
        ? buildPackageOptionsForSupplier(currentSupplierId, row.ingredientId, supplierIngredients)
        : info.packageOptions

      // Find the selected SI
      const currentSiId = sel?.siId ?? info.selectedSiId
      const selectedSI = currentSiId
        ? supplierIngredients.find((si) => si.id === currentSiId)
        : null

      // Also look up the matching package option for price
      const matchedPkg = currentPkgOptions.find((p) => p.siId === currentSiId)

      const pkgSize = matchedPkg?.packageSize ?? selectedSI?.package_size ?? null
      const pricePerPkg = matchedPkg?.pricePerPackage
        ?? selectedSI?.price_per_package
        ?? (selectedSI?.price_per_unit != null && pkgSize != null
          ? selectedSI.price_per_unit * pkgSize : null)
      const pkgName = matchedPkg?.packageName ?? selectedSI?.package_name ?? null

      const shortfall = row.shortfall

      let pkgsToOrder: number | null = null
      let orderQty: number | null = null
      let orderQtyExtra: number | null = null
      let estCost: number | null = null

      if (shortfall > 0 && pkgSize && pkgSize > 0) {
        pkgsToOrder = Math.ceil(shortfall / pkgSize)
        orderQty = pkgsToOrder * pkgSize
        const extra = orderQty - shortfall
        orderQtyExtra = extra > 0.01 ? extra : null
        estCost = pricePerPkg != null ? pkgsToOrder * pricePerPkg : null
      } else if (shortfall > 0) {
        // No package info — show shortfall as-is, cost from unit price
        orderQty = shortfall
        const unitPrice = selectedSI?.price_per_unit ?? ing?.unit_cost ?? 0
        estCost = shortfall * unitPrice || null
      }

      return {
        ...row,
        supplierInfo: {
          ...info,
          // Override with current supplier's options
          packageOptions: currentPkgOptions,
        },
        currentPackageOptions: currentPkgOptions,
        pkgsToOrder,
        orderQty,
        orderQtyExtra,
        estCost,
        selectedPkgName: pkgName,
      }
    })
  }, [procRows, selections, suppliers, supplierIngredients, ingredients, conversions])

  /* ── Totals ────────────────────────────────────────────── */

  const totals = useMemo(() => {
    let yourCost = 0
    let cpCost = 0
    for (const r of enrichedRows) {
      if (r.providedBy === 'copacker') {
        cpCost += r.estCost ?? 0
      } else {
        yourCost += r.estCost ?? 0
      }
    }
    return { yourCost, cpCost, total: yourCost + cpCost }
  }, [enrichedRows])

  /* ── PO tracking map (ingredientId → tracking info[]) ── */

  const poMap = useMemo(() => new Map(purchaseOrders.map((po) => [po.id, po])), [purchaseOrders])

  /* ── Render ────────────────────────────────────────────── */

  return (
    <div className="border-t border-border pt-3">
      {/* Section header */}
      <p className="mb-2 text-base font-semibold uppercase tracking-wider text-muted">Ingredient Procurement Status</p>
      {/* Summary bar */}
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-4 text-[14px]">
          <span className="font-medium text-text">{readyTotal} of {yourTotal} ingredients ready</span>
          {procSummary.ready + procSummary.received > 0 && (
            <span className="flex items-center gap-1.5 text-muted"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#22C55E' }} />{procSummary.ready + procSummary.received} Ready</span>
          )}
          {procSummary.ordered > 0 && (
            <span className="flex items-center gap-1.5 text-muted"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#3B82F6' }} />{procSummary.ordered} Ordered</span>
          )}
          {procSummary.inTransit > 0 && (
            <span className="flex items-center gap-1.5 text-muted"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#06B6D4' }} />{procSummary.inTransit} In Transit</span>
          )}
          {procSummary.partial > 0 && (
            <span className="flex items-center gap-1.5 text-muted"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#F59E0B' }} />{procSummary.partial} Partial</span>
          )}
          {procSummary.draft > 0 && (
            <span className="flex items-center gap-1.5 text-muted"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#7A8599' }} />{procSummary.draft} Draft</span>
          )}
          {procSummary.notOrdered > 0 && (
            <span className="flex items-center gap-1.5 text-muted"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#EF4444' }} />{procSummary.notOrdered} Not Ordered</span>
          )}
        </div>
        {missingCount > 0 && onOrderAll && (
          <button
            type="button"
            onClick={() => {
              const selMap = new Map<string, ProcurementSelection>()
              for (const r of missingRows) {
                const sel = selections.get(r.ingredientId)
                const info = enrichedRows.find((e) => e.ingredientId === r.ingredientId)
                selMap.set(r.ingredientId, {
                  supplierId: sel?.supplierId ?? info?.supplierInfo.selectedSupplierId ?? null,
                  siId: sel?.siId ?? info?.supplierInfo.selectedSiId ?? null,
                })
              }
              onOrderAll(missingRows, selMap)
            }}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px] font-medium text-accent hover:bg-accent/10 transition-colors"
          >
            <ShoppingCart size={14} /> Order All Missing ({missingCount})
          </button>
        )}
      </div>
      {/* Color legend */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted/70">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: '#22C55E' }} />Ready &mdash; at co-packer or received</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: '#3B82F6' }} />Ordered &mdash; PO placed, awaiting shipment</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: '#06B6D4' }} />In Transit &mdash; shipment on its way</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: '#F59E0B' }} />Partial &mdash; ordered but not enough</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: '#7A8599' }} />Draft &mdash; PO created but not sent</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: '#EF4444' }} />Not Ordered &mdash; action needed</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-[14px]" style={{ fontFeatureSettings: '"tnum"', minWidth: 1400 }}>
          <thead>
            <tr className="border-b border-border bg-surface/50">
              <th className={TH} style={{ width: 160 }}>Ingredient</th>
              <th className={`${TH} text-center`} style={{ width: 50 }}>Source</th>
              <th className={`${TH} text-right`} style={{ width: 80 }}>Needed</th>
              <th className={`${TH} text-right`} style={{ width: 70 }}>At CP</th>
              <th className={`${TH} text-right`} style={{ width: 80 }}>Ordered</th>
              <th className={`${TH} text-right`} style={{ width: 70 }}>Transit</th>
              <th className={`${TH} text-right`} style={{ width: 80 }}>Received</th>
              <th className={`${TH} text-center`} style={{ width: 100 }}>Status</th>
              <th className={`${TH} text-center`} style={{ width: 90 }}>ETA</th>
              <th className={TH} style={{ width: 140 }}>Tracking</th>
              <th className={`${TH} text-right`} style={{ width: 80 }}>Short</th>
              <th className={TH} style={{ width: 120 }}>Supplier</th>
              <th className={TH} style={{ width: 150 }}>Package</th>
              <th className={`${TH} text-right`} style={{ width: 75 }}>Pkgs</th>
              <th className={`${TH} text-right`} style={{ width: 90 }}>Order</th>
              <th className={`${TH} text-right`} style={{ width: 90 }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {enrichedRows.map((row, rowIdx) => {
              const isCp = row.status === 'CP_PROVIDED'
              const sel = selections.get(row.ingredientId)
              const currentSupplierId = sel?.supplierId ?? row.supplierInfo.selectedSupplierId
              const currentSiId = sel?.siId ?? row.supplierInfo.selectedSiId

              return (
                <tr
                  key={row.ingredientId}
                  className="border-b border-border last:border-0"
                  style={{
                    height: 48,
                    background: rowIdx % 2 === 1 ? 'var(--color-hover)' : 'var(--color-card)',
                    borderLeft: `4px solid ${PROC_BORDER[row.status]}`,
                    opacity: isCp ? 0.7 : 1,
                  }}
                >
                  {/* Ingredient */}
                  <td className="px-2 py-3 max-w-[160px] truncate font-medium text-text" title={row.ingredientName}>
                    {row.ingredientName}
                  </td>

                  {/* Source */}
                  <td className="px-2 py-3 text-center">
                    <span
                      className="inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold"
                      style={{
                        backgroundColor: isCp ? 'rgba(245,158,11,0.15)' : 'rgba(59,130,246,0.15)',
                        color: isCp ? '#F59E0B' : '#3B82F6',
                        minWidth: 36,
                      }}
                    >
                      {isCp ? 'CP' : 'You'}
                    </span>
                  </td>

                  {/* Needed */}
                  <td className="px-2 py-3 text-right font-mono text-text">{fmtProcQty(row.needed, row.unit) ?? '—'}</td>

                  {isCp ? (
                    <>
                      {/* At CP / Ordered / Transit / Received — dashes for CP */}
                      <td className="px-2 py-3 text-right font-mono text-muted/40">—</td>
                      <td className="px-2 py-3 text-right font-mono text-muted/40">—</td>
                      <td className="px-2 py-3 text-right font-mono text-muted/40">—</td>
                      <td className="px-2 py-3 text-right font-mono text-muted/40">—</td>
                      {/* Status */}
                      <td className="px-2 py-3 text-center">
                        <span className="inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-[12px] font-medium" style={{ backgroundColor: 'rgba(245,158,11,0.15)', color: '#F59E0B', width: 90 }}>CP PROVIDED</span>
                      </td>
                      {/* ETA — dash for CP */}
                      <td className="px-2 py-3 text-center font-mono text-muted/40">—</td>
                      {/* Tracking — dash for CP */}
                      <td className="px-2 py-3 text-muted/40">—</td>
                      {/* Shortfall / Supplier / Package / Pkgs / Order Qty — dashes for CP */}
                      <td className="px-2 py-3 text-right font-mono text-muted/40">—</td>
                      <td className="px-2 py-3 text-muted/40">—</td>
                      <td className="px-2 py-3 text-muted/40">—</td>
                      <td className="px-2 py-3 text-right font-mono text-muted/40">—</td>
                      <td className="px-2 py-3 text-right font-mono text-muted/40">—</td>
                      {/* Est. Cost — show CP charge */}
                      <td className="px-2 py-3 text-right font-mono text-text">
                        {row.estCost != null && row.estCost > 0
                          ? <span className="text-amber-400">{fmt$(row.estCost)}</span>
                          : <span className="text-muted/40">—</span>}
                      </td>
                    </>
                  ) : (
                    <>
                      {/* At CP */}
                      <td className="px-2 py-3 text-right font-mono text-text">{fmtProcQty(row.atCoPacker, row.unit) ?? <span className="text-muted/40">—</span>}</td>
                      {/* Ordered */}
                      <td className="px-2 py-3 text-right font-mono text-text">{fmtProcQty(row.ordered, row.unit) ?? <span className="text-muted/40">—</span>}</td>
                      {/* Transit */}
                      <td className="px-2 py-3 text-right font-mono text-text">{fmtProcQty(row.inTransit, row.unit) ?? <span className="text-muted/40">—</span>}</td>
                      {/* Received */}
                      <td className="px-2 py-3 text-right font-mono text-text">{fmtProcQty(row.received, row.unit) ?? <span className="text-muted/40">—</span>}</td>
                      {/* Status */}
                      <td className="px-2 py-3 text-center">
                        {(() => {
                          const transitions = PROC_TRANSITIONS[row.status] ?? []
                          const hasTransitions = transitions.length > 0 && onStatusChange && row.linkedPOIds.length > 0
                          const icon = PROC_ICON[row.status] || ''
                          const badgeLabel = `${PROC_LABEL[row.status]}${icon ? ` ${icon}` : ''}`
                          return (
                            <div className="inline-block">
                              {hasTransitions ? (
                                <StatusDropdown
                                  trigger={
                                    <span
                                      className="inline-flex items-center justify-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap"
                                      style={{ backgroundColor: `${PROC_DOT[row.status]}1F`, color: PROC_DOT[row.status], minWidth: 90 }}
                                      title={row.statusDetail ?? undefined}
                                    >
                                      {badgeLabel} ▾
                                    </span>
                                  }
                                  options={transitions.map((s) => ({
                                    value: s,
                                    label: `${PROC_LABEL[s]}${PROC_ICON[s] ? ` ${PROC_ICON[s]}` : ''}`,
                                    dotColor: PROC_DOT[s],
                                  }))}
                                  onSelect={(s) => onStatusChange!(row.ingredientId, s as ProcurementStatus, row.linkedPOIds)}
                                  width={170}
                                  align="center"
                                />
                              ) : (
                                <span
                                  className="inline-flex items-center justify-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap"
                                  style={{ backgroundColor: `${PROC_DOT[row.status]}1F`, color: PROC_DOT[row.status], minWidth: 90 }}
                                  title={row.statusDetail ?? undefined}
                                >
                                  {badgeLabel}
                                </span>
                              )}
                            </div>
                          )
                        })()}
                        {(row.status === 'NOT_ORDERED' || row.status === 'PARTIAL') && onOrderRow && (
                          <button
                            type="button"
                            onClick={() => onOrderRow(row, {
                              supplierId: currentSupplierId ?? null,
                              siId: currentSiId ?? null,
                            })}
                            className="mt-1 block mx-auto text-[13px] font-medium text-accent hover:underline"
                          >
                            {row.status === 'NOT_ORDERED' ? 'Order' : 'Order More'}
                          </button>
                        )}
                        {row.linkedPONumbers.length > 0 && (
                          <p className="mt-0.5 text-[13px] font-mono text-muted">{row.linkedPONumbers.join(', ')}</p>
                        )}
                      </td>

                      {/* ETA */}
                      <td className="px-2 py-3 text-center">
                        {(() => {
                          const showETA = row.status !== 'READY' && row.status !== 'RECEIVED' && row.status !== 'NOT_ORDERED'
                          if (!showETA) return <span className="text-muted/40">—</span>

                          // Color coding
                          let etaColor = 'text-text'
                          let etaBg = ''
                          if (row.etaDate) {
                            const today = new Date()
                            today.setHours(0, 0, 0, 0)
                            const eta = new Date(row.etaDate + 'T00:00:00')
                            const diffDays = Math.floor((eta.getTime() - today.getTime()) / 86400000)
                            if (diffDays < 0) {
                              etaColor = 'text-red-400'
                              etaBg = 'rgba(239,68,68,0.1)'
                            } else if (diffDays <= 2) {
                              etaColor = 'text-amber-400'
                              etaBg = 'rgba(245,158,11,0.1)'
                            }
                          }

                          if (row.etaPOId && onETAChange) {
                            return (
                              <div className="relative inline-block">
                                <input
                                  type="date"
                                  value={row.etaDate ?? ''}
                                  onChange={(e) => onETAChange(row.etaPOId!, e.target.value || null)}
                                  className={`w-[110px] rounded border border-border bg-transparent px-1.5 py-0.5 text-[13px] font-mono outline-none focus:border-accent cursor-pointer ${etaColor}`}
                                  style={etaBg ? { backgroundColor: etaBg } : undefined}
                                  title={row.etaDate ? ((() => {
                                    const today = new Date(); today.setHours(0, 0, 0, 0)
                                    const eta = new Date(row.etaDate + 'T00:00:00')
                                    const diffDays = Math.floor((eta.getTime() - today.getTime()) / 86400000)
                                    if (diffDays < 0) return `${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? 's' : ''} overdue`
                                    if (diffDays === 0) return 'Arriving today'
                                    return `${diffDays} day${diffDays !== 1 ? 's' : ''} away`
                                  })()) : 'Set ETA'}
                                />
                              </div>
                            )
                          }

                          // No linked PO — show date read-only or dash
                          if (row.etaDate) {
                            return <span className={`text-[13px] font-mono ${etaColor}`} style={etaBg ? { backgroundColor: etaBg, borderRadius: 4, padding: '2px 6px' } : undefined}>{row.etaDate}</span>
                          }
                          return <span className="text-muted/40">—</span>
                        })()}
                      </td>

                      {/* Tracking */}
                      <td className="px-2 py-3">
                        {(() => {
                          if (row.linkedPOIds.length === 0) return <span className="text-muted/40">—</span>
                          const trackingEntries = row.linkedPOIds
                            .map((poId) => poMap.get(poId))
                            .filter((po): po is PurchaseOrder => !!po && !!po.tracking_number)
                          if (trackingEntries.length === 0) return <span className="text-muted/40">—</span>
                          return (
                            <div className="space-y-0.5">
                              {trackingEntries.map((po) => {
                                const tracking = po.tracking_number!
                                const carrier = po.shipping_carrier ?? null
                                const url = getTrackingUrl(carrier, tracking)
                                const display = tracking.length > 14 ? tracking.slice(0, 14) + '…' : tracking
                                return (
                                  <div key={po.id} className="flex items-center gap-1">
                                    {url ? (
                                      <a
                                        href={url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="inline-flex items-center gap-0.5 font-mono text-[12px] text-accent hover:underline"
                                        title={`Track via ${carrier}`}
                                      >
                                        {display}
                                        <ExternalLink size={10} className="shrink-0" />
                                      </a>
                                    ) : (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          navigator.clipboard.writeText(tracking)
                                        }}
                                        className="font-mono text-[12px] text-accent hover:underline cursor-pointer"
                                        title={carrier ? `${carrier} — click to copy` : 'Click to copy'}
                                      >
                                        {display}
                                      </button>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )
                        })()}
                      </td>

                      {/* ── NEW COLUMNS ─────────────────────────── */}

                      {/* Shortfall */}
                      <td className="px-2 py-3 text-right font-mono text-text">
                        {row.shortfall > 0
                          ? <span className="text-amber-400">{fmtProcQty(row.shortfall, row.unit)}</span>
                          : <span className="text-muted/40">—</span>}
                      </td>

                      {/* Supplier */}
                      <td className="px-2 py-3">
                        {(() => {
                          const poSup = row.poSupplierId ? suppliers.find((s) => s.id === row.poSupplierId) : null
                          if (poSup) {
                            return (
                              <SupplierPopover
                                supplier={poSup}
                                contacts={supplierContacts.filter((c) => c.supplier_id === poSup.id)}
                              />
                            )
                          }
                          return <span className="text-muted/40 text-[14px]">—</span>
                        })()}
                      </td>

                      {/* Package */}
                      <td className="px-2 py-3">
                        {row.poPackageLabel ? (
                          <span className="text-[14px] truncate block max-w-[150px]" title={row.poQtyPackages ? `${row.poQtyPackages} × ${row.poPackageLabel}` : row.poPackageLabel}>
                            {row.poQtyPackages ? (
                              <><span className="font-medium text-text">{row.poQtyPackages} ×</span>{' '}<span className="text-muted">{row.poPackageLabel}</span></>
                            ) : (
                              <span className="text-muted">{row.poPackageLabel}</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted/40 text-[14px]">—</span>
                        )}
                      </td>

                      {/* Pkgs to Order */}
                      <td className="px-2 py-3 text-right font-mono font-bold text-text">
                        {row.pkgsToOrder != null
                          ? `${row.pkgsToOrder} ${row.selectedPkgName ?? 'pkg'}${row.pkgsToOrder !== 1 ? 's' : ''}`
                          : <span className="text-muted/40 font-normal">—</span>}
                      </td>

                      {/* Order Qty */}
                      <td className="px-2 py-3 text-right font-mono text-text">
                        {row.orderQty != null ? (
                          <>
                            {fmtProcQty(row.orderQty, row.unit)}
                            {row.orderQtyExtra != null && (
                              <span className="text-amber-400 text-[13px] block">
                                (+{fmtProcQty(row.orderQtyExtra, row.unit)} extra)
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted/40">—</span>
                        )}
                      </td>

                      {/* Est. Cost */}
                      <td className="px-2 py-3 text-right font-mono text-text">
                        {row.estCost != null && row.estCost > 0
                          ? fmt$(row.estCost)
                          : <span className="text-muted/40">—</span>}
                      </td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border bg-surface/30">
              <td colSpan={15} className="px-3 py-3 text-right text-[15px] font-bold">
                <span className="text-muted">Your ingredients: </span>
                <span className="font-mono font-medium text-text">{fmt$(totals.yourCost)}</span>
                {totals.cpCost > 0 && (
                  <>
                    <span className="mx-2 text-muted">|</span>
                    <span className="text-muted">CP provided: </span>
                    <span className="font-mono font-medium text-text">{fmt$(totals.cpCost)}</span>
                  </>
                )}
                <span className="mx-2 text-muted">|</span>
                <span className="text-muted">Total: </span>
                <span className="font-mono font-semibold text-text">{fmt$(totals.total)}</span>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
