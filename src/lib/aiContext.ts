import { supabase } from './supabase'
import { safeBatch } from './safeQuery'
import { loadConversions, getConversionFactorWithDensity } from './conversions'
import { calculateRecipeCOGSBreakdown } from './recipeCosting'
import type {
  CoPacker,
  Ingredient,
  IngredientInventory,
  Recipe,
  RecipeIngredient,
  PurchaseOrder,
  PurchaseOrderItem,
  Supplier,
  SupplierIngredient,
  ProductionOrder,
  ProductionRun,
  ShipmentToCopacker,
  FinishedGoodsMovement,
} from '../types/database'

/* ── Text table formatting helpers ─────────────────────────────── */

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length)
}

function padR(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : ' '.repeat(len - s.length) + s
}

function fmtN(v: number | null | undefined, dp = 0): string {
  if (v == null) return '—'
  return dp === 0
    ? Math.round(v).toLocaleString('en-US')
    : v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

function fmtD(v: number | null | undefined): string {
  if (v == null) return '—'
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function shortDate(d: string | null | undefined): string {
  if (!d) return '—'
  return d.slice(0, 10)
}

/* ── Shared data fetch ─────────────────────────────────────────── */

interface AllData {
  coPackers: CoPacker[]
  ingredients: Ingredient[]
  inventory: IngredientInventory[]
  recipes: Recipe[]
  recipeIngredients: RecipeIngredient[]
  purchaseOrders: PurchaseOrder[]
  poItems: PurchaseOrderItem[]
  suppliers: Supplier[]
  supplierIngredients: SupplierIngredient[]
  productionOrders: ProductionOrder[]
  productionRuns: ProductionRun[]
  shipments: ShipmentToCopacker[]
  movements: FinishedGoodsMovement[]
}

async function fetchAllData(): Promise<AllData> {
  const [cp, ing, inv, rec, ri, po, poi, sup, si, prodOrd, prodRun, ship, mov] = await safeBatch(() => Promise.all([
    supabase.from('co_packers').select('*').order('name'),
    supabase.from('ingredients').select('*').order('name'),
    supabase.from('ingredient_inventory').select('*'),
    supabase.from('recipes').select('*').order('name'),
    supabase.from('recipe_ingredients').select('*'),
    supabase.from('purchase_orders').select('*').order('order_date', { ascending: false }).limit(20),
    supabase.from('purchase_order_items').select('*'),
    supabase.from('suppliers').select('*').order('name'),
    supabase.from('supplier_ingredients').select('*'),
    supabase.from('production_orders').select('*').order('created_at', { ascending: false }),
    supabase.from('production_runs').select('*').order('requested_date', { ascending: false }),
    supabase.from('shipments_to_copacker').select('*').order('ship_date', { ascending: false }).limit(10),
    supabase.from('finished_goods_movements').select('*').order('date', { ascending: false }),
  ]))
  return {
    coPackers: cp.data ?? [],
    ingredients: ing.data ?? [],
    inventory: inv.data ?? [],
    recipes: rec.data ?? [],
    recipeIngredients: ri.data ?? [],
    purchaseOrders: po.data ?? [],
    poItems: poi.data ?? [],
    suppliers: sup.data ?? [],
    supplierIngredients: si.data ?? [],
    productionOrders: prodOrd.data ?? [],
    productionRuns: prodRun.data ?? [],
    shipments: ship.data ?? [],
    movements: mov.data ?? [],
  }
}

/* ── Section builders ──────────────────────────────────────────── */

function buildCoPackersSection(d: AllData): string {
  let s = '## Co-Packers\n'
  s += pad('Name', 22) + pad('Code', 6) + pad('Location', 20) + pad('Status', 10) + padR('Fee/Unit', 10) + padR('Min Order', 10) + '\n'
  s += '-'.repeat(78) + '\n'
  for (const cp of d.coPackers) {
    s += pad(cp.name, 22)
    s += pad(cp.short_code, 6)
    s += pad(cp.location ?? '—', 20)
    s += pad(cp.status ?? 'active', 10)
    s += padR(fmtD(cp.fee_per_unit), 10)
    s += padR(fmtN(cp.min_order_qty), 10)
    s += '\n'
  }
  return s
}

function buildIngredientsSection(d: AllData): string {
  // Aggregate inventory per ingredient per co-packer
  const invMap = new Map<string, Map<string, number>>() // ingredient_id -> (cp_id -> qty)
  for (const iv of d.inventory) {
    if (iv.location_type !== 'copacker') continue
    const cpId = iv.co_packer_id ?? 'unknown'
    if (!invMap.has(iv.ingredient_id)) invMap.set(iv.ingredient_id, new Map())
    const cpMap = invMap.get(iv.ingredient_id)!
    cpMap.set(cpId, (cpMap.get(cpId) ?? 0) + iv.quantity)
  }

  let s = '## Ingredients & Inventory\n'
  s += pad('Ingredient', 24) + pad('Unit', 6) + padR('Cost/Unit', 10) + padR('Reorder Pt', 10)
  for (const cp of d.coPackers) s += padR(cp.short_code, 10)
  s += padR('Total', 10) + '\n'
  s += '-'.repeat(60 + d.coPackers.length * 10) + '\n'

  for (const ing of d.ingredients) {
    const cpMap = invMap.get(ing.id)
    let total = 0
    s += pad(ing.name, 24)
    s += pad(ing.unit, 6)
    s += padR(fmtD(ing.unit_cost), 10)
    s += padR(ing.reorder_point != null ? fmtN(ing.reorder_point) : '—', 10)
    for (const cp of d.coPackers) {
      const qty = cpMap?.get(cp.id) ?? 0
      total += qty
      s += padR(qty > 0 ? fmtN(qty) : '—', 10)
    }
    s += padR(fmtN(total), 10)
    s += '\n'
  }
  return s
}

function buildRecipesSection(d: AllData, conversions: ReturnType<typeof loadConversions> extends Promise<infer T> ? T : never): string {
  let s = '## Recipes & COGS\n'
  s += pad('Recipe', 28) + pad('SKU', 14) + pad('Co-Packer', 14) + pad('Status', 12) + padR('Pkg Size', 10) + padR('COGS/Unit', 10) + '\n'
  s += '-'.repeat(88) + '\n'

  for (const rec of d.recipes) {
    const cp = d.coPackers.find((c) => c.id === rec.co_packer_id)
    const breakdown = calculateRecipeCOGSBreakdown(rec.id, d.recipeIngredients, d.ingredients, conversions)
    s += pad(rec.name, 28)
    s += pad(rec.sku, 14)
    s += pad(cp?.short_code ?? '—', 14)
    s += pad(rec.status ?? 'active', 12)
    s += padR(rec.package_size ? `${rec.package_size} ${rec.package_size_unit}` : '—', 10)
    s += padR(fmtD(breakdown.total), 10)
    s += '\n'
  }
  return s
}

function buildPurchaseOrdersSection(d: AllData): string {
  let s = '## Purchase Orders (Last 20)\n'
  s += pad('PO#', 12) + pad('Supplier', 18) + pad('Status', 12) + pad('Dest CP', 10) + pad('Order Date', 12) + pad('ETA', 12) + padR('Total', 12) + padR('Items', 6) + '\n'
  s += '-'.repeat(94) + '\n'

  for (const po of d.purchaseOrders) {
    const sup = d.suppliers.find((s) => s.id === po.supplier_id)
    const cp = d.coPackers.find((c) => c.id === po.destination_co_packer_id)
    const items = d.poItems.filter((pi) => pi.purchase_order_id === po.id)
    const total = items.reduce((sum, pi) => sum + pi.quantity * pi.unit_cost, 0) + (po.shipping_cost ?? 0)
    s += pad(po.po_number, 12)
    s += pad((sup?.name ?? '—').slice(0, 17), 18)
    s += pad(po.status ?? 'draft', 12)
    s += pad(cp?.short_code ?? '—', 10)
    s += pad(shortDate(po.order_date), 12)
    s += pad(shortDate(po.eta_date), 12)
    s += padR(fmtD(total), 12)
    s += padR(String(items.length), 6)
    s += '\n'
  }
  return s
}

function buildProductionSection(d: AllData): string {
  const activeOrders = d.productionOrders.filter((o) => o.status !== 'completed' && o.status !== 'cancelled')

  let s = '## Active Production Orders\n'
  s += pad('Order#', 12) + pad('Co-Packer', 12) + pad('Status', 14) + pad('Ingredients', 12) + pad('Priority', 10) + padR('Total Units', 12) + padR('Est. Cost', 12) + '\n'
  s += '-'.repeat(84) + '\n'

  for (const po of activeOrders) {
    const cp = d.coPackers.find((c) => c.id === po.co_packer_id)
    s += pad(po.order_number, 12)
    s += pad(cp?.short_code ?? '—', 12)
    s += pad(po.status, 14)
    s += pad(po.ingredient_status ?? '—', 12)
    s += pad(po.priority, 10)
    s += padR(fmtN(po.total_units), 12)
    s += padR(fmtD(po.total_estimated_cost), 12)
    s += '\n'
  }

  // Active production runs
  const activeRuns = d.productionRuns.filter((r) => r.status !== 'reconciled' && r.status !== 'cancelled').slice(0, 20)
  if (activeRuns.length > 0) {
    s += '\n## Active Production Runs\n'
    s += pad('Run#', 12) + pad('Recipe', 22) + pad('Co-Packer', 10) + pad('Status', 14) + padR('Req Qty', 10) + padR('Produced', 10) + '\n'
    s += '-'.repeat(78) + '\n'
    for (const run of activeRuns) {
      const rec = d.recipes.find((r) => r.id === run.recipe_id)
      const cp = d.coPackers.find((c) => c.id === run.co_packer_id)
      s += pad(run.run_number, 12)
      s += pad((rec?.name ?? '—').slice(0, 21), 22)
      s += pad(cp?.short_code ?? '—', 10)
      s += pad(run.status ?? '—', 14)
      s += padR(fmtN(run.requested_quantity), 10)
      s += padR(fmtN(run.produced_quantity), 10)
      s += '\n'
    }
  }

  return s
}

function buildSuppliersSection(d: AllData): string {
  let s = '## Suppliers & Pricing\n'
  s += pad('Supplier', 22) + pad('Lead Time', 10) + pad('Payment', 14) + padR('Rating', 8) + '\n'
  s += '-'.repeat(54) + '\n'

  for (const sup of d.suppliers) {
    s += pad(sup.name, 22)
    s += pad(sup.lead_time_days != null ? `${sup.lead_time_days} days` : '—', 10)
    s += pad(sup.payment_terms ?? '—', 14)
    s += padR(sup.rating != null ? `${sup.rating}/5` : '—', 8)
    s += '\n'
  }

  // Supplier ingredient pricing
  s += '\n## Supplier Ingredient Prices\n'
  s += pad('Supplier', 18) + pad('Ingredient', 22) + padR('Price/Unit', 12) + pad('Package', 22) + padR('Price/Pkg', 12) + '\n'
  s += '-'.repeat(86) + '\n'

  for (const si of d.supplierIngredients) {
    const sup = d.suppliers.find((s) => s.id === si.supplier_id)
    const ing = d.ingredients.find((i) => i.id === si.ingredient_id)
    if (!sup || !ing) continue
    s += pad(sup.name.slice(0, 17), 18)
    s += pad(ing.name.slice(0, 21), 22)
    s += padR(si.price_per_unit != null ? `${fmtD(si.price_per_unit)}/${si.price_unit ?? ing.unit}` : '—', 12)
    const pkg = si.package_size && si.package_name
      ? `${si.package_size} ${si.package_unit ?? ''} ${si.package_name}`
      : '—'
    s += pad(pkg.slice(0, 21), 22)
    s += padR(fmtD(si.price_per_package), 12)
    s += '\n'
  }

  return s
}

function buildShipmentsSection(d: AllData): string {
  let s = '## Recent Shipments (Last 10)\n'
  s += pad('Shipment#', 14) + pad('Supplier', 16) + pad('To CP', 10) + pad('Status', 12) + pad('Ship Date', 12) + pad('Received', 12) + padR('Value', 12) + '\n'
  s += '-'.repeat(88) + '\n'

  for (const ship of d.shipments) {
    const sup = d.suppliers.find((s) => s.id === ship.supplier_id)
    const cp = d.coPackers.find((c) => c.id === ship.co_packer_id)
    s += pad(ship.shipment_number, 14)
    s += pad((sup?.name ?? '—').slice(0, 15), 16)
    s += pad(cp?.short_code ?? '—', 10)
    s += pad(ship.status ?? '—', 12)
    s += pad(shortDate(ship.ship_date), 12)
    s += pad(shortDate(ship.received_date), 12)
    s += padR(fmtD(ship.total_value), 12)
    s += '\n'
  }
  return s
}

function buildFinishedGoodsSection(d: AllData): string {
  // Summarize FG by recipe: total produced, shipped, at CP
  const recipeMap = new Map<string, { produced: number; shipped: number; atCP: number }>()
  for (const mv of d.movements) {
    const rid = mv.recipe_id ?? 'unknown'
    if (!recipeMap.has(rid)) recipeMap.set(rid, { produced: 0, shipped: 0, atCP: 0 })
    const row = recipeMap.get(rid)!
    if (mv.from_location === 'production') row.produced += mv.quantity
    if (mv.to_location === 'fba' || mv.to_location === '3pl' || mv.to_location === 'fulfillment') row.shipped += mv.quantity
    if (mv.to_location === 'copacker_storage') row.atCP += mv.quantity
  }

  let s = '## Finished Goods Summary\n'
  s += pad('Recipe', 28) + padR('Produced', 10) + padR('Shipped', 10) + padR('At CP', 10) + '\n'
  s += '-'.repeat(58) + '\n'

  for (const [rid, data] of recipeMap) {
    const rec = d.recipes.find((r) => r.id === rid)
    s += pad((rec?.name ?? 'Unknown').slice(0, 27), 28)
    s += padR(fmtN(data.produced), 10)
    s += padR(fmtN(data.shipped), 10)
    s += padR(fmtN(data.atCP), 10)
    s += '\n'
  }
  return s
}

function buildDashboardMetrics(d: AllData): string {
  // Total inventory value
  let totalInvValue = 0
  for (const iv of d.inventory) {
    const ing = d.ingredients.find((i) => i.id === iv.ingredient_id)
    totalInvValue += iv.quantity * (ing?.unit_cost ?? 0)
  }

  // Low stock count
  let lowStockCount = 0
  for (const ing of d.ingredients) {
    if (!ing.reorder_point) continue
    const total = d.inventory
      .filter((iv) => iv.ingredient_id === ing.id)
      .reduce((s, iv) => s + iv.quantity, 0)
    if (total < ing.reorder_point) lowStockCount++
  }

  // Active POs
  const activePOs = d.purchaseOrders.filter((po) => po.status === 'ordered' || po.status === 'in_transit')
  const activePOValue = activePOs.reduce((sum, po) => {
    const items = d.poItems.filter((pi) => pi.purchase_order_id === po.id)
    return sum + items.reduce((s, pi) => s + pi.quantity * pi.unit_cost, 0) + (po.shipping_cost ?? 0)
  }, 0)

  // Active production
  const activeRuns = d.productionRuns.filter((r) =>
    r.status === 'in_production' || r.status === 'scheduled' || r.status === 'requested'
  )

  let s = '## Dashboard Metrics\n'
  s += `Total Inventory Value: ${fmtD(totalInvValue)}\n`
  s += `Low Stock Ingredients: ${lowStockCount}\n`
  s += `Active POs: ${activePOs.length} (${fmtD(activePOValue)} total)\n`
  s += `Active Production Runs: ${activeRuns.length}\n`
  s += `Total Ingredients: ${d.ingredients.length}\n`
  s += `Total Recipes: ${d.recipes.length}\n`
  s += `Total Suppliers: ${d.suppliers.length}\n`
  s += `Total Co-Packers: ${d.coPackers.length}\n`
  return s
}

/* ── Public API ────────────────────────────────────────────────── */

export async function buildDataContext(): Promise<string> {
  const [d, conversions] = await Promise.all([fetchAllData(), loadConversions()])
  const sections = [
    buildDashboardMetrics(d),
    buildCoPackersSection(d),
    buildIngredientsSection(d),
    buildRecipesSection(d, conversions),
    buildPurchaseOrdersSection(d),
    buildProductionSection(d),
    buildShipmentsSection(d),
    buildFinishedGoodsSection(d),
    buildSuppliersSection(d),
  ]
  return sections.join('\n')
}

export type AiTopic = 'inventory' | 'costs' | 'purchasing' | 'production' | 'suppliers' | 'finished_goods' | 'general'

export async function buildTopicContext(topic: AiTopic): Promise<string> {
  if (topic === 'general') return buildDataContext()

  const [d, conversions] = await Promise.all([fetchAllData(), loadConversions()])
  const sections: string[] = [buildDashboardMetrics(d)]

  switch (topic) {
    case 'inventory':
      sections.push(buildCoPackersSection(d))
      sections.push(buildIngredientsSection(d))
      break
    case 'costs':
      sections.push(buildRecipesSection(d, conversions))
      sections.push(buildIngredientsSection(d))
      sections.push(buildSuppliersSection(d))
      break
    case 'purchasing':
      sections.push(buildPurchaseOrdersSection(d))
      sections.push(buildSuppliersSection(d))
      sections.push(buildCoPackersSection(d))
      break
    case 'production':
      sections.push(buildProductionSection(d))
      sections.push(buildRecipesSection(d, conversions))
      sections.push(buildCoPackersSection(d))
      break
    case 'suppliers':
      sections.push(buildSuppliersSection(d))
      sections.push(buildPurchaseOrdersSection(d))
      break
    case 'finished_goods':
      sections.push(buildFinishedGoodsSection(d))
      sections.push(buildShipmentsSection(d))
      sections.push(buildRecipesSection(d, conversions))
      break
  }

  return sections.join('\n')
}

export function detectTopic(message: string): AiTopic {
  const lower = message.toLowerCase()
  if (/\b(inventory|stock|how much|low stock|reorder|on hand)\b/.test(lower)) return 'inventory'
  if (/\b(cost|cogs|price|expensive|margin|cheaper|pricing)\b/.test(lower)) return 'costs'
  if (/\b(order|po\b|purchase|buying)\b/.test(lower)) return 'purchasing'
  if (/\b(production|run|batch|manufacture|planner)\b/.test(lower)) return 'production'
  if (/\b(supplier|vendor)\b/.test(lower)) return 'suppliers'
  if (/\b(ship|fba|3pl|transit|finished good|fulfillment)\b/.test(lower)) return 'finished_goods'
  return 'general'
}
