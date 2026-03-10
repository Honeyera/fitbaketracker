import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { format, subMonths, startOfMonth } from 'date-fns'
import { useToast } from '../components/Toast'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import PageHeader from '../components/PageHeader'
import CPBadge from '../components/CPBadge'
import MiniBar from '../components/MiniBar'
import { PageSkeleton } from '../components/Skeleton'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts'
import type {
  CoPacker,
  ProductionRun,
  Recipe,
  PurchaseOrder,
  FinishedGoodsMovement,
  RecipeIngredient,
  Ingredient,
  RecipeFreightSummary,
  ProductionRunInvoice,
  ReconciliationLine,
} from '../types/database'
import { loadConversions, type ConversionMap } from '../lib/conversions'
import { calculateRecipeCOGS } from '../lib/recipeCosting'
import TrueLandedCogsReport from '../components/TrueLandedCogsReport'

/* ── Helpers ──────────────────────────────────────────────────── */

import { fmt$, fmtRate } from '../lib/format'

/* ── COGS table types ──────────────────────────────────────────── */

type CogsFilter = 'all' | 'active' | 'complete'
type CogsSortKey = 'sku' | 'name' | 'status' | 'ingredientCogs' | 'cpFee' | 'freight' | 'landedCogs'

interface CogsRow {
  recipe: Recipe
  cpName: string | null
  ingredientCogs: number | null
  cpFee: number | null
  freight: number | null
  freightEstimated: boolean
  landedCogs: number | null
  isPartial: boolean
  isComplete: boolean
}

/* ── Report card icons (text-based) ───────────────────────────── */

const REPORT_CARDS = [
  { icon: '⊞', title: 'Co-Packer Comparison', desc: 'Side-by-side waste, on-time, cost across all CPs' },
  { icon: '△', title: 'Ingredient Reconciliation', desc: 'Sent vs used vs remaining, per CP and period' },
  { icon: '▤', title: 'Inventory Valuation', desc: 'What you own, where it sits, at co-packers and fulfillment centers' },
  { icon: '◈', title: 'Lot Traceability', desc: 'PO → co-packer → finished unit → FBA/3PL' },
  { icon: '◰', title: 'Monthly P&L by SKU', desc: 'Revenue vs. landed COGS by product' },
]

/* ================================================================ */

export default function Reports() {
  const { can } = useAuth()
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [runs, setRuns] = useState<ProductionRun[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [fgMovements, setFgMovements] = useState<FinishedGoodsMovement[]>([])
  const [recipeIngredients, setRecipeIngredients] = useState<RecipeIngredient[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [freightSummaries, setFreightSummaries] = useState<RecipeFreightSummary[]>([])
  const [invoices, setInvoices] = useState<ProductionRunInvoice[]>([])
  const [reconciliationLines, setReconciliationLines] = useState<ReconciliationLine[]>([])
  const [conversions, setConversions] = useState<ConversionMap>(new Map())
  const [loading, setLoading] = useState(true)
  const toast = useToast()

  /* ── COGS table UI state ─────────────────────────────────────── */
  const [cogsFilter, setCogsFilter] = useState<CogsFilter>('all')
  const [cogsSortKey, setCogsSortKey] = useState<CogsSortKey>('landedCogs')
  const [cogsSortAsc, setCogsSortAsc] = useState(false)

  async function load() {
    const [cpRes, runRes, recRes, poRes, mvRes, riRes, ingRes, frRes, invRes, rlRes] = await safeBatch(() => Promise.all([
      supabase.from('co_packers').select('*').order('name'),
      supabase.from('production_runs').select('*').order('completed_date', { ascending: true }),
      supabase.from('recipes').select('*'),
      supabase.from('purchase_orders').select('*'),
      supabase.from('finished_goods_movements').select('*'),
      supabase.from('recipe_ingredients').select('*'),
      supabase.from('ingredients').select('*'),
      supabase.from('recipe_freight_summary').select('*'),
      supabase.from('production_run_invoices').select('*'),
      supabase.from('reconciliation_lines').select('*'),
    ]))
    setCoPackers(cpRes.data ?? [])
    setRuns(runRes.data ?? [])
    setRecipes(recRes.data ?? [])
    setPurchaseOrders(poRes.data ?? [])
    setFgMovements(mvRes.data ?? [])
    setRecipeIngredients(riRes.data ?? [])
    setIngredients(ingRes.data ?? [])
    setFreightSummaries(frRes.data ?? [])
    setInvoices(invRes.data ?? [])
    setReconciliationLines(rlRes.data ?? [])
    const convs = await loadConversions()
    setConversions(convs)
    setLoading(false)
  }

  useEffect(() => safeLoad(load, setLoading), [])

  /* (toast is now global via ToastProvider) */

  /* ── 1. Co-Packer Performance Scorecard ──────────────────────── */

  const scorecardRows = useMemo(() => {
    return coPackers.map((cp) => {
      const cpRuns = runs.filter((r) => r.co_packer_id === cp.id)
      const reconciledRuns = cpRuns.filter((r) => r.status === 'reconciled' && r.waste_pct != null)

      const avgWaste =
        reconciledRuns.length > 0
          ? reconciledRuns.reduce((s, r) => s + (r.waste_pct ?? 0), 0) / reconciledRuns.length
          : null

      const bestRun =
        reconciledRuns.length > 0
          ? Math.min(...reconciledRuns.map((r) => r.waste_pct ?? Infinity))
          : null

      const worstRun =
        reconciledRuns.length > 0
          ? Math.max(...reconciledRuns.map((r) => r.waste_pct ?? -Infinity))
          : null

      const totalUnits = cpRuns.reduce((s, r) => s + (r.produced_quantity ?? 0), 0)

      return {
        cp,
        avgWaste,
        bestRun,
        worstRun,
        totalRuns: cpRuns.length,
        totalUnits,
      }
    })
  }, [coPackers, runs])

  /* ── 2. Waste Trend Chart Data ───────────────────────────────── */

  const wasteTrendData = useMemo(() => {
    const reconciledRuns = runs
      .filter((r) => (r.status === 'reconciled' || r.status === 'flagged') && r.waste_pct != null && r.completed_date)
      .sort((a, b) => (a.completed_date ?? '').localeCompare(b.completed_date ?? ''))
      .slice(-12)

    return reconciledRuns.map((r) => {
      const cp = coPackers.find((c) => c.id === r.co_packer_id)
      const recipe = recipes.find((rec) => rec.id === r.recipe_id)
      const entry: Record<string, unknown> = {
        run: r.run_number,
        cpName: cp?.short_code ?? '?',
        recipeName: recipe?.name ?? '?',
        wasteCost: r.waste_cost ?? 0,
      }
      // Put waste_pct under the CP's short_code key so bars are grouped by CP
      if (cp) {
        entry[cp.short_code] = r.waste_pct ?? 0
      }
      return entry
    })
  }, [runs, coPackers, recipes])

  const wasteChartCPs = useMemo(() => {
    const codes = new Set<string>()
    for (const d of wasteTrendData) {
      for (const cp of coPackers) {
        if (d[cp.short_code] !== undefined) codes.add(cp.short_code)
      }
    }
    return coPackers.filter((cp) => codes.has(cp.short_code))
  }, [wasteTrendData, coPackers])

  /* ── 3. Landed COGS by SKU (full table) ─────────────────────── */

  const cogsRows = useMemo<CogsRow[]>(() => {
    return recipes.map((recipe) => {
      const cp = coPackers.find((c) => c.id === recipe.co_packer_id)

      // ── Ingredient COGS ──
      let ingredientCogs: number | null = null
      if (recipe.ingredient_cogs != null && recipe.ingredient_cogs > 0) {
        ingredientCogs = recipe.ingredient_cogs
      } else {
        // Calculate live from recipe_ingredients
        const live = calculateRecipeCOGS(recipe.id, recipeIngredients, ingredients, conversions)
        ingredientCogs = live > 0 ? live : null
      }

      // ── Co-Packer Fee ──
      let cpFee: number | null = null
      // Check invoices for actual per_unit_cost
      const recipeRuns = runs.filter((r) => r.recipe_id === recipe.id)
      const runIds = new Set(recipeRuns.map((r) => r.id))
      const recipeInvoices = invoices.filter(
        (inv) => inv.per_unit_cost != null && inv.per_unit_cost > 0 && inv.production_run_id && runIds.has(inv.production_run_id),
      )
      if (recipeInvoices.length > 0) {
        // Use average of actual invoice per_unit_cost
        cpFee = recipeInvoices.reduce((s, inv) => s + (inv.per_unit_cost ?? 0), 0) / recipeInvoices.length
      } else if (cp?.fee_per_unit != null && cp.fee_per_unit > 0) {
        cpFee = cp.fee_per_unit
      }

      // ── Freight ──
      let freight: number | null = null
      let freightEstimated = false
      // 1. From recipe_freight_summary
      const freightSummary = freightSummaries.find((f) => f.recipe_id === recipe.id)
      if (freightSummary?.avg_total_freight != null && freightSummary.avg_total_freight > 0) {
        freight = freightSummary.avg_total_freight
      } else {
        // 2. From actual finished_goods_movements
        const recipeMoves = fgMovements.filter(
          (m) => m.recipe_id === recipe.id && m.shipping_cost != null && Number(m.shipping_cost) > 0,
        )
        if (recipeMoves.length > 0) {
          const tc = recipeMoves.reduce((s, m) => s + Number(m.shipping_cost ?? 0), 0)
          const tq = recipeMoves.reduce((s, m) => s + m.quantity, 0)
          freight = tq > 0 ? tc / tq : null
        } else if (recipe.estimated_freight_per_unit != null) {
          // 3. From recipe estimated freight
          freight = Number(recipe.estimated_freight_per_unit)
          freightEstimated = true
        }
      }

      // ── Landed COGS ──
      const hasAllComponents = ingredientCogs != null && cpFee != null && freight != null
      const landedCogs = (ingredientCogs ?? 0) + (cpFee ?? 0) + (freight ?? 0)
      const isPartial = !hasAllComponents && landedCogs > 0

      return {
        recipe,
        cpName: cp?.name ?? null,
        ingredientCogs,
        cpFee,
        freight,
        freightEstimated,
        landedCogs: landedCogs > 0 ? landedCogs : null,
        isPartial,
        isComplete: hasAllComponents,
      }
    })
  }, [recipes, coPackers, recipeIngredients, ingredients, conversions, runs, invoices, freightSummaries, fgMovements])

  // Filter
  const filteredCogsRows = useMemo(() => {
    let rows = cogsRows
    if (cogsFilter === 'active') rows = rows.filter((r) => r.recipe.status === 'active')
    if (cogsFilter === 'complete') rows = rows.filter((r) => r.isComplete)
    return rows
  }, [cogsRows, cogsFilter])

  // Sort
  const sortedCogsRows = useMemo(() => {
    const sorted = [...filteredCogsRows].sort((a, b) => {
      let va: number | string | null
      let vb: number | string | null
      switch (cogsSortKey) {
        case 'sku': va = a.recipe.sku; vb = b.recipe.sku; break
        case 'name': va = a.recipe.name; vb = b.recipe.name; break
        case 'status': va = a.recipe.status ?? ''; vb = b.recipe.status ?? ''; break
        case 'ingredientCogs': va = a.ingredientCogs; vb = b.ingredientCogs; break
        case 'cpFee': va = a.cpFee; vb = b.cpFee; break
        case 'freight': va = a.freight; vb = b.freight; break
        case 'landedCogs': va = a.landedCogs; vb = b.landedCogs; break
        default: va = a.landedCogs; vb = b.landedCogs
      }
      // Nulls sort last regardless of direction
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'string' && typeof vb === 'string') {
        return cogsSortAsc ? va.localeCompare(vb) : vb.localeCompare(va)
      }
      return cogsSortAsc ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
    return sorted
  }, [filteredCogsRows, cogsSortKey, cogsSortAsc])

  // Summary stats
  const cogsSummary = useMemo(() => {
    const total = cogsRows.length
    const withComplete = cogsRows.filter((r) => r.isComplete).length
    const missing = total - withComplete
    const completeLanded = cogsRows.filter((r) => r.isComplete && r.landedCogs != null).map((r) => r.landedCogs!)
    const avg = completeLanded.length > 0
      ? completeLanded.reduce((s, v) => s + v, 0) / completeLanded.length
      : null
    let highest: CogsRow | null = null
    let lowest: CogsRow | null = null
    for (const r of cogsRows) {
      if (r.landedCogs == null) continue
      if (!highest || r.landedCogs > (highest.landedCogs ?? 0)) highest = r
      if (!lowest || r.landedCogs < (lowest.landedCogs ?? Infinity)) lowest = r
    }
    return { total, withComplete, missing, avg, highest, lowest }
  }, [cogsRows])

  function handleCogsSort(key: CogsSortKey) {
    if (cogsSortKey === key) {
      setCogsSortAsc(!cogsSortAsc)
    } else {
      setCogsSortKey(key)
      setCogsSortAsc(false)
    }
  }

  function cogsSortIcon(key: CogsSortKey) {
    if (cogsSortKey !== key) return ''
    return cogsSortAsc ? ' ↑' : ' ↓'
  }

  /* ── 4. Monthly Ingredient Spend ─────────────────────────────── */

  const monthlySpendData = useMemo(() => {
    const months: { key: string; label: string }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = subMonths(new Date(), i)
      months.push({
        key: format(startOfMonth(d), 'yyyy-MM'),
        label: format(d, 'MMM yyyy'),
      })
    }

    const ingredientByMonth: Record<string, number> = {}
    const shippingByMonth: Record<string, number> = {}
    for (const po of purchaseOrders) {
      if (!po.order_date) continue
      const month = po.order_date.slice(0, 7) // yyyy-MM
      if (po.total_cost) ingredientByMonth[month] = (ingredientByMonth[month] ?? 0) + po.total_cost
      if (po.shipping_cost) shippingByMonth[month] = (shippingByMonth[month] ?? 0) + po.shipping_cost
    }

    return months.map((m) => ({
      month: m.label,
      spend: (ingredientByMonth[m.key] ?? 0) + (shippingByMonth[m.key] ?? 0),
      ingredients: ingredientByMonth[m.key] ?? 0,
      shipping: shippingByMonth[m.key] ?? 0,
    }))
  }, [purchaseOrders])

  /* ── Custom Tooltip for Waste Chart ──────────────────────────── */

  function WasteTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; dataKey: string; color: string }>; label?: string }) {
    if (!active || !payload || payload.length === 0) return null
    const data = wasteTrendData.find((d) => d.run === label)
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
        <p className="font-mono font-medium text-accent">{label}</p>
        <p className="text-muted">{data?.cpName as string} — {data?.recipeName as string}</p>
        {payload.map((p, i) => (
          <p key={i} className="mt-1 font-mono" style={{ color: p.color }}>
            Waste: {Number(p.value).toFixed(1)}%
          </p>
        ))}
        {data?.wasteCost != null && (
          <p className="font-mono text-red-400">Cost: {fmt$(data.wasteCost as number)}</p>
        )}
      </div>
    )
  }

  /* ── Custom Tooltip for Spend Chart ──────────────────────────── */

  function SpendTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; dataKey: string }>; label?: string }) {
    if (!active || !payload || payload.length === 0) return null
    const data = monthlySpendData.find((d) => d.month === label)
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
        <p className="font-medium text-text">{label}</p>
        <p className="mt-1 font-mono text-accent">{fmt$(data?.spend ?? 0)}</p>
        {data && data.shipping > 0 && (
          <>
            <p className="mt-0.5 text-muted">Ingredients: <span className="font-mono text-text">{fmt$(data.ingredients)}</span></p>
            <p className="text-muted">Shipping: <span className="font-mono text-amber-400">{fmt$(data.shipping)}</span></p>
          </>
        )}
      </div>
    )
  }

  /* ── Render ──────────────────────────────────────────────────── */

  if (!can('view_reports')) return <Navigate to="/" replace />

  if (loading) return <PageSkeleton />

  return (
    <div>
      <PageHeader
        title="Reports & Analytics"
        subtitle="Production performance, cost analysis, and trends"
      />

      {/* ── Row 1: Scorecard + Waste Trend ──────────────────────── */}
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        {/* LEFT — Co-Packer Performance Scorecard */}
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-text">Co-Packer Performance Scorecard</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-surface">
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted">
                    Co-Packer
                  </th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-muted">
                    Avg Waste %
                  </th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-muted">
                    Best Run
                  </th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-muted">
                    Worst Run
                  </th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-muted">
                    Total Runs
                  </th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-muted">
                    Total Units
                  </th>
                </tr>
              </thead>
              <tbody>
                {scorecardRows.map(({ cp, avgWaste, bestRun, worstRun, totalRuns, totalUnits }) => (
                  <tr key={cp.id} className="border-b border-border">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: cp.color ?? '#3B82F6' }}
                        />
                        <span className="font-medium text-text">{cp.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {avgWaste != null ? (
                        <span
                          className="font-mono font-bold"
                          style={{
                            color:
                              avgWaste <= 2.0
                                ? '#22C55E'
                                : avgWaste <= 2.5
                                  ? '#F59E0B'
                                  : '#EF4444',
                          }}
                        >
                          {avgWaste.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {bestRun != null ? (
                        <span className="font-mono text-green-400">{bestRun.toFixed(1)}%</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {worstRun != null ? (
                        <span className="font-mono text-red-400">{worstRun.toFixed(1)}%</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-text">{totalRuns}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-text">
                      {totalUnits.toLocaleString()}
                    </td>
                  </tr>
                ))}
                {scorecardRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-muted">
                      No co-packer data
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* RIGHT — Co-Packer Waste Trend Chart */}
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-text">Co-Packer Waste Trend</h3>
          </div>
          <div className="px-4 py-4">
            {wasteTrendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={wasteTrendData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="run"
                    tick={{ fill: 'var(--color-muted)', fontSize: 10 }}
                    axisLine={{ stroke: 'var(--color-border)' }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 4]}
                    tick={{ fill: 'var(--color-muted)', fontSize: 10 }}
                    axisLine={{ stroke: 'var(--color-border)' }}
                    tickLine={false}
                    tickFormatter={(v: number) => `${v}%`}
                  />
                  <Tooltip content={<WasteTooltip />} cursor={{ fill: 'var(--color-hover)' }} />
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: 'var(--color-muted)' }}
                    iconType="circle"
                    iconSize={8}
                  />
                  <ReferenceLine
                    y={2.5}
                    stroke="#EF4444"
                    strokeDasharray="6 3"
                    strokeWidth={1.5}
                    label={{ value: '2.5% target', fill: '#EF4444', fontSize: 10, position: 'right' }}
                  />
                  {wasteChartCPs.map((cp) => (
                    <Bar
                      key={cp.short_code}
                      dataKey={cp.short_code}
                      name={cp.name}
                      fill={cp.color ?? '#3B82F6'}
                      radius={[3, 3, 0, 0]}
                      maxBarSize={40}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[260px] items-center justify-center text-sm text-muted">
                No reconciled runs yet
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Row 2: Landed COGS by SKU (full-width) ────────────────── */}
      <div className="mb-6 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-sm font-semibold text-text">Landed COGS by SKU</h3>
            <div className="flex gap-1">
              {(['all', 'active', 'complete'] as CogsFilter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setCogsFilter(f)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    cogsFilter === f
                      ? 'bg-accent text-white'
                      : 'bg-surface text-muted hover:text-text'
                  }`}
                >
                  {f === 'all' ? 'All' : f === 'active' ? 'Active Only' : 'With Complete COGS'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Summary strip */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-border bg-surface/30 px-5 py-2.5 text-xs">
          <span className="text-muted">
            Total SKUs: <span className="font-mono font-medium text-text">{cogsSummary.total}</span>
          </span>
          <span className="text-muted">
            With full COGS: <span className="font-mono font-medium text-green-400">{cogsSummary.withComplete}</span>
          </span>
          <span className="text-muted">
            Missing data: <span className="font-mono font-medium text-amber-400">{cogsSummary.missing}</span>
          </span>
          <span className="mx-1 text-border">|</span>
          <span className="text-muted">
            Avg Landed COGS: <span className="font-mono font-medium text-text">{cogsSummary.avg != null ? fmtRate(cogsSummary.avg) : '—'}</span>
          </span>
          {cogsSummary.highest && (
            <span className="text-muted">
              Highest: <span className="font-mono text-text">{cogsSummary.highest.recipe.sku}</span>{' '}
              <span className="font-mono text-red-400">({fmtRate(cogsSummary.highest.landedCogs)})</span>
            </span>
          )}
          {cogsSummary.lowest && (
            <span className="text-muted">
              Lowest: <span className="font-mono text-text">{cogsSummary.lowest.recipe.sku}</span>{' '}
              <span className="font-mono text-green-400">({fmtRate(cogsSummary.lowest.landedCogs)})</span>
            </span>
          )}
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-surface">
                {([
                  ['sku', 'SKU'],
                  ['name', 'Product'],
                  ['status', 'Status'],
                  ['ingredientCogs', 'Ingredient COGS'],
                  ['cpFee', 'CP Fee'],
                  ['freight', 'Freight'],
                  ['landedCogs', 'Landed COGS'],
                ] as [CogsSortKey, string][]).map(([key, label]) => (
                  <th
                    key={key}
                    onClick={() => handleCogsSort(key)}
                    className={`cursor-pointer select-none whitespace-nowrap px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted hover:text-text ${
                      key === 'sku' || key === 'name' || key === 'status' ? 'text-left' : 'text-right'
                    }`}
                  >
                    {label}{cogsSortIcon(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedCogsRows.length > 0 ? sortedCogsRows.map((row) => {
                const isDraft = row.recipe.status === 'draft'
                return (
                  <tr
                    key={row.recipe.id}
                    className={`border-b border-border ${isDraft ? 'opacity-60' : ''} ${
                      !row.isComplete ? 'border-l-2 border-l-amber-500/60' : ''
                    }`}
                  >
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono font-medium text-accent">
                      {row.recipe.sku}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-text">{row.recipe.name}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${
                          row.recipe.status === 'active'
                            ? 'bg-green-500/10 text-green-400'
                            : row.recipe.status === 'draft'
                              ? 'bg-gray-500/10 text-gray-400'
                              : row.recipe.status === 'seasonal'
                                ? 'bg-blue-500/10 text-blue-400'
                                : row.recipe.status === 'discontinued'
                                  ? 'bg-red-500/10 text-red-400'
                                  : 'bg-gray-500/10 text-gray-400'
                        }`}
                      >
                        {row.recipe.status ?? 'unknown'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-text">
                      {row.ingredientCogs != null ? fmtRate(row.ingredientCogs) : <span className="text-muted">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-text">
                      {row.cpFee != null ? fmtRate(row.cpFee) : <span className="text-muted">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-text">
                      {row.freight != null ? (
                        <span>{row.freightEstimated ? '~' : ''}{fmtRate(row.freight)}</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono font-bold">
                      {row.landedCogs != null ? (
                        <span className={row.isComplete ? 'text-green-400' : 'text-amber-400'}>
                          {row.isPartial ? '~' : ''}{fmtRate(row.landedCogs)}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                )
              }) : (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">
                    No recipes match the current filter
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Row 3: Monthly Ingredient Spend ──────────────────────── */}
      <div className="mb-6">
        {/* Monthly Ingredient Spend */}
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-text">Monthly Ingredient Spend</h3>
          </div>
          <div className="px-4 py-4">
            {monthlySpendData.some((d) => d.spend > 0) ? (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={monthlySpendData} margin={{ top: 10, right: 10, left: -10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: 'var(--color-muted)', fontSize: 10 }}
                    axisLine={{ stroke: 'var(--color-border)' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: 'var(--color-muted)', fontSize: 10 }}
                    axisLine={{ stroke: 'var(--color-border)' }}
                    tickLine={false}
                    tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                  />
                  <Tooltip content={<SpendTooltip />} cursor={{ stroke: '#3B82F6', strokeWidth: 1, strokeDasharray: '4 4' }} />
                  <Line
                    type="monotone"
                    dataKey="spend"
                    stroke="#3B82F6"
                    strokeWidth={2}
                    dot={{ fill: '#3B82F6', r: 4, strokeWidth: 0 }}
                    activeDot={{ r: 6, fill: '#3B82F6', stroke: 'var(--color-bg)', strokeWidth: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[280px] items-center justify-center text-sm text-muted">
                No purchase order data yet
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Row 4: True Landed COGS ─────────────────────────────── */}
      <div className="mb-6">
        <TrueLandedCogsReport
          recipes={recipes}
          coPackers={coPackers}
          runs={runs}
          recipeIngredients={recipeIngredients}
          ingredients={ingredients}
          fgMovements={fgMovements}
          freightSummaries={freightSummaries}
          invoices={invoices}
          reconciliationLines={reconciliationLines}
          conversions={conversions}
        />
      </div>

      {/* ── Row 5: Generate Reports ─────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold text-text">Generate Reports</h3>
        </div>
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {REPORT_CARDS.map((card) => (
            <button
              key={card.title}
              onClick={() => toast.success('Report generation coming soon')}
              className="group rounded-xl border border-border bg-surface/30 p-4 text-left transition-all hover:border-accent hover:bg-accent/5"
            >
              <div className="mb-2 text-2xl leading-none">{card.icon}</div>
              <p className="text-sm font-semibold text-text group-hover:text-accent">
                {card.title}
              </p>
              <p className="mt-1 text-xs text-muted">{card.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Toast */}
    </div>
  )
}
