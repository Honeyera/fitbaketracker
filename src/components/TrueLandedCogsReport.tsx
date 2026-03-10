import { useMemo, useState, useRef } from 'react'
import type {
  CoPacker,
  ProductionRun,
  Recipe,
  FinishedGoodsMovement,
  RecipeIngredient,
  Ingredient,
  RecipeFreightSummary,
  ProductionRunInvoice,
  ReconciliationLine,
} from '../types/database'
import type { ConversionMap } from '../lib/conversions'
import { getConversionFactorWithDensity } from '../lib/conversions'
import { fmtRate, fmt$ } from '../lib/format'

/* ── Types ──────────────────────────────────────────────────── */

type TlcFilter = 'all' | 'active' | 'withData'
type TlcSortKey = 'sku' | 'name' | 'unitsProduced' | 'ingredientCogs' | 'cpFee' | 'freight' | 'wasteCost' | 'trueLandedCogs' | 'vsEstimate'

interface IngredientLine {
  name: string
  qtyPerUnit: number
  unit: string
  unitCost: number
  costPerUnit: number
  providedBy: string
}

interface FreightShipment {
  date: string
  quantity: number
  shippingCost: number
  perUnit: number
  fromLocation: string
  toLocation: string
}

interface WasteRun {
  runNumber: string
  wastePct: number | null
  wastePerUnit: number
  producedQty: number
}

interface InvoiceDetail {
  invoiceNumber: string | null
  invoiceDate: string | null
  perUnitCost: number
}

interface TlcRow {
  recipe: Recipe
  cpName: string | null
  cpId: string | null
  unitsProduced: number
  ingredientCogs: number | null
  ingredientLines: IngredientLine[]
  cpFee: number | null
  cpFeeSource: 'actual' | 'default' | null
  cpFeeDefault: number | null
  cpFeeInvoices: InvoiceDetail[]
  freight: number | null
  freightSource: 'actual' | 'est.' | null
  freightShipments: FreightShipment[]
  wasteCost: number | null
  wasteRuns: WasteRun[]
  trueLandedCogs: number | null
  estimatedCogs: number | null
  vsDiff: number | null
  vsPct: number | null
}

interface Props {
  recipes: Recipe[]
  coPackers: CoPacker[]
  runs: ProductionRun[]
  recipeIngredients: RecipeIngredient[]
  ingredients: Ingredient[]
  fgMovements: FinishedGoodsMovement[]
  freightSummaries: RecipeFreightSummary[]
  invoices: ProductionRunInvoice[]
  reconciliationLines: ReconciliationLine[]
  conversions: ConversionMap
}

/* ── Component ──────────────────────────────────────────────── */

export default function TrueLandedCogsReport({
  recipes,
  coPackers,
  runs,
  recipeIngredients,
  ingredients,
  fgMovements,
  freightSummaries,
  invoices,
  reconciliationLines,
  conversions,
}: Props) {
  const [filter, setFilter] = useState<TlcFilter>('all')
  const [cpFilter, setCpFilter] = useState<string>('all')
  const [sortKey, setSortKey] = useState<TlcSortKey>('trueLandedCogs')
  const [sortAsc, setSortAsc] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)

  /* ── Build rows ──────────────────────────────────────────── */

  const allRows = useMemo<TlcRow[]>(() => {
    return recipes.map((recipe) => {
      const cp = coPackers.find((c) => c.id === recipe.co_packer_id)
      const recipeRuns = runs.filter((r) => r.recipe_id === recipe.id)
      const unitsProduced = recipeRuns.reduce((s, r) => s + (r.produced_quantity ?? 0), 0)

      // ── Ingredient COGS (from BOM) ──
      const ris = recipeIngredients.filter((ri) => ri.recipe_id === recipe.id)
      const ingredientLines: IngredientLine[] = []
      let ingredientCogs = 0
      for (const ri of ris) {
        if (ri.provided_by === 'copacker') {
          const charge = ri.cp_charge_per_unit ?? 0
          ingredientCogs += charge
          ingredientLines.push({
            name: '(Co-packer supplied)',
            qtyPerUnit: ri.quantity_per_unit,
            unit: ri.unit,
            unitCost: charge,
            costPerUnit: charge,
            providedBy: 'copacker',
          })
          continue
        }
        const ing = ingredients.find((i) => i.id === ri.ingredient_id)
        if (!ing) continue
        let factor = 1
        try {
          factor = getConversionFactorWithDensity(conversions, ri.unit, ing.unit ?? 'lbs', ing.density_g_per_ml)
        } catch { /* fallback 1 */ }
        const costPerUnit = ri.quantity_per_unit * factor * ing.unit_cost
        ingredientCogs += costPerUnit
        ingredientLines.push({
          name: ing.name,
          qtyPerUnit: ri.quantity_per_unit,
          unit: ri.unit,
          unitCost: ing.unit_cost,
          costPerUnit,
          providedBy: 'fitbake',
        })
      }
      const finalIngredientCogs = ingredientLines.length > 0 ? ingredientCogs : (recipe.ingredient_cogs ?? null)

      // ── CP Fee ──
      const runIds = new Set(recipeRuns.map((r) => r.id))
      const recipeInvoices = invoices.filter(
        (inv) => inv.per_unit_cost != null && inv.per_unit_cost > 0 && inv.production_run_id && runIds.has(inv.production_run_id),
      )
      let cpFee: number | null = null
      let cpFeeSource: 'actual' | 'default' | null = null
      const cpFeeDefault = cp?.fee_per_unit ?? null
      const cpFeeInvoiceDetails: InvoiceDetail[] = recipeInvoices.map((inv) => ({
        invoiceNumber: inv.invoice_number,
        invoiceDate: inv.invoice_date,
        perUnitCost: inv.per_unit_cost!,
      }))
      if (recipeInvoices.length > 0) {
        cpFee = recipeInvoices.reduce((s, inv) => s + (inv.per_unit_cost ?? 0), 0) / recipeInvoices.length
        cpFeeSource = 'actual'
      } else if (cpFeeDefault != null && cpFeeDefault > 0) {
        cpFee = cpFeeDefault
        cpFeeSource = 'default'
      }

      // ── Freight ──
      const recipeMoves = fgMovements.filter(
        (m) => m.recipe_id === recipe.id && m.shipping_cost != null && Number(m.shipping_cost) > 0,
      )
      let freight: number | null = null
      let freightSource: 'actual' | 'est.' | null = null
      const freightShipments: FreightShipment[] = recipeMoves.map((m) => ({
        date: m.date,
        quantity: m.quantity,
        shippingCost: Number(m.shipping_cost ?? 0),
        perUnit: m.quantity > 0 ? Number(m.shipping_cost ?? 0) / m.quantity : 0,
        fromLocation: m.from_location,
        toLocation: m.to_location,
      }))

      const freightSummary = freightSummaries.find((f) => f.recipe_id === recipe.id)
      if (recipeMoves.length > 0) {
        const tc = recipeMoves.reduce((s, m) => s + Number(m.shipping_cost ?? 0), 0)
        const tq = recipeMoves.reduce((s, m) => s + m.quantity, 0)
        freight = tq > 0 ? tc / tq : null
        freightSource = 'actual'
      } else if (freightSummary?.avg_total_freight != null && freightSummary.avg_total_freight > 0) {
        freight = freightSummary.avg_total_freight
        freightSource = 'actual'
      } else if (recipe.estimated_freight_per_unit != null) {
        freight = Number(recipe.estimated_freight_per_unit)
        freightSource = 'est.'
      }

      // ── Waste Cost ──
      const reconciledRuns = recipeRuns.filter(
        (r) => (r.status === 'reconciled' || r.status === 'flagged') && r.produced_quantity && r.produced_quantity > 0,
      )
      const wasteRuns: WasteRun[] = []
      let totalWasteCost = 0
      let totalProduced = 0
      for (const run of reconciledRuns) {
        // Sum variance_cost from reconciliation_lines for this run
        const runLines = reconciliationLines.filter((rl) => rl.production_run_id === run.id)
        const runVarianceCost = runLines.reduce((s, rl) => s + Math.abs(rl.variance_cost ?? 0), 0)
        // Use waste_cost from run if reconciliation_lines don't have cost, else use run.waste_cost
        const runWasteCost = runVarianceCost > 0 ? runVarianceCost : Math.abs(run.waste_cost ?? 0)
        const produced = run.produced_quantity ?? 0
        totalWasteCost += runWasteCost
        totalProduced += produced
        wasteRuns.push({
          runNumber: run.run_number,
          wastePct: run.waste_pct,
          wastePerUnit: produced > 0 ? runWasteCost / produced : 0,
          producedQty: produced,
        })
      }
      const wasteCost = totalProduced > 0 ? totalWasteCost / totalProduced : null

      // ── True Landed COGS ──
      const components = [finalIngredientCogs, cpFee, freight, wasteCost]
      const available = components.filter((c) => c != null) as number[]
      const trueLandedCogs = available.length > 0 ? available.reduce((s, v) => s + v, 0) : null

      // ── vs Estimate ──
      const estimatedCogs = recipe.landed_cogs
      let vsDiff: number | null = null
      let vsPct: number | null = null
      if (trueLandedCogs != null && estimatedCogs != null && estimatedCogs > 0) {
        vsDiff = trueLandedCogs - estimatedCogs
        vsPct = (vsDiff / estimatedCogs) * 100
      }

      return {
        recipe,
        cpName: cp?.name ?? null,
        cpId: cp?.id ?? null,
        unitsProduced,
        ingredientCogs: finalIngredientCogs,
        ingredientLines,
        cpFee,
        cpFeeSource,
        cpFeeDefault,
        cpFeeInvoices: cpFeeInvoiceDetails,
        freight,
        freightSource,
        freightShipments,
        wasteCost,
        wasteRuns,
        trueLandedCogs,
        estimatedCogs,
        vsDiff,
        vsPct,
      }
    })
  }, [recipes, coPackers, runs, recipeIngredients, ingredients, conversions, invoices, fgMovements, freightSummaries, reconciliationLines])

  // ── Filter ──
  const filteredRows = useMemo(() => {
    let rows = allRows
    if (filter === 'active') rows = rows.filter((r) => r.recipe.status === 'active')
    if (filter === 'withData') rows = rows.filter((r) => r.unitsProduced > 0)
    if (cpFilter !== 'all') rows = rows.filter((r) => r.cpId === cpFilter)
    return rows
  }, [allRows, filter, cpFilter])

  // ── Sort ──
  const sortedRows = useMemo(() => {
    return [...filteredRows].sort((a, b) => {
      let va: number | string | null
      let vb: number | string | null
      switch (sortKey) {
        case 'sku': va = a.recipe.sku; vb = b.recipe.sku; break
        case 'name': va = a.recipe.name; vb = b.recipe.name; break
        case 'unitsProduced': va = a.unitsProduced; vb = b.unitsProduced; break
        case 'ingredientCogs': va = a.ingredientCogs; vb = b.ingredientCogs; break
        case 'cpFee': va = a.cpFee; vb = b.cpFee; break
        case 'freight': va = a.freight; vb = b.freight; break
        case 'wasteCost': va = a.wasteCost; vb = b.wasteCost; break
        case 'trueLandedCogs': va = a.trueLandedCogs; vb = b.trueLandedCogs; break
        case 'vsEstimate': va = a.vsDiff; vb = b.vsDiff; break
        default: va = a.trueLandedCogs; vb = b.trueLandedCogs
      }
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'string' && typeof vb === 'string') {
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va)
      }
      return sortAsc ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
  }, [filteredRows, sortKey, sortAsc])

  // ── Summary stats ──
  const summary = useMemo(() => {
    const withCogs = allRows.filter((r) => r.trueLandedCogs != null)
    const cogsValues = withCogs.map((r) => r.trueLandedCogs!)
    const avg = cogsValues.length > 0 ? cogsValues.reduce((s, v) => s + v, 0) / cogsValues.length : null
    let highest: TlcRow | null = null
    let lowest: TlcRow | null = null
    for (const r of withCogs) {
      if (!highest || r.trueLandedCogs! > highest.trueLandedCogs!) highest = r
      if (!lowest || r.trueLandedCogs! < lowest.trueLandedCogs!) lowest = r
    }
    const vsEstimates = allRows.filter((r) => r.vsPct != null)
    const avgVsPct = vsEstimates.length > 0
      ? vsEstimates.reduce((s, r) => s + r.vsPct!, 0) / vsEstimates.length
      : null
    return { avg, highest, lowest, avgVsPct }
  }, [allRows])

  function handleSort(key: TlcSortKey) {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(false) }
  }

  function sortIcon(key: TlcSortKey) {
    if (sortKey !== key) return ''
    return sortAsc ? ' ↑' : ' ↓'
  }

  // ── Export CSV ──
  function exportCsv() {
    const headers = ['SKU', 'Product', 'Status', 'Units Produced', 'Ingredient COGS', 'CP Fee', 'CP Fee Source', 'Freight', 'Freight Source', 'Waste Cost', 'True Landed COGS', 'Estimated COGS', 'vs Estimate ($)', 'vs Estimate (%)']
    const csvRows = [headers.join(',')]
    for (const r of sortedRows) {
      csvRows.push([
        r.recipe.sku,
        `"${r.recipe.name}"`,
        r.recipe.status ?? '',
        r.unitsProduced,
        r.ingredientCogs?.toFixed(4) ?? '',
        r.cpFee?.toFixed(4) ?? '',
        r.cpFeeSource ?? '',
        r.freight?.toFixed(4) ?? '',
        r.freightSource ?? '',
        r.wasteCost?.toFixed(4) ?? '',
        r.trueLandedCogs?.toFixed(4) ?? '',
        r.estimatedCogs?.toFixed(4) ?? '',
        r.vsDiff?.toFixed(4) ?? '',
        r.vsPct?.toFixed(1) ?? '',
      ].join(','))
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `true-landed-cogs-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Export PDF (via print) ──
  function exportPdf() {
    const printContent = tableRef.current
    if (!printContent) return
    const printWindow = window.open('', '_blank')
    if (!printWindow) return
    printWindow.document.write(`
      <!DOCTYPE html>
      <html><head><title>True Landed COGS Report</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 11px; color: #1a1a1a; padding: 20px; }
        h1 { font-size: 16px; margin-bottom: 4px; }
        .subtitle { color: #666; font-size: 11px; margin-bottom: 16px; }
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 6px 8px; border-bottom: 2px solid #333; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; }
        td { padding: 5px 8px; border-bottom: 1px solid #ddd; font-size: 10px; }
        .right { text-align: right; }
        .mono { font-family: 'SF Mono', 'Fira Code', monospace; }
        .green { color: #16a34a; }
        .red { color: #dc2626; }
        .muted { color: #999; }
        .source { font-size: 8px; color: #888; }
        @media print { body { padding: 0; } }
      </style></head><body>
      <h1>True Landed COGS Report</h1>
      <p class="subtitle">Generated ${new Date().toLocaleDateString()} — ${sortedRows.length} SKUs</p>
      <table>
        <thead><tr>
          <th>SKU</th><th>Product</th><th class="right">Units</th>
          <th class="right">Ingr. COGS</th><th class="right">CP Fee</th>
          <th class="right">Freight</th><th class="right">Waste</th>
          <th class="right">True COGS</th><th class="right">vs Est.</th>
        </tr></thead>
        <tbody>${sortedRows.map((r) => `
          <tr>
            <td class="mono">${r.recipe.sku}</td>
            <td>${r.recipe.name}</td>
            <td class="right mono">${r.unitsProduced.toLocaleString()}</td>
            <td class="right mono">${r.ingredientCogs != null ? '$' + r.ingredientCogs.toFixed(2) : '—'}</td>
            <td class="right mono">${r.cpFee != null ? '$' + r.cpFee.toFixed(2) : '—'} ${r.cpFeeSource ? `<span class="source">(${r.cpFeeSource})</span>` : ''}</td>
            <td class="right mono">${r.freight != null ? '$' + r.freight.toFixed(2) : '—'} ${r.freightSource ? `<span class="source">(${r.freightSource})</span>` : ''}</td>
            <td class="right mono">${r.wasteCost != null ? '$' + r.wasteCost.toFixed(2) : '—'}</td>
            <td class="right mono" style="font-weight:600">${r.trueLandedCogs != null ? '$' + r.trueLandedCogs.toFixed(2) : '—'}</td>
            <td class="right mono ${r.vsDiff != null ? (r.vsDiff > 0 ? 'red' : 'green') : 'muted'}">${r.vsDiff != null ? (r.vsDiff > 0 ? '+' : '') + '$' + r.vsDiff.toFixed(2) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      </body></html>
    `)
    printWindow.document.close()
    printWindow.onload = () => { printWindow.print() }
  }

  // ── Stacked bar component ──
  function CostBar({ row }: { row: TlcRow }) {
    if (row.trueLandedCogs == null || row.trueLandedCogs === 0) {
      return <div className="h-2.5 w-full rounded-full bg-hover" />
    }
    const total = row.trueLandedCogs
    const ingPct = ((row.ingredientCogs ?? 0) / total) * 100
    const cpPct = ((row.cpFee ?? 0) / total) * 100
    const frPct = ((row.freight ?? 0) / total) * 100
    const wastePct = ((row.wasteCost ?? 0) / total) * 100
    return (
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-hover" title={`Ing ${ingPct.toFixed(0)}% | CP ${cpPct.toFixed(0)}% | Fr ${frPct.toFixed(0)}% | W ${wastePct.toFixed(0)}%`}>
        {ingPct > 0 && <div style={{ width: `${ingPct}%`, backgroundColor: '#3B82F6' }} />}
        {cpPct > 0 && <div style={{ width: `${cpPct}%`, backgroundColor: '#A855F7' }} />}
        {frPct > 0 && <div style={{ width: `${frPct}%`, backgroundColor: '#06B6D4' }} />}
        {wastePct > 0 && <div style={{ width: `${wastePct}%`, backgroundColor: '#EF4444' }} />}
      </div>
    )
  }

  // ── Unique co-packers for filter ──
  const cpOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of allRows) {
      if (r.cpId && r.cpName && !seen.has(r.cpId)) seen.set(r.cpId, r.cpName)
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [allRows])

  // ── Column definitions ──
  const columns: { key: TlcSortKey; label: string; align: 'left' | 'right' }[] = [
    { key: 'sku', label: 'SKU', align: 'left' },
    { key: 'name', label: 'Product', align: 'left' },
    { key: 'unitsProduced', label: 'Units Produced', align: 'right' },
    { key: 'ingredientCogs', label: 'Ingr. COGS', align: 'right' },
    { key: 'cpFee', label: 'CP Fee', align: 'right' },
    { key: 'freight', label: 'Freight', align: 'right' },
    { key: 'wasteCost', label: 'Waste', align: 'right' },
    { key: 'trueLandedCogs', label: 'True COGS', align: 'right' },
    { key: 'vsEstimate', label: 'vs Est.', align: 'right' },
  ]

  return (
    <div className="rounded-xl border border-border bg-card">
      {/* Header */}
      <div className="border-b border-border px-5 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text">True Landed COGS</h3>
            <p className="mt-0.5 text-[11px] text-muted">Full cost breakdown per SKU from actual production data</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportCsv} className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:text-text">
              Export CSV
            </button>
            <button onClick={exportPdf} className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:text-text">
              Export PDF
            </button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4">
        <div className="bg-card px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-muted">Avg Landed COGS</p>
          <p className="mt-1 font-mono text-lg font-bold text-text">{summary.avg != null ? fmtRate(summary.avg) : '—'}</p>
          <p className="text-[10px] text-muted">per unit</p>
        </div>
        <div className="bg-card px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-muted">Highest COGS SKU</p>
          <p className="mt-1 font-mono text-lg font-bold text-red-400">{summary.highest ? fmtRate(summary.highest.trueLandedCogs) : '—'}</p>
          <p className="text-[10px] font-mono text-muted">{summary.highest?.recipe.sku ?? '—'}</p>
        </div>
        <div className="bg-card px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-muted">Lowest COGS SKU</p>
          <p className="mt-1 font-mono text-lg font-bold text-green-400">{summary.lowest ? fmtRate(summary.lowest.trueLandedCogs) : '—'}</p>
          <p className="text-[10px] font-mono text-muted">{summary.lowest?.recipe.sku ?? '—'}</p>
        </div>
        <div className="bg-card px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-muted">Avg vs Estimate</p>
          <p className={`mt-1 font-mono text-lg font-bold ${summary.avgVsPct != null ? (summary.avgVsPct > 0 ? 'text-red-400' : 'text-green-400') : 'text-muted'}`}>
            {summary.avgVsPct != null ? `${summary.avgVsPct > 0 ? '+' : ''}${summary.avgVsPct.toFixed(1)}%` : '—'}
          </p>
          <p className="text-[10px] text-muted">{summary.avgVsPct != null ? (summary.avgVsPct > 0 ? 'over estimate' : 'under estimate') : 'no data'}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface/30 px-5 py-2.5">
        <div className="flex gap-1">
          {(['all', 'active', 'withData'] as TlcFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                filter === f ? 'bg-accent text-white' : 'bg-surface text-muted hover:text-text'
              }`}
            >
              {f === 'all' ? 'All SKUs' : f === 'active' ? 'Active Only' : 'With Production Data'}
            </button>
          ))}
        </div>
        {cpOptions.length > 1 && (
          <select
            value={cpFilter}
            onChange={(e) => setCpFilter(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text"
          >
            <option value="all">All Co-Packers</option>
            {cpOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        )}
        {/* Bar legend */}
        <div className="ml-auto flex items-center gap-3 text-[10px] text-muted">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: '#3B82F6' }} />Ingredients</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: '#A855F7' }} />CP Fee</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: '#06B6D4' }} />Freight</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: '#EF4444' }} />Waste</span>
        </div>
      </div>

      {/* Table */}
      <div ref={tableRef} className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-surface">
              {/* Expand spacer */}
              <th className="w-6" />
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className={`cursor-pointer select-none whitespace-nowrap px-3 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted hover:text-text ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                >
                  {col.label}{sortIcon(col.key)}
                </th>
              ))}
              {/* Cost breakdown bar */}
              <th className="w-[140px] px-3 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted">
                Breakdown
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.length > 0 ? sortedRows.map((row) => {
              const isExpanded = expandedId === row.recipe.id
              return (
                <tbody key={row.recipe.id}>
                  <tr
                    onClick={() => setExpandedId(isExpanded ? null : row.recipe.id)}
                    className={`cursor-pointer border-b border-border transition-colors hover:bg-hover ${row.recipe.status === 'draft' ? 'opacity-60' : ''}`}
                  >
                    <td className="w-6 pl-2 text-center text-muted">
                      <span className={`inline-block transition-transform ${isExpanded ? 'rotate-90' : ''}`}>&#9656;</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono font-medium text-accent">{row.recipe.sku}</td>
                    <td className="px-3 py-2.5 font-medium text-text">{row.recipe.name}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-text">
                      {row.unitsProduced > 0 ? row.unitsProduced.toLocaleString() : <span className="text-muted">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-text">
                      {row.ingredientCogs != null ? fmtRate(row.ingredientCogs) : <span className="text-muted">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      {row.cpFee != null ? (
                        <span className="font-mono text-text">
                          {fmtRate(row.cpFee)}
                          {row.cpFeeSource && <span className="ml-1 text-[9px] text-muted">({row.cpFeeSource})</span>}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      {row.freight != null ? (
                        <span className="font-mono text-text">
                          {fmtRate(row.freight)}
                          {row.freightSource && <span className="ml-1 text-[9px] text-muted">({row.freightSource})</span>}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-text">
                      {row.wasteCost != null ? fmtRate(row.wasteCost) : <span className="text-muted">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono font-bold text-green-400">
                      {row.trueLandedCogs != null ? fmtRate(row.trueLandedCogs) : <span className="font-normal text-muted">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono">
                      {row.vsDiff != null ? (
                        <span className={row.vsDiff > 0 ? 'text-red-400' : 'text-green-400'}>
                          {row.vsDiff > 0 ? '+' : ''}{fmtRate(row.vsDiff)}
                          <span className="ml-0.5 text-[9px]">({row.vsPct! > 0 ? '+' : ''}{row.vsPct!.toFixed(1)}%)</span>
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <CostBar row={row} />
                    </td>
                  </tr>

                  {/* ── Expanded Detail ── */}
                  {isExpanded && (
                    <tr>
                      <td colSpan={12} className="border-b border-border bg-surface/40 px-6 py-4">
                        <ExpandedDetail row={row} />
                      </td>
                    </tr>
                  )}
                </tbody>
              )
            }) : (
              <tr>
                <td colSpan={12} className="px-4 py-8 text-center text-sm text-muted">
                  No recipes match the current filter
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── Expanded Detail Section ──────────────────────────────── */

function ExpandedDetail({ row }: { row: TlcRow }) {
  return (
    <div className="space-y-5">
      <h4 className="text-xs font-semibold text-text">
        {row.recipe.name} <span className="font-mono text-muted">({row.recipe.sku})</span>
      </h4>

      {/* Ingredient Costs */}
      <div>
        <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted">Ingredient Costs (per unit)</p>
        {row.ingredientLines.length > 0 ? (
          <table className="w-full max-w-lg text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="pb-1 text-left text-[10px] font-medium text-muted">Ingredient</th>
                <th className="pb-1 text-right text-[10px] font-medium text-muted">Qty/Unit</th>
                <th className="pb-1 text-right text-[10px] font-medium text-muted">Unit Cost</th>
                <th className="pb-1 text-right text-[10px] font-medium text-muted">Cost/Unit</th>
              </tr>
            </thead>
            <tbody>
              {row.ingredientLines.map((line, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-1.5 text-text">{line.name}</td>
                  <td className="py-1.5 text-right font-mono text-text">
                    {line.providedBy === 'copacker' ? '—' : `${line.qtyPerUnit}${line.unit}`}
                  </td>
                  <td className="py-1.5 text-right font-mono text-text">
                    {line.providedBy === 'copacker' ? '—' : fmtRate(line.unitCost)}
                  </td>
                  <td className="py-1.5 text-right font-mono font-medium text-text">{fmtRate(line.costPerUnit)}</td>
                </tr>
              ))}
              <tr className="border-t border-border">
                <td colSpan={3} className="py-1.5 text-right text-[10px] font-medium text-muted">Subtotal</td>
                <td className="py-1.5 text-right font-mono font-bold text-text">{fmtRate(row.ingredientCogs)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-muted">No BOM data available</p>
        )}
      </div>

      {/* CP Fee */}
      <div>
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted">Co-Packer Fee</p>
        {row.cpFee != null ? (
          <div className="space-y-1 text-xs">
            {row.cpFeeSource === 'actual' && row.cpFeeInvoices.length > 0 ? (
              <>
                <p className="text-text">
                  Source: {row.cpFeeInvoices.length} invoice{row.cpFeeInvoices.length > 1 ? 's' : ''} — <span className="font-mono font-medium">{fmtRate(row.cpFee)}/unit</span> <span className="text-green-400">(actual)</span>
                </p>
                {row.cpFeeInvoices.map((inv, i) => (
                  <p key={i} className="ml-3 text-muted">
                    {inv.invoiceNumber ?? 'Invoice'} {inv.invoiceDate ? `(${inv.invoiceDate})` : ''} — {fmtRate(inv.perUnitCost)}/unit
                  </p>
                ))}
              </>
            ) : (
              <p className="text-text">
                Source: Default co-packer rate — <span className="font-mono font-medium">{fmtRate(row.cpFee)}/unit</span> <span className="text-amber-400">(default)</span>
              </p>
            )}
            {row.cpFeeSource === 'actual' && row.cpFeeDefault != null && (
              <p className="text-muted">
                Default rate: {fmtRate(row.cpFeeDefault)}/unit
                {row.cpFee !== row.cpFeeDefault && (
                  <span className={row.cpFee! > row.cpFeeDefault ? 'ml-1 text-red-400' : 'ml-1 text-green-400'}>
                    ({row.cpFee! > row.cpFeeDefault ? '+' : ''}{fmtRate(row.cpFee! - row.cpFeeDefault)} / {row.cpFeeDefault > 0 ? `${(((row.cpFee! - row.cpFeeDefault) / row.cpFeeDefault) * 100).toFixed(1)}%` : '—'})
                  </span>
                )}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted">No co-packer fee data — {row.cpName ?? 'no co-packer assigned'}</p>
        )}
      </div>

      {/* Freight */}
      <div>
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted">Freight</p>
        {row.freight != null ? (
          <div className="space-y-1 text-xs">
            <p className="text-text">
              {row.freightShipments.length > 0 ? (
                <>Avg from {row.freightShipments.length} shipment{row.freightShipments.length > 1 ? 's' : ''}: <span className="font-mono font-medium">{fmtRate(row.freight)}/unit</span> <span className="text-green-400">(actual)</span></>
              ) : row.freightSource === 'est.' ? (
                <>Estimated: <span className="font-mono font-medium">{fmtRate(row.freight)}/unit</span> <span className="text-amber-400">(est.)</span></>
              ) : (
                <>From freight summary: <span className="font-mono font-medium">{fmtRate(row.freight)}/unit</span> <span className="text-green-400">(actual)</span></>
              )}
            </p>
            {row.freightShipments.map((ship, i) => (
              <p key={i} className="ml-3 text-muted">
                {ship.date}: {ship.quantity.toLocaleString()} units, {fmt$(ship.shippingCost)} freight = {fmtRate(ship.perUnit)}/unit
                <span className="ml-1 text-[10px]">({ship.fromLocation} → {ship.toLocation})</span>
              </p>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">No freight data available</p>
        )}
      </div>

      {/* Waste */}
      <div>
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted">Waste Cost</p>
        {row.wasteCost != null && row.wasteRuns.length > 0 ? (
          <div className="space-y-1 text-xs">
            <p className="text-text">
              From {row.wasteRuns.length} reconciled run{row.wasteRuns.length > 1 ? 's' : ''}: <span className="font-mono font-medium">{fmtRate(row.wasteCost)}/unit avg</span>
            </p>
            {row.wasteRuns.map((wr, i) => (
              <p key={i} className="ml-3 text-muted">
                {wr.runNumber}: {wr.wastePct != null ? `${wr.wastePct.toFixed(1)}% waste` : 'waste'} = {fmtRate(wr.wastePerUnit)}/unit
                <span className="ml-1 text-[10px]">({wr.producedQty.toLocaleString()} units)</span>
              </p>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">No reconciliation data</p>
        )}
      </div>

      {/* Total */}
      <div className="border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-text">TRUE LANDED COGS</span>
          <div className="text-right">
            <span className="font-mono text-base font-bold text-green-400">
              {row.trueLandedCogs != null ? fmtRate(row.trueLandedCogs) : '—'}
            </span>
            {row.trueLandedCogs != null && (
              <span className="ml-2 text-[10px] text-muted">
                = {row.ingredientCogs != null ? fmtRate(row.ingredientCogs) : '—'}
                {' + '}{row.cpFee != null ? fmtRate(row.cpFee) : '—'}
                {' + '}{row.freight != null ? fmtRate(row.freight) : '—'}
                {' + '}{row.wasteCost != null ? fmtRate(row.wasteCost) : '$0.00'}
              </span>
            )}
          </div>
        </div>
        {row.vsDiff != null && (
          <p className={`mt-1 text-right text-xs ${row.vsDiff > 0 ? 'text-red-400' : 'text-green-400'}`}>
            {row.vsDiff > 0 ? '+' : ''}{fmtRate(row.vsDiff)} vs estimate ({row.vsPct! > 0 ? '+' : ''}{row.vsPct!.toFixed(1)}%)
            {' — '}estimated was {fmtRate(row.estimatedCogs)}/unit
          </p>
        )}
      </div>
    </div>
  )
}
