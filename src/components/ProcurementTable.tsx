import { useEffect, useMemo, useState } from 'react'
import { fmt$, fmtProcQty } from '../lib/format'
import { ShoppingCart } from 'lucide-react'
import {
  resolveIngredientSupplier,
  buildPackageOptionsForSupplier,
  findDefaultSI,
  type ResolvedSupplierInfo,
  type PackageOption,
} from '../lib/mrp'
import type { ProcurementRow, ProcurementSummary, ProcurementStatus } from '../lib/procurement'
import type {
  ProductionOrder,
  Supplier,
  SupplierIngredient,
  Ingredient,
} from '../types/database'
import type { ConversionMap } from '../lib/conversions'

/* ── Status color configs ─────────────────────────────────── */

const PROC_BORDER: Record<ProcurementStatus, string> = {
  READY: '#22C55E',
  RECEIVED: '#22C55E',
  ORDERED: '#3B82F6',
  IN_TRANSIT: '#06B6D4',
  PARTIAL: '#F59E0B',
  NOT_ORDERED: '#EF4444',
  CP_PROVIDED: '#F59E0B',
}
const PROC_LABEL: Record<ProcurementStatus, string> = {
  READY: 'READY', RECEIVED: 'RECEIVED', ORDERED: 'ORDERED', IN_TRANSIT: 'IN TRANSIT', PARTIAL: 'PARTIAL', NOT_ORDERED: 'NOT ORDERED', CP_PROVIDED: 'CP PROVIDED',
}
const PROC_DOT: Record<ProcurementStatus, string> = {
  READY: '#22C55E', RECEIVED: '#22C55E', ORDERED: '#3B82F6', IN_TRANSIT: '#06B6D4', PARTIAL: '#F59E0B', NOT_ORDERED: '#EF4444', CP_PROVIDED: '#F59E0B',
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
  suppliers: Supplier[]
  supplierIngredients: SupplierIngredient[]
  ingredients: Ingredient[]
  conversions: ConversionMap
  onOrderRow?: (row: ProcurementRow, selection: ProcurementSelection) => void
  onOrderAll?: (rows: ProcurementRow[], selections: Map<string, ProcurementSelection>) => void
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

function formatPackageLabel(pkg: PackageOption): string {
  const sizeLabel = `${pkg.packageSize} ${pkg.packageUnit} ${pkg.packageName}`
  const priceLabel = pkg.pricePerPackage > 0 ? ` — ${fmt$(pkg.pricePerPackage)}` : ''
  return `${sizeLabel}${priceLabel}`
}

const TH = 'px-2 py-3 text-[13px] font-semibold uppercase tracking-wider text-muted'

/* ── Component ─────────────────────────────────────────────── */

export default function ProcurementTable({
  procRows,
  procSummary,
  order,
  suppliers,
  supplierIngredients,
  ingredients,
  conversions,
  onOrderRow,
  onOrderAll,
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

  /* ── Dropdown handlers ─────────────────────────────────── */

  function handleSupplierChange(ingredientId: string, newSupplierId: string) {
    const si = findDefaultSI(supplierIngredients, newSupplierId, ingredientId)
    setSelections((prev) => {
      const next = new Map(prev)
      next.set(ingredientId, { supplierId: newSupplierId, siId: si?.id ?? '' })
      return next
    })
  }

  function handlePackageChange(ingredientId: string, newSiId: string) {
    setSelections((prev) => {
      const next = new Map(prev)
      const existing = prev.get(ingredientId)
      if (existing) {
        next.set(ingredientId, { ...existing, siId: newSiId })
      }
      return next
    })
  }

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
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: '#EF4444' }} />Not Ordered &mdash; action needed</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-[14px]" style={{ fontFeatureSettings: '"tnum"', minWidth: 1160 }}>
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
                        <span
                          className="inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-[12px] font-medium"
                          style={{ backgroundColor: `${PROC_DOT[row.status]}1F`, color: PROC_DOT[row.status], width: 90 }}
                        >
                          {PROC_LABEL[row.status]}
                        </span>
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
                        {(row.status === 'ORDERED' || row.status === 'IN_TRANSIT') && row.linkedPONumbers.length > 0 && (
                          <p className="mt-0.5 text-[13px] font-mono text-muted">{row.linkedPONumbers.join(', ')}</p>
                        )}
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
                        {row.supplierInfo.supplierOptions.length === 0 ? (
                          <span className="text-muted/40 text-[13px]">No supplier</span>
                        ) : row.supplierInfo.supplierOptions.length === 1 ? (
                          <span className="text-text text-[13px] truncate block max-w-[110px]" title={row.supplierInfo.supplierOptions[0].supplierName}>
                            {row.supplierInfo.supplierOptions[0].supplierName}
                          </span>
                        ) : (
                          <select
                            value={currentSupplierId ?? ''}
                            onChange={(e) => handleSupplierChange(row.ingredientId, e.target.value)}
                            className="w-full rounded border border-border bg-surface px-1.5 py-1 text-[13px] text-text outline-none focus:border-accent truncate"
                            style={{ maxWidth: 120 }}
                          >
                            {row.supplierInfo.supplierOptions.map((opt) => (
                              <option key={opt.supplierId} value={opt.supplierId}>{opt.supplierName}</option>
                            ))}
                          </select>
                        )}
                      </td>

                      {/* Package */}
                      <td className="px-2 py-3">
                        {row.currentPackageOptions.length === 0 ? (
                          <span className="text-muted/40 text-[13px]">—</span>
                        ) : row.currentPackageOptions.length === 1 ? (
                          <span className="text-text text-[13px] truncate block max-w-[140px]" title={formatPackageLabel(row.currentPackageOptions[0])}>
                            {formatPackageLabel(row.currentPackageOptions[0])}
                          </span>
                        ) : (
                          <select
                            value={currentSiId ?? ''}
                            onChange={(e) => handlePackageChange(row.ingredientId, e.target.value)}
                            className="w-full rounded border border-border bg-surface px-1.5 py-1 text-[13px] text-text outline-none focus:border-accent"
                            style={{ maxWidth: 150 }}
                          >
                            {row.currentPackageOptions.map((pkg) => (
                              <option key={pkg.siId} value={pkg.siId}>{formatPackageLabel(pkg)}</option>
                            ))}
                          </select>
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
              <td colSpan={13} className="px-3 py-3 text-right text-[15px] font-bold">
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
