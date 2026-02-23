import type {
  ProductionRun,
  RecipeIngredient,
  Ingredient,
  IngredientInventory,
  PurchaseOrder,
  PurchaseOrderItem,
  Supplier,
  SupplierIngredient,
  ShipmentToCopacker,
} from '../types/database'
import { type ConversionMap, getConversionFactorWithDensity } from './conversions'

/* â”€â”€ Interfaces â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export interface MRPRow {
  ingredientId: string
  ingredientName: string
  unit: string
  recipeUnit: string
  recipeUnitNeed: number
  totalNeed: number
  atCoPacker: number
  inTransit: number
  totalAvailable: number
  shortfall: number
  needToOrder: number
  status: 'ready' | 'order' | 'cp_provided'
  unitCost: number
  providedBy: 'fitbake' | 'copacker'
  cpChargePerUnit?: number
  /** Pre-selected supplier from ProcurementTable (overrides auto-resolution) */
  preferredSupplierId?: string
  /** Pre-selected supplier_ingredient from ProcurementTable package dropdown */
  preferredSiId?: string
}

export interface MRPSummary {
  ready: number
  needOrder: number
  totalIngredientCost: number
}

export interface SupplierOption {
  supplierId: string
  supplierName: string
  pricePerUnit: number
  rawPrice: number
  priceUnit: string
  siId?: string
  isDefault?: boolean
  packageLabel?: string | null
}

/* â”€â”€ Planned run input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export interface PlannedRun {
  recipeId: string
  quantity: number
}

/* â”€â”€ Core MRP calculation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export function buildMRPRows(
  runs: PlannedRun[],
  coPackerId: string,
  recipeIngredients: RecipeIngredient[],
  ingredients: Ingredient[],
  inventory: IngredientInventory[],
  purchaseOrders: PurchaseOrder[],
  poItems: PurchaseOrderItem[],
  conversions: ConversionMap,
): MRPRow[] {
  // Aggregate need per ingredient across all runs (in inventory unit)
  const needMap = new Map<string, number>()
  // Track recipe-unit need: { unit, qty } — if multiple recipe units map to same
  // ingredient, we collapse to inventory unit
  const recipeNeedMap = new Map<string, { unit: string; qty: number }>()
  // Track which ingredients are CP-provided
  const cpMap = new Map<string, { providedBy: 'fitbake' | 'copacker'; cpChargePerUnit?: number }>()

  for (const run of runs) {
    const ris = recipeIngredients.filter((ri) => ri.recipe_id === run.recipeId)
    for (const ri of ris) {
      if (!ri.ingredient_id) continue
      const isCp = ri.provided_by === 'copacker'
      const ing = ingredients.find((i) => i.id === ri.ingredient_id)
      const invUnit = ing?.unit ?? 'lbs'

      // Track source
      if (!cpMap.has(ri.ingredient_id)) {
        cpMap.set(ri.ingredient_id, {
          providedBy: isCp ? 'copacker' : 'fitbake',
          cpChargePerUnit: isCp ? (ri.cp_charge_per_unit ?? 0) : undefined,
        })
      }

      let factor = 1
      try {
        factor = getConversionFactorWithDensity(conversions, ri.unit, invUnit, ing?.density_g_per_ml)
      } catch {
        /* fallback to 1 */
      }
      const need = ri.quantity_per_unit * factor * run.quantity
      needMap.set(ri.ingredient_id, (needMap.get(ri.ingredient_id) ?? 0) + need)

      // Track recipe-unit qty
      const rawQty = ri.quantity_per_unit * run.quantity
      const existing = recipeNeedMap.get(ri.ingredient_id)
      if (!existing) {
        recipeNeedMap.set(ri.ingredient_id, { unit: ri.unit, qty: rawQty })
      } else if (existing.unit === ri.unit) {
        existing.qty += rawQty
      } else {
        // Different recipe units for same ingredient — collapse to inventory unit
        existing.unit = invUnit
        existing.qty = needMap.get(ri.ingredient_id) ?? 0
      }
    }
  }

  // In-transit PO IDs destined for this CP
  const inTransitPOIds = new Set(
    purchaseOrders
      .filter(
        (po) =>
          po.status === 'in_transit' &&
          po.destination_type === 'copacker' &&
          po.destination_co_packer_id === coPackerId,
      )
      .map((po) => po.id),
  )

  const rows: MRPRow[] = []

  for (const [ingredientId, totalNeed] of needMap) {
    const ing = ingredients.find((i) => i.id === ingredientId)
    if (!ing) continue

    const cpInfo = cpMap.get(ingredientId)
    const isCp = cpInfo?.providedBy === 'copacker'

    // CP-provided ingredients skip availability tracking
    const atCoPacker = isCp ? 0 : inventory
      .filter(
        (iv) =>
          iv.ingredient_id === ingredientId &&
          iv.location_type === 'copacker' &&
          iv.co_packer_id === coPackerId,
      )
      .reduce((s, iv) => s + (iv.quantity ?? 0), 0)

    const inTransit = isCp ? 0 : poItems
      .filter(
        (pi) => pi.ingredient_id === ingredientId && inTransitPOIds.has(pi.purchase_order_id),
      )
      .reduce((s, pi) => s + pi.quantity, 0)

    const totalAvailable = atCoPacker + inTransit
    const shortfall = isCp ? 0 : Math.max(0, totalNeed - totalAvailable)

    const status: 'ready' | 'order' | 'cp_provided' = isCp
      ? 'cp_provided'
      : shortfall > 0 ? 'order' : 'ready'

    const rn = recipeNeedMap.get(ingredientId)

    rows.push({
      ingredientId,
      ingredientName: ing.name,
      unit: ing.unit,
      recipeUnit: rn?.unit ?? ing.unit,
      recipeUnitNeed: rn?.qty ?? totalNeed,
      totalNeed,
      atCoPacker,
      inTransit,
      totalAvailable,
      shortfall,
      needToOrder: shortfall,
      status,
      unitCost: isCp ? 0 : ing.unit_cost,
      providedBy: isCp ? 'copacker' : 'fitbake',
      cpChargePerUnit: cpInfo?.cpChargePerUnit,
    })
  }

  // Sort: order first, then ready, then CP-provided last
  const statusOrder = { order: 0, ready: 1, cp_provided: 2 }
  rows.sort((a, b) => statusOrder[a.status] - statusOrder[b.status])

  return rows
}

/* â”€â”€ Summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export function buildMRPSummary(rows: MRPRow[]): MRPSummary {
  let ready = 0
  let needOrder = 0
  let totalIngredientCost = 0

  for (const r of rows) {
    if (r.status === 'cp_provided') continue // CP rows excluded from summary counts
    if (r.status === 'ready') ready++
    else needOrder++
    totalIngredientCost += r.totalNeed * r.unitCost
  }

  return { ready, needOrder, totalIngredientCost }
}

/* ── Default SI lookup helpers ──────────────────────────────── */

/** Find the default (or cheapest) supplier_ingredient row for a supplier+ingredient pair. */
export function findDefaultSI(
  supplierIngredients: SupplierIngredient[],
  supplierId: string,
  ingredientId: string,
): SupplierIngredient | undefined {
  const matches = supplierIngredients.filter(
    (s) => s.supplier_id === supplierId && s.ingredient_id === ingredientId,
  )
  if (matches.length <= 1) return matches[0]
  const def = matches.find((s) => s.is_default)
  if (def) return def
  return matches
    .filter((s) => s.price_per_unit != null)
    .sort((a, b) => (a.price_per_unit ?? Infinity) - (b.price_per_unit ?? Infinity))[0]
    ?? matches[0]
}

/** Return ALL supplier_ingredient rows for a supplier+ingredient pair. */
export function findAllSIOptions(
  supplierIngredients: SupplierIngredient[],
  supplierId: string,
  ingredientId: string,
): SupplierIngredient[] {
  return supplierIngredients.filter(
    (s) => s.supplier_id === supplierId && s.ingredient_id === ingredientId,
  )
}

/* ── Resolved supplier info for procurement table ─────────── */

export interface PackageOption {
  siId: string
  packageSize: number
  packageUnit: string
  packageName: string
  pricePerPackage: number
  pricePerUnit: number | null
  isDefault: boolean
}

export interface ResolvedSupplierInfo {
  supplierOptions: Array<{
    supplierId: string
    supplierName: string
    siId: string
  }>
  packageOptions: PackageOption[]
  selectedSupplierId: string | null
  selectedSiId: string | null
  selectedPackageSize: number | null
  selectedPackageName: string | null
  selectedPricePerPackage: number | null
}

export function resolveIngredientSupplier(
  ingredientId: string,
  ingredientUnit: string,
  suppliers: Supplier[],
  supplierIngredients: SupplierIngredient[],
  conversions: ConversionMap,
  density?: number | null,
): ResolvedSupplierInfo {
  const supplierOpts = findSupplierOptions(
    ingredientId, ingredientUnit, suppliers, supplierIngredients, conversions, density,
  )

  const supplierOptions = supplierOpts.map((o) => ({
    supplierId: o.supplierId,
    supplierName: o.supplierName,
    siId: o.siId ?? '',
  }))

  const defaultSupplier = supplierOpts[0] ?? null
  const selectedSupplierId = defaultSupplier?.supplierId ?? null
  const selectedSiId = defaultSupplier?.siId ?? null

  const packageOptions = buildPackageOptionsForSupplier(
    selectedSupplierId, ingredientId, supplierIngredients,
  )

  const selectedSI = selectedSiId
    ? supplierIngredients.find((si) => si.id === selectedSiId)
    : null

  return {
    supplierOptions,
    packageOptions,
    selectedSupplierId,
    selectedSiId,
    selectedPackageSize: selectedSI?.package_size ?? null,
    selectedPackageName: selectedSI?.package_name ?? null,
    selectedPricePerPackage: selectedSI?.price_per_package
      ?? (selectedSI?.price_per_unit != null && selectedSI?.package_size != null
        ? selectedSI.price_per_unit * selectedSI.package_size : null),
  }
}

export function buildPackageOptionsForSupplier(
  supplierId: string | null,
  ingredientId: string,
  supplierIngredients: SupplierIngredient[],
): PackageOption[] {
  if (!supplierId) return []
  const allSIs = findAllSIOptions(supplierIngredients, supplierId, ingredientId)
  return allSIs
    .filter((si) => si.package_size != null && si.package_name != null)
    .map((si) => ({
      siId: si.id,
      packageSize: si.package_size!,
      packageUnit: si.package_unit ?? '',
      packageName: si.package_name!,
      pricePerPackage: si.price_per_package
        ?? (si.price_per_unit != null && si.package_size != null
          ? si.price_per_unit * si.package_size : 0),
      pricePerUnit: si.price_per_unit,
      isDefault: si.is_default ?? false,
    }))
}

/* ── Supplier options for an ingredient ──────────────────────── */

export function findSupplierOptions(
  ingredientId: string,
  ingredientUnit: string,
  suppliers: Supplier[],
  supplierIngredients: SupplierIngredient[],
  conversions: ConversionMap,
  density?: number | null,
  allOptions?: boolean,
): SupplierOption[] {
  const sis = supplierIngredients.filter((si) => si.ingredient_id === ingredientId)

  const options: SupplierOption[] = []
  for (const si of sis) {
    const sup = suppliers.find((s) => s.id === si.supplier_id)
    if (!sup || si.price_per_unit == null) continue

    const priceUnit = si.price_unit ?? ingredientUnit
    let pricePerUnit = si.price_per_unit
    if (priceUnit !== ingredientUnit) {
      try {
        const factor = getConversionFactorWithDensity(conversions, priceUnit, ingredientUnit, density ?? null)
        pricePerUnit = si.price_per_unit / factor
      } catch {
        /* keep raw price */
      }
    }

    options.push({
      supplierId: sup.id,
      supplierName: sup.name,
      pricePerUnit,
      rawPrice: si.price_per_unit,
      priceUnit,
      siId: si.id,
      isDefault: si.is_default ?? undefined,
      packageLabel: si.package_size && si.package_unit && si.package_name
        ? `${si.package_size}${si.package_unit} ${si.package_name}`
        : null,
    })
  }

  options.sort((a, b) => a.pricePerUnit - b.pricePerUnit)

  if (allOptions) return options

  // Deduplicate by supplier: prefer is_default, then cheapest (already sorted)
  const seen = new Map<string, SupplierOption>()
  for (const opt of options) {
    const existing = seen.get(opt.supplierId)
    if (!existing) {
      seen.set(opt.supplierId, opt)
    } else if (opt.isDefault && !existing.isDefault) {
      seen.set(opt.supplierId, opt)
    }
  }
  return Array.from(seen.values())
}

/* â”€â”€ Auto-numbering helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export function nextPONumber(existingPOs: PurchaseOrder[]): string {
  if (existingPOs.length === 0) return '#1001'
  const nums = existingPOs
    .map((p) => {
      const m = p.po_number.match(/#?(\d+)/)
      return m ? parseInt(m[1], 10) : 0
    })
    .filter((n) => !isNaN(n) && n > 0)
  const max = Math.max(...nums, 1000)
  return `#${max + 1}`
}

export function nextShipmentNumber(existingShipments: ShipmentToCopacker[]): string {
  if (existingShipments.length === 0) return 'SH-001'
  const nums = existingShipments
    .map((s) => {
      const m = s.shipment_number.match(/(?:SHP?|SH)-?(\d+)/)
      return m ? parseInt(m[1], 10) : 0
    })
    .filter(Boolean)
  const max = Math.max(...nums, 0)
  return `SH-${String(max + 1).padStart(3, '0')}`
}

export function nextRunNumber(existingRuns: ProductionRun[]): string {
  if (existingRuns.length === 0) return 'PR-0001'
  const nums = existingRuns
    .map((r) => {
      const m = r.run_number.match(/(?:RUN|PR)-?(\d+)/)
      return m ? parseInt(m[1], 10) : 0
    })
    .filter(Boolean)
  const max = Math.max(...nums, 0)
  return `PR-${String(max + 1).padStart(4, '0')}`
}
