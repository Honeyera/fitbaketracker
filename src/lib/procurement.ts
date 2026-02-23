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
  linkedPONumbers: string[]
  providedBy: 'fitbake' | 'copacker'
  cpChargePerUnit?: number
}

export interface ProcurementSummary {
  total: number
  ready: number
  received: number
  ordered: number
  inTransit: number
  partial: number
  notOrdered: number
  overallStatus: 'ALL_READY' | 'IN_PROGRESS' | 'ACTION_NEEDED'
  cpCount: number
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
  // "ordered" = total from all linked POs regardless of status
  // "inTransit" = from POs with status in_transit
  // "received" = from POs with status received
  const orderedMap = new Map<string, number>()
  const inTransitMap = new Map<string, number>()
  const receivedMap = new Map<string, number>()
  const poNumberMap = new Map<string, Set<string>>()
  // Track which PO statuses exist per ingredient
  const ingPOStatuses = new Map<string, Set<string>>()

  for (const po of linkedPOs) {
    const items = poItems.filter((pi) => pi.purchase_order_id === po.id)
    for (const item of items) {
      if (!item.ingredient_id) continue
      const qty = item.quantity
      orderedMap.set(item.ingredient_id, (orderedMap.get(item.ingredient_id) ?? 0) + qty)

      if (po.status === 'in_transit') {
        inTransitMap.set(item.ingredient_id, (inTransitMap.get(item.ingredient_id) ?? 0) + qty)
      }
      if (po.status === 'received') {
        const recQty = item.received_quantity ?? item.quantity
        receivedMap.set(item.ingredient_id, (receivedMap.get(item.ingredient_id) ?? 0) + recQty)
      }

      // Track PO numbers per ingredient
      if (!poNumberMap.has(item.ingredient_id)) poNumberMap.set(item.ingredient_id, new Set())
      poNumberMap.get(item.ingredient_id)!.add(po.po_number)

      // Track PO statuses per ingredient
      if (!ingPOStatuses.has(item.ingredient_id)) ingPOStatuses.set(item.ingredient_id, new Set())
      ingPOStatuses.get(item.ingredient_id)!.add(po.status ?? 'draft')
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
        linkedPONumbers: [],
        providedBy: 'copacker',
        cpChargePerUnit: cpInfo?.cpChargePerUnit,
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
    const shortfall = Math.max(0, needed - atCoPacker - inTransit - ordered)
    const linkedPONumbers = Array.from(poNumberMap.get(ingredientId) ?? [])
    const statuses = ingPOStatuses.get(ingredientId)

    // 5. Determine status
    let status: ProcurementStatus

    if (atCoPacker >= needed) {
      // Already have enough at CP
      if (statuses && statuses.size > 0 && Array.from(statuses).every((s) => s === 'received')) {
        status = 'RECEIVED'
      } else {
        status = 'READY'
      }
    } else if (ordered === 0) {
      status = 'NOT_ORDERED'
    } else if (atCoPacker + ordered >= needed) {
      // Enough once orders arrive
      if (statuses?.has('in_transit')) {
        status = 'IN_TRANSIT'
      } else {
        status = 'ORDERED'
      }
    } else {
      status = 'PARTIAL'
    }

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
      linkedPONumbers,
      providedBy: 'fitbake',
    })
  }

  // Sort: action-needed first (NOT_ORDERED, PARTIAL), then in-progress, then ready, CP last
  const statusPriority: Record<ProcurementStatus, number> = {
    NOT_ORDERED: 0,
    PARTIAL: 1,
    IN_TRANSIT: 2,
    ORDERED: 3,
    RECEIVED: 4,
    READY: 5,
    CP_PROVIDED: 6,
  }
  rows.sort((a, b) => statusPriority[a.status] - statusPriority[b.status])

  return rows
}

/* ── Summary ──────────────────────────────────────────────────── */

export function buildProcurementSummary(rows: ProcurementRow[]): ProcurementSummary {
  let ready = 0, received = 0, ordered = 0, inTransit = 0, partial = 0, notOrdered = 0
  let cpCount = 0
  for (const r of rows) {
    if (r.status === 'CP_PROVIDED') { cpCount++; continue }
    if (r.status === 'READY') ready++
    else if (r.status === 'RECEIVED') received++
    else if (r.status === 'ORDERED') ordered++
    else if (r.status === 'IN_TRANSIT') inTransit++
    else if (r.status === 'PARTIAL') partial++
    else if (r.status === 'NOT_ORDERED') notOrdered++
  }

  let overallStatus: ProcurementSummary['overallStatus']
  if (notOrdered > 0 || partial > 0) overallStatus = 'ACTION_NEEDED'
  else if (ordered > 0 || inTransit > 0) overallStatus = 'IN_PROGRESS'
  else overallStatus = 'ALL_READY'

  const yourTotal = rows.length - cpCount
  return { total: yourTotal, ready, received, ordered, inTransit, partial, notOrdered, overallStatus, cpCount }
}

/* ── Card dots ────────────────────────────────────────────────── */

export function procurementDots(rows: ProcurementRow[]): { green: number; blue: number; red: number } {
  let green = 0, blue = 0, red = 0
  for (const r of rows) {
    if (r.status === 'CP_PROVIDED') continue // CP rows don't count as dots
    if (r.status === 'READY' || r.status === 'RECEIVED') green++
    else if (r.status === 'ORDERED' || r.status === 'IN_TRANSIT') blue++
    else red++
  }
  return { green, blue, red }
}
