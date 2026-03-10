import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { logActivity } from '../lib/activityLog'
import { supabase } from '../lib/supabase'
import { dbInsert, dbInsertSingle, dbUpdate, dbDelete } from '../lib/dbWrite'
import { sanitize } from '../lib/sanitizePayload'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { fmt$, fmtRate, fmtNum, fmtDate } from '../lib/format'
import { unitGroup, normalizeUnit, loadConversions, getConversionFactorWithDensity, type ConversionMap } from '../lib/conversions'
import { downloadCSV } from '../lib/csv'
import { useToast } from '../components/Toast'
import PageHeader from '../components/PageHeader'
import StatCard from '../components/StatCard'
import CPFilterBar from '../components/CPFilterBar'
import DataTable, { type Column } from '../components/DataTable'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import ConfirmDialog from '../components/ConfirmDialog'
import CostGuard from '../components/CostGuard'
import HelpTip from '../components/HelpTip'
import Tooltip from '../components/Tooltip'
import { PageSkeleton } from '../components/Skeleton'
import { Plus, Download, Pencil, Trash2, Tag, X, Settings, RefreshCw } from 'lucide-react'
import type {
  Ingredient,
  IngredientInventory,
  IngredientInsert,
  IngredientCostHistory,
  CoPacker,
  IngredientTag,
  IngredientTagLink,
} from '../types/database'

interface CostHistoryWithPO extends IngredientCostHistory {
  purchase_orders: {
    po_number: string
    supplier_id: string
    suppliers: { name: string } | null
  }
}

/** Unified purchase history entry (from cost_history table OR po_items fallback) */
interface PurchaseHistoryEntry {
  id: string
  date: string
  poNumber: string
  supplier: string
  quantity: number
  unitCost: number
  purchaseOrderId: string
}

const CATEGORIES = [
  'Flour/Base',
  'Sweetener',
  'Flavoring',
  'Fiber',
  'Dairy',
  'Protein',
  'Stabilizer',
  'Leavening',
  'Seasoning',
  'Packaging',
  'Other',
]

const UNIT_OPTIONS = [
  { value: 'lbs', label: 'lbs (Pounds)' },
  { value: 'oz', label: 'oz (Ounces)' },
  { value: 'g', label: 'g (Grams)' },
  { value: 'kg', label: 'kg (Kilograms)' },
  { value: 'fl_oz', label: 'fl_oz (Fluid Ounces)' },
  { value: 'ml', label: 'ml (Milliliters)' },
  { value: 'l', label: 'l (Liters)' },
  { value: 'gal', label: 'gal (Gallons)' },
  { value: 'pcs', label: 'pcs (Pieces)' },
] as const

const UNIT_SINGULAR: Record<string, string> = {
  lbs: 'lb', oz: 'oz', g: 'g', kg: 'kg', fl_oz: 'fl oz', ml: 'ml', l: 'l', gal: 'gal', pcs: 'pc',
}

const VOLUME_UNIT_SET = new Set(['fl_oz', 'ml', 'l', 'gal'])

interface Row extends Record<string, unknown> {
  id: string
  name: string
  category: string | null
  unit: string
  unit_cost: number
  last_cost: number | null
  reorder_point: number | null
  density_g_per_ml: number | null
  cpTotals: Record<string, number>
  totalOwned: number
  totalValue: number
  status: 'OK' | 'LOW' | 'CRITICAL'
  tags: IngredientTag[]
}

export default function Ingredients() {
  const toast = useToast()
  const { can, appUser } = useAuth()
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [inventory, setInventory] = useState<IngredientInventory[]>([])
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [cpFilter, setCpFilter] = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [detailRow, setDetailRow] = useState<Row | null>(null)
  const [costHistory, setCostHistory] = useState<CostHistoryWithPO[]>([])
  const [purchaseHistory, setPurchaseHistory] = useState<PurchaseHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [conversions, setConversions] = useState<ConversionMap>(new Map())
  const [tags, setTags] = useState<IngredientTag[]>([])
  const [tagLinks, setTagLinks] = useState<IngredientTagLink[]>([])
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  /* manage tags modal */
  const [manageTagsOpen, setManageTagsOpen] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('#3B82F6')
  const [editingTagId, setEditingTagId] = useState<string | null>(null)
  const [editTagName, setEditTagName] = useState('')
  const [editTagColor, setEditTagColor] = useState('')

  /* add/edit modal tag selection */
  const [addTagIds, setAddTagIds] = useState<string[]>([])
  const [editTagIds, setEditTagIds] = useState<string[]>([])

  /* add modal state (for dynamic labels & density conditional) */
  const [addUnit, setAddUnit] = useState('lbs')
  const [addCategory, setAddCategory] = useState('')
  const [addDensityWarning, setAddDensityWarning] = useState('')

  /* edit modal */
  const [editIngredient, setEditIngredient] = useState<Ingredient | null>(null)
  const [editForm, setEditForm] = useState({
    name: '', category: '', unit: '', unit_cost: '',
    reorder_point: '', shelf_life_days: '', notes: '', density_g_per_ml: '',
  })
  const [unitChangeWarning, setUnitChangeWarning] = useState('')
  const [editDensityWarning, setEditDensityWarning] = useState('')

  /* delete confirm */
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [pendingDeleteIngredient, setPendingDeleteIngredient] = useState<Ingredient | null>(null)

  async function load() {
    const [ingRes, invRes, cpRes, convMap, tagRes, linkRes] = await safeBatch(() => Promise.all([
      supabase.from('ingredients').select('*').order('name'),
      supabase.from('ingredient_inventory').select('*'),
      supabase.from('co_packers').select('*').order('name'),
      loadConversions(),
      supabase.from('ingredient_tags').select('*').order('name'),
      supabase.from('ingredient_tag_links').select('*'),
    ]))
    setIngredients(ingRes.data ?? [])
    setInventory(invRes.data ?? [])
    setCoPackers(cpRes.data ?? [])
    setConversions(convMap)
    setTags(tagRes.data ?? [])
    setTagLinks(linkRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => safeLoad(load, setLoading), [])

  // Build tag lookup: ingredient_id → IngredientTag[]
  const tagsByIngredient = useMemo(() => {
    const map = new Map<string, IngredientTag[]>()
    for (const link of tagLinks) {
      const tag = tags.find((t) => t.id === link.tag_id)
      if (!tag) continue
      const arr = map.get(link.ingredient_id) ?? []
      arr.push(tag)
      map.set(link.ingredient_id, arr)
    }
    return map
  }, [tags, tagLinks])

  // Build rows
  const rows: Row[] = useMemo(() => {
    return ingredients
      .filter((ing) => {
        if (!tagFilter) return true
        const ingTags = tagsByIngredient.get(ing.id) ?? []
        return ingTags.some((t) => t.id === tagFilter)
      })
      .map((ing) => {
      const invRows = inventory.filter((iv) => iv.ingredient_id === ing.id)

      const cpTotals: Record<string, number> = {}
      for (const cp of coPackers) {
        cpTotals[cp.id] = invRows
          .filter((iv) => iv.location_type === 'copacker' && iv.co_packer_id === cp.id)
          .reduce((s, iv) => s + (iv.quantity ?? 0), 0)
      }

      // Filtered total based on cpFilter
      let totalOwned: number
      if (cpFilter === 'all') {
        totalOwned = Object.values(cpTotals).reduce((s, v) => s + v, 0)
      } else {
        totalOwned = cpTotals[cpFilter] ?? 0
      }

      const totalValue = totalOwned * ing.unit_cost

      // Status based on OVERALL total (all locations)
      const overallTotal = Object.values(cpTotals).reduce((s, v) => s + v, 0)
      const rp = ing.reorder_point ?? 0
      let status: 'OK' | 'LOW' | 'CRITICAL'
      if (rp > 0 && overallTotal < rp) {
        status = 'CRITICAL'
      } else if (rp > 0 && overallTotal < rp * 1.5) {
        status = 'LOW'
      } else {
        status = 'OK'
      }

      return {
        id: ing.id,
        name: ing.name,
        category: ing.category,
        unit: ing.unit,
        unit_cost: ing.unit_cost,
        last_cost: ing.last_cost,
        reorder_point: ing.reorder_point,
        density_g_per_ml: ing.density_g_per_ml,
        cpTotals,
        totalOwned,
        totalValue,
        status,
        tags: tagsByIngredient.get(ing.id) ?? [],
      }
    })
  }, [ingredients, inventory, coPackers, cpFilter, tagFilter, tagsByIngredient])

  // Stats
  const stats = useMemo(() => {
    let totalValue = 0
    const cpValues: Record<string, number> = {}
    for (const cp of coPackers) cpValues[cp.id] = 0
    let belowReorder = 0

    for (const row of rows) {
      // Use un-filtered values for per-location stats
      const ing = ingredients.find((i) => i.id === row.id)!

      for (const cp of coPackers) {
        const cpVal = (row.cpTotals[cp.id] ?? 0) * ing.unit_cost
        cpValues[cp.id] += cpVal
        totalValue += cpVal
      }

      if (row.status === 'CRITICAL') belowReorder++
    }

    return { totalValue, cpValues, belowReorder }
  }, [rows, ingredients, coPackers])

  // Dynamic columns
  const columns: Column<Row>[] = useMemo(() => {
    const cols: Column<Row>[] = [
      {
        label: 'Ingredient',
        key: 'name',
        width: '220px',
        render: (row) => (
          <div>
            <div className="flex items-center gap-1">
              <p className="font-medium text-text">{row.name}</p>
              {VOLUME_UNIT_SET.has(row.unit) && row.density_g_per_ml == null && (
                <Tooltip maxWidth={320} content={
                  <span className="text-amber-200">
                    Missing density — weight/volume conversion won't work for this ingredient. Click to edit.
                  </span>
                }>
                  <span className="cursor-help text-amber-500">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                    </svg>
                  </span>
                </Tooltip>
              )}
            </div>
            {row.category && (
              <p className="text-[11px] text-muted">{row.category}</p>
            )}
          </div>
        ),
      },
    ]

    // Tags column
    cols.push({
      label: 'Tags',
      key: 'tags',
      width: '180px',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.tags.map((tag) => (
            <span
              key={tag.id}
              className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium leading-tight"
              style={{ backgroundColor: tag.color + '25', color: tag.color }}
            >
              {tag.name}
            </span>
          ))}
        </div>
      ),
    })

    // CP columns — show all when 'all', or just the selected one
    const visibleCPs = cpFilter === 'all'
      ? coPackers
      : coPackers.filter((cp) => cp.id === cpFilter)

    for (const cp of visibleCPs) {
      cols.push({
        label: `@ ${cp.short_code}`,
        key: `cp_${cp.id}`,
        align: 'right',
        width: '120px',
        render: (row) => {
          const qty = row.cpTotals[cp.id] ?? 0
          return (
            <span className="font-mono" style={{ color: qty > 0 ? 'var(--color-text)' : 'var(--color-muted)' }}>
              {`${fmtNum(Math.round(qty))} ${row.unit}`}
            </span>
          )
        },
      })
    }

    cols.push(
      {
        label: 'Total Owned',
        key: 'totalOwned',
        align: 'right',
        width: '120px',
        render: (row) => (
          <span className="font-mono font-semibold text-text">
            {`${fmtNum(Math.round(row.totalOwned))} ${row.unit}`}
          </span>
        ),
      },
      {
        label: (
          <HelpTip text="Weighted average cost per unit — recalculated when POs are received. Last cost shown below if different.">
            Cost/Unit
          </HelpTip>
        ),
        key: 'unit_cost',
        align: 'right',
        width: '130px',
        render: (row) => {
          if (!row.unit_cost) return <span className="text-muted">—</span>
          const same = row.last_cost != null && Math.abs(row.last_cost - row.unit_cost) < 0.0001
          const lastColor = row.last_cost != null
            ? row.last_cost > row.unit_cost ? '#EF4444' : row.last_cost < row.unit_cost ? '#22C55E' : undefined
            : undefined
          return (
            <CostGuard>
              <div>
                <span className="font-mono text-text">{fmtRate(row.unit_cost)}<span className="text-muted text-[11px]">/{row.unit}</span></span>
                {row.last_cost != null && !same && (
                  <div className="font-mono text-[11px]" style={{ color: lastColor }}>
                    {fmtRate(row.last_cost)}/{row.unit} <span className="text-muted font-sans">(last)</span>
                  </div>
                )}
              </div>
            </CostGuard>
          )
        },
      },
      {
        label: (
          <HelpTip text="Total quantity owned × weighted average cost. Includes stock at all co-packers.">
            Total Value
          </HelpTip>
        ),
        key: 'totalValue',
        align: 'right',
        width: '130px',
        render: (row) => (
          <CostGuard><span className="font-mono font-medium text-text">{fmt$(row.totalValue)}</span></CostGuard>
        ),
      },
      {
        label: (
          <HelpTip text="OK = well stocked. LOW = approaching reorder point. CRITICAL = below reorder point, order soon.">
            Status
          </HelpTip>
        ),
        key: 'status',
        align: 'center',
        width: '100px',
        render: (row) => (
          <Badge
            color={
              row.status === 'OK' ? 'green' : row.status === 'LOW' ? 'amber' : 'red'
            }
          >
            {row.status}
          </Badge>
        ),
      },
    )

    return cols
  }, [coPackers, cpFilter])

  // CSV export
  function handleExportCSV() {
    const csvData = rows.map((row) => ({
      name: row.name,
      category: row.category ?? '',
      tags: row.tags.map((t) => t.name).join(', '),
      unit: row.unit,
      totalOwned: Math.round(row.totalOwned),
      unit_cost: row.unit_cost.toFixed(2),
      totalValue: row.totalValue.toFixed(2),
      status: row.status,
    }))

    downloadCSV(
      csvData,
      [
        { key: 'name', label: 'Name' },
        { key: 'category', label: 'Category' },
        { key: 'tags', label: 'Tags' },
        { key: 'unit', label: 'Unit' },
        { key: 'totalOwned', label: 'Total Owned' },
        { key: 'unit_cost', label: 'Unit Cost' },
        { key: 'totalValue', label: 'Total Value' },
        { key: 'status', label: 'Status' },
      ],
      'ingredients-export',
    )
  }

  async function openDetail(row: Row) {
    setDetailRow(row)
    setHistoryLoading(true)

    // Primary: cost history table
    const { data: chData } = await supabase
      .from('ingredient_cost_history')
      .select('*, purchase_orders!inner(po_number, supplier_id, suppliers(name))')
      .eq('ingredient_id', row.id)
      .order('date', { ascending: false })
    const costHistoryRows = (chData as CostHistoryWithPO[] | null) ?? []
    setCostHistory(costHistoryRows)

    // Fallback: get directly from PO items (covers POs received before cost history tracking)
    const { data: poItemData } = await supabase
      .from('purchase_order_items')
      .select('id, quantity, received_quantity, unit_cost, quantity_unit, purchase_order_id, purchase_orders(id, po_number, status, order_date, supplier_id, suppliers(name))')
      .eq('ingredient_id', row.id)

    // Merge — deduplicate by purchase_order_id
    const seenPOs = new Set(costHistoryRows.map((ch) => ch.purchase_order_id))
    const merged: PurchaseHistoryEntry[] = []

    // Add cost history records first (already in ingredient units from when PO was received)
    for (const ch of costHistoryRows) {
      // If cost history has quantity=0, it was saved with the received_quantity bug — skip it so fallback picks it up
      if (ch.quantity <= 0) { continue }
      merged.push({
        id: ch.id,
        date: ch.date,
        poNumber: ch.purchase_orders.po_number,
        supplier: ch.purchase_orders.suppliers?.name ?? '—',
        quantity: ch.quantity,
        unitCost: ch.unit_cost,
        purchaseOrderId: ch.purchase_order_id,
      })
    }

    // Add PO items not already in cost history (only from non-draft/cancelled POs)
    // Converts to ingredient's unit using conversions
    type POItemRow = { id: string; quantity: number; received_quantity: number | null; unit_cost: number; quantity_unit: string | null; purchase_order_id: string; purchase_orders: { id: string; po_number: string; status: string; order_date: string | null; supplier_id: string; suppliers: { name: string } | null } | null }
    const skipStatuses = new Set(['draft', 'cancelled'])
    const ingUnit = row.unit
    for (const item of (poItemData as POItemRow[] | null) ?? []) {
      const po = item.purchase_orders
      if (!po || skipStatuses.has(po.status) || seenPOs.has(po.id)) continue
      seenPOs.add(po.id)

      // Use quantity (ordered), not received_quantity (may be 0)
      const rawQty = (item.received_quantity != null && item.received_quantity > 0) ? item.received_quantity : item.quantity
      if (rawQty <= 0) continue
      const lineUnit = item.quantity_unit ?? ingUnit

      // Convert to ingredient's unit
      let qty = rawQty
      let cost = item.unit_cost
      if (normalizeUnit(lineUnit) !== normalizeUnit(ingUnit)) {
        try {
          const factor = getConversionFactorWithDensity(conversions, lineUnit, ingUnit, row.density_g_per_ml)
          qty = Math.round(rawQty * factor * 10000) / 10000
          cost = Math.round((item.unit_cost / factor) * 10000) / 10000
        } catch {
          // Conversion not available — show in original units
        }
      }

      merged.push({
        id: item.id,
        date: po.order_date ?? '',
        poNumber: po.po_number,
        supplier: po.suppliers?.name ?? '—',
        quantity: qty,
        unitCost: cost,
        purchaseOrderId: po.id,
      })
    }

    // Sort by date descending
    merged.sort((a, b) => b.date.localeCompare(a.date))
    setPurchaseHistory(merged)
    setHistoryLoading(false)
  }

  /** Recalculate an ingredient's avg cost and last cost from all received PO items */
  async function recalcIngredientCost(ingredientId: string, ingUnit: string, density: number | null): Promise<{ avgCost: number; lastCost: number; count: number } | null> {
    const { data: poItems } = await supabase
      .from('purchase_order_items')
      .select('quantity, received_quantity, unit_cost, quantity_unit, purchase_order_id, purchase_orders(id, status, order_date)')
      .eq('ingredient_id', ingredientId)

    if (!poItems || poItems.length === 0) return null

    type PIRow = { quantity: number; received_quantity: number | null; unit_cost: number; quantity_unit: string | null; purchase_order_id: string; purchase_orders: { id: string; status: string; order_date: string | null } | null }
    const received = (poItems as PIRow[]).filter((pi) => {
      const st = pi.purchase_orders?.status
      return st && st !== 'draft' && st !== 'cancelled'
    })
    if (received.length === 0) return null

    // Sort by order_date ascending so last item = most recent
    received.sort((a, b) => (a.purchase_orders?.order_date ?? '').localeCompare(b.purchase_orders?.order_date ?? ''))

    let totalQty = 0
    let totalValue = 0
    let lastCost = 0

    for (const pi of received) {
      const rawQty = (pi.received_quantity != null && pi.received_quantity > 0) ? pi.received_quantity : pi.quantity
      if (rawQty <= 0) continue
      const lineUnit = pi.quantity_unit ?? ingUnit

      let qty = rawQty
      let cost = pi.unit_cost
      if (normalizeUnit(lineUnit) !== normalizeUnit(ingUnit)) {
        try {
          const factor = getConversionFactorWithDensity(conversions, lineUnit, ingUnit, density)
          qty = Math.round(rawQty * factor * 10000) / 10000
          cost = Math.round((pi.unit_cost / factor) * 10000) / 10000
        } catch { /* use unconverted */ }
      }

      totalQty += qty
      totalValue += qty * cost
      lastCost = cost
    }

    if (totalQty <= 0) return null
    return { avgCost: Math.round((totalValue / totalQty) * 10000) / 10000, lastCost, count: received.length }
  }

  /** Recalculate and save cost for a single ingredient, then refresh */
  async function recalcSingleIngredient(ingredientId: string, ingUnit: string, density: number | null) {
    setSaving(true)
    try {
      const result = await recalcIngredientCost(ingredientId, ingUnit, density)
      if (!result) { toast.info('No received PO items found for this ingredient'); setSaving(false); return }
      await dbUpdate('ingredients', sanitize('ingredients', {
        unit_cost: result.avgCost,
        last_cost: result.lastCost,
        updated_at: new Date().toISOString(),
      }), 'id', ingredientId)
      toast.success(`Cost updated: avg ${fmtRate(result.avgCost)}/${ingUnit}, last ${fmtRate(result.lastCost)}/${ingUnit}`)
      // Update detail row in place so the popup refreshes immediately
      setDetailRow((prev) => prev ? { ...prev, unit_cost: result.avgCost, last_cost: result.lastCost } : null)
      load() // refresh table in background
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Recalculation failed')
    } finally {
      setSaving(false)
    }
  }

  /** Bulk recalculate all ingredient costs */
  const [bulkRecalcProgress, setBulkRecalcProgress] = useState<string | null>(null)
  async function bulkRecalcCosts() {
    setBulkRecalcProgress('Starting...')
    let updated = 0
    try {
      for (let i = 0; i < ingredients.length; i++) {
        const ing = ingredients[i]
        setBulkRecalcProgress(`${i + 1}/${ingredients.length} — ${ing.name}`)
        const result = await recalcIngredientCost(ing.id, ing.unit, ing.density_g_per_ml ?? null)
        if (result) {
          await dbUpdate('ingredients', sanitize('ingredients', {
            unit_cost: result.avgCost,
            last_cost: result.lastCost,
            updated_at: new Date().toISOString(),
          }), 'id', ing.id)
          updated++
        }
      }
      toast.success(`Updated costs for ${updated} ingredient${updated !== 1 ? 's' : ''} with purchase history`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk recalculation failed')
    } finally {
      setBulkRecalcProgress(null)
    }
  }

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    try {
      const fd = new FormData(e.currentTarget)
      const densityRaw = fd.get('density_g_per_ml') as string
      const row: IngredientInsert = {
        name: fd.get('name') as string,
        category: (fd.get('category') as string) || null,
        unit: (fd.get('unit') as string) || 'lbs',
        unit_cost: Number(fd.get('unit_cost')),
        reorder_point: fd.get('reorder_point') ? Number(fd.get('reorder_point')) : null,
        shelf_life_days: fd.get('shelf_life_days') ? Number(fd.get('shelf_life_days')) : null,
        density_g_per_ml: densityRaw ? Number(densityRaw) : null,
      }
      const { data: inserted, error } = await dbInsertSingle('ingredients', sanitize('ingredients', row))
      if (error || !inserted) throw error ?? new Error('Failed to add ingredient')
      // Save tag links
      if (addTagIds.length > 0) {
        await dbInsert('ingredient_tag_links',
          addTagIds.map((tag_id) => sanitize('ingredient_tag_links', { ingredient_id: inserted.id, tag_id }))
        )
      }
      toast.success('Ingredient added')
      logActivity(appUser?.id, 'create_ingredient', 'ingredient', inserted.id)
      setModalOpen(false)
      setAddTagIds([])
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add ingredient')
    } finally {
      setSaving(false)
    }
  }

  /* ── Edit ───────────────────────────────────────────────── */

  function openEdit(row: Row) {
    const ing = ingredients.find((i) => i.id === row.id)
    if (!ing) return
    setEditIngredient(ing)
    setEditForm({
      name: ing.name,
      category: ing.category ?? '',
      unit: ing.unit,
      unit_cost: String(ing.unit_cost),
      reorder_point: ing.reorder_point != null ? String(ing.reorder_point) : '',
      shelf_life_days: ing.shelf_life_days != null ? String(ing.shelf_life_days) : '',
      notes: ing.notes ?? '',
      density_g_per_ml: ing.density_g_per_ml != null ? String(ing.density_g_per_ml) : '',
    })
    setEditTagIds(tagLinks.filter((l) => l.ingredient_id === ing.id).map((l) => l.tag_id))
    setUnitChangeWarning('')
    setEditDensityWarning('')
    setDetailRow(null)
  }

  async function handleSaveEdit() {
    if (!editIngredient) return
    setSaving(true)
    try {
      const { error } = await dbUpdate('ingredients', sanitize('ingredients', {
        name: editForm.name,
        category: editForm.category || null,
        unit: editForm.unit || 'lbs',
        unit_cost: Number(editForm.unit_cost),
        reorder_point: editForm.reorder_point ? Number(editForm.reorder_point) : null,
        shelf_life_days: editForm.shelf_life_days ? Number(editForm.shelf_life_days) : null,
        notes: editForm.notes || null,
        density_g_per_ml: editForm.density_g_per_ml ? Number(editForm.density_g_per_ml) : null,
      }), 'id', editIngredient.id)
      if (error) throw error
      // Sync tag links: delete all, re-insert current selection
      await dbDelete('ingredient_tag_links', 'ingredient_id', editIngredient.id)
      if (editTagIds.length > 0) {
        await dbInsert('ingredient_tag_links',
          editTagIds.map((tag_id) => sanitize('ingredient_tag_links', { ingredient_id: editIngredient.id, tag_id }))
        )
      }
      toast.success('Ingredient updated')
      logActivity(appUser?.id, 'update_ingredient', 'ingredient', editIngredient.id)
      setEditIngredient(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update ingredient')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteIngredient() {
    if (!pendingDeleteIngredient) return
    setSaving(true)
    try {
      const { error } = await dbDelete('ingredients', 'id', pendingDeleteIngredient.id)
      if (error) throw error
      toast.success(`Deleted ${pendingDeleteIngredient.name}`)
      logActivity(appUser?.id, 'delete_ingredient', 'ingredient', pendingDeleteIngredient.id)
      setConfirmDeleteOpen(false)
      setPendingDeleteIngredient(null)
      setEditIngredient(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete ingredient')
    } finally {
      setSaving(false)
    }
  }

  /* ── Tag CRUD ─────────────────────────────────────────── */

  async function handleCreateTag() {
    if (!newTagName.trim()) return
    setSaving(true)
    try {
      const { error } = await dbInsert('ingredient_tags', sanitize('ingredient_tags', { name: newTagName.trim(), color: newTagColor }))
      if (error) throw error
      setNewTagName('')
      setNewTagColor('#3B82F6')
      const { data } = await supabase.from('ingredient_tags').select('*').order('name')
      setTags(data ?? [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create tag')
    } finally {
      setSaving(false)
    }
  }

  async function handleUpdateTag(id: string) {
    if (!editTagName.trim()) return
    setSaving(true)
    try {
      const { error } = await dbUpdate('ingredient_tags', sanitize('ingredient_tags', { name: editTagName.trim(), color: editTagColor }), 'id', id)
      if (error) throw error
      setEditingTagId(null)
      const { data } = await supabase.from('ingredient_tags').select('*').order('name')
      setTags(data ?? [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update tag')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteTag(id: string) {
    setSaving(true)
    try {
      const { error } = await dbDelete('ingredient_tags', 'id', id)
      if (error) throw error
      if (tagFilter === id) setTagFilter(null)
      const { data } = await supabase.from('ingredient_tags').select('*').order('name')
      setTags(data ?? [])
      const { data: links } = await supabase.from('ingredient_tag_links').select('*')
      setTagLinks(links ?? [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete tag')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <PageSkeleton />

  return (
    <div>
      <PageHeader title="Ingredients" subtitle="Inventory levels across all locations">
        <button
          onClick={bulkRecalcCosts}
          disabled={!!bulkRecalcProgress}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:text-text disabled:opacity-50"
          title="Recalculate all ingredient costs from purchase history"
        >
          <RefreshCw size={14} className={bulkRecalcProgress ? 'animate-spin' : ''} />
          {bulkRecalcProgress ?? 'Recalculate Costs'}
        </button>
        <button
          onClick={handleExportCSV}
          className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
        >
          <Download size={16} />
          Export CSV
        </button>
        <button
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
        >
          <Plus size={16} />
          Add Ingredient
        </button>
      </PageHeader>

      {/* Stat Cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Total Inventory Value"
          value={can('view_costs') ? fmt$(stats.totalValue) : '—'}
          sub={`${rows.length} ingredients`}
        />
        {coPackers.map((cp) => (
          <StatCard
            key={cp.id}
            label={`At ${cp.short_code}`}
            value={can('view_costs') ? fmt$(stats.cpValues[cp.id] ?? 0) : '—'}
          />
        ))}
        <StatCard
          label="Below Reorder Point"
          value={stats.belowReorder}
          trend={stats.belowReorder > 0 ? `${stats.belowReorder} need reorder` : undefined}
          trendGood={stats.belowReorder === 0}
        />
      </div>

      {/* CP Filter */}
      <CPFilterBar selected={cpFilter} onSelect={setCpFilter} />

      {/* Tag Filter Bar */}
      {tags.length > 0 && (
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <Tag size={14} className="text-muted" />
          <button
            onClick={() => setTagFilter(null)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              tagFilter === null ? 'bg-accent text-white' : 'bg-surface text-muted hover:text-text'
            }`}
          >
            All
          </button>
          {tags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => setTagFilter(tagFilter === tag.id ? null : tag.id)}
              className="rounded-full px-3 py-1 text-xs font-medium transition-colors"
              style={{
                backgroundColor: tagFilter === tag.id ? tag.color : tag.color + '20',
                color: tagFilter === tag.id ? '#fff' : tag.color,
              }}
            >
              {tag.name}
            </button>
          ))}
          <button
            onClick={() => setManageTagsOpen(true)}
            className="rounded-full p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-text"
            title="Manage Tags"
          >
            <Settings size={13} />
          </button>
        </div>
      )}

      {/* Table */}
      <DataTable
        columns={columns}
        data={rows}
        highlightRow={(row) => row.status === 'CRITICAL'}
        highlightColor="#EF4444"
        onRowClick={openDetail}
        emptyMessage="No ingredients yet"
        emptyHint="Add your first ingredient to get started"
      />

      {/* Ingredient Detail / Cost History Modal */}
      <Modal
        isOpen={!!detailRow}
        onClose={() => setDetailRow(null)}
        title={detailRow?.name ?? 'Ingredient Detail'}
        wide
      >
        {detailRow && (() => {
          // Running weighted average calculation (oldest → newest)
          const sorted = [...costHistory].reverse()
          const runningAvgs: number[] = []
          let runTotalQty = 0
          let runTotalValue = 0
          for (const ch of sorted) {
            runTotalQty += ch.quantity
            runTotalValue += ch.quantity * ch.unit_cost
            runningAvgs.push(runTotalValue / runTotalQty)
          }
          runningAvgs.reverse()

          const lastPurchase = purchaseHistory.length > 0 ? purchaseHistory[0] : null

          // Live cost calculation from purchase history (more reliable than DB values that may be stale)
          const phTotalQty = purchaseHistory.reduce((s, h) => s + h.quantity, 0)
          const phTotalValue = purchaseHistory.reduce((s, h) => s + h.quantity * h.unitCost, 0)
          const liveAvgCost = phTotalQty > 0 ? phTotalValue / phTotalQty : detailRow.unit_cost
          const liveLastCost = lastPurchase ? lastPurchase.unitCost : detailRow.last_cost
          const displayAvgCost = purchaseHistory.length > 0 ? liveAvgCost : detailRow.unit_cost
          const totalValue = detailRow.totalOwned * displayAvgCost

          // Density-based equivalent costs
          const baseGroup = unitGroup(detailRow.unit)
          let densityCosts: { unit: string; cost: number }[] = []
          if (detailRow.density_g_per_ml != null) {
            const targets = baseGroup === 'weight' ? ['ml', 'gal'] : baseGroup === 'volume' ? ['g', 'lbs'] : []
            for (const t of targets) {
              try {
                const factor = getConversionFactorWithDensity(conversions, detailRow.unit, t, detailRow.density_g_per_ml)
                densityCosts.push({ unit: t, cost: detailRow.unit_cost / factor })
              } catch { /* skip if conversion fails */ }
            }
          }

          return (
            <div className="space-y-4">
              {/* Edit button */}
              <div className="flex justify-end -mt-2">
                <button
                  onClick={() => openEdit(detailRow)}
                  className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-accent"
                  title="Edit"
                >
                  <Pencil size={14} />
                </button>
              </div>

              {/* Cost summary */}
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg border border-border bg-surface p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] uppercase tracking-wider text-muted">Avg Cost (Weighted)</p>
                    {purchaseHistory.length > 0 && (
                      <button
                        onClick={() => recalcSingleIngredient(detailRow.id, detailRow.unit, detailRow.density_g_per_ml)}
                        className="flex items-center gap-1 text-[10px] text-muted hover:text-accent transition-colors"
                        title="Recalculate from purchase history"
                        disabled={saving}
                      >
                        <RefreshCw size={10} />
                        Recalc
                      </button>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-lg font-semibold text-text">{fmtRate(displayAvgCost)}<span className="text-xs text-muted">/{detailRow.unit}</span></p>
                </div>
                <div className="rounded-lg border border-border bg-surface p-3">
                  <p className="text-[10px] uppercase tracking-wider text-muted">Last Purchase Cost</p>
                  <p className="mt-1 font-mono text-lg font-semibold" style={{ color: liveLastCost != null && liveLastCost < displayAvgCost ? '#22C55E' : liveLastCost != null && liveLastCost > displayAvgCost ? '#EF4444' : 'var(--color-text)' }}>
                    {liveLastCost != null ? fmtRate(liveLastCost) : '—'}<span className="text-xs text-muted">/{detailRow.unit}</span>
                  </p>
                </div>
              </div>

              {/* How This Cost Is Calculated */}
              {!historyLoading && (
                <div className="rounded-lg bg-surface p-4 border-l-[3px] border-accent">
                  <p className="flex items-center gap-2 text-xs font-semibold text-text mb-3">
                    <span className="text-sm">&#8505;&#65039;</span>
                    How This Cost Is Calculated
                  </p>

                  {purchaseHistory.length > 0 ? (
                    <div className="space-y-3 text-xs text-muted">
                      <p>
                        This cost uses the <span className="font-medium text-text">Weighted Average</span> method:
                        each time a purchase order is received, the cost is recalculated by combining the value
                        of existing stock with the new purchase.
                      </p>

                      <div className="rounded bg-code-bg px-3 py-2 font-mono text-[11px] text-muted">
                        Avg Cost = (Existing Value + New Purchase Value) ÷ (Existing Qty + New Qty)
                      </div>

                      <div className="space-y-1">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-muted mb-1">Current Calculation</p>
                        <p>Total quantity owned: <span className="font-mono text-accent">{fmtNum(Math.round(detailRow.totalOwned))} {detailRow.unit}</span></p>
                        <p>Total value: <span className="font-mono text-accent">{fmt$(totalValue)}</span></p>
                        <p>Weighted average cost: <span className="font-mono text-accent">{fmtRate(displayAvgCost)}</span> per {detailRow.unit}</p>
                        {lastPurchase && (
                          <p>Last purchase price: <span className="font-mono text-accent">{fmtRate(lastPurchase.unitCost)}</span> per {detailRow.unit}{' '}
                            <span className="text-muted">({lastPurchase.poNumber}, {lastPurchase.date ? fmtDate(lastPurchase.date) : '—'})</span>
                          </p>
                        )}
                      </div>

                      <p className="text-[10px] text-muted/70 italic">Cost updates automatically when new POs are received.</p>
                    </div>
                  ) : (
                    <div className="space-y-2 text-xs text-muted">
                      <p>
                        This cost was <span className="font-medium text-text">manually entered</span>. It will automatically
                        update to a weighted average once purchase orders for this ingredient are received.
                      </p>
                      <p>
                        Current cost: <span className="font-mono text-accent">{fmtRate(detailRow.unit_cost)}</span> per {detailRow.unit} <span className="text-muted/70">(manually set)</span>
                      </p>
                      <p className="text-[10px] text-muted/70 italic">
                        To get accurate costs, create a Purchase Order for this ingredient and mark it as received.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Cost Used Across the App */}
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Cost Used Across the App</p>
                <div className="space-y-1.5 text-xs text-muted">
                  <p>
                    <span className="text-text font-medium">Recipe COGS:</span>{' '}
                    <span className="font-mono text-text">{fmtRate(detailRow.unit_cost)}/{detailRow.unit}</span>{' '}
                    — used to calculate recipe ingredient costs
                  </p>
                  <p>
                    <span className="text-text font-medium">Inventory Value:</span>{' '}
                    <span className="font-mono text-text">{fmtNum(Math.round(detailRow.totalOwned))} {detailRow.unit} × {fmtRate(detailRow.unit_cost)} = {fmt$(totalValue)}</span>
                  </p>
                  <p>
                    <span className="text-text font-medium">Reconciliation:</span>{' '}
                    waste cost calculated using this price
                  </p>
                  {detailRow.density_g_per_ml != null && (
                    <>
                      <p className="mt-2">
                        <span className="text-text font-medium">Density:</span>{' '}
                        <span className="font-mono text-text">{detailRow.density_g_per_ml} g/ml</span>
                      </p>
                      {densityCosts.length > 0 && (
                        <p>
                          <span className="text-text font-medium">Equivalent cost:</span>{' '}
                          {densityCosts.map((dc, i) => (
                            <span key={dc.unit}>
                              {i > 0 && ', '}
                              <span className="font-mono text-text">{fmtRate(dc.cost)}/{dc.unit}</span>
                            </span>
                          ))}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Purchase History table */}
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Purchase History</p>
                {historyLoading ? (
                  <p className="text-sm text-muted">Loading...</p>
                ) : purchaseHistory.length === 0 ? (
                  <p className="text-xs text-muted">
                    No purchase history yet — costs will appear when POs are received.
                  </p>
                ) : (
                  <>
                    <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border bg-surface/50 text-left">
                            <th className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted font-medium">Date</th>
                            <th className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted font-medium">PO #</th>
                            <th className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted font-medium">Supplier</th>
                            <th className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted font-medium text-right">Qty</th>
                            <th className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted font-medium text-right">Unit Cost</th>
                            <th className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted font-medium text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {purchaseHistory.map((h) => (
                            <tr key={h.id} className="border-b border-border last:border-0">
                              <td className="px-3 py-2 text-muted">{h.date ? fmtDate(h.date) : '—'}</td>
                              <td className="px-3 py-2 font-mono text-accent">{h.poNumber}</td>
                              <td className="px-3 py-2 text-text">{h.supplier}</td>
                              <td className="px-3 py-2 text-right font-mono text-text">{fmtNum(h.quantity)} {detailRow.unit}</td>
                              <td className="px-3 py-2 text-right font-mono text-text">{fmtRate(h.unitCost)}/{detailRow.unit}</td>
                              <td className="px-3 py-2 text-right font-mono text-text">{fmt$(h.quantity * h.unitCost)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {/* Summary */}
                    {(() => {
                      const totalQty = purchaseHistory.reduce((s, h) => s + h.quantity, 0)
                      const totalSpent = purchaseHistory.reduce((s, h) => s + h.quantity * h.unitCost, 0)
                      return (
                        <div className="mt-2 flex items-center gap-4 text-xs text-muted">
                          <span>Total purchased: <span className="font-mono text-text">{fmtNum(Math.round(totalQty))} {detailRow.unit}</span> across {purchaseHistory.length} PO{purchaseHistory.length !== 1 ? 's' : ''}</span>
                          <span>Total spent: <span className="font-mono text-text">{fmt$(totalSpent)}</span></span>
                        </div>
                      )
                    })()}
                  </>
                )}
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* Add Ingredient Modal */}
      <Modal isOpen={modalOpen} onClose={() => { setModalOpen(false); setAddUnit('lbs'); setAddCategory(''); setAddDensityWarning(''); setAddTagIds([]) }} title="Add Ingredient">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Name</span>
              <input
                name="name"
                required
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent"
                placeholder="e.g. Almond Flour (Fine)"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Category</span>
              <select
                name="category"
                value={addCategory}
                onChange={(e) => setAddCategory(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              >
                <option value="">Select…</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Unit</span>
              <select
                name="unit"
                value={addUnit}
                onChange={(e) => setAddUnit(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              >
                {UNIT_OPTIONS.map((u) => (
                  <option key={u.value} value={u.value}>{u.label}</option>
                ))}
              </select>
            </label>
          </div>
          {/* Tags */}
          {tags.length > 0 && (
            <div>
              <span className="mb-1.5 block text-xs text-muted">Tags</span>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => {
                  const selected = addTagIds.includes(tag.id)
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => setAddTagIds(selected ? addTagIds.filter((id) => id !== tag.id) : [...addTagIds, tag.id])}
                      className="rounded-full px-2.5 py-1 text-[11px] font-medium transition-all"
                      style={{
                        backgroundColor: selected ? tag.color : tag.color + '15',
                        color: selected ? '#fff' : tag.color,
                        border: `1px solid ${selected ? tag.color : tag.color + '40'}`,
                      }}
                    >
                      {tag.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {(VOLUME_UNIT_SET.has(addUnit) || addCategory === 'Flavoring') && (
            <label className="block">
              <span className="mb-1 flex items-center gap-1 text-xs text-muted">
                Density (g/ml)
                <Tooltip maxWidth={320} content={
                  <>
                    <span className="block font-semibold text-text">Common densities:</span>
                    <span className="block">Water: 1.00</span>
                    <span className="block">Vanilla Extract: 1.03</span>
                    <span className="block">Almond Extract: 1.04</span>
                    <span className="block">Cream Cheese Extract: 1.05</span>
                    <span className="block">Lemon Extract: 0.98</span>
                    <span className="block">Oils (MCT, coconut): 0.92-0.95</span>
                    <span className="mt-1 block text-text">If unsure, use 1.0</span>
                  </>
                }>
                  <span className="cursor-help">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
                    </svg>
                  </span>
                </Tooltip>
              </span>
              <input
                name="density_g_per_ml"
                type="number"
                step="0.01"
                min="0.01"
                placeholder="e.g. 1.03"
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (e.target.value && (v < 0.5 || v > 2.0)) {
                    setAddDensityWarning('Unusual density value. Typical range is 0.5-2.0 g/ml')
                  } else {
                    setAddDensityWarning('')
                  }
                }}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
              {addDensityWarning && (
                <p className="mt-1 text-xs text-amber-500">{addDensityWarning}</p>
              )}
              <p className="mt-1 text-[11px] text-muted">Required for converting between weight and volume units.</p>
            </label>
          )}
          <div className="grid grid-cols-3 gap-4">
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Cost per {UNIT_SINGULAR[addUnit] ?? addUnit}</span>
              <input
                name="unit_cost"
                type="number"
                step="any"
                required
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Reorder point ({addUnit})</span>
              <input
                name="reorder_point"
                type="number"
                step="any"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Shelf Life (days)</span>
              <input
                name="shelf_life_days"
                type="number"
                step="1"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </label>
          </div>
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => { setModalOpen(false); setAddUnit('lbs'); setAddCategory(''); setAddDensityWarning(''); setAddTagIds([]) }}
              className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Add Ingredient'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Ingredient Modal */}
      <Modal isOpen={!!editIngredient} onClose={() => setEditIngredient(null)} title={`Edit ${editIngredient?.name ?? 'Ingredient'}`}>
        {editIngredient && (
          <div className="space-y-4">
            <div>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Name</span>
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  required
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Category</span>
                <select
                  value={editForm.category}
                  onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                >
                  <option value="">Select…</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Unit</span>
                <select
                  value={editForm.unit}
                  onChange={(e) => {
                    const newUnit = e.target.value
                    const oldGroup = unitGroup(editForm.unit)
                    const newGroup = unitGroup(newUnit)
                    if (oldGroup !== 'unknown' && newGroup !== 'unknown' && oldGroup !== newGroup) {
                      setUnitChangeWarning(`Changing from ${oldGroup} to ${newGroup}. Make sure all recipes using this ingredient are updated too.`)
                    } else {
                      setUnitChangeWarning('')
                    }
                    setEditForm({ ...editForm, unit: newUnit })
                  }}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                >
                  {UNIT_OPTIONS.map((u) => (
                    <option key={u.value} value={u.value}>{u.label}</option>
                  ))}
                </select>
                {unitChangeWarning && (
                  <p className="mt-1 text-xs text-amber-500">{unitChangeWarning}</p>
                )}
              </label>
            </div>
            {/* Tags */}
            {tags.length > 0 && (
              <div>
                <span className="mb-1.5 block text-xs text-muted">Tags</span>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => {
                    const selected = editTagIds.includes(tag.id)
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() => setEditTagIds(selected ? editTagIds.filter((id) => id !== tag.id) : [...editTagIds, tag.id])}
                        className="rounded-full px-2.5 py-1 text-[11px] font-medium transition-all"
                        style={{
                          backgroundColor: selected ? tag.color : tag.color + '15',
                          color: selected ? '#fff' : tag.color,
                          border: `1px solid ${selected ? tag.color : tag.color + '40'}`,
                        }}
                      >
                        {tag.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {(VOLUME_UNIT_SET.has(editForm.unit) || editForm.category === 'Flavoring') && (
              <label className="block">
                <span className="mb-1 flex items-center gap-1 text-xs text-muted">
                  Density (g/ml)
                  <Tooltip maxWidth={320} content={
                    <>
                      <span className="block font-semibold text-text">Common densities:</span>
                      <span className="block">Water: 1.00</span>
                      <span className="block">Vanilla Extract: 1.03</span>
                      <span className="block">Almond Extract: 1.04</span>
                      <span className="block">Cream Cheese Extract: 1.05</span>
                      <span className="block">Lemon Extract: 0.98</span>
                      <span className="block">Oils (MCT, coconut): 0.92-0.95</span>
                      <span className="mt-1 block text-text">If unsure, use 1.0</span>
                    </>
                  }>
                    <span className="cursor-help">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
                      </svg>
                    </span>
                  </Tooltip>
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={editForm.density_g_per_ml}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (e.target.value && (v < 0.5 || v > 2.0)) {
                      setEditDensityWarning('Unusual density value. Typical range is 0.5-2.0 g/ml')
                    } else {
                      setEditDensityWarning('')
                    }
                    setEditForm({ ...editForm, density_g_per_ml: e.target.value })
                  }}
                  placeholder="e.g. 1.03"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
                {editDensityWarning && (
                  <p className="mt-1 text-xs text-amber-500">{editDensityWarning}</p>
                )}
                <p className="mt-1 text-[11px] text-muted">Required for converting between weight and volume units.</p>
              </label>
            )}
            <div className="grid grid-cols-3 gap-4">
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Cost per {UNIT_SINGULAR[editForm.unit] ?? editForm.unit}</span>
                <input
                  type="number"
                  step="any"
                  value={editForm.unit_cost}
                  onChange={(e) => setEditForm({ ...editForm, unit_cost: e.target.value })}
                  required
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Reorder point ({editForm.unit})</span>
                <input
                  type="number"
                  step="any"
                  value={editForm.reorder_point}
                  onChange={(e) => setEditForm({ ...editForm, reorder_point: e.target.value })}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Shelf Life (days)</span>
                <input
                  type="number"
                  step="1"
                  value={editForm.shelf_life_days}
                  onChange={(e) => setEditForm({ ...editForm, shelf_life_days: e.target.value })}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Notes</span>
              <textarea
                value={editForm.notes}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                rows={2}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent resize-none"
              />
            </label>
            <div className="flex items-center justify-between border-t border-border pt-4">
              {can('delete_any') && (
              <button
                type="button"
                onClick={() => { setPendingDeleteIngredient(editIngredient); setConfirmDeleteOpen(true) }}
                className="rounded-lg px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-400/10"
              >
                <span className="flex items-center gap-1.5"><Trash2 size={14} /> Delete</span>
              </button>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setEditIngredient(null)}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={saving || !editForm.name.trim() || !editForm.unit_cost}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Confirm Delete Ingredient */}
      <ConfirmDialog
        isOpen={confirmDeleteOpen}
        title={`Delete ${pendingDeleteIngredient?.name ?? 'ingredient'}?`}
        message="This will permanently delete this ingredient. Recipes and inventory using it may be affected."
        confirmLabel="Delete Ingredient"
        danger
        onConfirm={handleDeleteIngredient}
        onCancel={() => { setConfirmDeleteOpen(false); setPendingDeleteIngredient(null) }}
      />

      {/* Manage Tags Modal */}
      <Modal isOpen={manageTagsOpen} onClose={() => { setManageTagsOpen(false); setEditingTagId(null); setNewTagName(''); setNewTagColor('#3B82F6') }} title="Manage Tags">
        <div className="space-y-4">
          {/* Existing tags */}
          <div className="space-y-2">
            {tags.map((tag) => {
              const linkCount = tagLinks.filter((l) => l.tag_id === tag.id).length
              const isEditing = editingTagId === tag.id
              return (
                <div key={tag.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                  {isEditing ? (
                    <>
                      <input
                        type="color"
                        value={editTagColor}
                        onChange={(e) => setEditTagColor(e.target.value)}
                        className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                      />
                      <input
                        value={editTagName}
                        onChange={(e) => setEditTagName(e.target.value)}
                        className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-text outline-none focus:border-accent"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleUpdateTag(tag.id)
                          }
                        }}
                      />
                      <button
                        onClick={() => handleUpdateTag(tag.id)}
                        className="rounded px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingTagId(null)}
                        className="rounded px-2 py-1 text-xs text-muted hover:text-text"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span
                        className="inline-block h-3 w-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="flex-1 text-sm text-text">{tag.name}</span>
                      <span className="text-[11px] text-muted">{linkCount} ingredient{linkCount !== 1 ? 's' : ''}</span>
                      <button
                        onClick={() => { setEditingTagId(tag.id); setEditTagName(tag.name); setEditTagColor(tag.color) }}
                        className="rounded p-1 text-muted transition-colors hover:text-text"
                      >
                        <Pencil size={12} />
                      </button>
                      {can('delete_any') && (
                      <button
                        onClick={() => handleDeleteTag(tag.id)}
                        className="rounded p-1 text-muted transition-colors hover:text-red-400"
                      >
                        <X size={12} />
                      </button>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>

          {/* Add new tag */}
          <div className="flex items-center gap-2 border-t border-border pt-3">
            <input
              type="color"
              value={newTagColor}
              onChange={(e) => setNewTagColor(e.target.value)}
              className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
            />
            <input
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder="New tag name…"
              className="flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleCreateTag()
                }
              }}
            />
            <button
              onClick={handleCreateTag}
              disabled={!newTagName.trim()}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
