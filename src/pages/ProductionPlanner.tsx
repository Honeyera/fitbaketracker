import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { supabase } from '../lib/supabase'
import { dbInsert, dbInsertSingle } from '../lib/dbWrite'
import { sanitize } from '../lib/sanitizePayload'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { fmt$, fmtRate } from '../lib/format'
import { loadConversions, type ConversionMap } from '../lib/conversions'
import { calculateRecipeCOGS } from '../lib/recipeCosting'
import {
  buildMRPRows,
  buildMRPSummary,
  nextRunNumber as calcNextRunNumber,
  type PlannedRun,
} from '../lib/mrp'
import PageHeader from '../components/PageHeader'
import MRPPanel from '../components/MRPPanel'
import MRPCreatePOModal from '../components/MRPCreatePOModal'
import { PageSkeleton } from '../components/Skeleton'
import { useToast } from '../components/Toast'
import { Plus, X, Play, ClipboardList } from 'lucide-react'
import type {
  CoPacker,
  Recipe,
  RecipeIngredient,
  Ingredient,
  IngredientInventory,
  PurchaseOrder,
  PurchaseOrderItem,
  SupplierIngredient,
  SupplierContact,
  Supplier,
  ShipmentToCopacker,
  ProductionRun,
  ProductionRunInsert,
  ProductionOrder,
  ProductionOrderInsert,
} from '../types/database'

/* ── Planned run row ─────────────────────────────────────────── */

interface PlanRow {
  recipeId: string
  qty: string
}

/* ================================================================ */

export default function ProductionPlanner() {
  const toast = useToast()
  const [loading, setLoading] = useState(true)

  /* ── Data state ────────────────────────────────────────────── */
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [recipeIngredients, setRecipeIngredients] = useState<RecipeIngredient[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [inventory, setInventory] = useState<IngredientInventory[]>([])
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [poItems, setPOItems] = useState<PurchaseOrderItem[]>([])
  const [supplierIngredients, setSupplierIngredients] = useState<SupplierIngredient[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierContacts, setSupplierContacts] = useState<SupplierContact[]>([])
  const [, setShipments] = useState<ShipmentToCopacker[]>([])
  const [productionRuns, setProductionRuns] = useState<ProductionRun[]>([])
  const [orders, setOrders] = useState<ProductionOrder[]>([])
  const [conversions, setConversions] = useState<ConversionMap>(new Map())

  /* ── Plan state ────────────────────────────────────────────── */
  const [selectedCP, setSelectedCP] = useState('')
  const [planRows, setPlanRows] = useState<PlanRow[]>([{ recipeId: '', qty: '' }])
  const [saving, setSaving] = useState(false)

  /* ── MRP action modal state ────────────────────────────────── */
  const [mrpPOOpen, setMRPPOOpen] = useState(false)

  /* ── Data loading ──────────────────────────────────────────── */

  async function load() {
    // Phase 1: Core data — unblocks the page skeleton
    try {
      const [cpRes, recRes, riRes, ingRes, invRes, runRes, ordRes, convMap] = await safeBatch(() => Promise.all([
        supabase.from('co_packers').select('*').order('name'),
        supabase.from('recipes').select('*').order('name'),
        supabase.from('recipe_ingredients').select('*'),
        supabase.from('ingredients').select('*').order('name'),
        supabase.from('ingredient_inventory').select('*'),
        supabase.from('production_runs').select('*'),
        supabase.from('production_orders').select('*'),
        loadConversions(),
      ]))
      setCoPackers(cpRes.data ?? [])
      setRecipes(recRes.data ?? [])
      setRecipeIngredients(riRes.data ?? [])
      setIngredients(ingRes.data ?? [])
      setInventory(invRes.data ?? [])
      setProductionRuns(runRes.data ?? [])
      setOrders(ordRes.data ?? [])
      setConversions(convMap)
    } catch (err) {
      console.error('Failed to load production planner (core):', err)
    } finally {
      setLoading(false)
    }

    // Phase 2: Supplementary data (suppliers, POs, shipments)
    try {
      const [poRes, poiRes, siRes, supRes, scRes, shipRes] = await safeBatch(() => Promise.all([
        supabase.from('purchase_orders').select('*'),
        supabase.from('purchase_order_items').select('*'),
        supabase.from('supplier_ingredients').select('*'),
        supabase.from('suppliers').select('*').order('name'),
        supabase.from('supplier_contacts').select('*'),
        supabase.from('shipments_to_copacker').select('*'),
      ]))
      setPurchaseOrders(poRes.data ?? [])
      setPOItems(poiRes.data ?? [])
      setSupplierIngredients(siRes.data ?? [])
      setSuppliers(supRes.data ?? [])
      setSupplierContacts(scRes.data ?? [])
      setShipments(shipRes.data ?? [])
    } catch (err) {
      console.error('Failed to load supplementary data:', err)
    }
  }

  useEffect(() => safeLoad(load, setLoading), [])

  /* ── Filtered recipes for selected CP ──────────────────────── */

  const cpRecipes = useMemo(() => {
    if (!selectedCP) return []
    return recipes.filter((r) => r.co_packer_id === selectedCP)
  }, [selectedCP, recipes])

  const cpName = coPackers.find((cp) => cp.id === selectedCP)?.name ?? '—'
  const cpObj = coPackers.find((cp) => cp.id === selectedCP)

  /* ── Plan row helpers ──────────────────────────────────────── */

  function updatePlanRow(idx: number, field: keyof PlanRow, value: string) {
    setPlanRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)))
  }

  function addPlanRow() {
    setPlanRows((prev) => [...prev, { recipeId: '', qty: '' }])
  }

  function removePlanRow(idx: number) {
    setPlanRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)))
  }

  /* ── Valid planned runs ────────────────────────────────────── */

  const validRuns: PlannedRun[] = useMemo(() => {
    return planRows
      .filter((r) => r.recipeId && r.qty && Number(r.qty) > 0)
      .map((r) => ({ recipeId: r.recipeId, quantity: Number(r.qty) }))
  }, [planRows])

  /* ── MRP calculation ───────────────────────────────────────── */

  const mrpRows = useMemo(() => {
    if (!selectedCP || validRuns.length === 0) return []
    return buildMRPRows(
      validRuns,
      selectedCP,
      recipeIngredients,
      ingredients,
      inventory,
      purchaseOrders,
      poItems,
      conversions,
    )
  }, [validRuns, selectedCP, recipeIngredients, ingredients, inventory, purchaseOrders, poItems, conversions])

  const mrpSummary = useMemo(() => buildMRPSummary(mrpRows), [mrpRows])

  /* ── Cost estimates ────────────────────────────────────────── */

  const costEstimates = useMemo(() => {
    const totalQty = validRuns.reduce((s, r) => s + r.quantity, 0)
    const ingredientCost = mrpSummary.totalIngredientCost
    const feePerUnit = cpObj?.fee_per_unit ?? 0
    const cpFee = totalQty * feePerUnit
    const totalCost = ingredientCost + cpFee
    const cogsPerUnit = totalQty > 0 ? totalCost / totalQty : 0
    return { ingredientCost, cpFee, totalCost, cogsPerUnit, totalQty }
  }, [mrpSummary, validRuns, cpObj])

  /* ── Create production runs ────────────────────────────────── */

  async function handleCreateRuns() {
    if (validRuns.length === 0) return
    setSaving(true)

    try {
      let runNum = calcNextRunNumber(productionRuns)

      for (const planned of validRuns) {
        const insert: ProductionRunInsert = {
          run_number: runNum,
          co_packer_id: selectedCP,
          recipe_id: planned.recipeId,
          requested_quantity: planned.quantity,
          requested_date: format(new Date(), 'yyyy-MM-dd'),
          status: 'requested',
        }

        const { error } = await dbInsert('production_runs', sanitize('production_runs', insert))
        if (error) throw error

        // Increment run number
        const num = parseInt(runNum.replace('PR-', ''), 10)
        runNum = `PR-${String(num + 1).padStart(4, '0')}`
      }

      toast.success(`Created ${validRuns.length} production run${validRuns.length > 1 ? 's' : ''}`)
      setPlanRows([{ recipeId: '', qty: '' }])
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create runs')
    } finally {
      setSaving(false)
    }
  }

  /* ── Order number generator ────────────────────────────────── */

  function nextOrderNumber(): string {
    if (orders.length === 0) return 'PO-B001'
    const nums = orders.map((o) => {
      const m = o.order_number.match(/PO-B(\d+)/)
      return m ? parseInt(m[1], 10) : 0
    }).filter(Boolean)
    const max = Math.max(...nums, 0)
    return `PO-B${String(max + 1).padStart(3, '0')}`
  }

  /* ── Recipe COGS for cost estimates ──────────────────────── */

  const recipeCOGS = useMemo(() => {
    const map = new Map<string, number>()
    for (const recipe of recipes) {
      map.set(recipe.id, calculateRecipeCOGS(recipe.id, recipeIngredients, ingredients, conversions))
    }
    return map
  }, [recipes, recipeIngredients, ingredients, conversions])

  /* ── Create production order ─────────────────────────────── */

  async function handleCreateOrder() {
    if (validRuns.length === 0 || !selectedCP) return
    setSaving(true)

    try {
      const orderNum = nextOrderNumber()
      const totalUnits = validRuns.reduce((s, r) => s + r.quantity, 0)
      const cpFee = cpObj?.fee_per_unit ?? 0
      const totalCost = validRuns.reduce((s, r) => {
        const cogs = recipeCOGS.get(r.recipeId) ?? 0
        return s + r.quantity * (cogs + cpFee)
      }, 0)

      const insert: ProductionOrderInsert = {
        order_number: orderNum,
        co_packer_id: selectedCP,
        status: 'draft',
        order_date: format(new Date(), 'yyyy-MM-dd'),
        priority: 'normal',
        total_units: totalUnits,
        total_estimated_cost: totalCost,
      }

      const { data: order, error } = await dbInsertSingle('production_orders', sanitize('production_orders', insert))
      if (error || !order) throw error ?? new Error('Failed to create order')

      let runNum = calcNextRunNumber(productionRuns)
      for (const planned of validRuns) {
        const runInsert: ProductionRunInsert = {
          run_number: runNum,
          co_packer_id: selectedCP,
          recipe_id: planned.recipeId,
          requested_quantity: planned.quantity,
          requested_date: format(new Date(), 'yyyy-MM-dd'),
          status: 'requested',
          production_order_id: order.id,
        }
        const { error: runError } = await dbInsert('production_runs', sanitize('production_runs', runInsert))
        if (runError) throw runError

        const num = parseInt(runNum.replace('PR-', ''), 10)
        runNum = `PR-${String(num + 1).padStart(4, '0')}`
      }

      toast.success(`Created production order ${orderNum} with ${validRuns.length} flavor${validRuns.length > 1 ? 's' : ''}`)
      setPlanRows([{ recipeId: '', qty: '' }])
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create order')
    } finally {
      setSaving(false)
    }
  }

  /* ── Render ────────────────────────────────────────────────── */

  if (loading) return <PageSkeleton />

  return (
    <div>
      <PageHeader
        title="Production Planner"
        subtitle="Plan production runs and calculate material requirements"
      />

      {/* ── Plan Runs Section ────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-6">
        {/* Co-Packer selection */}
        <div className="mb-6">
          <span className="mb-1 block text-xs text-muted">Co-Packer</span>
          <select
            value={selectedCP}
            onChange={(e) => {
              setSelectedCP(e.target.value)
              setPlanRows([{ recipeId: '', qty: '' }])
            }}
            className="w-full max-w-xs rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
          >
            <option value="">Select co-packer…</option>
            {coPackers.map((cp) => (
              <option key={cp.id} value={cp.id}>{cp.name}</option>
            ))}
          </select>
        </div>

        {/* Planned runs table */}
        {selectedCP && (
          <>
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">
              Planned Runs
            </p>
            <div className="space-y-3">
              {planRows.map((row, idx) => {
                return (
                  <div key={idx} className="grid grid-cols-[1fr_150px_40px] items-end gap-3">
                    <div>
                      <span className="mb-1 block text-xs text-muted">Recipe / SKU</span>
                      <select
                        value={row.recipeId}
                        onChange={(e) => updatePlanRow(idx, 'recipeId', e.target.value)}
                        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                      >
                        <option value="">Select recipe…</option>
                        {cpRecipes.map((r) => (
                          <option key={r.id} value={r.id}>{r.name} ({r.sku})</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <span className="mb-1 block text-xs text-muted">Quantity</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={row.qty}
                        onChange={(e) => updatePlanRow(idx, 'qty', e.target.value)}
                        placeholder="e.g. 5000"
                        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removePlanRow(idx)}
                      disabled={planRows.length <= 1}
                      className="flex h-[38px] items-center justify-center rounded-lg text-muted transition-colors hover:text-red-400 disabled:opacity-30"
                    >
                      <X size={16} />
                    </button>
                  </div>
                )
              })}
            </div>
            <button
              type="button"
              onClick={addPlanRow}
              className="mt-3 flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
            >
              <Plus size={14} />
              Add Run
            </button>
          </>
        )}
      </div>

      {/* ── Requirements Breakdown ───────────────────────────── */}
      {validRuns.length > 0 && mrpRows.length > 0 && (
        <div className="mt-6 rounded-xl border border-border bg-card p-6">
          <MRPPanel
            rows={mrpRows}
            summary={mrpSummary}
            cpName={cpName}
            conversions={conversions}
            onCreatePOs={() => setMRPPOOpen(true)}
          />
        </div>
      )}

      {/* ── Cost Estimates ───────────────────────────────────── */}
      {validRuns.length > 0 && mrpRows.length > 0 && (
        <div className="mt-6 rounded-xl border border-border bg-card p-6">
          <p className="mb-4 text-xs font-medium uppercase tracking-wider text-muted">
            Cost Estimates
          </p>

          {/* Per-ingredient breakdown */}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-surface/50 text-muted">
                  <th className="px-3 py-2 font-medium">Ingredient</th>
                  <th className="px-3 py-2 font-medium text-right">Need</th>
                  <th className="px-3 py-2 font-medium text-right">Unit Cost</th>
                  <th className="px-3 py-2 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {mrpRows.map((row) => (
                  <tr key={row.ingredientId} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium text-text">{row.ingredientName}</td>
                    <td className="px-3 py-2 text-right font-mono text-text">
                      {row.totalNeed % 1 === 0
                        ? row.totalNeed.toLocaleString()
                        : row.totalNeed.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}{' '}
                      {row.unit}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-text">
                      {fmtRate(row.unitCost)}/{row.unit}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-text">
                      {fmt$(row.totalNeed * row.unitCost)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td colSpan={3} className="px-3 py-2 text-right text-muted">
                    Ingredient Subtotal
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-text">
                    {fmt$(costEstimates.ingredientCost)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Summary cards */}
          <div className="mt-4 grid grid-cols-3 gap-6">
            <div>
              <span className="block text-xs text-muted">Co-Packer Fee</span>
              <span className="font-mono text-lg font-semibold text-text">
                {fmt$(costEstimates.cpFee)}
              </span>
              {cpObj?.fee_per_unit != null && cpObj.fee_per_unit > 0 && (
                <span className="block text-[10px] text-muted">
                  @ {fmtRate(cpObj.fee_per_unit)}/unit × {costEstimates.totalQty.toLocaleString()}
                </span>
              )}
            </div>
            <div>
              <span className="block text-xs text-muted">Total Est. Cost</span>
              <span className="font-mono text-lg font-semibold text-accent">
                {fmt$(costEstimates.totalCost)}
              </span>
            </div>
            <div>
              <span className="block text-xs text-muted">Est. COGS/Unit</span>
              <span className="font-mono text-lg font-semibold text-text">
                {fmtRate(costEstimates.cogsPerUnit)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Actions ──────────────────────────────────────────── */}
      {validRuns.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-3">
          {validRuns.length > 1 && (
            <button
              type="button"
              onClick={handleCreateOrder}
              disabled={saving}
              className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              <ClipboardList size={16} />
              {saving ? 'Creating…' : 'Create Production Order'}
            </button>
          )}
          <button
            type="button"
            onClick={handleCreateRuns}
            disabled={saving}
            className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
              validRuns.length > 1
                ? 'border border-border bg-surface text-text hover:bg-surface/80'
                : 'bg-accent text-white hover:bg-accent-hover'
            }`}
          >
            <Play size={16} />
            {saving
              ? 'Creating…'
              : `Create ${validRuns.length} Individual Run${validRuns.length > 1 ? 's' : ''}`}
          </button>
        </div>
      )}

      {/* ── MRP Create PO Modal ──────────────────────────────── */}
      <MRPCreatePOModal
        isOpen={mrpPOOpen}
        onClose={() => setMRPPOOpen(false)}
        onCreated={load}
        shortfallRows={mrpRows}
        coPackerId={selectedCP}
        cpName={cpName}
        ingredients={ingredients}
        suppliers={suppliers}
        supplierContacts={supplierContacts}
        supplierIngredients={supplierIngredients}
        purchaseOrders={purchaseOrders}
        coPackers={coPackers}
        conversions={conversions}
      />

    </div>
  )
}
