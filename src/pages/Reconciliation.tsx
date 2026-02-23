import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { sanitize } from '../lib/sanitizePayload'
import { dbInsert, dbUpdate } from '../lib/dbWrite'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { format, startOfMonth } from 'date-fns'
import { useToast } from '../components/Toast'
import { downloadCSV } from '../lib/csv'
import ConfirmDialog from '../components/ConfirmDialog'
import PageHeader from '../components/PageHeader'
import CPFilterBar from '../components/CPFilterBar'
import StatCard from '../components/StatCard'
import CPBadge from '../components/CPBadge'
import Badge from '../components/Badge'
import DataTable, { type Column } from '../components/DataTable'
import { PageSkeleton } from '../components/Skeleton'
import { fmt$, fmtRate, fmtDate, fmtNum } from '../lib/format'
import { ChevronDown, ChevronUp, Download } from 'lucide-react'
import type {
  ProductionRun,
  CoPacker,
  Recipe,
  RecipeIngredient,
  Ingredient,
  ReconciliationLine,
} from '../types/database'
import { loadConversions, getConversionFactorWithDensity, dualUnitParts, type ConversionMap } from '../lib/conversions'
import { useAuth } from '../contexts/AuthContext'
import { logActivity } from '../lib/activityLog'
import CostGuard from '../components/CostGuard'

/* ── Types ──────────────────────────────────────────────────── */

interface RecLine {
  ingredientId: string
  ingredientName: string
  unit: string
  unitCost: number
  tolerancePct: number | null
  theoretical: number
  actual: string
  providedBy: 'fitbake' | 'copacker'
  cpChargePerUnit: number | null
}

interface RecRow extends Record<string, unknown> {
  ingredientName: string
  theoretical: number
  actual: number
  varianceQty: number
  variancePct: number
  varianceCost: number
  status: string
}

interface HistoryRow extends Record<string, unknown> {
  id: string
  run_number: string
  co_packer_id: string | null
  recipeName: string
  produced: number
  waste_pct: number | null
  totalWasteCost: number
  reconciledDate: string
}

/* ================================================================ */

export default function Reconciliation() {
  const { can, appUser } = useAuth()
  const [runs, setRuns] = useState<ProductionRun[]>([])
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [recipeIngredients, setRecipeIngredients] = useState<RecipeIngredient[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [reconLines, setReconLines] = useState<ReconciliationLine[]>([])
  const [cpFilter, setCpFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [conversions, setConversions] = useState<ConversionMap>(new Map())
  const toast = useToast()
  const [confirmRunId, setConfirmRunId] = useState<string | null>(null)

  /* ── Per-run form state ───────────────────────────────────── */
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [formLines, setFormLines] = useState<RecLine[]>([])
  const [saving, setSaving] = useState(false)

  /* ── Data loading ─────────────────────────────────────────── */

  async function load() {
    const [runRes, cpRes, recRes, riRes, ingRes, rlRes, convMap] = await safeBatch(() => Promise.all([
      supabase
        .from('production_runs')
        .select('*')
        .in('status', ['complete', 'reconciled', 'flagged'])
        .order('completed_date', { ascending: false }),
      supabase.from('co_packers').select('*').order('name'),
      supabase.from('recipes').select('*'),
      supabase.from('recipe_ingredients').select('*'),
      supabase.from('ingredients').select('*').order('name'),
      supabase.from('reconciliation_lines').select('*'),
      loadConversions(),
    ]))
    setRuns(runRes.data ?? [])
    setCoPackers(cpRes.data ?? [])
    setRecipes(recRes.data ?? [])
    setRecipeIngredients(riRes.data ?? [])
    setIngredients(ingRes.data ?? [])
    setReconLines(rlRes.data ?? [])
    setConversions(convMap)
    setLoading(false)
  }

  useEffect(() => safeLoad(load, setLoading), [])

  /* ── Filtered runs ────────────────────────────────────────── */

  const filteredRuns = useMemo(() => {
    if (cpFilter === 'all') return runs
    return runs.filter((r) => r.co_packer_id === cpFilter)
  }, [runs, cpFilter])

  const unreconciledRuns = useMemo(
    () => filteredRuns.filter((r) => r.status === 'complete'),
    [filteredRuns],
  )

  const reconciledRuns = useMemo(
    () => filteredRuns.filter((r) => r.status === 'reconciled' || r.status === 'flagged'),
    [filteredRuns],
  )

  /* ── Stats ────────────────────────────────────────────────── */

  const stats = useMemo(() => {
    const monthStart = format(startOfMonth(new Date()), 'yyyy-MM-dd')
    const allReconciled = runs.filter((r) => r.status === 'reconciled')

    // Avg waste per CP
    const cpAvgWaste: Record<string, { sum: number; count: number }> = {}
    for (const cp of coPackers) {
      const cpRuns = allReconciled.filter((r) => r.co_packer_id === cp.id && r.waste_pct != null)
      cpAvgWaste[cp.id] = {
        sum: cpRuns.reduce((s, r) => s + (r.waste_pct ?? 0), 0),
        count: cpRuns.length,
      }
    }

    // MTD waste cost
    const mtdRuns = allReconciled.filter(
      (r) => r.completed_date && r.completed_date >= monthStart,
    )
    const mtdLines = reconLines.filter((rl) =>
      mtdRuns.some((r) => r.id === rl.production_run_id),
    )
    const totalWasteCostMTD = mtdLines.reduce((s, rl) => s + (rl.variance_cost ?? 0), 0)

    // Unreconciled count
    const unreconCount = runs.filter((r) => r.status === 'complete').length

    return { cpAvgWaste, totalWasteCostMTD, unreconCount }
  }, [runs, coPackers, reconLines])

  /* ── Expand / build form ──────────────────────────────────── */

  function expandRun(runId: string) {
    if (expandedId === runId) {
      setExpandedId(null)
      return
    }
    const run = runs.find((r) => r.id === runId)
    if (!run) return

    const ris = recipeIngredients.filter((ri) => ri.recipe_id === run.recipe_id)
    const produced = run.produced_quantity ?? 0

    const lines: RecLine[] = ris.map((ri) => {
      const ing = ingredients.find((i) => i.id === ri.ingredient_id)
      const invUnit = ing?.unit ?? 'lbs'
      const isCp = ri.provided_by === 'copacker'
      let factor = 1
      try { factor = getConversionFactorWithDensity(conversions, ri.unit, invUnit, ing?.density_g_per_ml) } catch { /* fallback */ }
      const theoretical = ri.quantity_per_unit * factor * produced
      return {
        ingredientId: ri.ingredient_id ?? '',
        ingredientName: ing?.name ?? '?',
        unit: invUnit,
        unitCost: isCp ? 0 : (ing?.unit_cost ?? 0),
        tolerancePct: ri.tolerance_pct,
        theoretical,
        actual: '',
        providedBy: (isCp ? 'copacker' : 'fitbake') as 'fitbake' | 'copacker',
        cpChargePerUnit: ri.cp_charge_per_unit ?? null,
      }
    })
    // Sort: FitBake ingredients first, then CP
    lines.sort((a, b) => (a.providedBy === b.providedBy ? 0 : a.providedBy === 'fitbake' ? -1 : 1))

    setFormLines(lines)
    setExpandedId(runId)
  }

  function updateActual(idx: number, value: string) {
    setFormLines((prev) => prev.map((l, i) => (i === idx ? { ...l, actual: value } : l)))
  }

  /* ── Submit reconciliation ────────────────────────────────── */

  async function handleReconcile(runId: string) {
    setSaving(true)
    try {
      const inserts = formLines
        .filter((l) => l.actual !== '' && l.providedBy !== 'copacker')
        .map((l) => {
          const actual = Number(l.actual)
          const varianceQty = actual - l.theoretical
          const variancePct = l.theoretical > 0 ? (varianceQty / l.theoretical) * 100 : 0
          const varianceCost = varianceQty * l.unitCost
          const tolerance = l.tolerancePct ?? 2.5
          const status =
            Math.abs(variancePct) <= tolerance
              ? 'approved'
              : variancePct > tolerance * 2
                ? 'flagged'
                : 'over'

          return sanitize('reconciliation_lines', {
            production_run_id: runId,
            ingredient_id: l.ingredientId,
            theoretical_usage: Math.round(l.theoretical * 100) / 100,
            actual_usage: actual,
            variance_qty: Math.round(varianceQty * 100) / 100,
            variance_pct: Math.round(variancePct * 10) / 10,
            variance_cost: Math.round(varianceCost * 100) / 100,
            status,
          })
        })

      if (inserts.length > 0) {
        const { error } = await dbInsert('reconciliation_lines', inserts)
        if (error) throw error
      }

      // Determine run status: flagged if any line is flagged
      const anyFlagged = inserts.some((l) => l.status === 'flagged')
      const totalWasteCost = inserts.reduce((s, l) => s + (l.variance_cost ?? 0), 0)

      const { error } = await dbUpdate('production_runs', sanitize('production_runs', {
          status: anyFlagged ? 'flagged' : 'reconciled',
          waste_cost: Math.round(totalWasteCost * 100) / 100,
        }), 'id', runId)
      if (error) throw error

      setExpandedId(null)
      setConfirmRunId(null)
      toast.success(anyFlagged ? 'Run reconciled with flags' : 'Run reconciled successfully')
      logActivity(appUser?.id, 'reconcile', 'production_run', runId)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reconcile run')
    } finally {
      setSaving(false)
    }
  }

  /* ── CSV export ────────────────────────────────────────────── */

  function handleExportCSV() {
    const exportData = historyRows.map((r) => ({
      run_number: r.run_number,
      recipe: r.recipeName,
      produced: r.produced,
      waste_pct: r.waste_pct != null ? `${(r.waste_pct as number).toFixed(1)}%` : '',
      waste_cost: r.totalWasteCost,
      date: r.reconciledDate,
    }))
    downloadCSV(exportData, [
      { key: 'run_number', label: 'Run #' },
      { key: 'recipe', label: 'Recipe/SKU' },
      { key: 'produced', label: 'Produced' },
      { key: 'waste_pct', label: 'Waste %' },
      { key: 'waste_cost', label: 'Waste Cost' },
      { key: 'date', label: 'Date' },
    ], 'reconciliation-history')
  }

  /* ── Reconciled history table ─────────────────────────────── */

  const historyRows: HistoryRow[] = useMemo(() => {
    return reconciledRuns.map((r) => {
      const recipe = recipes.find((rec) => rec.id === r.recipe_id)
      const lines = reconLines.filter((rl) => rl.production_run_id === r.id)
      const totalWasteCost = lines.reduce((s, rl) => s + (rl.variance_cost ?? 0), 0)
      return {
        id: r.id,
        run_number: r.run_number,
        co_packer_id: r.co_packer_id,
        recipeName: recipe ? `${recipe.name} (${recipe.sku})` : '—',
        produced: r.produced_quantity ?? 0,
        waste_pct: r.waste_pct,
        totalWasteCost,
        reconciledDate: r.completed_date ?? '',
      }
    })
  }, [reconciledRuns, recipes, reconLines])

  const historyColumns: Column<HistoryRow>[] = useMemo(
    () => [
      {
        label: 'Run',
        key: 'run_number',
        width: '100px',
        render: (row) => <span className="font-mono font-medium text-accent">{row.run_number}</span>,
      },
      {
        label: 'CP',
        key: 'co_packer_id',
        width: '90px',
        render: (row) =>
          row.co_packer_id ? <CPBadge coPackerId={row.co_packer_id as string} /> : '—',
      },
      {
        label: 'Recipe',
        key: 'recipeName',
        render: (row) => <span className="text-text">{row.recipeName}</span>,
      },
      {
        label: 'Produced',
        key: 'produced',
        align: 'right',
        width: '100px',
        render: (row) => (
          <span className="font-mono text-text">{fmtNum(row.produced as number)}</span>
        ),
      },
      {
        label: 'Waste %',
        key: 'waste_pct',
        align: 'right',
        width: '90px',
        render: (row) => {
          const w = row.waste_pct as number | null
          if (w == null) return <span className="text-muted">—</span>
          const color = w <= 2.5 ? '#22C55E' : w <= 3.0 ? '#F59E0B' : '#EF4444'
          return <span className="font-mono font-medium" style={{ color }}>{w.toFixed(1)}%</span>
        },
      },
      {
        label: 'Waste Cost',
        key: 'totalWasteCost',
        align: 'right',
        width: '110px',
        render: (row) => (
          <span className="font-mono font-medium text-red-400">
            <CostGuard>{fmt$((row.totalWasteCost as number) > 0 ? (row.totalWasteCost as number) : 0)}</CostGuard>
          </span>
        ),
      },
      {
        label: 'Date',
        key: 'reconciledDate',
        width: '110px',
        render: (row) => (
          <span className="text-xs text-muted">
            {row.reconciledDate ? fmtDate(row.reconciledDate as string) : '—'}
          </span>
        ),
      },
      {
        label: 'Status',
        key: '_status',
        align: 'center',
        width: '100px',
        render: (row) => {
          const run = runs.find((r) => r.id === row.id)
          const s = run?.status ?? 'reconciled'
          return (
            <Badge color={s === 'flagged' ? 'red' : 'green'}>
              {s === 'flagged' ? 'FLAGGED' : 'RECONCILED'}
            </Badge>
          )
        },
      },
    ],
    [runs],
  )

  /* ── Render ───────────────────────────────────────────────── */

  if (loading) return <PageSkeleton />

  return (
    <div>
      <PageHeader
        title="Reconciliation & Waste"
        subtitle="Compare theoretical vs actual ingredient usage"
      >
        {reconciledRuns.length > 0 && (
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-text"
          >
            <Download size={14} />
            Export CSV
          </button>
        )}
      </PageHeader>

      <CPFilterBar selected={cpFilter} onSelect={setCpFilter} />

      {/* Stat Cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
        {coPackers.map((cp) => {
          const data = stats.cpAvgWaste[cp.id]
          const avg = data && data.count > 0 ? data.sum / data.count : null
          return (
            <StatCard
              key={cp.id}
              label={`Avg Waste — ${cp.short_code}`}
              value={avg != null ? `${avg.toFixed(1)}%` : '—'}
              sub={data ? `${data.count} runs` : '0 runs'}
            />
          )
        })}
        <StatCard
          label="Waste Cost (MTD)"
          value={can('view_costs') ? fmt$(stats.totalWasteCostMTD) : '\u2014'}
          trend={stats.totalWasteCostMTD > 0 ? 'This month' : undefined}
          trendGood={false}
        />
        <StatCard
          label="Unreconciled Runs"
          value={stats.unreconCount}
          trend={stats.unreconCount > 0 ? `${stats.unreconCount} awaiting review` : undefined}
          trendGood={stats.unreconCount === 0}
        />
      </div>

      {/* ── Section 1: Unreconciled Runs ──────────────────── */}
      {unreconciledRuns.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">
            Awaiting Reconciliation ({unreconciledRuns.length})
          </h2>
          <div className="space-y-4">
            {unreconciledRuns.map((run) => {
              const recipe = recipes.find((r) => r.id === run.recipe_id)
              const expanded = expandedId === run.id

              // Build display rows from form lines when expanded
              const displayRows: RecRow[] = expanded
                ? formLines.map((l) => {
                    const actual = Number(l.actual) || 0
                    const varianceQty = actual - l.theoretical
                    const variancePct = l.theoretical > 0 ? (varianceQty / l.theoretical) * 100 : 0
                    const varianceCost = varianceQty * l.unitCost
                    const tolerance = l.tolerancePct ?? 2.5
                    let status: string
                    if (!l.actual) {
                      status = '—'
                    } else if (Math.abs(variancePct) <= tolerance) {
                      status = 'OK'
                    } else if (variancePct > tolerance * 2) {
                      status = 'FLAG'
                    } else {
                      status = 'OVER'
                    }
                    return {
                      ingredientName: l.ingredientName,
                      theoretical: l.theoretical,
                      actual,
                      varianceQty,
                      variancePct,
                      varianceCost,
                      status,
                    }
                  })
                : []

              const allFilled = expanded && formLines.filter((l) => l.providedBy !== 'copacker').every((l) => l.actual !== '')
              const totalVarianceCost = displayRows.filter((_, i) => formLines[i]?.providedBy !== 'copacker').reduce((s, r) => s + r.varianceCost, 0)

              return (
                <div
                  key={run.id}
                  className="rounded-xl border border-border bg-card overflow-hidden"
                >
                  {/* Card header */}
                  <div
                    className="flex cursor-pointer items-center justify-between p-4"
                    onClick={() => expandRun(run.id)}
                  >
                    <div className="flex items-center gap-3">
                      {run.co_packer_id && <CPBadge coPackerId={run.co_packer_id} />}
                      <span className="font-mono font-medium text-accent">{run.run_number}</span>
                      <span className="text-sm text-text">
                        {recipe ? `${recipe.name} (${recipe.sku})` : '—'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted">
                        {run.requested_quantity.toLocaleString()} units requested ·{' '}
                        {run.produced_quantity != null ? `${run.produced_quantity.toLocaleString()} units` : '—'} produced
                        {run.completed_date && ` · Completed ${fmtDate(run.completed_date)}`}
                      </span>
                      <Badge color="purple">AWAITING YOUR REVIEW</Badge>
                      {expanded ? <ChevronUp size={14} className="text-muted" /> : <ChevronDown size={14} className="text-muted" />}
                    </div>
                  </div>

                  {/* Expanded form */}
                  {expanded && (
                    <div className="border-t border-border px-4 pb-4 pt-3">
                      {/* Column headers */}
                      <div
                        className="mb-2 grid gap-3 px-3 text-[10px] uppercase tracking-wider text-muted"
                        style={{ gridTemplateColumns: '160px 60px 180px 110px 90px 70px 90px 70px' }}
                      >
                        <span>Ingredient</span>
                        <span className="text-center">Source</span>
                        <span className="text-right">Theoretical</span>
                        <span className="text-right">Actual</span>
                        <span className="text-right">Var Qty</span>
                        <span className="text-right">Var %</span>
                        <span className="text-right">Var Cost</span>
                        <span className="text-center">Status</span>
                      </div>

                      {/* Ingredient input rows */}
                      <div className="space-y-2">
                        {formLines.map((line, idx) => {
                          const isCp = line.providedBy === 'copacker'
                          const actual = Number(line.actual) || 0
                          const varianceQty = actual - line.theoretical
                          const variancePct = line.theoretical > 0 ? (varianceQty / line.theoretical) * 100 : 0
                          const varianceCost = isCp ? 0 : varianceQty * line.unitCost
                          const tolerance = line.tolerancePct ?? 2.5
                          const hasActual = line.actual !== ''

                          let statusLabel = '—'
                          let statusColor: 'green' | 'amber' | 'red' | 'gray' = 'gray'
                          if (isCp) {
                            statusLabel = 'CP'
                            statusColor = 'amber'
                          } else if (hasActual) {
                            if (Math.abs(variancePct) <= tolerance) {
                              statusLabel = 'OK'
                              statusColor = 'green'
                            } else if (variancePct > tolerance * 2) {
                              statusLabel = 'FLAG'
                              statusColor = 'red'
                            } else {
                              statusLabel = 'OVER'
                              statusColor = 'amber'
                            }
                          }

                          return (
                            <div
                              key={idx}
                              className="grid items-center gap-3 rounded-lg px-3 py-2.5 text-xs"
                              style={{
                                gridTemplateColumns: '160px 60px 180px 110px 90px 70px 90px 70px',
                                backgroundColor: isCp ? 'rgba(245,158,11,0.06)' : 'var(--color-hover)',
                              }}
                            >
                              <span className="font-medium text-text">{line.ingredientName}</span>
                              <div className="text-center">
                                <Badge color={isCp ? 'amber' : 'accent'}>{isCp ? 'CP' : 'You'}</Badge>
                              </div>
                              <span className="text-right font-mono text-muted">
                                {(() => { const d = dualUnitParts(conversions, line.theoretical, line.unit); return <>{d.primary}{d.secondary && <span className="text-muted/60"> ({d.secondary})</span>}</> })()}
                              </span>
                              {isCp ? (
                                <>
                                  <span className="text-right text-muted">—</span>
                                  <span className="text-right text-muted">—</span>
                                  <span className="text-right text-muted">—</span>
                                  <span className="text-right font-mono text-amber-400">
                                    {line.cpChargePerUnit != null ? `${fmtRate(line.cpChargePerUnit)}/unit` : '—'}
                                  </span>
                                  <div className="text-center">
                                    <Badge color="amber">CP</Badge>
                                  </div>
                                </>
                              ) : (
                                <>
                                  <input
                                    type="number"
                                    step="any"
                                    min="0"
                                    value={line.actual}
                                    onChange={(e) => updateActual(idx, e.target.value)}
                                    placeholder="Actual"
                                    className="rounded border border-border bg-surface px-2 py-1.5 text-right font-mono text-sm text-text outline-none focus:border-accent"
                                  />
                                  {hasActual ? (
                                    <>
                                      <span
                                        className="text-right font-mono"
                                        style={{ color: varianceQty > 0 ? '#F59E0B' : '#22C55E' }}
                                      >
                                        {varianceQty > 0 ? '+' : ''}{varianceQty.toFixed(1)} {line.unit}
                                      </span>
                                      <span
                                        className="text-right font-mono"
                                        style={{ color: variancePct > 0 ? '#F59E0B' : '#22C55E' }}
                                      >
                                        {variancePct > 0 ? '+' : ''}{variancePct.toFixed(1)}%
                                      </span>
                                      <span
                                        className="text-right font-mono font-medium"
                                        style={{ color: varianceCost > 0 ? '#EF4444' : '#22C55E' }}
                                      >
                                        <CostGuard>{varianceCost > 0 ? '+' : ''}{fmt$(varianceCost)}</CostGuard>
                                      </span>
                                      <div className="text-center">
                                        <Badge color={statusColor}>{statusLabel}</Badge>
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      <span className="text-right text-muted">—</span>
                                      <span className="text-right text-muted">—</span>
                                      <span className="text-right text-muted">—</span>
                                      <span className="text-center text-muted">—</span>
                                    </>
                                  )}
                                </>
                              )}
                            </div>
                          )
                        })}
                      </div>

                      {/* Total + submit */}
                      <div className="mt-4 flex items-center justify-between rounded-lg bg-surface/50 px-4 py-3">
                        <span className="text-sm text-muted">
                          Total Variance Cost:{' '}
                          <span
                            className="font-mono font-semibold"
                            style={{ color: totalVarianceCost > 0 ? '#EF4444' : '#22C55E' }}
                          >
                            <CostGuard>{totalVarianceCost > 0 ? '+' : ''}{fmt$(totalVarianceCost)}</CostGuard>
                          </span>
                        </span>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => setExpandedId(null)}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-text"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => setConfirmRunId(run.id)}
                            disabled={saving || !allFilled}
                            className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                          >
                            {saving ? 'Saving…' : 'Submit Reconciliation'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Section 2: Reconciled History ─────────────────── */}
      <div>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">
          Reconciled History ({reconciledRuns.length})
        </h2>
        <DataTable
          columns={historyColumns}
          data={historyRows}
          emptyMessage="No reconciled runs yet"
          emptyHint="Expand an unreconciled run above to submit actuals"
        />
      </div>

      <ConfirmDialog
        isOpen={confirmRunId !== null}
        title="Submit Reconciliation"
        message="This will finalize the reconciliation for this run. Flagged variances will require review. Continue?"
        confirmLabel="Submit"
        onConfirm={() => confirmRunId && handleReconcile(confirmRunId)}
        onCancel={() => setConfirmRunId(null)}
        loading={saving}
      />
    </div>
  )
}
