import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { format, startOfMonth, subMonths } from 'date-fns'
import PageHeader from '../components/PageHeader'
import CPFilterBar from '../components/CPFilterBar'
import StatCard from '../components/StatCard'
import CPBadge from '../components/CPBadge'
import Badge from '../components/Badge'
import RecipeIcon from '../components/RecipeIcon'
import { PageSkeleton } from '../components/Skeleton'
import { fmt$, fmtNum, fmtDate } from '../lib/format'
import { MapPin, AlertTriangle } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import type {
  CoPacker,
  Ingredient,
  IngredientInventory,
  ProductionRun,
  ProductionOrder,
  Recipe,
  RecipeIngredient,
  FinishedGoodsMovement,
  PurchaseOrder,
  PurchaseOrderItem,
} from '../types/database'
import { loadConversions, getConversionFactorWithDensity, type ConversionMap } from '../lib/conversions'
import { buildProcurementRows } from '../lib/procurement'

/* ── Status badge config ──────────────────────────────────────── */

const STATUS_BADGE: Record<string, { color: 'gray' | 'cyan' | 'amber' | 'purple' | 'green' | 'red'; label: string }> = {
  requested: { color: 'gray', label: 'REQUESTED' },
  scheduled: { color: 'cyan', label: 'SCHEDULED' },
  in_production: { color: 'amber', label: 'IN PRODUCTION' },
  complete: { color: 'purple', label: 'COMPLETE' },
  reconciled: { color: 'green', label: 'RECONCILED' },
  flagged: { color: 'red', label: 'FLAGGED' },
}

const DEFAULT_RUN_SIZE = 5000

/* ================================================================ */

export default function Dashboard() {
  const { can } = useAuth()
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [inventory, setInventory] = useState<IngredientInventory[]>([])
  const [runs, setRuns] = useState<ProductionRun[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [loading, setLoading] = useState(true)
  const [recipeIngredients, setRecipeIngredients] = useState<RecipeIngredient[]>([])
  const [movements, setMovements] = useState<FinishedGoodsMovement[]>([])
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [poItems, setPOItems] = useState<PurchaseOrderItem[]>([])
  const [productionOrders, setProductionOrders] = useState<ProductionOrder[]>([])
  const [conversions, setConversions] = useState<ConversionMap>(new Map())
  const [cpFilter, setCpFilter] = useState('all')

  async function load() {
    const [cpRes, ingRes, invRes, runRes, recRes, riRes, mvRes, poRes, convMap, prodOrdRes, poItemsRes] = await safeBatch(() => Promise.all([
      supabase.from('co_packers').select('*').order('name'),
      supabase.from('ingredients').select('*').order('name'),
      supabase.from('ingredient_inventory').select('*'),
      supabase.from('production_runs').select('*').order('requested_date', { ascending: false }),
      supabase.from('recipes').select('*'),
      supabase.from('recipe_ingredients').select('*'),
      supabase.from('finished_goods_movements').select('*'),
      supabase.from('purchase_orders').select('*'),
      loadConversions(),
      supabase.from('production_orders').select('*'),
      supabase.from('purchase_order_items').select('*'),
    ]))
    setCoPackers(cpRes.data ?? [])
    setIngredients(ingRes.data ?? [])
    setInventory(invRes.data ?? [])
    setRuns(runRes.data ?? [])
    setRecipes(recRes.data ?? [])
    setRecipeIngredients(riRes.data ?? [])
    setMovements(mvRes.data ?? [])
    setPurchaseOrders(poRes.data ?? [])
    setConversions(convMap)
    setProductionOrders(prodOrdRes.data ?? [])
    setPOItems(poItemsRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => safeLoad(load, setLoading), [])

  /* ── Visible co-packers ──────────────────────────────────────── */

  const visibleCPs = useMemo(() => {
    if (cpFilter === 'all') return coPackers
    return coPackers.filter((cp) => cp.id === cpFilter)
  }, [coPackers, cpFilter])

  /* ── Stat 1: Total Ingredient Value ──────────────────────────── */

  const totalIngValue = useMemo(() => {
    return inventory
      .filter(
        (iv) =>
          iv.location_type === 'copacker' &&
          (cpFilter === 'all' || iv.co_packer_id === cpFilter),
      )
      .reduce((sum, iv) => {
        const ing = ingredients.find((i) => i.id === iv.ingredient_id)
        return sum + (iv.quantity ?? 0) * (ing?.unit_cost ?? 0)
      }, 0)
  }, [inventory, ingredients, cpFilter])

  /* ── Stat 2: Active Production Runs ──────────────────────────── */

  const activeStatuses = new Set(['in_production', 'scheduled', 'requested'])

  const activeRuns = useMemo(() => {
    return runs.filter(
      (r) =>
        activeStatuses.has(r.status ?? '') &&
        (cpFilter === 'all' || r.co_packer_id === cpFilter),
    )
  }, [runs, cpFilter])

  const activeRunsBreakdown = useMemo(() => {
    const map: Record<string, number> = {}
    for (const r of activeRuns) {
      const cp = coPackers.find((c) => c.id === r.co_packer_id)
      const code = cp?.short_code ?? '?'
      map[code] = (map[code] ?? 0) + 1
    }
    return Object.entries(map)
      .map(([code, count]) => `${code}: ${count}`)
      .join(' · ')
  }, [activeRuns, coPackers])

  /* ── Stat 3: Avg Waste Rate (MTD) ───────────────────────────── */

  const wasteStats = useMemo(() => {
    const thisMonth = format(startOfMonth(new Date()), 'yyyy-MM-dd')
    const lastMonthStart = format(startOfMonth(subMonths(new Date(), 1)), 'yyyy-MM-dd')
    const lastMonthEnd = format(startOfMonth(new Date()), 'yyyy-MM-dd')

    const reconciledThisMonth = runs.filter(
      (r) =>
        r.status === 'reconciled' &&
        r.completed_date &&
        r.completed_date >= thisMonth &&
        r.waste_pct != null &&
        (cpFilter === 'all' || r.co_packer_id === cpFilter),
    )
    const reconciledLastMonth = runs.filter(
      (r) =>
        r.status === 'reconciled' &&
        r.completed_date &&
        r.completed_date >= lastMonthStart &&
        r.completed_date < lastMonthEnd &&
        r.waste_pct != null &&
        (cpFilter === 'all' || r.co_packer_id === cpFilter),
    )

    const avgThisMonth =
      reconciledThisMonth.length > 0
        ? reconciledThisMonth.reduce((s, r) => s + (r.waste_pct ?? 0), 0) / reconciledThisMonth.length
        : null
    const avgLastMonth =
      reconciledLastMonth.length > 0
        ? reconciledLastMonth.reduce((s, r) => s + (r.waste_pct ?? 0), 0) / reconciledLastMonth.length
        : null

    return { avgThisMonth, avgLastMonth, countThisMonth: reconciledThisMonth.length }
  }, [runs, cpFilter])

  /* ── Stat 4: Finished Goods in Transit ───────────────────────── */

  const fgInTransit = useMemo(() => {
    return movements
      .filter(
        (m) =>
          m.status === 'in_transit' &&
          (cpFilter === 'all' || m.co_packer_id === cpFilter),
      )
      .reduce((s, m) => s + m.quantity, 0)
  }, [movements, cpFilter])

  /* ── Co-Packer Scorecards ────────────────────────────────────── */

  const scorecards = useMemo(() => {
    return visibleCPs.map((cp) => {
      // Inventory value
      const cpInv = inventory.filter(
        (iv) => iv.location_type === 'copacker' && iv.co_packer_id === cp.id,
      )
      const invValue = cpInv.reduce((s, iv) => {
        const ing = ingredients.find((i) => i.id === iv.ingredient_id)
        return s + (iv.quantity ?? 0) * (ing?.unit_cost ?? 0)
      }, 0)

      // SKU count
      const skuCount = recipes.filter((r) => r.co_packer_id === cp.id).length

      // Active runs
      const cpActiveRuns = runs.filter(
        (r) =>
          r.co_packer_id === cp.id &&
          (r.status === 'in_production' || r.status === 'scheduled'),
      )

      // In production qty
      const inProdQty = runs
        .filter(
          (r) =>
            r.co_packer_id === cp.id &&
            activeStatuses.has(r.status ?? ''),
        )
        .reduce((s, r) => s + r.requested_quantity, 0)

      // Waste MTD
      const thisMonth = format(startOfMonth(new Date()), 'yyyy-MM-dd')
      const cpReconciledMTD = runs.filter(
        (r) =>
          r.co_packer_id === cp.id &&
          r.status === 'reconciled' &&
          r.completed_date &&
          r.completed_date >= thisMonth &&
          r.waste_pct != null,
      )
      const wasteMTD =
        cpReconciledMTD.length > 0
          ? cpReconciledMTD.reduce((s, r) => s + (r.waste_pct ?? 0), 0) / cpReconciledMTD.length
          : null

      // Unreconciled count
      const unreconciledCount = runs.filter(
        (r) => r.co_packer_id === cp.id && r.status === 'complete',
      ).length

      return {
        cp,
        invValue,
        skuCount,
        activeRunCount: cpActiveRuns.length,
        inProdQty,
        wasteMTD,
        unreconciledCount,
      }
    })
  }, [visibleCPs, inventory, ingredients, recipes, runs])

  /* ── Action Items ────────────────────────────────────────────── */

  const actionItems = useMemo(() => {
    const items: { priority: number; color: string; node: React.ReactNode }[] = []

    // 1. Ingredients below 1-run threshold at any CP
    for (const cp of (cpFilter === 'all' ? coPackers : coPackers.filter((c) => c.id === cpFilter))) {
      const cpInv = inventory.filter(
        (iv) => iv.location_type === 'copacker' && iv.co_packer_id === cp.id,
      )
      const cpRecipes = recipes.filter((r) => r.co_packer_id === cp.id)
      const cpRecipeIds = new Set(cpRecipes.map((r) => r.id))
      const cpRI = recipeIngredients.filter((ri) => cpRecipeIds.has(ri.recipe_id))

      for (const iv of cpInv) {
        const ing = ingredients.find((i) => i.id === iv.ingredient_id)
        if (!ing) continue
        const usages = cpRI.filter((ri) => ri.ingredient_id === iv.ingredient_id)
        if (usages.length === 0) continue

        const qty = iv.quantity ?? 0
        const runCounts = usages.map((ri) => {
          let factor = 1
          try { factor = getConversionFactorWithDensity(conversions, ri.unit, ing.unit, ing.density_g_per_ml) } catch { /* fallback */ }
          const perRun = ri.quantity_per_unit * factor * DEFAULT_RUN_SIZE
          return perRun > 0 ? qty / perRun : Infinity
        })
        const enoughFor = Math.min(...runCounts)

        if (enoughFor < 1) {
          items.push({
            priority: 0,
            color: '#EF4444',
            node: (
              <div className="flex items-center gap-2">
                <CPBadge coPackerId={cp.id} />
                <span>
                  <span className="font-medium text-text">{ing.name}</span>
                  <span className="text-muted"> at {cp.short_code} below 1-run threshold — reorder + ship</span>
                </span>
              </div>
            ),
          })
        }
      }
    }

    // 2. Unreconciled runs (status = complete)
    const completeRuns = runs.filter(
      (r) =>
        r.status === 'complete' &&
        (cpFilter === 'all' || r.co_packer_id === cpFilter),
    )
    for (const r of completeRuns) {
      items.push({
        priority: 1,
        color: '#F59E0B',
        node: (
          <div className="flex items-center gap-2">
            {r.co_packer_id && <CPBadge coPackerId={r.co_packer_id} />}
            <span>
              <span className="font-mono font-medium text-text">{r.run_number}</span>
              <span className="text-muted"> complete — reconcile</span>
            </span>
          </div>
        ),
      })
    }

    // 3. Reconciled runs above waste threshold
    const reconciledRuns = runs.filter(
      (r) =>
        r.status === 'reconciled' &&
        r.waste_pct != null &&
        (cpFilter === 'all' || r.co_packer_id === cpFilter),
    )
    for (const r of reconciledRuns) {
      const recipe = recipes.find((rec) => rec.id === r.recipe_id)
      const threshold = recipe?.waste_tolerance_pct ?? 2.5
      if ((r.waste_pct ?? 0) > threshold) {
        items.push({
          priority: 0,
          color: '#EF4444',
          node: (
            <div className="flex items-center gap-2">
              {r.co_packer_id && <CPBadge coPackerId={r.co_packer_id} />}
              <span>
                <span className="font-mono font-medium text-text">{r.run_number}</span>
                <span className="text-muted">
                  {' '}waste at {r.waste_pct?.toFixed(1)}% — above {threshold}% threshold
                </span>
              </span>
            </div>
          ),
        })
      }
    }

    // 4. POs in transit
    const transitPOs = purchaseOrders.filter(
      (po) =>
        po.status === 'in_transit' &&
        (cpFilter === 'all' || po.destination_co_packer_id === cpFilter),
    )
    for (const po of transitPOs) {
      const dest =
        coPackers.find((c) => c.id === po.destination_co_packer_id)?.short_code ?? po.destination_type ?? '?'
      items.push({
        priority: 2,
        color: '#3B82F6',
        node: (
          <span>
            <span className="font-mono font-medium text-text">{po.po_number}</span>
            <span className="text-muted">
              {' '}arriving {po.eta_date ? fmtDate(po.eta_date) : '?'} — route to {dest}
            </span>
          </span>
        ),
      })
    }

    // 5. Ingredients below reorder point (all locations)
    for (const ing of ingredients) {
      if (!ing.reorder_point || ing.reorder_point <= 0) continue
      const totalQty = inventory
        .filter((iv) => iv.ingredient_id === ing.id)
        .reduce((s, iv) => s + (iv.quantity ?? 0), 0)
      if (totalQty < ing.reorder_point) {
        items.push({
          priority: 1,
          color: '#F59E0B',
          node: (
            <span>
              <span className="font-medium text-text">{ing.name}</span>
              <span className="text-muted">
                {' '}below reorder point ({fmtNum(Math.round(totalQty))} / {fmtNum(ing.reorder_point)} {ing.unit})
              </span>
            </span>
          ),
        })
      }
    }

    // 6. Stale inventory counts (> 30 days since last count)
    const thirtyDaysAgo = Date.now() - 30 * 86_400_000
    for (const cp of (cpFilter === 'all' ? coPackers : coPackers.filter((c) => c.id === cpFilter))) {
      const cpInv = inventory.filter(
        (iv) => iv.location_type === 'copacker' && iv.co_packer_id === cp.id,
      )
      if (cpInv.length === 0) continue

      const lastCount = cpInv
        .map((iv) => iv.last_count_date)
        .filter(Boolean)
        .sort()
        .pop()

      const isStale = !lastCount || new Date(lastCount).getTime() < thirtyDaysAgo
      if (isStale) {
        const daysSince = lastCount
          ? Math.floor((Date.now() - new Date(lastCount).getTime()) / 86_400_000)
          : null
        items.push({
          priority: 2,
          color: '#F59E0B',
          node: (
            <div className="flex items-center gap-2">
              <CPBadge coPackerId={cp.id} />
              <span className="text-muted">
                {cp.name} inventory {daysSince ? `not counted in ${daysSince} days` : 'never counted'}
              </span>
            </div>
          ),
        })
      }
    }

    // 7. Recipes with no freight cost data
    for (const recipe of recipes.filter((r) => r.status === 'active')) {
      if (cpFilter !== 'all' && recipe.co_packer_id !== cpFilter) continue
      const hasActualFreight = movements.some(
        (m) => m.recipe_id === recipe.id && m.shipping_cost != null && Number(m.shipping_cost) > 0,
      )
      const hasEstimate = recipe.estimated_freight_per_unit != null
      if (!hasActualFreight && !hasEstimate) {
        items.push({
          priority: 1,
          color: '#F59E0B',
          node: (
            <span>
              <span className="font-medium text-text">{recipe.name}</span>
              {' '}
              <span className="text-muted">has no freight cost data — Landed COGS may be incomplete</span>
            </span>
          ),
        })
      }
    }

    // 8. Production orders with un-procured ingredients
    for (const order of productionOrders.filter(
      (o) => o.status !== 'complete' && o.status !== 'cancelled',
    )) {
      if (cpFilter !== 'all' && order.co_packer_id !== cpFilter) continue
      if (!order.co_packer_id) continue
      const orderRuns = runs.filter((r) => r.production_order_id === order.id)
      if (orderRuns.length === 0) continue
      const rows = buildProcurementRows({
        order,
        orderRuns,
        recipeIngredients,
        ingredients,
        inventory,
        purchaseOrders,
        poItems,
        conversions,
      })
      const notOrdered = rows.filter((r) => r.status === 'NOT_ORDERED').length
      const partial = rows.filter((r) => r.status === 'PARTIAL').length
      const actionCount = notOrdered + partial
      if (actionCount > 0) {
        items.push({
          priority: 0,
          color: '#EF4444',
          node: (
            <div className="flex items-center gap-2">
              {order.co_packer_id && <CPBadge coPackerId={order.co_packer_id} />}
              <span>
                <span className="font-mono font-medium text-text">{order.order_number}</span>
                <span className="text-muted">
                  {' '}has {actionCount} ingredient{actionCount > 1 ? 's' : ''} not ordered for production
                </span>
              </span>
            </div>
          ),
        })
      }
    }

    // Sort: red (0) first, amber (1), blue (2)
    items.sort((a, b) => a.priority - b.priority)
    return items.slice(0, 12)
  }, [coPackers, ingredients, inventory, recipes, recipeIngredients, runs, purchaseOrders, movements, cpFilter, productionOrders, poItems, conversions])

  /* ── Recent / Active Runs ────────────────────────────────────── */

  const recentRuns = useMemo(() => {
    return runs
      .filter(
        (r) =>
          (r.status === 'in_production' || r.status === 'scheduled' || r.status === 'complete') &&
          (cpFilter === 'all' || r.co_packer_id === cpFilter),
      )
      .slice(0, 8)
  }, [runs, cpFilter])

  /* ── Render ──────────────────────────────────────────────────── */

  if (loading) return <PageSkeleton />

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`FitBake Production Overview — ${format(new Date(), 'EEEE, MMMM d, yyyy')}`}
      />

      <CPFilterBar selected={cpFilter} onSelect={setCpFilter} />

      {/* ── Stat Cards ──────────────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label={cpFilter === 'all' ? 'Total Ingredient Value (All CPs)' : 'Ingredient Value'}
          value={can('view_costs') ? fmt$(totalIngValue) : '\u2014'}
          sub="at co-packers"
        />
        <StatCard
          label="Active Production Runs"
          value={activeRuns.length}
          sub={activeRunsBreakdown || 'None'}
        />
        <StatCard
          label="Avg Waste Rate (MTD)"
          value={wasteStats.avgThisMonth != null ? `${wasteStats.avgThisMonth.toFixed(1)}%` : '—'}
          sub={`${wasteStats.countThisMonth} run${wasteStats.countThisMonth !== 1 ? 's' : ''} this month`}
          trend={
            wasteStats.avgThisMonth != null && wasteStats.avgLastMonth != null
              ? `${wasteStats.avgThisMonth > wasteStats.avgLastMonth ? '↑' : '↓'} vs last month (${wasteStats.avgLastMonth.toFixed(1)}%)`
              : undefined
          }
          trendGood={
            wasteStats.avgThisMonth != null && wasteStats.avgLastMonth != null
              ? wasteStats.avgThisMonth <= wasteStats.avgLastMonth
              : undefined
          }
        />
        <StatCard
          label="Finished Goods in Transit"
          value={fmtNum(fgInTransit)}
          sub="units"
        />
      </div>

      {/* ── Co-Packer Scorecards ────────────────────────────────── */}
      <div className={`mb-6 grid gap-4 ${visibleCPs.length === 1 ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-3'}`}>
        {scorecards.map(({ cp, invValue, skuCount, activeRunCount, inProdQty, wasteMTD, unreconciledCount }) => {
          const hex = cp.color ?? '#3B82F6'
          return (
            <div
              key={cp.id}
              className="overflow-hidden rounded-xl border border-border bg-card"
            >
              {/* Colored top border */}
              <div className="h-[3px]" style={{ backgroundColor: hex }} />

              {/* Header */}
              <div className="px-5 pt-4 pb-3">
                <div className="flex items-center gap-3">
                  <CPBadge coPackerId={cp.id} />
                  <div>
                    <h3 className="text-base font-semibold text-text">{cp.name}</h3>
                    <div className="flex items-center gap-3 text-xs text-muted">
                      {cp.location && (
                        <span className="flex items-center gap-1">
                          <MapPin size={11} />
                          {cp.location}
                        </span>
                      )}
                      <span>{skuCount} SKU{skuCount !== 1 ? 's' : ''}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* 2x2 mini stats */}
              <div className="grid grid-cols-2 gap-px bg-border/30 px-5 pb-4">
                <div className="rounded-tl-lg bg-surface/40 px-3 py-2.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
                    Your Inventory
                  </p>
                  <p className="mt-0.5 font-mono text-sm font-semibold text-text">
                    {can('view_costs') ? fmt$(invValue) : '\u2014'}
                  </p>
                </div>
                <div className="rounded-tr-lg bg-surface/40 px-3 py-2.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
                    Active Runs
                  </p>
                  <p className="mt-0.5 font-mono text-sm font-semibold text-text">
                    {activeRunCount}
                  </p>
                </div>
                <div className="rounded-bl-lg bg-surface/40 px-3 py-2.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
                    Waste (MTD)
                  </p>
                  <p
                    className="mt-0.5 font-mono text-sm font-semibold"
                    style={{
                      color:
                        wasteMTD == null
                          ? '#7A8599'
                          : wasteMTD <= 2.5
                            ? '#22C55E'
                            : wasteMTD <= 3.5
                              ? '#F59E0B'
                              : '#EF4444',
                    }}
                  >
                    {wasteMTD != null ? `${wasteMTD.toFixed(1)}%` : '—'}
                  </p>
                </div>
                <div className="rounded-br-lg bg-surface/40 px-3 py-2.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
                    In Production
                  </p>
                  <p className="mt-0.5 font-mono text-sm font-semibold text-text">
                    {fmtNum(inProdQty)}
                  </p>
                </div>
              </div>

              {/* Unreconciled alert */}
              {unreconciledCount > 0 && (
                <div className="flex items-center gap-2 border-t border-border bg-amber-500/10 px-5 py-2.5 text-xs font-medium text-amber-400">
                  <AlertTriangle size={14} />
                  {unreconciledCount} run{unreconciledCount !== 1 ? 's' : ''} awaiting reconciliation
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Two-column grid ─────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* LEFT — Action Items */}
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-text">Action Items</h3>
          </div>
          {actionItems.length > 0 ? (
            <div className="divide-y divide-border">
              {actionItems.map((item, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-3 text-xs">
                  <div
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  {item.node}
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 py-8 text-center text-sm text-muted">
              No action items — all clear
            </div>
          )}
        </div>

        {/* RIGHT — Active / Recent Runs */}
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-text">Active / Recent Runs</h3>
          </div>
          {recentRuns.length > 0 ? (
            <div className="divide-y divide-border">
              {recentRuns.map((run) => {
                const recipe = recipes.find((r) => r.id === run.recipe_id)
                const badge = STATUS_BADGE[run.status ?? '']
                return (
                  <div
                    key={run.id}
                    className="flex items-center justify-between px-5 py-3"
                  >
                    <div className="flex items-center gap-3">
                      {run.co_packer_id && <CPBadge coPackerId={run.co_packer_id} />}
                      <RecipeIcon imageUrl={recipe?.image_url} recipeName={recipe?.name ?? '—'} coPackerColor={coPackers.find((c) => c.id === run.co_packer_id)?.color} size="sm" />
                      <div>
                        <p className="text-sm font-medium text-text">
                          {recipe?.name ?? '—'}
                        </p>
                        <p className="font-mono text-xs text-muted">
                          {run.run_number} · {fmtNum(run.requested_quantity)} units
                        </p>
                      </div>
                    </div>
                    {badge && <Badge color={badge.color}>{badge.label}</Badge>}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="px-5 py-8 text-center text-sm text-muted">
              No active runs
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
