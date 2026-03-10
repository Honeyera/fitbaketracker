import type {
  ProductionRun,
  ProductionOrder,
  RecipeIngredient,
  Ingredient,
  IngredientInventory,
  PurchaseOrder,
  PurchaseOrderItem,
} from '../types/database'
import { type ConversionMap, getConversionFactorWithDensity } from './conversions'

/* ── Types ────────────────────────────────────────────────────── */

export type ProcurementStatus =
  | 'READY'
  | 'RECEIVED'
  | 'ORDERED'
  | 'IN_TRANSIT'
  | 'PARTIAL'
  | 'NOT_ORDERED'
  | 'DRAFT'
  | 'CP_PROVIDED'

export interface ProcurementRow {
  ingredientId: string
  ingredientName: string
  unit: string
  needed: number
  atCoPacker: number
  ordered: number
  inTransit: number
  received: number
  shortfall: number
  status: ProcurementStatus
  statusDetail: string | null
  linkedPONumbers: string[]
  linkedPOIds: string[]
  etaDate: string | null
  etaPOId: string | null
  providedBy: 'fitbake' | 'copacker'
  cpChargePerUnit?: number
  /** Supplier from linked PO */
  poSupplierId: string | null
  /** Package info from linked PO items */
  poPackageLabel: string | null
  poQtyPackages: number | null
}

export interface ProcurementSummary {
  total: number
  ready: number
  received: number
  ordered: number
  inTransit: number
  partial: number
  notOrdered: number
  draft: number
  overallStatus: 'ALL_READY' | 'IN_PROGRESS' | 'ACTION_NEEDED'
  cpCount: number
  nearestETA: string | null
}

export interface ProcurementInput {
  order: ProductionOrder
  orderRuns: ProductionRun[]
  recipeIngredients: RecipeIngredient[]
  ingredients: Ingredient[]
  inventory: IngredientInventory[]
  purchaseOrders: PurchaseOrder[]
  poItems: PurchaseOrderItem[]
  conversions: ConversionMap
}

/* ── Helpers ──────────────────────────────────────────────────── */

function fmtQty(qty: number, unit: string): string {
  const val = qty < 10 ? qty.toFixed(1) : Math.round(qty).toLocaleString()
  return `${val} ${unit}`
}

/* ── Core calculation ─────────────────────────────────────────── */

export function buildProcurementRows(input: ProcurementInput): ProcurementRow[] {
  const {
    order,
    orderRuns,
    recipeIngredients,
    ingredients,
    inventory,
    purchaseOrders,
    poItems,
    conversions,
  } = input

  // 1. Aggregate ingredient needs across all runs (in inventory units)
  const needMap = new Map<string, number>()
  const cpMap = new Map<string, { providedBy: 'fitbake' | 'copacker'; cpChargePerUnit?: number }>()

  for (const run of orderRuns) {
    if (!run.recipe_id) continue
    const ris = recipeIngredients.filter((ri) => ri.recipe_id === run.recipe_id)
    for (const ri of ris) {
      if (!ri.ingredient_id) continue
      const isCp = ri.provided_by === 'copacker'

      if (!cpMap.has(ri.ingredient_id)) {
        cpMap.set(ri.ingredient_id, {
          providedBy: isCp ? 'copacker' : 'fitbake',
          cpChargePerUnit: isCp ? (ri.cp_charge_per_unit ?? 0) : undefined,
        })
      }

      const ing = ingredients.find((i) => i.id === ri.ingredient_id)
      const invUnit = ing?.unit ?? 'lbs'
      let factor = 1
      try {
        factor = getConversionFactorWithDensity(conversions, ri.unit, invUnit, ing?.density_g_per_ml)
      } catch {
        /* fallback to 1 */
      }
      const need = ri.quantity_per_unit * factor * run.requested_quantity
      needMap.set(ri.ingredient_id, (needMap.get(ri.ingredient_id) ?? 0) + need)
    }
  }

  // 2. Find linked POs (non-cancelled, linked to this production order)
  const linkedPOs = purchaseOrders.filter(
    (po) => po.production_order_id === order.id && po.status !== 'cancelled',
  )
  // 3. Sum PO item quantities per ingredient, grouped by PO status
  const orderedMap = new Map<string, number>()
  const inTransitMap = new Map<string, number>()
  const receivedMap = new Map<string, number>()
  const draftMap = new Map<string, number>()
  const poNumberMap = new Map<string, Set<string>>()
  const poIdMap = new Map<string, Set<string>>()
  const ingPOStatuses = new Map<string, Set<string>>()
  // Track earliest ETA per ingredient (from non-received POs)
  const ingETA = new Map<string, { date: string; poId: string }>()
  // Track first non-received PO per ingredient (for ETA editing fallback)
  const ingFirstPO = new Map<string, string>()
  // Track package info per ingredient from PO items (first item with package data wins)
  const ingPkgInfo = new Map<string, { label: string; qtyPkgs: number | null }>()
  // Track supplier from linked POs per ingredient (first PO's supplier wins)
  const ingSupplier = new Map<string, string>()

  for (const po of linkedPOs) {
    const items = poItems.filter((pi) => pi.purchase_order_id === po.id)
    const poStatus = po.status ?? 'draft'
    for (const item of items) {
      if (!item.ingredient_id) continue
      const qty = item.quantity

      // Total ordered across all non-cancelled POs
      orderedMap.set(item.ingredient_id, (orderedMap.get(item.ingredient_id) ?? 0) + qty)

      if (poStatus === 'draft') {
        draftMap.set(item.ingredient_id, (draftMap.get(item.ingredient_id) ?? 0) + qty)
      }
      if (poStatus === 'in_transit') {
        inTransitMap.set(item.ingredient_id, (inTransitMap.get(item.ingredient_id) ?? 0) + qty)
      }
      if (poStatus === 'received') {
        const recQty = item.received_quantity ?? item.quantity
        receivedMap.set(item.ingredient_id, (receivedMap.get(item.ingredient_id) ?? 0) + recQty)
      }

      // Track PO numbers and IDs per ingredient
      if (!poNumberMap.has(item.ingredient_id)) poNumberMap.set(item.ingredient_id, new Set())
      poNumberMap.get(item.ingredient_id)!.add(po.po_number)
      if (!poIdMap.has(item.ingredient_id)) poIdMap.set(item.ingredient_id, new Set())
      poIdMap.get(item.ingredient_id)!.add(po.id)

      // Track PO statuses per ingredient
      if (!ingPOStatuses.has(item.ingredient_id)) ingPOStatuses.set(item.ingredient_id, new Set())
      ingPOStatuses.get(item.ingredient_id)!.add(poStatus)

      // Track supplier from PO (first PO's supplier wins)
      if (po.supplier_id && !ingSupplier.has(item.ingredient_id)) {
        ingSupplier.set(item.ingredient_id, po.supplier_id)
      }

      // Track first non-received PO per ingredient (for ETA editing)
      if (poStatus !== 'received' && !ingFirstPO.has(item.ingredient_id)) {
        ingFirstPO.set(item.ingredient_id, po.id)
      }

      // Track package info from PO items (first item with package data wins)
      if (!ingPkgInfo.has(item.ingredient_id) && item.package_size && item.package_name) {
        const label = `${item.package_size} ${item.package_unit ?? ''} ${item.package_name}`.replace(/\s+/g, ' ').trim()
        ingPkgInfo.set(item.ingredient_id, { label, qtyPkgs: item.qty_packages })
      }

      // Track earliest ETA per ingredient (from non-received POs)
      if (po.eta_date && poStatus !== 'received') {
        const existing = ingETA.get(item.ingredient_id)
        if (!existing || po.eta_date < existing.date) {
          ingETA.set(item.ingredient_id, { date: po.eta_date, poId: po.id })
        }
      }
    }
  }

  // 4. Build rows
  const rows: ProcurementRow[] = []

  for (const [ingredientId, needed] of needMap) {
    const ing = ingredients.find((i) => i.id === ingredientId)
    if (!ing) continue

    const cpInfo = cpMap.get(ingredientId)
    const isCp = cpInfo?.providedBy === 'copacker'

    if (isCp) {
      // CP-provided — no tracking, just show as CP_PROVIDED
      rows.push({
        ingredientId,
        ingredientName: ing.name,
        unit: ing.unit,
        needed,
        atCoPacker: 0,
        ordered: 0,
        inTransit: 0,
        received: 0,
        shortfall: 0,
        status: 'CP_PROVIDED',
        statusDetail: null,
        linkedPONumbers: [],
        linkedPOIds: [],
        etaDate: null,
        etaPOId: null,
        providedBy: 'copacker',
        cpChargePerUnit: cpInfo?.cpChargePerUnit,
        poSupplierId: null,
        poPackageLabel: null,
        poQtyPackages: null,
      })
      continue
    }

    // At-CP inventory
    const atCoPacker = inventory
      .filter(
        (iv) =>
          iv.ingredient_id === ingredientId &&
          iv.location_type === 'copacker' &&
          iv.co_packer_id === order.co_packer_id,
      )
      .reduce((s, iv) => s + (iv.quantity ?? 0), 0)

    const ordered = orderedMap.get(ingredientId) ?? 0
    const inTransit = inTransitMap.get(ingredientId) ?? 0
    const received = receivedMap.get(ingredientId) ?? 0
    const draft = draftMap.get(ingredientId) ?? 0
    const shortfall = Math.max(0, needed - atCoPacker - inTransit - ordered)
    const linkedPONumbers = Array.from(poNumberMap.get(ingredientId) ?? [])
    const statuses = ingPOStatuses.get(ingredientId)
    const statusArr = statuses ? Array.from(statuses) : []

    // 5. Determine status (per user's spec)
    let status: ProcurementStatus
    let statusDetail: string | null = null

    if (atCoPacker >= needed && ordered === 0) {
      // Already have enough at CP without any POs
      status = 'READY'
    } else if (atCoPacker >= needed && statusArr.length > 0 && statusArr.every((s) => s === 'received')) {
      // Enough at CP and all POs received
      status = 'RECEIVED'
    } else if (atCoPacker >= needed) {
      // Enough at CP (some POs may still be in progress)
      status = 'READY'
    } else if (ordered === 0) {
      // No POs at all
      status = 'NOT_ORDERED'
    } else if (statusArr.every((s) => s === 'draft')) {
      // All POs are still drafts
      status = 'DRAFT'
    } else if (statusArr.every((s) => s === 'received')) {
      // All POs received
      status = 'RECEIVED'
    } else if (atCoPacker + ordered >= needed) {
      // Enough once all orders arrive — determine most advanced in-progress status
      if (statusArr.length > 1 && !statusArr.every((s) => s === statusArr[0])) {
        // Mixed statuses across multiple POs
        status = 'PARTIAL'
        const parts: string[] = []
        if (received > 0) parts.push(`${fmtQty(received, ing.unit)} received`)
        if (inTransit > 0) parts.push(`${fmtQty(inTransit, ing.unit)} in transit`)
        const orderedOnly = ordered - inTransit - received - draft
        if (orderedOnly > 0) parts.push(`${fmtQty(orderedOnly, ing.unit)} ordered`)
        if (draft > 0) parts.push(`${fmtQty(draft, ing.unit)} draft`)
        if (parts.length > 0) statusDetail = parts.join(', ')
      } else if (statusArr.includes('in_transit')) {
        status = 'IN_TRANSIT'
      } else if (statusArr.includes('ordered')) {
        status = 'ORDERED'
      } else {
        status = 'ORDERED'
      }
    } else {
      // Not enough even with all orders — partial
      status = 'PARTIAL'
      const parts: string[] = []
      if (received > 0) parts.push(`${fmtQty(received, ing.unit)} received`)
      if (inTransit > 0) parts.push(`${fmtQty(inTransit, ing.unit)} in transit`)
      const orderedOnly = ordered - inTransit - received - draft
      if (orderedOnly > 0) parts.push(`${fmtQty(orderedOnly, ing.unit)} ordered`)
      if (draft > 0) parts.push(`${fmtQty(draft, ing.unit)} draft`)
      const gap = needed - atCoPacker - ordered
      if (gap > 0) parts.push(`${fmtQty(gap, ing.unit)} still needed`)
      if (parts.length > 0) statusDetail = parts.join(', ')
    }

    const pkgInfo = ingPkgInfo.get(ingredientId)
    rows.push({
      ingredientId,
      ingredientName: ing.name,
      unit: ing.unit,
      needed,
      atCoPacker,
      ordered,
      inTransit,
      received,
      shortfall,
      status,
      statusDetail,
      linkedPONumbers,
      linkedPOIds: Array.from(poIdMap.get(ingredientId) ?? []),
      etaDate: ingETA.get(ingredientId)?.date ?? null,
      etaPOId: ingETA.get(ingredientId)?.poId ?? ingFirstPO.get(ingredientId) ?? null,
      providedBy: 'fitbake',
      poSupplierId: ingSupplier.get(ingredientId) ?? null,
      poPackageLabel: pkgInfo?.label ?? null,
      poQtyPackages: pkgInfo?.qtyPkgs ?? null,
    })
  }

  // Sort: action-needed first (NOT_ORDERED, PARTIAL), then in-progress, then ready, CP last
  const statusPriority: Record<ProcurementStatus, number> = {
    NOT_ORDERED: 0,
    PARTIAL: 1,
    DRAFT: 2,
    IN_TRANSIT: 3,
    ORDERED: 4,
    RECEIVED: 5,
    READY: 6,
    CP_PROVIDED: 7,
  }
  rows.sort((a, b) => statusPriority[a.status] - statusPriority[b.status])

  return rows
}

/* ── Summary ──────────────────────────────────────────────────── */

export function buildProcurementSummary(rows: ProcurementRow[]): ProcurementSummary {
  let ready = 0, received = 0, ordered = 0, inTransit = 0, partial = 0, notOrdered = 0, draft = 0
  let cpCount = 0
  for (const r of rows) {
    if (r.status === 'CP_PROVIDED') { cpCount++; continue }
    if (r.status === 'READY') ready++
    else if (r.status === 'RECEIVED') received++
    else if (r.status === 'ORDERED') ordered++
    else if (r.status === 'IN_TRANSIT') inTransit++
    else if (r.status === 'PARTIAL') partial++
    else if (r.status === 'NOT_ORDERED') notOrdered++
    else if (r.status === 'DRAFT') draft++
  }

  let overallStatus: ProcurementSummary['overallStatus']
  if (notOrdered > 0 || partial > 0) overallStatus = 'ACTION_NEEDED'
  else if (ordered > 0 || inTransit > 0 || draft > 0) overallStatus = 'IN_PROGRESS'
  else overallStatus = 'ALL_READY'

  // Find nearest (earliest) ETA across all non-ready rows
  let nearestETA: string | null = null
  for (const r of rows) {
    if (r.status === 'CP_PROVIDED' || r.status === 'READY' || r.status === 'RECEIVED') continue
    if (r.etaDate) {
      if (!nearestETA || r.etaDate < nearestETA) nearestETA = r.etaDate
    }
  }

  const yourTotal = rows.length - cpCount
  return { total: yourTotal, ready, received, ordered, inTransit, partial, notOrdered, draft, overallStatus, cpCount, nearestETA }
}

/* ── Card dots ────────────────────────────────────────────────── */

export interface ProcurementDots {
  green: number   // READY + RECEIVED
  cyan: number    // IN_TRANSIT
  blue: number    // ORDERED
  gray: number    // DRAFT
  amber: number   // PARTIAL
  red: number     // NOT_ORDERED
  total: number
}

export function procurementDots(rows: ProcurementRow[]): ProcurementDots {
  let green = 0, cyan = 0, blue = 0, gray = 0, amber = 0, red = 0
  for (const r of rows) {
    if (r.status === 'CP_PROVIDED') continue
    switch (r.status) {
      case 'READY': case 'RECEIVED': green++; break
      case 'IN_TRANSIT': cyan++; break
      case 'ORDERED': blue++; break
      case 'DRAFT': gray++; break
      case 'PARTIAL': amber++; break
      case 'NOT_ORDERED': default: red++; break
    }
  }
  const total = green + cyan + blue + gray + amber + red
  return { green, cyan, blue, gray, amber, red, total }
}
