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
} from '../types/database'

/* ── Helpers ──────────────────────────────────────────────────── */

import { fmt$, fmtRate } from '../lib/format'

/* ── Report card icons (text-based) ───────────────────────────── */

const REPORT_CARDS = [
  { icon: '⊞', title: 'Co-Packer Comparison', desc: 'Side-by-side waste, on-time, cost across all CPs' },
  { icon: '△', title: 'Ingredient Reconciliation', desc: 'Sent vs used vs remaining, per CP and period' },
  { icon: '◎', title: 'True Landed COGS', desc: 'Full cost including CP fee, freight, waste, FBA' },
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
  const [loading, setLoading] = useState(true)
  const toast = useToast()

  async function load() {
    const [cpRes, runRes, recRes, poRes, mvRes] = await safeBatch(() => Promise.all([
      supabase.from('co_packers').select('*').order('name'),
      supabase.from('production_runs').select('*').order('completed_date', { ascending: true }),
      supabase.from('recipes').select('*'),
      supabase.from('purchase_orders').select('*'),
      supabase.from('finished_goods_movements').select('*'),
    ]))
    setCoPackers(cpRes.data ?? [])
    setRuns(runRes.data ?? [])
    setRecipes(recRes.data ?? [])
    setPurchaseOrders(poRes.data ?? [])
    setFgMovements(mvRes.data ?? [])
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

  /* ── 3. Landed COGS by SKU ──────────────────────────────────── */

  const cogsCards = useMemo(() => {
    // Count runs per recipe to sort by most-used
    const runCountByRecipe: Record<string, number> = {}
    for (const r of runs) {
      if (r.recipe_id) {
        runCountByRecipe[r.recipe_id] = (runCountByRecipe[r.recipe_id] ?? 0) + 1
      }
    }

    return recipes
      .filter((r) => r.status === 'active')
      .sort((a, b) => (runCountByRecipe[b.id] ?? 0) - (runCountByRecipe[a.id] ?? 0))
      .slice(0, 4)
      .map((recipe) => {
        const cp = coPackers.find((c) => c.id === recipe.co_packer_id)
        const ingredientCogs = recipe.ingredient_cogs ?? 0
        const cpFee = cp?.fee_per_unit ?? 0

        // Freight from actual movements
        const recipeMoves = fgMovements.filter(
          (m) => m.recipe_id === recipe.id && m.shipping_cost != null && Number(m.shipping_cost) > 0,
        )
        let freightPerUnit: number
        let freightLabel = 'Freight'
        if (recipeMoves.length > 0) {
          const tc = recipeMoves.reduce((s, m) => s + Number(m.shipping_cost ?? 0), 0)
          const tq = recipeMoves.reduce((s, m) => s + m.quantity, 0)
          freightPerUnit = tq > 0 ? tc / tq : 0
          freightLabel = `Freight (${recipeMoves.length} shipments)`
        } else if (recipe.estimated_freight_per_unit != null) {
          freightPerUnit = Number(recipe.estimated_freight_per_unit)
          freightLabel = 'Freight (est.)'
        } else {
          freightPerUnit = 0
          freightLabel = 'Freight (none)'
        }

        // Average waste cost per unit from reconciled runs for this recipe
        const recipeReconciledRuns = runs.filter(
          (r) => r.recipe_id === recipe.id && r.status === 'reconciled' && r.produced_quantity && r.produced_quantity > 0,
        )
        let wastePerUnit = 0
        if (recipeReconciledRuns.length > 0) {
          const totalWasteCost = recipeReconciledRuns.reduce((s, r) => s + (r.waste_cost ?? 0), 0)
          const totalProduced = recipeReconciledRuns.reduce((s, r) => s + (r.produced_quantity ?? 0), 0)
          wastePerUnit = totalProduced > 0 ? totalWasteCost / totalProduced : 0
        }

        const total = ingredientCogs + cpFee + freightPerUnit + Math.abs(wastePerUnit)
        const maxComponent = Math.max(ingredientCogs, cpFee, freightPerUnit, Math.abs(wastePerUnit), 0.01)

        return {
          recipe,
          cp,
          lines: [
            { label: 'Ingredients', value: ingredientCogs, color: '#3B82F6', max: maxComponent },
            { label: 'Co-Packer Fee', value: cpFee, color: '#F59E0B', max: maxComponent },
            { label: freightLabel, value: freightPerUnit, color: '#06B6D4', max: maxComponent },
            { label: 'Waste Allocated', value: Math.abs(wastePerUnit), color: '#EF4444', max: maxComponent },
          ],
          total,
          runCount: runCountByRecipe[recipe.id] ?? 0,
        }
      })
  }, [recipes, runs, coPackers, fgMovements])

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

      {/* ── Row 2: Landed COGS + Monthly Spend ──────────────────── */}
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        {/* LEFT — Landed COGS by SKU */}
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-text">Landed COGS by SKU</h3>
          </div>
          <div className="divide-y divide-border">
            {cogsCards.length > 0 ? (
              cogsCards.map(({ recipe, cp, lines, total, runCount }) => (
                <div key={recipe.id} className="px-5 py-4">
                  {/* Recipe header */}
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-text">{recipe.name}</span>
                      <span className="font-mono text-xs text-muted">({recipe.sku})</span>
                      {cp && <CPBadge coPackerId={cp.id} />}
                    </div>
                    <span className="text-[10px] text-muted">{runCount} runs</span>
                  </div>

                  {/* Cost lines */}
                  <div className="space-y-2">
                    {lines.map((line) => (
                      <div key={line.label} className="flex items-center gap-3 text-xs">
                        <span className="w-[100px] shrink-0 text-muted">{line.label}</span>
                        <div className="flex-1">
                          <MiniBar value={line.value} max={line.max} color={line.color} />
                        </div>
                        <span className="w-[60px] shrink-0 text-right font-mono text-text">
                          {fmtRate(line.value)}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Total */}
                  <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
                    <span className="text-xs font-medium text-muted">Total Landed COGS</span>
                    <span className="font-mono text-sm font-bold text-green-400">
                      {fmtRate(total)}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <div className="px-5 py-8 text-center text-sm text-muted">
                No active recipes
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — Monthly Ingredient Spend */}
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

      {/* ── Row 3: Generate Reports ─────────────────────────────── */}
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
