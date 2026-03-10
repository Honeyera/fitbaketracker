import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { sanitize } from '../lib/sanitizePayload'
import { dbInsert, dbInsertSingle, dbUpdate, dbDelete, dbDeleteIn } from '../lib/dbWrite'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { format } from 'date-fns'
import { fmt$, fmtRate, fmtDate } from '../lib/format'
import { downloadCSV } from '../lib/csv'
import PageHeader from '../components/PageHeader'
import CPFilterBar from '../components/CPFilterBar'
import DataTable, { type Column } from '../components/DataTable'
import CPBadge from '../components/CPBadge'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import ConfirmDialog from '../components/ConfirmDialog'
import MRPPanel from '../components/MRPPanel'
import MRPCreatePOModal from '../components/MRPCreatePOModal'
import ProcurementTable, { type ProcurementSelection } from '../components/ProcurementTable'
import StatusDropdown, { type StatusOption } from '../components/StatusDropdown'
import { PageSkeleton } from '../components/Skeleton'
import RecipeIcon from '../components/RecipeIcon'
import { useToast } from '../components/Toast'
import { useAuth } from '../contexts/AuthContext'
import { logActivity } from '../lib/activityLog'
import { Plus, Trash2, Download, ChevronDown, ChevronRight, FileDown, Printer, Pencil } from 'lucide-react'
import { buildMRPRows, buildMRPSummary, nextRunNumber as calcNextRunNumber, type MRPRow } from '../lib/mrp'
import { syncIngredientStatus } from '../lib/syncIngredientStatus'
import { syncAfterPOStatusChange } from '../lib/poStatusChange'
import { buildProcurementRows, buildProcurementSummary, procurementDots, type ProcurementRow } from '../lib/procurement'
import { generateProductionOrderPDF, type ProductionOrderPDFData } from '../lib/generateProductionOrderPDF'
import { generatePO_PDF, type POPDFData } from '../lib/generatePO_PDF'
import InvoicePaymentSection, { getOrderPaymentSummary } from '../components/InvoicePaymentSection'
import OrderPaymentPopover, { buildLinkedPOs, buildCPInvoiceSummaries, getOrderPOPaymentSummary } from '../components/OrderPaymentPopover'
import type {
  ProductionRun,
  ProductionOrder,
  ProductionOrderInsert,
  CoPacker,
  CoPackerContact,
  Recipe,
  RecipeIngredient,
  Ingredient,
  IngredientInventory,
  ProductionRunInsert,
  PurchaseOrder,
  PurchaseOrderItem,
  SupplierIngredient,
  SupplierContact,
  Supplier,
  ShipmentToCopacker,
  ShipmentItem,
  ProductionRunInvoice,
  ProductionRunPayment,
} from '../types/database'
import { loadConversions, type ConversionMap } from '../lib/conversions'
import { calculateRecipeCOGS } from '../lib/recipeCosting'

/* ── Row type for All Runs tab ─────────────────────────────── */

interface RunRow extends Record<string, unknown> {
  id: string
  run_number: string
  co_packer_id: string | null
  recipe_id: string | null
  recipeName: string
  requested_quantity: number
  produced_quantity: number | null
  waste_pct: number | null
  status: string
  requested_date: string | null
  priority: string | null
  production_order_id: string | null
  orderNumber: string | null
}

/* ── Status config ─────────────────────────────────────────── */

type BadgeColor = 'gray' | 'accent' | 'amber' | 'purple' | 'green' | 'red' | 'cyan'

const RUN_STATUS_BADGE: Record<string, BadgeColor> = {
  requested: 'gray',
  scheduled: 'accent',
  in_production: 'amber',
  complete: 'purple',
  reconciled: 'green',
  flagged: 'red',
}

const RUN_STATUS_LABEL: Record<string, string> = {
  requested: 'REQUESTED',
  scheduled: 'SCHEDULED',
  in_production: 'IN PRODUCTION',
  complete: 'COMPLETE',
  reconciled: 'RECONCILED',
  flagged: 'FLAGGED',
}

const MANUAL_STATUSES = ['requested', 'scheduled', 'in_production', 'complete', 'flagged'] as const

const STATUS_DOT_COLOR: Record<string, string> = {
  requested: '#7A8599',
  scheduled: '#3B82F6',
  in_production: '#F59E0B',
  complete: '#A78BFA',
  flagged: '#EF4444',
}

const ORDER_STATUS_BADGE: Record<string, BadgeColor> = {
  draft: 'gray',
  sent_to_cp: 'accent',
  confirmed_by_cp: 'purple',
  in_production: 'amber',
  completed: 'green',
  shipped: 'cyan',
  on_hold: 'red',
  cancelled: 'red',
}

const ORDER_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  sent_to_cp: 'Sent to CP',
  confirmed_by_cp: 'Confirmed by CP',
  in_production: 'In Production',
  completed: 'Completed',
  shipped: 'Shipped',
  on_hold: 'On Hold',
  cancelled: 'Cancelled',
  // Legacy compat
  sent: 'Sent',
  complete: 'Complete',
}

const ORDER_MANUAL_STATUSES = ['draft', 'sent_to_cp', 'confirmed_by_cp', 'in_production', 'completed', 'shipped', 'on_hold', 'cancelled'] as const

/** Which statuses can transition TO which other statuses (order level) */
const ORDER_TRANSITIONS: Record<string, string[]> = {
  draft: ['sent_to_cp', 'cancelled'],
  sent_to_cp: ['confirmed_by_cp', 'on_hold', 'cancelled'],
  confirmed_by_cp: ['in_production', 'on_hold', 'cancelled'],
  in_production: ['completed', 'on_hold', 'cancelled'],
  completed: ['shipped'],
  shipped: [],
  on_hold: ['sent_to_cp', 'confirmed_by_cp', 'in_production', 'cancelled'],
  cancelled: ['draft'],
  // Legacy compat
  sent: ['in_production', 'cancelled'],
  complete: [],
}

/** Transitions that require a confirmation dialog (order level) */
const ORDER_CONFIRM_MESSAGES: Record<string, { title: string; message: string; danger: boolean }> = {
  in_production: { title: 'Start Production?', message: 'Also update pending/scheduled runs to In Production?', danger: false },
  completed: { title: 'Mark as Completed?', message: 'Make sure all production runs are finished.', danger: false },
  on_hold: { title: 'Put On Hold?', message: 'This will pause the production order.', danger: false },
  cancelled: { title: 'Cancel this order?', message: 'This will cancel the order and flag linked runs.', danger: true },
}

/** Which statuses can transition for runs */
const RUN_TRANSITIONS: Record<string, string[]> = {
  requested: ['scheduled', 'in_production'],
  scheduled: ['in_production', 'requested'],
  in_production: ['complete', 'flagged'],
  complete: [],
  reconciled: [],
  flagged: ['in_production'],
}

const ORDER_STATUS_DOT: Record<string, string> = {
  draft: '#6B7280',
  sent_to_cp: '#3B82F6',
  confirmed_by_cp: '#8B5CF6',
  in_production: '#F59E0B',
  completed: '#10B981',
  shipped: '#06B6D4',
  on_hold: '#EF4444',
  cancelled: '#991B1B',
  // Legacy compat
  sent: '#3B82F6',
  complete: '#22C55E',
}

/* ── Procurement badge/row configs (now in ProcurementTable) ── */
/* ── Flavor line for Create Order modal ────────────────────── */

interface FlavorLine {
  recipeId: string
  quantity: string
}

interface EditOrderRun {
  id: string | null
  run_number: string
  recipe_id: string
  requested_quantity: string
  produced_quantity: string
  status: string
  _deleted?: boolean
}

/* ================================================================ */

export default function ProductionRuns() {
  const toast = useToast()
  const { can, appUser } = useAuth()

  /* ── Tab state ──────────────────────────────────────────────── */
  const [tab, setTab] = useState<'orders' | 'runs'>('orders')

  /* ── Data state ─────────────────────────────────────────────── */
  const [runs, setRuns] = useState<ProductionRun[]>([])
  const [orders, setOrders] = useState<ProductionOrder[]>([])
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [cpContacts, setCpContacts] = useState<CoPackerContact[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [recipeIngredients, setRecipeIngredients] = useState<RecipeIngredient[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [inventory, setInventory] = useState<IngredientInventory[]>([])
  const [cpFilter, setCpFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [conversions, setConversions] = useState<ConversionMap>(new Map())
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [poItems, setPOItems] = useState<PurchaseOrderItem[]>([])
  const [supplierIngredients, setSupplierIngredients] = useState<SupplierIngredient[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierContacts, setSupplierContacts] = useState<SupplierContact[]>([])
  const [shipments, setShipments] = useState<ShipmentToCopacker[]>([])
  const [shipmentItems, setShipmentItems] = useState<ShipmentItem[]>([])
  const [cpInvoices, setCpInvoices] = useState<ProductionRunInvoice[]>([])
  const [cpPayments, setCpPayments] = useState<ProductionRunPayment[]>([])

  /* ── UI state ───────────────────────────────────────────────── */
  const [saving, setSaving] = useState(false)

  /* ── Create single run modal ────────────────────────────────── */
  const [runModalOpen, setRunModalOpen] = useState(false)
  const [runStep, setRunStep] = useState(1)
  const [fCP, setFCP] = useState('')
  const [fRecipe, setFRecipe] = useState('')
  const [fQty, setFQty] = useState('')
  const [fDate, setFDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [fPriority, setFPriority] = useState('normal')

  /* ── Complete run modal ─────────────────────────────────────── */
  const [completeRunId, setCompleteRunId] = useState<string | null>(null)
  const [producedQty, setProducedQty] = useState('')

  /* ── Edit run modal ─────────────────────────────────────────── */
  const [editRun, setEditRun] = useState<ProductionRun | null>(null)
  const [eReqQty, setEReqQty] = useState('')
  const [eReqDate, setEReqDate] = useState('')
  const [ePriority, setEPriority] = useState('normal')
  const [eYourNotes, setEYourNotes] = useState('')
  const [eProducedQty, setEProducedQty] = useState('')
  const [eCpNotes, setECpNotes] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  /* ── MRP action modals ──────────────────────────────────────── */
  const [mrpPOOpen, setMRPPOOpen] = useState(false)
  const [mrpContext, setMRPContext] = useState<{ rows: ReturnType<typeof buildMRPRows>; cpId: string; cpName: string; orderId: string | null } | null>(null)

  /* ── Create production order modal ──────────────────────────── */
  const [orderModalOpen, setOrderModalOpen] = useState(false)
  const [orderStep, setOrderStep] = useState(1)
  const [oCP, setOCP] = useState('')
  const [oDate, setODate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [oStartDate, setOStartDate] = useState('')
  const [oPriority, setOPriority] = useState('normal')
  const [oNotes, setONotes] = useState('')
  const [oFlavors, setOFlavors] = useState<FlavorLine[]>([{ recipeId: '', quantity: '' }])

  /* ── Expanded order cards ───────────────────────────────────── */
  const [expandedOrders, setExpandedOrders] = useState<Set<string>>(new Set())

  /* ── Order status confirmation ────────────────────────────── */
  const [orderStatusConfirm, setOrderStatusConfirm] = useState<{
    orderId: string; newStatus: string; cascade: boolean
  } | null>(null)

  /* ── Complete order modal (enter produced qty per run) ───────── */
  const [completeOrderId, setCompleteOrderId] = useState<string | null>(null)
  const [completeOrderQtys, setCompleteOrderQtys] = useState<Record<string, string>>({})

  /* ── Edit production order modal ─────────────────────────────── */
  const [editOrder, setEditOrder] = useState<ProductionOrder | null>(null)
  const [editOrderForm, setEditOrderForm] = useState({
    co_packer_id: '',
    status: 'draft',
    order_date: '',
    requested_start_date: '',
    estimated_completion_date: '',
    priority: 'normal',
    notes: '',
  })
  const [editOrderRuns, setEditOrderRuns] = useState<EditOrderRun[]>([])
  const [confirmDeleteOrder, setConfirmDeleteOrder] = useState(false)
  const [confirmRemoveRunIdx, setConfirmRemoveRunIdx] = useState<number | null>(null)
  const [cpChangeWarning, setCPChangeWarning] = useState(false)
  const [pendingCP, setPendingCP] = useState('')

  /* ── Data loading ───────────────────────────────────────────── */

  async function load() {
    // Phase 1: Core data — unblocks the page skeleton quickly
    try {
      const [runRes, orderRes, cpRes, cpCtRes, recRes, riRes, ingRes, convMap] = await safeBatch(() => Promise.all([
        supabase.from('production_runs').select('*').order('requested_date', { ascending: false }),
        supabase.from('production_orders').select('*').order('created_at', { ascending: false }),
        supabase.from('co_packers').select('*').order('name'),
        supabase.from('co_packer_contacts').select('*'),
        supabase.from('recipes').select('*').order('name'),
        supabase.from('recipe_ingredients').select('*'),
        supabase.from('ingredients').select('*').order('name'),
        loadConversions(),
      ]))
      setRuns(runRes.data ?? [])
      setOrders(orderRes.data ?? [])
      setCoPackers(cpRes.data ?? [])
      setCpContacts(cpCtRes.data ?? [])
      setRecipes(recRes.data ?? [])
      setRecipeIngredients(riRes.data ?? [])
      setIngredients(ingRes.data ?? [])
      setConversions(convMap)
    } catch (err) {
      console.error('Failed to load production orders (core):', err)
    } finally {
      setLoading(false)
    }

    // Phase 2: Supplementary data (procurement, suppliers, shipments)
    // Loads after the page is visible — populates procurement dots & tables
    try {
      const [invRes, poRes, poiRes, siRes, supRes, scRes, shipRes, shipItemRes] = await safeBatch(() => Promise.all([
        supabase.from('ingredient_inventory').select('*'),
        supabase.from('purchase_orders').select('*'),
        supabase.from('purchase_order_items').select('*'),
        supabase.from('supplier_ingredients').select('*'),
        supabase.from('suppliers').select('*').order('name'),
        supabase.from('supplier_contacts').select('*'),
        supabase.from('shipments_to_copacker').select('*'),
        supabase.from('shipment_items').select('*'),
      ]))
      setInventory(invRes.data ?? [])
      setPurchaseOrders(poRes.data ?? [])
      setPOItems(poiRes.data ?? [])
      setSupplierIngredients(siRes.data ?? [])
      setSuppliers(supRes.data ?? [])
      setSupplierContacts(scRes.data ?? [])
      setShipments(shipRes.data ?? [])
      setShipmentItems(shipItemRes.data ?? [])
    } catch (err) {
      console.error('Failed to load supplementary data:', err)
    }

    // Phase 3: Invoice & payment data (isolated so failures don't break procurement)
    try {
      const [cpInvRes, cpPayRes] = await safeBatch(() => Promise.all([
        supabase.from('production_run_invoices').select('*'),
        supabase.from('production_run_payments').select('*'),
      ]))
      setCpInvoices(cpInvRes.data ?? [])
      setCpPayments(cpPayRes.data ?? [])
    } catch (err) {
      console.error('Failed to load invoice data:', err)
    }
  }

  useEffect(() => safeLoad(load, setLoading), [])

  /* ════════════════════════════════════════════════════════════
   *  ALL RUNS TAB — logic
   * ════════════════════════════════════════════════════════════ */

  const runRows: RunRow[] = useMemo(() => {
    let filtered = runs
    if (cpFilter !== 'all') filtered = filtered.filter((r) => r.co_packer_id === cpFilter)
    return filtered.map((r) => {
      const recipe = recipes.find((rec) => rec.id === r.recipe_id)
      const order = orders.find((o) => o.id === r.production_order_id)
      return {
        id: r.id,
        run_number: r.run_number,
        co_packer_id: r.co_packer_id,
        recipe_id: r.recipe_id,
        recipeName: recipe ? `${recipe.name} (${recipe.sku})` : '—',
        requested_quantity: r.requested_quantity,
        produced_quantity: r.produced_quantity,
        waste_pct: r.waste_pct,
        status: r.status ?? 'requested',
        requested_date: r.requested_date,
        priority: r.priority,
        production_order_id: r.production_order_id,
        orderNumber: order?.order_number ?? null,
      }
    })
  }, [runs, recipes, cpFilter, orders])

  /* ── Run columns ────────────────────────────────────────────── */

  const runColumns: Column<RunRow>[] = useMemo(
    () => [
      {
        label: 'Run ID',
        key: 'run_number',
        width: '100px',
        render: (row) => <span className="font-mono font-medium text-accent">{row.run_number}</span>,
      },
      {
        label: 'Order',
        key: 'orderNumber',
        width: '100px',
        render: (row) =>
          row.orderNumber ? (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[13px] font-medium text-accent">
              {row.orderNumber}
            </span>
          ) : (
            <span className="text-[13px] text-muted">—</span>
          ),
      },
      {
        label: 'CP',
        key: 'co_packer_id',
        width: '90px',
        render: (row) => row.co_packer_id ? <CPBadge coPackerId={row.co_packer_id as string} /> : '—',
      },
      {
        label: 'SKU',
        key: 'recipeName',
        width: '240px',
        render: (row) => {
          const recipe = recipes.find((r) => r.id === row.recipe_id)
          const cp = coPackers.find((c) => c.id === row.co_packer_id)
          return (
            <div className="flex items-center gap-2">
              <RecipeIcon imageUrl={recipe?.image_url} recipeName={recipe?.name ?? '—'} coPackerColor={cp?.color} size="sm" />
              <span className="text-text">{row.recipeName}</span>
            </div>
          )
        },
      },
      {
        label: 'Requested',
        key: 'requested_quantity',
        align: 'right',
        width: '100px',
        render: (row) => <span className="font-mono text-text">{(row.requested_quantity as number).toLocaleString()}</span>,
      },
      {
        label: 'Produced',
        key: 'produced_quantity',
        align: 'right',
        width: '100px',
        render: (row) => (
          <span className="font-mono text-text">
            {row.produced_quantity != null ? (row.produced_quantity as number).toLocaleString() : '—'}
          </span>
        ),
      },
      {
        label: 'Waste %',
        key: 'waste_pct',
        align: 'right',
        width: '80px',
        render: (row) => {
          const w = row.waste_pct as number | null
          if (w == null) return <span className="text-muted">—</span>
          const color = w <= 2.5 ? '#22C55E' : w <= 3.0 ? '#F59E0B' : '#EF4444'
          return <span className="font-mono font-medium" style={{ color }}>{w.toFixed(1)}%</span>
        },
      },
      {
        label: 'Status',
        key: 'status',
        align: 'center',
        width: '150px',
        render: (row) => {
          const s = row.status as string
          const transitions = RUN_TRANSITIONS[s] ?? []
          if (transitions.length === 0) {
            return <Badge color={RUN_STATUS_BADGE[s] ?? 'gray'}>{RUN_STATUS_LABEL[s] ?? s.toUpperCase()}</Badge>
          }
          const opts: StatusOption[] = transitions.map((st) => ({
            value: st,
            label: RUN_STATUS_LABEL[st] ?? st,
            dotColor: STATUS_DOT_COLOR[st] ?? '#7A8599',
          }))
          return (
            <div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
              <StatusDropdown
                trigger={<Badge color={RUN_STATUS_BADGE[s] ?? 'gray'}>{RUN_STATUS_LABEL[s] ?? s.toUpperCase()} ▾</Badge>}
                options={opts}
                onSelect={(st) => handleRunStatusChange(row.id as string, s, st)}
                align="right"
              />
            </div>
          )
        },
      },
      {
        label: 'Date',
        key: 'requested_date',
        width: '100px',
        render: (row) => <span className="text-[13px] text-muted">{row.requested_date ? fmtDate(row.requested_date as string) : '—'}</span>,
      },
    ],
    [recipes, coPackers],
  )

  /* ── Run status change ──────────────────────────────────────── */

  async function handleRunStatusChange(runId: string, currentStatus: string, newStatus: string) {

    if (newStatus === 'complete') {
      const run = runs.find((r) => r.id === runId)
      if (run && run.produced_quantity == null) {
        setCompleteRunId(runId)
        setProducedQty('')
        return
      }
    }

    setSaving(true)
    try {
      const run = runs.find((r) => r.id === runId)
      const updates: Record<string, unknown> = { status: newStatus }
      if (newStatus === 'in_production' && currentStatus !== 'in_production') {
        if (!run?.started_date) updates.started_date = format(new Date(), 'yyyy-MM-dd')
      }
      if (currentStatus === 'complete' && newStatus !== 'complete') {
        updates.produced_quantity = null
        updates.completed_date = null
        updates.waste_pct = null
      }

      const { error } = await dbUpdate('production_runs', sanitize('production_runs', updates), 'id', runId)
      if (error) { toast.error(error.message); return }

      // Auto-promote order to in_production if a run moves there
      if (newStatus === 'in_production' && run?.production_order_id) {
        const order = orders.find((o) => o.id === run.production_order_id)
        if (order && (order.status === 'draft' || order.status === 'sent' || order.status === 'sent_to_cp' || order.status === 'confirmed_by_cp')) {
          await dbUpdate('production_orders', sanitize('production_orders', {
            status: 'in_production',
            updated_at: new Date().toISOString(),
          }), 'id', order.id)
          toast.info(`Order ${order.order_number} auto-updated to In Production`)
        }
      }

      // Prompt to complete order if all runs now complete
      if (newStatus === 'complete' && run?.production_order_id) {
        const order = orders.find((o) => o.id === run.production_order_id)
        if (order && order.status === 'in_production') {
          const siblings = runs.filter((r) => r.production_order_id === run.production_order_id && r.id !== runId)
          const allDone = siblings.every((r) => r.status === 'complete' || r.status === 'reconciled')
          if (allDone) {
            toast.info(`All runs complete — you can now mark ${order.order_number} as Completed`)
          }
        }
      }

      toast.success(`Run status updated to ${RUN_STATUS_LABEL[newStatus] ?? newStatus}`)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update run status')
    } finally {
      setSaving(false)
    }
  }

  async function handleComplete(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!completeRunId) return
    setSaving(true)
    try {
      const produced = Number(producedQty)
      const run = runs.find((r) => r.id === completeRunId)
      const wastePct = run ? ((run.requested_quantity - produced) / run.requested_quantity) * 100 : null
      const { error } = await dbUpdate('production_runs', sanitize('production_runs', {
        status: 'complete',
        produced_quantity: produced,
        completed_date: format(new Date(), 'yyyy-MM-dd'),
        waste_pct: wastePct != null && wastePct >= 0 ? Math.round(wastePct * 10) / 10 : null,
      }), 'id', completeRunId)
      setCompleteRunId(null)
      if (error) toast.error(error.message)
      else {
        toast.success('Run marked as complete')
        logActivity(appUser?.id, 'update_production_run', 'production_run', completeRunId)
      }
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to complete run')
    } finally {
      setSaving(false)
    }
  }

  /* ── Open / save / delete run edit modal ─────────────────────── */

  function openEdit(row: RunRow) {
    const run = runs.find((r) => r.id === row.id)
    if (!run) return
    setEditRun(run)
    setEReqQty(String(run.requested_quantity))
    setEReqDate(run.requested_date ?? '')
    setEPriority(run.priority ?? 'normal')
    setEYourNotes(run.your_notes ?? '')
    setEProducedQty(run.produced_quantity != null ? String(run.produced_quantity) : '')
    setECpNotes(run.cp_notes ?? '')
    setConfirmDelete(false)
  }
  function closeEdit() { setEditRun(null); setConfirmDelete(false) }

  async function handleEditSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!editRun) return
    setSaving(true)
    try {
      const s = editRun.status ?? 'requested'
      const canEditBasic = s === 'requested' || s === 'scheduled'
      const canEditProduced = s === 'in_production' || s === 'complete'
      const updates: Record<string, unknown> = { your_notes: eYourNotes || null, cp_notes: eCpNotes || null }
      if (canEditBasic) {
        updates.requested_quantity = Number(eReqQty)
        updates.requested_date = eReqDate || null
        updates.priority = ePriority
      }
      if (canEditProduced && eProducedQty) updates.produced_quantity = Number(eProducedQty)
      const { error } = await dbUpdate('production_runs', sanitize('production_runs', updates), 'id', editRun.id)
      closeEdit()
      if (error) toast.error(error.message)
      else {
        toast.success('Run updated')
        logActivity(appUser?.id, 'update_production_run', 'production_run', editRun.id)
      }
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save run')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteRun() {
    if (!editRun) return
    setSaving(true)
    try {
      const { error } = await dbDelete('production_runs', 'id', editRun.id)
      closeEdit()
      if (error) toast.error(error.message)
      else {
        toast.success('Run deleted')
        logActivity(appUser?.id, 'delete_production_run', 'production_run', editRun.id)
      }
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete run')
    } finally {
      setSaving(false)
    }
  }

  /* ── MRP for create single run ──────────────────────────────── */

  const mrpRows = useMemo(() => {
    if (!fRecipe || !fCP || !fQty || Number(fQty) <= 0) return []
    return buildMRPRows([{ recipeId: fRecipe, quantity: Number(fQty) }], fCP, recipeIngredients, ingredients, inventory, purchaseOrders, poItems, conversions)
  }, [fRecipe, fCP, fQty, recipeIngredients, ingredients, inventory, purchaseOrders, poItems, conversions])
  const mrpSummary = useMemo(() => buildMRPSummary(mrpRows), [mrpRows])

  /* ── MRP for edit run modal ─────────────────────────────────── */

  const editMRPRows = useMemo(() => {
    if (!editRun) return []
    const qty = Number(eReqQty) || 0
    if (!editRun.recipe_id || !editRun.co_packer_id || qty <= 0) return []
    return buildMRPRows([{ recipeId: editRun.recipe_id, quantity: qty }], editRun.co_packer_id, recipeIngredients, ingredients, inventory, purchaseOrders, poItems, conversions)
  }, [editRun, eReqQty, recipeIngredients, ingredients, inventory, purchaseOrders, poItems, conversions])
  const editMRPSummary = useMemo(() => buildMRPSummary(editMRPRows), [editMRPRows])

  /* ── Run form helpers ───────────────────────────────────────── */

  function nextRunNumber(): string { return calcNextRunNumber(runs) }

  const cpRecipes = useMemo(() => {
    if (!fCP) return []
    return recipes.filter((r) => r.co_packer_id === fCP)
  }, [fCP, recipes])

  function resetRunForm() {
    setFCP(''); setFRecipe(''); setFQty(''); setFDate(format(new Date(), 'yyyy-MM-dd')); setFPriority('normal'); setRunStep(1)
  }

  async function handleCreateRun(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    try {
      const { data: newRun, error } = await dbInsertSingle('production_runs', sanitize('production_runs', {
        run_number: nextRunNumber(), co_packer_id: fCP || null, recipe_id: fRecipe || null,
        requested_quantity: Number(fQty), requested_date: fDate, priority: fPriority, status: 'requested',
      } satisfies ProductionRunInsert))
      setRunModalOpen(false); resetRunForm()
      if (error) toast.error(error.message)
      else {
        toast.success('Production run requested')
        logActivity(appUser?.id, 'create_production_run', 'production_run', newRun?.id)
      }
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create run')
    } finally {
      setSaving(false)
    }
  }

  const step1Valid = fCP && fRecipe && fQty && Number(fQty) > 0

  /* ── Edit modal derived data ────────────────────────────────── */
  const editRecipe = editRun ? recipes.find((r) => r.id === editRun.recipe_id) : null
  const editCP = editRun ? coPackers.find((cp) => cp.id === editRun.co_packer_id) : null
  const editCPContact = editRun ? cpContacts.find((c) => c.co_packer_id === editRun.co_packer_id && c.is_primary) : null
  const editStatus = editRun?.status ?? 'requested'
  const canEditBasic = editStatus === 'requested' || editStatus === 'scheduled'
  const canEditProduced = editStatus === 'in_production' || editStatus === 'complete'
  const showAdvanced = editStatus === 'in_production' || editStatus === 'complete' || editStatus === 'reconciled' || editStatus === 'flagged'

  /* ── CSV export ─────────────────────────────────────────────── */

  function handleExport() {
    const cpMap = new Map(coPackers.map((cp) => [cp.id, cp.short_code]))
    const exportData = runRows.map((row) => ({
      run_number: row.run_number, co_packer: row.co_packer_id ? (cpMap.get(row.co_packer_id) ?? '—') : '—',
      recipe_sku: row.recipeName, requested: row.requested_quantity,
      produced: row.produced_quantity ?? '', waste_pct: row.waste_pct != null ? `${(row.waste_pct as number).toFixed(1)}%` : '',
      status: RUN_STATUS_LABEL[row.status] ?? row.status, date: row.requested_date ? fmtDate(row.requested_date) : '',
      order: row.orderNumber ?? '',
    }))
    downloadCSV(exportData, [
      { key: 'run_number', label: 'Run #' }, { key: 'order', label: 'Order' }, { key: 'co_packer', label: 'Co-Packer' },
      { key: 'recipe_sku', label: 'Recipe/SKU' }, { key: 'requested', label: 'Requested' },
      { key: 'produced', label: 'Produced' }, { key: 'waste_pct', label: 'Waste %' },
      { key: 'status', label: 'Status' }, { key: 'date', label: 'Date' },
    ], 'production-runs')
  }

  /* ════════════════════════════════════════════════════════════
   *  ORDERS TAB — logic
   * ════════════════════════════════════════════════════════════ */

  const filteredOrders = useMemo(() => {
    if (cpFilter === 'all') return orders
    return orders.filter((o) => o.co_packer_id === cpFilter)
  }, [orders, cpFilter])

  function toggleOrder(id: string) {
    setExpandedOrders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  /* ── Edit production order ─────────────────────────────────── */

  function openEditOrder(order: ProductionOrder) {
    setEditOrder(order)
    setEditOrderForm({
      co_packer_id: order.co_packer_id ?? '',
      status: order.status ?? 'draft',
      order_date: order.order_date ?? '',
      requested_start_date: order.requested_start_date ?? '',
      estimated_completion_date: order.estimated_completion_date ?? '',
      priority: order.priority ?? 'normal',
      notes: order.notes ?? '',
    })
    const orderRuns = runs.filter((r) => r.production_order_id === order.id)
    setEditOrderRuns(orderRuns.map((r) => ({
      id: r.id,
      run_number: r.run_number,
      recipe_id: r.recipe_id ?? '',
      requested_quantity: String(r.requested_quantity),
      produced_quantity: r.produced_quantity != null ? String(r.produced_quantity) : '',
      status: r.status ?? 'requested',
    })))
  }

  function closeEditOrder() {
    setEditOrder(null)
    setConfirmDeleteOrder(false)
    setConfirmRemoveRunIdx(null)
    setCPChangeWarning(false)
    setPendingCP('')
  }

  function handleEditOrderCPChange(newCP: string) {
    const activeRuns = editOrderRuns.filter((r) => !r._deleted)
    if (activeRuns.length > 0) {
      setPendingCP(newCP)
      setCPChangeWarning(true)
    } else {
      setEditOrderForm((f) => ({ ...f, co_packer_id: newCP }))
    }
  }

  function confirmCPChange() {
    setEditOrderForm((f) => ({ ...f, co_packer_id: pendingCP }))
    setEditOrderRuns((prev) => prev.map((r) => r.id ? { ...r, _deleted: true } : r).filter((r) => r.id !== null || !r._deleted))
    setCPChangeWarning(false)
    setPendingCP('')
  }

  function handleAddEditOrderFlavor() {
    setEditOrderRuns((prev) => [...prev, { id: null, run_number: '(new)', recipe_id: '', requested_quantity: '', produced_quantity: '', status: 'requested' }])
  }

  function handleRemoveEditOrderRun(idx: number) {
    const run = editOrderRuns[idx]
    const inProgress = run.status === 'in_production' || run.status === 'complete' || run.status === 'reconciled' || run.status === 'flagged'
    if (inProgress) {
      setConfirmRemoveRunIdx(idx)
      return
    }
    doRemoveEditOrderRun(idx)
  }

  function doRemoveEditOrderRun(idx: number) {
    setEditOrderRuns((prev) => {
      const run = prev[idx]
      if (run.id) {
        const next = [...prev]
        next[idx] = { ...run, _deleted: true }
        return next
      }
      return prev.filter((_, i) => i !== idx)
    })
    setConfirmRemoveRunIdx(null)
  }

  function updateEditOrderRun(idx: number, field: keyof EditOrderRun, value: string) {
    setEditOrderRuns((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: value }
      return next
    })
  }

  async function handleSaveOrder() {
    if (!editOrder) return
    setSaving(true)
    try {
      const { totalUnits, totalCost } = editOrderTotals
      await dbUpdate('production_orders', sanitize('production_orders', {
        co_packer_id: editOrderForm.co_packer_id || null,
        status: editOrderForm.status,
        order_date: editOrderForm.order_date || null,
        requested_start_date: editOrderForm.requested_start_date || null,
        estimated_completion_date: editOrderForm.estimated_completion_date || null,
        priority: editOrderForm.priority,
        notes: editOrderForm.notes || null,
        total_units: totalUnits,
        total_estimated_cost: totalCost,
      }), 'id', editOrder.id)

      // Delete removed runs
      const toDelete = editOrderRuns.filter((r) => r._deleted && r.id)
      if (toDelete.length > 0) {
        await dbDeleteIn('production_runs', 'id', toDelete.map((r) => r.id!))
      }

      // Update existing runs
      for (const r of editOrderRuns.filter((r) => r.id && !r._deleted)) {
        const canSetProduced = r.status === 'in_production' || r.status === 'complete'
        await dbUpdate('production_runs', sanitize('production_runs', {
          recipe_id: r.recipe_id || null,
          requested_quantity: Number(r.requested_quantity) || 0,
          ...(canSetProduced && r.produced_quantity ? { produced_quantity: Number(r.produced_quantity) } : {}),
          status: r.status,
          co_packer_id: editOrderForm.co_packer_id || null,
        }), 'id', r.id!)
      }

      // Insert new runs
      const newRuns = editOrderRuns.filter((r) => !r.id && !r._deleted && r.recipe_id && Number(r.requested_quantity) > 0)
      if (newRuns.length > 0) {
        let runNum = calcNextRunNumber(runs)
        for (const nr of newRuns) {
          await dbInsert('production_runs', sanitize('production_runs', {
            run_number: runNum,
            co_packer_id: editOrderForm.co_packer_id || null,
            recipe_id: nr.recipe_id || null,
            requested_quantity: Number(nr.requested_quantity),
            requested_date: editOrderForm.order_date || null,
            priority: editOrderForm.priority,
            status: 'requested',
            production_order_id: editOrder.id,
          } satisfies ProductionRunInsert))
          const num = parseInt(runNum.replace('PR-', ''), 10)
          runNum = `PR-${String(num + 1).padStart(4, '0')}`
        }
      }

      toast.success(`Updated production order ${editOrder.order_number}`)
      logActivity(appUser?.id, 'update_production_order', 'production_order', editOrder.id)
      syncIngredientStatus(editOrder.id)
      closeEditOrder()
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save order')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteOrder() {
    if (!editOrder) return
    setSaving(true)
    try {
      const orderRunIds = runs.filter((r) => r.production_order_id === editOrder.id).map((r) => r.id)
      if (orderRunIds.length > 0) {
        await dbDeleteIn('production_runs', 'id', orderRunIds)
      }
      // Unlink any POs
      await dbUpdate('purchase_orders', sanitize('purchase_orders', { production_order_id: null }), 'production_order_id', editOrder.id)
      // Delete the order
      const { error } = await dbDelete('production_orders', 'id', editOrder.id)
      if (error) throw error
      toast.success(`Deleted production order ${editOrder.order_number}`)
      logActivity(appUser?.id, 'delete_production_order', 'production_order', editOrder.id)
      setConfirmDeleteOrder(false)
      closeEditOrder()
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete order')
    } finally {
      setSaving(false)
    }
  }

  /* ── Procurement: Order missing ingredients ───────────────── */

  function procurementToMRPRow(row: ProcurementRow, selection?: ProcurementSelection): MRPRow | null {
    const ing = ingredients.find((i) => i.id === row.ingredientId)
    if (!ing) return null
    const needToOrder = Math.max(0, row.needed - row.atCoPacker - row.inTransit - row.ordered)
    return {
      ingredientId: row.ingredientId,
      ingredientName: row.ingredientName,
      unit: row.unit,
      recipeUnit: row.unit,
      recipeUnitNeed: row.needed,
      totalNeed: row.needed,
      atCoPacker: row.atCoPacker,
      inTransit: row.inTransit,
      totalAvailable: row.atCoPacker + row.inTransit,
      shortfall: needToOrder,
      needToOrder,
      status: 'order',
      unitCost: ing.unit_cost,
      providedBy: row.providedBy ?? 'fitbake',
      preferredSupplierId: selection?.supplierId ?? undefined,
      preferredSiId: selection?.siId ?? undefined,
    }
  }

  function openProcurementPO(order: ProductionOrder, mrpRows: MRPRow[]) {
    const cp = coPackers.find((c) => c.id === order.co_packer_id)
    setMRPContext({ rows: mrpRows, cpId: order.co_packer_id ?? '', cpName: cp?.name ?? '', orderId: order.id })
    setMRPPOOpen(true)
  }

  function handleOrderAllMissingForOrder(order: ProductionOrder, procRows: ProcurementRow[], selMap?: Map<string, ProcurementSelection>) {
    const rowsToOrder = procRows
      .filter((r) => r.status === 'NOT_ORDERED' || r.status === 'PARTIAL')
      .map((r) => procurementToMRPRow(r, selMap?.get(r.ingredientId)))
      .filter(Boolean) as MRPRow[]
    if (rowsToOrder.length === 0) return
    openProcurementPO(order, rowsToOrder)
  }

  function handleOrderIngredientForOrder(order: ProductionOrder, row: ProcurementRow, selection?: ProcurementSelection) {
    const mrpRow = procurementToMRPRow(row, selection)
    if (!mrpRow) return
    openProcurementPO(order, [mrpRow])
  }

  function handleOrderAllMissing(rows?: ProcurementRow[], selMap?: Map<string, ProcurementSelection>) {
    if (!editOrder || !editOrderProcurement) return
    handleOrderAllMissingForOrder(editOrder, rows ?? editOrderProcurement.rows, selMap)
    closeEditOrder()
  }

  function handleOrderIngredient(row: ProcurementRow, selection?: ProcurementSelection) {
    if (!editOrder) return
    handleOrderIngredientForOrder(editOrder, row, selection)
    closeEditOrder()
  }

  /* ── Procurement status change (updates linked POs) ─────────── */

  async function handleProcurementStatusChange(ingredientId: string, newStatus: string, linkedPOIds: string[]) {
    if (linkedPOIds.length === 0) return

    // Map procurement status to PO status
    const PROC_TO_PO: Record<string, string> = {
      ORDERED: 'ordered',
      IN_TRANSIT: 'in_transit',
      RECEIVED: 'received',
      READY: 'received',
    }
    const poStatus = PROC_TO_PO[newStatus]
    if (!poStatus) return

    setSaving(true)
    try {
      for (const poId of linkedPOIds) {
        const po = purchaseOrders.find((p) => p.id === poId)
        // Update PO status
        await dbUpdate('purchase_orders', sanitize('purchase_orders', {
          status: poStatus,
          updated_at: new Date().toISOString(),
        }), 'id', poId)

        // Full sync chain: shipment + ingredient status (non-blocking)
        syncAfterPOStatusChange(poId, poStatus, {
          productionOrderId: po?.production_order_id ?? null,
        })
      }
      const ing = ingredients.find((i) => i.id === ingredientId)
      toast.success(`${ing?.name ?? 'Ingredient'} → ${newStatus.replace('_', ' ')} (${linkedPOIds.length} PO${linkedPOIds.length !== 1 ? 's' : ''} updated — shipment synced)`)

      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update procurement status')
    } finally {
      setSaving(false)
    }
  }

  /* ── ETA change from procurement table ──────────────────────── */

  async function handleETAChange(poId: string, newDate: string | null) {
    try {
      await dbUpdate('purchase_orders', sanitize('purchase_orders', {
        eta_date: newDate,
        updated_at: new Date().toISOString(),
      }), 'id', poId)
      toast.success(`ETA updated${newDate ? ` to ${newDate}` : ' (cleared)'}`)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update ETA')
    }
  }

  /* ── Order status change ────────────────────────────────────── */

  function handleOrderStatusChange(orderId: string, newStatus: string) {

    // Changing to completed → prompt for produced quantities first
    if (newStatus === 'completed') {
      const orderRuns = runs.filter((r) => r.production_order_id === orderId)
      const incompleteRuns = orderRuns.filter((r) => r.status !== 'complete' && r.status !== 'reconciled')
      if (incompleteRuns.length > 0) {
        // Some runs aren't done — show qty prompt
        const needQty = orderRuns.some((r) => r.produced_quantity == null)
        if (needQty) {
          setCompleteOrderId(orderId)
          const qtys: Record<string, string> = {}
          for (const r of orderRuns) qtys[r.id] = r.produced_quantity != null ? String(r.produced_quantity) : ''
          setCompleteOrderQtys(qtys)
          return
        }
      }
    }

    // Check if this transition needs confirmation
    if (ORDER_CONFIRM_MESSAGES[newStatus]) {
      setOrderStatusConfirm({ orderId, newStatus, cascade: true })
      return
    }

    // Simple toast transitions (no confirmation needed)
    if (newStatus === 'sent_to_cp') {
      executeOrderStatusChange(orderId, newStatus, false)
      toast.success('Production order sent to co-packer')
      return
    }
    if (newStatus === 'confirmed_by_cp') {
      executeOrderStatusChange(orderId, newStatus, false)
      toast.success('Co-packer confirmed the order')
      return
    }
    if (newStatus === 'shipped') {
      executeOrderStatusChange(orderId, newStatus, false)
      toast.success('Order marked as shipped')
      return
    }

    // No confirmation needed — execute directly
    executeOrderStatusChange(orderId, newStatus, true)
  }

  async function executeOrderStatusChange(orderId: string, newStatus: string, cascade: boolean) {
    setOrderStatusConfirm(null)
    setSaving(true)
    try {
      await dbUpdate('production_orders', sanitize('production_orders', {
        status: newStatus,
        updated_at: new Date().toISOString(),
      }), 'id', orderId)

      // Cascade to child runs
      if (cascade) {
        const orderRuns = runs.filter((r) => r.production_order_id === orderId)
        if (newStatus === 'in_production') {
          for (const r of orderRuns) {
            if (r.status === 'requested' || r.status === 'scheduled') {
              await dbUpdate('production_runs', sanitize('production_runs', {
                status: 'in_production',
                started_date: r.started_date ?? format(new Date(), 'yyyy-MM-dd'),
              }), 'id', r.id)
            }
          }
        } else if (newStatus === 'cancelled') {
          for (const r of orderRuns) {
            if (r.status !== 'complete' && r.status !== 'reconciled') {
              await dbUpdate('production_runs', sanitize('production_runs', {
                status: 'flagged',
              }), 'id', r.id)
            }
          }
        } else if (newStatus === 'on_hold') {
          for (const r of orderRuns) {
            if (r.status === 'in_production' || r.status === 'scheduled') {
              await dbUpdate('production_runs', sanitize('production_runs', {
                status: 'flagged',
              }), 'id', r.id)
            }
          }
        }
      }

      toast.success(`Status updated to ${ORDER_STATUS_LABEL[newStatus] ?? newStatus}`)
      syncIngredientStatus(orderId)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update order status')
    } finally {
      setSaving(false)
    }
  }

  async function handleCompleteOrder(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!completeOrderId) return
    setSaving(true)
    try {
      const orderRuns = runs.filter((r) => r.production_order_id === completeOrderId)
      for (const r of orderRuns) {
        const produced = Number(completeOrderQtys[r.id] || 0)
        if (produced <= 0) continue
        const wastePct = ((r.requested_quantity - produced) / r.requested_quantity) * 100
        await dbUpdate('production_runs', sanitize('production_runs', {
          status: 'complete',
          produced_quantity: produced,
          completed_date: format(new Date(), 'yyyy-MM-dd'),
          waste_pct: wastePct >= 0 ? Math.round(wastePct * 10) / 10 : null,
        }), 'id', r.id)
      }
      await dbUpdate('production_orders', sanitize('production_orders', { status: 'completed' }), 'id', completeOrderId)
      toast.success('Order marked as completed')
      logActivity(appUser?.id, 'update_production_order', 'production_order', completeOrderId)
      setCompleteOrderId(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to complete order')
    } finally {
      setSaving(false)
    }
  }

  /* ── Order PDF ──────────────────────────────────────────────── */

  function buildOrderPDFData(order: ProductionOrder): ProductionOrderPDFData {
    const cp = coPackers.find((c) => c.id === order.co_packer_id)
    const contact = cpContacts.find((c) => c.co_packer_id === order.co_packer_id && c.is_primary)
      ?? cpContacts.find((c) => c.co_packer_id === order.co_packer_id)
    const orderRuns = runs.filter((r) => r.production_order_id === order.id)

    return {
      order_number: order.order_number,
      order_date: order.order_date,
      co_packer_name: cp?.name ?? 'Unknown',
      contact_name: contact?.name ?? null,
      contact_email: contact?.email ?? null,
      contact_phone: contact?.phone ?? null,
      co_packer_location: cp?.location ?? null,
      receiving_hours: cp?.receiving_hours ?? null,
      receiving_notes: cp?.receiving_notes ?? null,
      priority: order.priority ?? 'normal',
      notes: order.notes,
      cp_fee_per_unit: cp?.fee_per_unit ?? 0,
      items: orderRuns.map((r) => {
        const recipe = recipes.find((rec) => rec.id === r.recipe_id)
        return {
          sku: recipe?.sku ?? '—',
          product_name: recipe?.name ?? 'Unknown',
          quantity: r.requested_quantity,
          image_url: recipe?.image_url,
          co_packer_color: cp?.color,
        }
      }),
    }
  }

  /* ── Download PO PDFs for a production order ──────────────── */

  function getOrderPOs(order: ProductionOrder): PurchaseOrder[] {
    return purchaseOrders.filter((po) => po.production_order_id === order.id)
  }

  function buildPOPDFData(po: PurchaseOrder): POPDFData {
    const sup = suppliers.find((s) => s.id === po.supplier_id)
    const contact = supplierContacts.find((c) => c.supplier_id === po.supplier_id && c.is_primary)
      ?? supplierContacts.find((c) => c.supplier_id === po.supplier_id)
    const cp = coPackers.find((c) => c.id === po.destination_co_packer_id)
    const items = poItems.filter((it) => it.purchase_order_id === po.id)

    return {
      po_number: po.po_number,
      order_type: po.order_type ?? 'po',
      order_reference: po.order_reference ?? null,
      order_date: po.order_date ?? null,
      supplier_name: sup?.name ?? 'Unknown Supplier',
      contact_name: contact?.name ?? null,
      contact_email: contact?.email ?? null,
      contact_phone: contact?.phone ?? null,
      destination_type: po.destination_type ?? 'copacker',
      destination_name: cp?.name ?? null,
      destination_location: cp?.location ?? null,
      receiving_hours: null,
      receiving_notes: null,
      items: items.map((it) => {
        const ing = ingredients.find((i) => i.id === it.ingredient_id)
        return {
          name: ing?.name ?? 'Unknown',
          quantity: it.quantity,
          unit: ing?.unit ?? 'lbs',
          unit_cost: it.unit_cost,
        }
      }),
      shipping_cost: po.shipping_cost,
      shipping_method: po.shipping_method,
      shipping_carrier: po.shipping_carrier,
    }
  }

  async function handleDownloadPOPDFs(order: ProductionOrder) {
    const pos = getOrderPOs(order)
    if (pos.length === 0) {
      toast.error('No purchase orders found for this co-packer')
      return
    }
    for (let i = 0; i < pos.length; i++) {
      generatePO_PDF(buildPOPDFData(pos[i]), 'download')
      if (i < pos.length - 1) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    toast.success(`Downloaded ${pos.length} PO PDF${pos.length > 1 ? 's' : ''}`)
  }

  /* ── Next order number ──────────────────────────────────────── */

  function nextOrderNumber(): string {
    if (orders.length === 0) return 'PO-B001'
    const nums = orders.map((o) => {
      const m = o.order_number.match(/PO-B(\d+)/)
      return m ? parseInt(m[1], 10) : 0
    }).filter(Boolean)
    const max = Math.max(...nums, 0)
    return `PO-B${String(max + 1).padStart(3, '0')}`
  }

  /* ── Create order modal helpers ─────────────────────────────── */

  const oCPRecipes = useMemo(() => {
    if (!oCP) return []
    return recipes.filter((r) => r.co_packer_id === oCP)
  }, [oCP, recipes])

  function resetOrderForm() {
    setOCP(''); setODate(format(new Date(), 'yyyy-MM-dd')); setOStartDate(''); setOPriority('normal')
    setONotes(''); setOFlavors([{ recipeId: '', quantity: '' }]); setOrderStep(1)
  }

  const validFlavors = oFlavors.filter((f) => f.recipeId && f.quantity && Number(f.quantity) > 0)
  const orderTotalUnits = validFlavors.reduce((s, f) => s + Number(f.quantity), 0)

  // Compute ingredient cost per unit for each recipe (with proper unit conversion)
  const recipeCOGS = useMemo(() => {
    const map = new Map<string, number>()
    for (const recipe of recipes) {
      map.set(recipe.id, calculateRecipeCOGS(recipe.id, recipeIngredients, ingredients, conversions))
    }
    return map
  }, [recipes, recipeIngredients, ingredients, conversions])

  const orderTotalCost = validFlavors.reduce((s, f) => {
    const cogs = recipeCOGS.get(f.recipeId) ?? 0
    const cpFee = coPackers.find((c) => c.id === oCP)?.fee_per_unit ?? 0
    return s + Number(f.quantity) * (cogs + cpFee)
  }, 0)

  // Edit order — recipes for selected CP + totals (must be after recipeCOGS)
  const editOrderCPRecipes = useMemo(() => {
    if (!editOrderForm.co_packer_id) return []
    return recipes.filter((r) => r.co_packer_id === editOrderForm.co_packer_id)
  }, [editOrderForm.co_packer_id, recipes])

  const editOrderTotals = useMemo(() => {
    const active = editOrderRuns.filter((r) => !r._deleted && r.recipe_id && r.requested_quantity && Number(r.requested_quantity) > 0)
    const cpFee = coPackers.find((c) => c.id === editOrderForm.co_packer_id)?.fee_per_unit ?? 0
    let totalUnits = 0
    let totalCost = 0
    for (const r of active) {
      const qty = Number(r.requested_quantity)
      const cogs = recipeCOGS.get(r.recipe_id) ?? 0
      totalUnits += qty
      totalCost += qty * (cogs + cpFee)
    }
    return { flavors: active.length, totalUnits, totalCost }
  }, [editOrderRuns, editOrderForm.co_packer_id, coPackers, recipeCOGS])

  const editOrderProcurement = useMemo(() => {
    if (!editOrder?.co_packer_id) return null
    const orderRuns = runs.filter((r) => r.production_order_id === editOrder.id)
    if (orderRuns.length === 0) return null
    const rows = buildProcurementRows({
      order: editOrder,
      orderRuns,
      recipeIngredients,
      ingredients,
      inventory,
      purchaseOrders,
      poItems,
      conversions,
    })
    return { rows, summary: buildProcurementSummary(rows) }
  }, [editOrder, runs, recipeIngredients, ingredients, inventory, purchaseOrders, poItems, conversions])

  const orderProcurementMap = useMemo(() => {
    const map = new Map<string, { rows: ProcurementRow[]; summary: ReturnType<typeof buildProcurementSummary>; dots: ReturnType<typeof procurementDots> }>()
    for (const order of orders) {
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
      const dots = procurementDots(rows)
      const summary = buildProcurementSummary(rows)
      map.set(order.id, { rows, summary, dots })
    }
    return map
  }, [orders, runs, recipeIngredients, ingredients, inventory, purchaseOrders, poItems, conversions])

  // MRP for order step 3
  const orderMRPRows = useMemo(() => {
    if (!oCP || validFlavors.length === 0) return []
    return buildMRPRows(
      validFlavors.map((f) => ({ recipeId: f.recipeId, quantity: Number(f.quantity) })),
      oCP, recipeIngredients, ingredients, inventory, purchaseOrders, poItems, conversions,
    )
  }, [oCP, validFlavors, recipeIngredients, ingredients, inventory, purchaseOrders, poItems, conversions])
  const orderMRPSummary = useMemo(() => buildMRPSummary(orderMRPRows), [orderMRPRows])

  async function handleCreateOrder() {
    if (validFlavors.length === 0) return
    setSaving(true)
    try {
      const orderNum = nextOrderNumber()
      const insert: ProductionOrderInsert = {
        order_number: orderNum,
        co_packer_id: oCP || null,
        status: 'draft',
        order_date: oDate || null,
        requested_start_date: oStartDate || null,
        priority: oPriority,
        notes: oNotes || null,
        total_units: orderTotalUnits,
        total_estimated_cost: orderTotalCost,
      }
      const { data: order, error } = await dbInsertSingle('production_orders', sanitize('production_orders', insert))
      if (error || !order) throw error ?? new Error('Failed to create order')

      let runNum = calcNextRunNumber(runs)
      for (const flavor of validFlavors) {
        await dbInsert('production_runs', sanitize('production_runs', {
          run_number: runNum,
          co_packer_id: oCP || null,
          recipe_id: flavor.recipeId || null,
          requested_quantity: Number(flavor.quantity),
          requested_date: oDate,
          priority: oPriority,
          status: 'requested',
          production_order_id: order.id,
        } satisfies ProductionRunInsert))
        const num = parseInt(runNum.replace('PR-', ''), 10)
        runNum = `PR-${String(num + 1).padStart(4, '0')}`
      }

      toast.success(`Created production order ${orderNum} with ${validFlavors.length} flavor${validFlavors.length > 1 ? 's' : ''}`)
      logActivity(appUser?.id, 'create_production_order', 'production_order', order.id)
      syncIngredientStatus(order.id)
      setOrderModalOpen(false)
      resetOrderForm()
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create order')
    } finally {
      setSaving(false)
    }
  }

  /* ════════════════════════════════════════════════════════════
   *  RENDER
   * ════════════════════════════════════════════════════════════ */

  if (loading) return <PageSkeleton />

  return (
    <div>
      <PageHeader title="Production Orders" subtitle="Group production runs into orders for co-packers">
        <button onClick={handleExport} className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text">
          <Download size={16} /> Export CSV
        </button>
        {tab === 'runs' && (
          <button onClick={() => setRunModalOpen(true)} className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text hover:bg-hover">
            <Plus size={16} /> Single Run
          </button>
        )}
        <button onClick={() => { resetOrderForm(); setOrderModalOpen(true) }} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover">
          <Plus size={16} /> New Production Order
        </button>
      </PageHeader>

      {/* Tab bar */}
      <div className="mb-4 flex items-center gap-6 border-b border-border">
        {(['orders', 'runs'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2.5 text-[14px] transition-colors ${
              tab === t ? 'border-b-2 border-accent text-accent font-semibold' : 'text-muted hover:text-text font-medium'
            }`}
          >
            {t === 'orders' ? 'Orders' : 'All Runs'}
          </button>
        ))}
      </div>

      <CPFilterBar selected={cpFilter} onSelect={setCpFilter} />

      {/* ── ORDERS TAB ─────────────────────────────────────────── */}
      {tab === 'orders' && (
        <div className="space-y-4">
          {filteredOrders.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-border py-16 text-center">
              <p className="text-base font-medium text-muted">No production orders</p>
              <p className="mt-1 text-[13px] text-muted/70">Create your first production order to group runs together</p>
            </div>
          )}
          {filteredOrders.map((order) => {
            const expanded = expandedOrders.has(order.id)
            const cp = coPackers.find((c) => c.id === order.co_packer_id)
            const orderRuns = runs.filter((r) => r.production_order_id === order.id)
            const totalUnits = orderRuns.reduce((s, r) => s + r.requested_quantity, 0)
            const status = order.status ?? 'draft'

            return (
              <div key={order.id} className="rounded-xl border border-border bg-card overflow-hidden">
                {/* Card header */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleOrder(order.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOrder(order.id) } }}
                  className="px-5 py-4 transition-colors hover:bg-hover cursor-pointer"
                >
                  {/* Row 1: Order identity + status */}
                  <div className="flex items-center gap-3">
                    {expanded ? <ChevronDown size={16} className="text-muted shrink-0" /> : <ChevronRight size={16} className="text-muted shrink-0" />}
                    <span className="font-mono text-[15px] font-bold text-accent">{order.order_number}</span>
                    {cp && <CPBadge coPacker={cp} />}
                    <span className="text-[14px] text-text">{cp?.name ?? '—'}</span>
                    <span className="ml-auto" />
                    {/* Clickable status badge */}
                    {(() => {
                      const transitions = ORDER_TRANSITIONS[status] ?? []
                      if (transitions.length === 0) {
                        return <Badge color={ORDER_STATUS_BADGE[status] ?? 'gray'}>{ORDER_STATUS_LABEL[status] ?? status}</Badge>
                      }
                      const opts: StatusOption[] = transitions.map((s) => ({
                        value: s,
                        label: ORDER_STATUS_LABEL[s] ?? s,
                        dotColor: ORDER_STATUS_DOT[s] ?? '#7A8599',
                      }))
                      return (
                        <div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                          <StatusDropdown
                            trigger={<Badge color={ORDER_STATUS_BADGE[status] ?? 'gray'}>{ORDER_STATUS_LABEL[status] ?? status} ▾</Badge>}
                            options={opts}
                            onSelect={(s) => handleOrderStatusChange(order.id, s)}
                          />
                        </div>
                      )
                    })()}
                  </div>
                  {/* Row 2: Details */}
                  <div className="mt-1.5 ml-7 flex items-center gap-4 text-[13px] text-muted">
                    <span>{orderRuns.length} flavor{orderRuns.length !== 1 ? 's' : ''}</span>
                    <span className="font-mono">{totalUnits.toLocaleString()} units</span>
                    {order.order_date && <span>{fmtDate(order.order_date)}</span>}
                    {order.total_estimated_cost != null && Number(order.total_estimated_cost) > 0 && (
                      <span className="font-mono">{fmt$(Number(order.total_estimated_cost))}</span>
                    )}
                    {/* Procurement dots */}
                    {(() => {
                      const proc = orderProcurementMap.get(order.id)
                      if (!proc || proc.dots.total === 0) return null
                      const d = proc.dots
                      return (
                        <span className="flex items-center gap-0.5">
                          {Array.from({ length: d.green }, (_, i) => (
                            <span key={`g${i}`} className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: '#22C55E' }} />
                          ))}
                          {Array.from({ length: d.cyan }, (_, i) => (
                            <span key={`c${i}`} className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: '#06B6D4' }} />
                          ))}
                          {Array.from({ length: d.blue }, (_, i) => (
                            <span key={`b${i}`} className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: '#3B82F6' }} />
                          ))}
                          {Array.from({ length: d.gray }, (_, i) => (
                            <span key={`d${i}`} className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: '#7A8599' }} />
                          ))}
                          {Array.from({ length: d.amber }, (_, i) => (
                            <span key={`a${i}`} className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: '#F59E0B' }} />
                          ))}
                          {Array.from({ length: d.red }, (_, i) => (
                            <span key={`r${i}`} className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: '#EF4444' }} />
                          ))}
                          <span className="ml-0.5">{d.green}/{d.total}</span>
                        </span>
                      )
                    })()}
                    {/* Payment status (POs + CP invoices combined) */}
                    {(() => {
                      const poSummary = getOrderPOPaymentSummary(order.id, purchaseOrders)
                      const cpSummary = getOrderPaymentSummary(order.id, cpInvoices, cpPayments)

                      const hasPOs = poSummary.status !== 'no_pos'
                      const hasCPInv = cpSummary.status !== 'none'
                      if (!hasPOs && !hasCPInv) return null

                      const combinedTotal = poSummary.total + cpSummary.cpCost
                      const combinedPaid = poSummary.paid + cpSummary.totalPaid
                      const combinedBalance = Math.max(0, combinedTotal - combinedPaid)
                      const allPaid = combinedPaid >= combinedTotal && combinedTotal > 0

                      let display: React.ReactNode
                      if (allPaid) {
                        display = (
                          <span className="rounded-md px-2 py-0.5 transition-colors hover:bg-hover-strong" style={{ color: '#22C55E' }}>
                            All paid ✓
                          </span>
                        )
                      } else if (combinedPaid > 0) {
                        display = (
                          <span className="font-mono rounded-md px-2 py-0.5 transition-colors hover:bg-hover-strong" style={{ color: '#F59E0B' }}>
                            {fmt$(combinedPaid)} / {fmt$(combinedTotal)} paid
                            {hasPOs && ` (${poSummary.poCount} PO${poSummary.poCount !== 1 ? 's' : ''})`}
                          </span>
                        )
                      } else if (poSummary.hasOverdue) {
                        display = (
                          <span className="font-mono font-bold rounded-md px-2 py-0.5 transition-colors hover:bg-hover-strong" style={{ color: '#EF4444' }}>
                            Overdue ⚠ ({fmt$(combinedBalance)} due)
                          </span>
                        )
                      } else {
                        display = (
                          <span className="font-mono rounded-md px-2 py-0.5 transition-colors hover:bg-hover-strong" style={{ color: '#EF4444' }}>
                            Unpaid ({fmt$(combinedTotal)})
                          </span>
                        )
                      }

                      const linkedPOData = buildLinkedPOs(order.id, purchaseOrders, suppliers)
                      const cpInvData = buildCPInvoiceSummaries(order.id, cpInvoices, cpPayments)

                      return (
                        <OrderPaymentPopover
                          orderNumber={order.order_number}
                          linkedPOs={linkedPOData}
                          cpInvoices={cpInvData}
                          onDone={load}
                        >
                          {display}
                        </OrderPaymentPopover>
                      )
                    })()}
                  </div>
                </div>

                {/* Expanded content */}
                {expanded && (
                  <div className="border-t border-border px-5 py-4 space-y-4">
                    {/* Actions bar */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openEditOrder(order)}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
                      >
                        <Pencil size={14} /> Edit
                      </button>
                      <button
                        onClick={() => { generateProductionOrderPDF(buildOrderPDFData(order), 'download') }}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
                      >
                        <FileDown size={14} /> PDF
                      </button>
                      <button
                        onClick={() => { generateProductionOrderPDF(buildOrderPDFData(order), 'print') }}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
                      >
                        <Printer size={14} /> Print
                      </button>
                      {getOrderPOs(order).length > 0 && (
                        <button
                          onClick={() => handleDownloadPOPDFs(order)}
                          className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent/20"
                        >
                          <FileDown size={14} /> PO PDFs ({getOrderPOs(order).length})
                        </button>
                      )}
                    </div>

                    {/* Runs table */}
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table className="w-full text-[14px]">
                        <thead>
                          <tr className="border-b border-border bg-surface/50 text-muted">
                            <th className="px-3 py-3 text-left text-[13px] font-semibold uppercase tracking-wider">Run #</th>
                            <th className="px-3 py-3 text-left text-[13px] font-semibold uppercase tracking-wider">SKU / Recipe</th>
                            <th className="px-3 py-3 text-right text-[13px] font-semibold uppercase tracking-wider">Requested</th>
                            <th className="px-3 py-3 text-right text-[13px] font-semibold uppercase tracking-wider">Produced</th>
                            <th className="px-3 py-3 text-right text-[13px] font-semibold uppercase tracking-wider">Waste %</th>
                            <th className="px-3 py-3 text-center text-[13px] font-semibold uppercase tracking-wider">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {orderRuns.map((r) => {
                            const recipe = recipes.find((rec) => rec.id === r.recipe_id)
                            const rs = r.status ?? 'requested'
                            const w = r.waste_pct
                            return (
                              <tr key={r.id} className="border-b border-border last:border-0" style={{ height: 48 }}>
                                <td className="px-3 py-3 font-mono text-accent">{r.run_number}</td>
                                <td className="px-3 py-3">
                                  <div className="flex items-center gap-2">
                                    <RecipeIcon imageUrl={recipe?.image_url} recipeName={recipe?.name ?? '—'} coPackerColor={coPackers.find((c) => c.id === r.co_packer_id)?.color} size="sm" />
                                    <span className="font-medium text-text">{recipe ? `${recipe.name} (${recipe.sku})` : '—'}</span>
                                  </div>
                                </td>
                                <td className="px-3 py-3 text-right font-mono text-text">{r.requested_quantity.toLocaleString()} units</td>
                                <td className="px-3 py-3 text-right font-mono text-text">{r.produced_quantity != null ? `${r.produced_quantity.toLocaleString()} units` : '—'}</td>
                                <td className="px-3 py-3 text-right font-mono">
                                  {w != null ? (
                                    <span style={{ color: w <= 2.5 ? '#22C55E' : w <= 3.0 ? '#F59E0B' : '#EF4444' }}>{w.toFixed(1)}%</span>
                                  ) : '—'}
                                </td>
                                <td className="px-3 py-3 text-center">
                                  {(() => {
                                    const runTransitions = RUN_TRANSITIONS[rs] ?? []
                                    if (runTransitions.length === 0) {
                                      return <Badge color={RUN_STATUS_BADGE[rs] ?? 'gray'}>{RUN_STATUS_LABEL[rs] ?? rs}</Badge>
                                    }
                                    const opts: StatusOption[] = runTransitions.map((st) => ({
                                      value: st,
                                      label: RUN_STATUS_LABEL[st] ?? st,
                                      dotColor: STATUS_DOT_COLOR[st] ?? '#7A8599',
                                    }))
                                    return (
                                      <StatusDropdown
                                        trigger={<Badge color={RUN_STATUS_BADGE[rs] ?? 'gray'}>{RUN_STATUS_LABEL[rs] ?? rs} ▾</Badge>}
                                        options={opts}
                                        onSelect={(st) => handleRunStatusChange(r.id, rs, st)}
                                        align="right"
                                      />
                                    )
                                  })()}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Ingredient Procurement Status */}
                    {(() => {
                      const procData = orderProcurementMap.get(order.id)
                      if (!procData || procData.rows.length === 0) return null
                      const { rows: procRows, summary: procSummary } = procData
                      return (
                        <ProcurementTable
                          procRows={procRows}
                          procSummary={procSummary}
                          order={order}
                          purchaseOrders={purchaseOrders}
                          suppliers={suppliers}
                          supplierContacts={supplierContacts}
                          supplierIngredients={supplierIngredients}
                          ingredients={ingredients}
                          conversions={conversions}
                          onOrderRow={(row, sel) => handleOrderIngredientForOrder(order, row, sel)}
                          onOrderAll={(rows, selMap) => handleOrderAllMissingForOrder(order, rows, selMap)}
                          onStatusChange={handleProcurementStatusChange}
                          onETAChange={handleETAChange}
                        />
                      )
                    })()}

                    {/* CP Invoice & Payments */}
                    <InvoicePaymentSection
                      order={order}
                      runs={runs}
                      coPackers={coPackers}
                      invoices={cpInvoices}
                      payments={cpPayments}
                      onRefresh={load}
                    />

                    {/* Linked Purchase Orders */}
                    {(() => {
                      const linkedPOs = getOrderPOs(order)
                      if (linkedPOs.length === 0) return null
                      return (
                        <div className="border-t border-border pt-3">
                          <p className="mb-2 text-base font-semibold uppercase tracking-wider text-muted">Purchase Orders</p>
                          <div className="flex flex-wrap gap-2">
                            {linkedPOs.map((po) => {
                              const sup = suppliers.find((s) => s.id === po.supplier_id)
                              const st = po.status ?? 'draft'
                              const badgeColor = st === 'ordered' ? 'accent' : st === 'in_transit' ? 'cyan' : st === 'received' ? 'green' : st === 'cancelled' ? 'red' : 'gray'
                              return (
                                <span key={po.id} className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/50 px-3 py-2 text-[14px]">
                                  <span className="font-mono font-medium text-accent">{po.po_number}</span>
                                  {sup && <span className="text-muted">— {sup.name}</span>}
                                  <Badge color={badgeColor}>{st}</Badge>
                                </span>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })()}

                    {/* Notes */}
                    {order.notes && (
                      <p className="text-[14px] text-muted"><span className="font-medium text-text">Notes:</span> {order.notes}</p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── ALL RUNS TAB ───────────────────────────────────────── */}
      {tab === 'runs' && (
        <DataTable columns={runColumns} data={runRows} onRowClick={openEdit} emptyMessage="No production runs" emptyHint="Request your first production run" />
      )}

      {/* ── Request Single Run Modal ───────────────────────────── */}
      <Modal isOpen={runModalOpen} onClose={() => { setRunModalOpen(false); resetRunForm() }} title={runStep === 1 ? 'Request Production Run' : 'Material Requirements'} wide={runStep === 2}>
        {runStep === 1 ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="mb-1 block text-[13px] font-medium text-muted">Co-Packer</span>
                <select value={fCP} onChange={(e) => { setFCP(e.target.value); setFRecipe('') }} required className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent">
                  <option value="">Select…</option>
                  {coPackers.map((cp) => <option key={cp.id} value={cp.id}>{cp.name}</option>)}
                </select>
              </div>
              <div>
                <span className="mb-1 block text-[13px] font-medium text-muted">Recipe / SKU</span>
                <select value={fRecipe} onChange={(e) => setFRecipe(e.target.value)} required disabled={!fCP} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-50">
                  <option value="">{fCP ? 'Select recipe…' : 'Select CP first'}</option>
                  {cpRecipes.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.sku})</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Quantity (units)</span>
                <input type="number" min="1" step="1" value={fQty} onChange={(e) => setFQty(e.target.value)} required placeholder="e.g. 5000" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Requested Date</span>
                <input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} required className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <div>
                <span className="mb-1 block text-[13px] font-medium text-muted">Priority</span>
                <select value={fPriority} onChange={(e) => setFPriority(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent">
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
            </div>
            <p className="text-[13px] font-medium text-muted">Run # <span className="font-mono text-text">{nextRunNumber()}</span></p>
            <div className="flex justify-end gap-3 border-t border-border pt-4">
              <button type="button" onClick={() => { setRunModalOpen(false); resetRunForm() }} className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text">Cancel</button>
              <button type="button" onClick={() => setRunStep(2)} disabled={!step1Valid} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">Check Ingredients →</button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleCreateRun} className="space-y-4">
            <MRPPanel rows={mrpRows} summary={mrpSummary} cpName={coPackers.find((cp) => cp.id === fCP)?.name ?? '—'} conversions={conversions} compact />
            <div className="flex justify-end gap-3 border-t border-border pt-4">
              <button type="button" onClick={() => setRunStep(1)} className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text">← Back</button>
              <button type="submit" disabled={saving} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">{saving ? 'Saving…' : 'Request Run'}</button>
            </div>
          </form>
        )}
      </Modal>

      {/* ── Complete Run Modal ──────────────────────────────────── */}
      <Modal isOpen={completeRunId !== null} onClose={() => setCompleteRunId(null)} title="Mark Run as Complete">
        <form onSubmit={handleComplete} className="space-y-4">
          <p className="text-sm text-muted">Enter the actual quantity produced for run <span className="font-mono font-medium text-text">{runs.find((r) => r.id === completeRunId)?.run_number}</span></p>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-muted">Produced Quantity</span>
            <input type="number" min="0" step="1" value={producedQty} onChange={(e) => setProducedQty(e.target.value)} required placeholder="e.g. 4850" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
          </label>
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <button type="button" onClick={() => setCompleteRunId(null)} className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text">Cancel</button>
            <button type="submit" disabled={saving} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">{saving ? 'Saving…' : 'Complete Run'}</button>
          </div>
        </form>
      </Modal>

      {/* ── Edit Run Modal ─────────────────────────────────────── */}
      <Modal isOpen={editRun !== null} onClose={closeEdit} title="Production Run Details" wide>
        {editRun && (
          <form onSubmit={handleEditSave} className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-mono text-base font-semibold text-accent">{editRun.run_number}</span>
                {editCP && <CPBadge coPacker={editCP} />}
                <Badge color={RUN_STATUS_BADGE[editStatus] ?? 'gray'}>{RUN_STATUS_LABEL[editStatus] ?? editStatus.toUpperCase()}</Badge>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg bg-surface/50 px-4 py-3 text-[14px]">
              <div><span className="text-muted">Co-Packer</span><p className="font-medium text-text">{editCP?.name ?? '—'}</p></div>
              <div><span className="text-muted">Recipe / SKU</span><p className="font-medium text-text">{editRecipe ? `${editRecipe.name} (${editRecipe.sku})` : '—'}</p></div>
              <div><span className="text-muted">Primary Contact</span><p className="font-medium text-text">{editCPContact ? `${editCPContact.name}${editCPContact.phone ? ` · ${editCPContact.phone}` : ''}${editCPContact.email ? ` · ${editCPContact.email}` : ''}` : '—'}</p></div>
              <div><span className="text-muted">Created</span><p className="font-medium text-text">{editRun.created_at ? fmtDate(editRun.created_at) : '—'}</p></div>
            </div>
            <div className="border-t border-border pt-4">
              <div className="grid grid-cols-3 gap-4">
                <label className="block"><span className="mb-1 block text-[13px] font-medium text-muted">Requested Qty</span><input type="number" min="1" step="1" value={eReqQty} onChange={(e) => setEReqQty(e.target.value)} disabled={!canEditBasic} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-50" /></label>
                <label className="block"><span className="mb-1 block text-[13px] font-medium text-muted">Requested Date</span><input type="date" value={eReqDate} onChange={(e) => setEReqDate(e.target.value)} disabled={!canEditBasic} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-50" /></label>
                <div><span className="mb-1 block text-[13px] font-medium text-muted">Priority</span><select value={ePriority} onChange={(e) => setEPriority(e.target.value)} disabled={!canEditBasic} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-50"><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></div>
              </div>
              <label className="mt-4 block"><span className="mb-1 block text-[13px] font-medium text-muted">Your Notes</span><textarea value={eYourNotes} onChange={(e) => setEYourNotes(e.target.value)} rows={2} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent" placeholder="Internal notes about this run…" /></label>
            </div>
            {showAdvanced && (
              <div className="border-t border-border pt-4">
                <p className="mb-3 text-base font-semibold uppercase tracking-wider text-muted">Production Details</p>
                <div className="grid grid-cols-2 gap-4">
                  <label className="block"><span className="mb-1 block text-[13px] font-medium text-muted">Produced Qty</span><input type="number" min="0" step="1" value={eProducedQty} onChange={(e) => setEProducedQty(e.target.value)} disabled={!canEditProduced} placeholder="—" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-50" /></label>
                  <div className="grid grid-cols-2 gap-4">
                    <div><span className="mb-1 block text-[13px] font-medium text-muted">Started</span><p className="rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm text-muted">{editRun.started_date ? fmtDate(editRun.started_date) : '—'}</p></div>
                    <div><span className="mb-1 block text-[13px] font-medium text-muted">Completed</span><p className="rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm text-muted">{editRun.completed_date ? fmtDate(editRun.completed_date) : '—'}</p></div>
                  </div>
                </div>
                <label className="mt-4 block"><span className="mb-1 block text-[13px] font-medium text-muted">Co-Packer Notes</span><textarea value={eCpNotes} onChange={(e) => setECpNotes(e.target.value)} rows={2} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent" placeholder="Notes from the co-packer…" /></label>
              </div>
            )}
            {editMRPRows.length > 0 && (
              <div className="border-t border-border pt-4">
                <MRPPanel rows={editMRPRows} summary={editMRPSummary} cpName={editCP?.name ?? '—'} conversions={conversions}
                  onCreatePOs={() => { setMRPContext({ rows: editMRPRows, cpId: editRun.co_packer_id ?? '', cpName: editCP?.name ?? '—', orderId: editRun.production_order_id ?? null }); closeEdit(); setMRPPOOpen(true) }}
                />
              </div>
            )}
            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>{canEditBasic && can('delete_any') && (<button type="button" onClick={() => setConfirmDelete(true)} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium text-red-400 transition-colors hover:bg-red-400/10"><Trash2 size={14} /> Delete Run</button>)}</div>
              <div className="flex gap-3">
                <button type="button" onClick={closeEdit} className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text">Cancel</button>
                <button type="submit" disabled={saving} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">{saving ? 'Saving…' : 'Save Changes'}</button>
              </div>
            </div>
          </form>
        )}
      </Modal>

      {/* ── Delete Run Confirm ─────────────────────────────────── */}
      <ConfirmDialog isOpen={confirmDelete} title="Delete Production Run" message="Are you sure? This cannot be undone." confirmLabel="Yes, Delete" danger loading={saving} onConfirm={handleDeleteRun} onCancel={() => setConfirmDelete(false)} />

      {/* ── Complete Order Modal ───────────────────────────────── */}
      <Modal isOpen={completeOrderId !== null} onClose={() => setCompleteOrderId(null)} title="Complete Production Order">
        <form onSubmit={handleCompleteOrder} className="space-y-4">
          <p className="text-sm text-muted">Enter the produced quantity for each flavor:</p>
          <div className="space-y-3">
            {runs.filter((r) => r.production_order_id === completeOrderId).map((r) => {
              const recipe = recipes.find((rec) => rec.id === r.recipe_id)
              return (
                <div key={r.id} className="flex items-center gap-4">
                  <div className="flex-1">
                    <p className="text-sm text-text">{recipe ? `${recipe.name} (${recipe.sku})` : r.run_number}</p>
                    <p className="text-[13px] text-muted">Requested: {r.requested_quantity.toLocaleString()} units</p>
                  </div>
                  <input type="number" min="0" step="1" value={completeOrderQtys[r.id] ?? ''} onChange={(e) => setCompleteOrderQtys((prev) => ({ ...prev, [r.id]: e.target.value }))} placeholder="Produced" className="w-32 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
                </div>
              )
            })}
          </div>
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <button type="button" onClick={() => setCompleteOrderId(null)} className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text">Cancel</button>
            <button type="submit" disabled={saving} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">{saving ? 'Saving…' : 'Complete Order'}</button>
          </div>
        </form>
      </Modal>

      {/* ── Edit Production Order Modal ──────────────────────── */}
      <Modal isOpen={!!editOrder} onClose={closeEditOrder} title="Edit Production Order" wide="3xl">
        {editOrder && (() => {
          const eoCP = coPackers.find((c) => c.id === editOrderForm.co_packer_id)
          const cpFee = eoCP?.fee_per_unit ?? 0
          return (
            <div className="space-y-4">
              {/* Header */}
              <div className="flex items-center gap-3">
                <span className="font-mono text-base font-semibold text-accent">{editOrder.order_number}</span>
                {eoCP && <CPBadge coPacker={eoCP} />}
                <Badge color={ORDER_STATUS_BADGE[editOrderForm.status] ?? 'gray'}>{ORDER_STATUS_LABEL[editOrderForm.status] ?? editOrderForm.status}</Badge>
              </div>

              {/* Fields */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="mb-1 block text-[13px] font-medium text-muted">Co-Packer</span>
                  <select value={editOrderForm.co_packer_id} onChange={(e) => handleEditOrderCPChange(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent">
                    <option value="">Select co-packer…</option>
                    {coPackers.map((cp) => <option key={cp.id} value={cp.id}>{cp.name}</option>)}
                  </select>
                </div>
                <div>
                  <span className="mb-1 block text-[13px] font-medium text-muted">Status</span>
                  <select value={editOrderForm.status} onChange={(e) => setEditOrderForm((f) => ({ ...f, status: e.target.value }))} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent">
                    {ORDER_MANUAL_STATUSES.map((s) => <option key={s} value={s}>{ORDER_STATUS_LABEL[s]}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <label className="block"><span className="mb-1 block text-[13px] font-medium text-muted">Order Date</span><input type="date" value={editOrderForm.order_date} onChange={(e) => setEditOrderForm((f) => ({ ...f, order_date: e.target.value }))} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent" /></label>
                <label className="block"><span className="mb-1 block text-[13px] font-medium text-muted">Requested Start Date</span><input type="date" value={editOrderForm.requested_start_date} onChange={(e) => setEditOrderForm((f) => ({ ...f, requested_start_date: e.target.value }))} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent" /></label>
                <label className="block"><span className="mb-1 block text-[13px] font-medium text-muted">Est. Completion Date</span><input type="date" value={editOrderForm.estimated_completion_date} onChange={(e) => setEditOrderForm((f) => ({ ...f, estimated_completion_date: e.target.value }))} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent" /></label>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <span className="mb-1 block text-[13px] font-medium text-muted">Priority</span>
                  <select value={editOrderForm.priority} onChange={(e) => setEditOrderForm((f) => ({ ...f, priority: e.target.value }))} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent">
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
              </div>
              <label className="block"><span className="mb-1 block text-[13px] font-medium text-muted">Notes</span><textarea value={editOrderForm.notes} onChange={(e) => setEditOrderForm((f) => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Optional notes…" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text placeholder:text-muted/50 outline-none focus:border-accent resize-none" /></label>

              {/* Flavors / Runs */}
              <div className="border-t border-border pt-4">
                <p className="mb-3 text-base font-semibold uppercase tracking-wider text-muted">Flavors / Runs ({editOrderRuns.filter((r) => !r._deleted).length})</p>
                <div className="space-y-3">
                  {editOrderRuns.map((run, idx) => {
                    if (run._deleted) return null
                    const recipe = recipes.find((r) => r.id === run.recipe_id)
                    const cogs = recipe ? (recipeCOGS.get(recipe.id) ?? 0) : 0
                    const unitCost = cogs + cpFee
                    const lineTotal = run.requested_quantity ? Number(run.requested_quantity) * unitCost : 0
                    const runInProgress = run.status === 'in_production' || run.status === 'complete' || run.status === 'reconciled' || run.status === 'flagged'
                    const canEditProducedQty = run.status === 'in_production' || run.status === 'complete'
                    return (
                      <div key={run.id ?? `new-${idx}`} className="grid grid-cols-[1fr_90px_90px_90px_70px_90px_100px_90px_36px] items-end gap-2">
                        <div>
                          {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">Recipe / SKU</span>}
                          <select value={run.recipe_id} onChange={(e) => updateEditOrderRun(idx, 'recipe_id', e.target.value)} disabled={runInProgress} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent disabled:opacity-50">
                            <option value="">Select recipe…</option>
                            {editOrderCPRecipes.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.sku})</option>)}
                          </select>
                        </div>
                        <div>
                          {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">Requested</span>}
                          <input type="number" min="1" step="1" value={run.requested_quantity} onChange={(e) => updateEditOrderRun(idx, 'requested_quantity', e.target.value)} placeholder="Qty" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent" />
                        </div>
                        <div>
                          {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">Produced</span>}
                          <input type="number" min="0" step="1" value={run.produced_quantity} onChange={(e) => updateEditOrderRun(idx, 'produced_quantity', e.target.value)} disabled={!canEditProducedQty} placeholder="—" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent disabled:opacity-50" />
                        </div>
                        <div>
                          {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">COGS/unit</span>}
                          <p className="rounded-lg border border-border bg-surface/50 px-2 py-2 text-[14px] font-mono text-muted">{run.recipe_id ? fmtRate(cogs) : '—'}</p>
                        </div>
                        <div>
                          {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">CP Fee</span>}
                          <p className="rounded-lg border border-border bg-surface/50 px-2 py-2 text-[14px] font-mono text-muted">{run.recipe_id ? fmtRate(cpFee) : '—'}</p>
                        </div>
                        <div>
                          {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">Total/unit</span>}
                          <p className="rounded-lg border border-border bg-surface/50 px-2 py-2 text-[14px] font-mono text-accent">{run.recipe_id ? fmtRate(unitCost) : '—'}</p>
                        </div>
                        <div>
                          {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">Line Total</span>}
                          <p className="rounded-lg border border-border bg-surface/50 px-2 py-2 text-[14px] font-mono text-text">{lineTotal > 0 ? fmt$(lineTotal) : '—'}</p>
                        </div>
                        <div>
                          {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">Status</span>}
                          <select value={run.status} onChange={(e) => updateEditOrderRun(idx, 'status', e.target.value)} className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-[14px] text-text outline-none focus:border-accent">
                            {MANUAL_STATUSES.map((s) => <option key={s} value={s}>{RUN_STATUS_LABEL[s]}</option>)}
                          </select>
                        </div>
                        <div className={idx === 0 ? 'mt-5' : ''}>
                          {can('delete_any') && (
                            <button type="button" onClick={() => handleRemoveEditOrderRun(idx)} className="flex h-[38px] items-center justify-center rounded-lg text-muted transition-colors hover:text-red-400">
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <button type="button" onClick={handleAddEditOrderFlavor} className="mt-3 flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium text-accent transition-colors hover:bg-accent/10">
                  <Plus size={14} /> Add Flavor
                </button>
              </div>

              {/* Totals */}
              <div className="flex items-center justify-between border-t border-border pt-3">
                <div className="flex gap-6 text-[14px] text-muted">
                  <span>Flavors: <span className="font-medium text-text">{editOrderTotals.flavors}</span></span>
                  <span>Total Units: <span className="font-mono font-medium text-text">{editOrderTotals.totalUnits.toLocaleString()}</span></span>
                </div>
                <span className="font-mono text-sm font-semibold text-text">{fmt$(editOrderTotals.totalCost)}</span>
              </div>

              {/* Ingredient Procurement Status */}
              {editOrderProcurement && editOrderProcurement.rows.length > 0 && editOrder && (
                <ProcurementTable
                  procRows={editOrderProcurement.rows}
                  procSummary={editOrderProcurement.summary}
                  order={editOrder}
                  purchaseOrders={purchaseOrders}
                  suppliers={suppliers}
                  supplierContacts={supplierContacts}
                  supplierIngredients={supplierIngredients}
                  ingredients={ingredients}
                  conversions={conversions}
                  onOrderRow={(row, sel) => handleOrderIngredient(row, sel)}
                  onOrderAll={(rows, selMap) => handleOrderAllMissing(rows, selMap)}
                  onStatusChange={handleProcurementStatusChange}
                  onETAChange={handleETAChange}
                />
              )}

              {/* CP Invoice & Payments (in edit modal) */}
              <InvoicePaymentSection
                order={editOrder}
                runs={runs}
                coPackers={coPackers}
                invoices={cpInvoices}
                payments={cpPayments}
                onRefresh={load}
              />

              {/* Linked Purchase Orders */}
              {(() => {
                const linkedPOs = getOrderPOs(editOrder)
                if (linkedPOs.length === 0) return null
                return (
                  <div className="border-t border-border pt-3">
                    <p className="mb-2 text-base font-semibold uppercase tracking-wider text-muted">Linked Purchase Orders</p>
                    <div className="flex flex-wrap gap-2">
                      {linkedPOs.map((po) => {
                        const sup = suppliers.find((s) => s.id === po.supplier_id)
                        const st = po.status ?? 'draft'
                        const badgeColor: BadgeColor = st === 'ordered' ? 'accent' : st === 'in_transit' ? 'accent' : st === 'received' ? 'green' : st === 'cancelled' ? 'red' : 'gray'
                        return (
                          <span key={po.id} className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/50 px-2.5 py-1.5 text-[14px]">
                            <span className="font-mono font-medium text-accent">{po.po_number}</span>
                            {sup && <span className="text-muted">— {sup.name}</span>}
                            {po.total_cost != null && Number(po.total_cost) > 0 && <span className="font-mono text-muted">{fmt$(Number(po.total_cost))}</span>}
                            <Badge color={badgeColor}>{st}</Badge>
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

              {/* Inbound Shipments */}
              {(() => {
                const orderPOIds = new Set(purchaseOrders.filter((po) => po.production_order_id === editOrder.id).map((po) => po.id))
                const linkedShipments = shipments.filter(
                  (s) => s.production_order_id === editOrder.id || (s.purchase_order_id && orderPOIds.has(s.purchase_order_id)),
                )
                if (linkedShipments.length === 0) return null
                return (
                  <div className="border-t border-border pt-3">
                    <p className="mb-2 text-base font-semibold uppercase tracking-wider text-muted">Inbound Shipments</p>
                    <div className="space-y-1.5">
                      {linkedShipments.map((s) => {
                        const sItems = shipmentItems.filter((si) => si.shipment_id === s.id)
                        const itemDescs = sItems.map((si) => {
                          const ing = ingredients.find((i) => i.id === si.ingredient_id)
                          return `${Math.round(si.quantity).toLocaleString()} ${ing?.unit ?? ''} ${ing?.name ?? '?'}`
                        }).join(', ')
                        const sup = s.supplier_id ? suppliers.find((sp) => sp.id === s.supplier_id) : null
                        const st = s.status ?? 'ordered'
                        const badgeColor: BadgeColor = st === 'received' || st === 'confirmed' ? 'green' : st === 'in_transit' ? 'accent' : st === 'cancelled' ? 'red' : 'gray'
                        return (
                          <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface/30 px-2.5 py-2 text-[14px]">
                            <span className="font-mono font-medium text-accent">{s.shipment_number}</span>
                            {sup && <span className="text-muted">from {sup.name}</span>}
                            {itemDescs && <span className="text-muted">{'\u2014'} {itemDescs}</span>}
                            <Badge color={badgeColor}>{st === 'confirmed' ? '\u2713 Confirmed' : st === 'in_transit' ? 'In Transit' : st.charAt(0).toUpperCase() + st.slice(1)}</Badge>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

              {/* Footer */}
              <div className="flex items-center justify-between border-t border-border pt-4">
                {can('delete_any') && (
                  <button type="button" onClick={() => setConfirmDeleteOrder(true)} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium text-red-400 transition-colors hover:bg-red-400/10">
                    <Trash2 size={13} /> Delete Order
                  </button>
                )}
                {!can('delete_any') && <div />}
                <div className="flex gap-3">
                  <button type="button" onClick={closeEditOrder} className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text">Cancel</button>
                  <button type="button" onClick={handleSaveOrder} disabled={saving} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">{saving ? 'Saving…' : 'Save Changes'}</button>
                </div>
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* ── Delete Order Confirm ──────────────────────────────── */}
      <ConfirmDialog
        isOpen={confirmDeleteOrder}
        title={`Delete ${editOrder?.order_number ?? 'this order'}?`}
        message="This will permanently delete this production order, all its production runs, and unlink any purchase orders. This cannot be undone."
        confirmLabel="Delete Order"
        danger
        loading={saving}
        onConfirm={handleDeleteOrder}
        onCancel={() => setConfirmDeleteOrder(false)}
      />

      {/* ── Remove In-Progress Run Confirm ────────────────────── */}
      <ConfirmDialog
        isOpen={confirmRemoveRunIdx !== null}
        title="Remove Run?"
        message="This run is already in production. Are you sure you want to remove it?"
        confirmLabel="Yes, Remove"
        danger
        onConfirm={() => { if (confirmRemoveRunIdx !== null) doRemoveEditOrderRun(confirmRemoveRunIdx) }}
        onCancel={() => setConfirmRemoveRunIdx(null)}
      />

      {/* ── Change Co-Packer Warning ─────────────────────────── */}
      <ConfirmDialog
        isOpen={cpChangeWarning}
        title="Change Co-Packer?"
        message="Changing co-packer will clear all flavors since recipes are co-packer specific."
        confirmLabel="Change Co-Packer"
        danger={false}
        onConfirm={confirmCPChange}
        onCancel={() => { setCPChangeWarning(false); setPendingCP('') }}
      />

      {/* ── Order Status Confirmation Dialog ───────────────────── */}
      {orderStatusConfirm && (() => {
        const cfg = ORDER_CONFIRM_MESSAGES[orderStatusConfirm.newStatus]
        if (!cfg) return null
        const orderRuns = runs.filter((r) => r.production_order_id === orderStatusConfirm.orderId)
        const cascadeRuns = orderStatusConfirm.newStatus === 'in_production'
          ? orderRuns.filter((r) => r.status === 'requested' || r.status === 'scheduled')
          : orderStatusConfirm.newStatus === 'cancelled'
            ? orderRuns.filter((r) => r.status !== 'complete' && r.status !== 'reconciled')
            : orderStatusConfirm.newStatus === 'on_hold'
              ? orderRuns.filter((r) => r.status === 'in_production' || r.status === 'scheduled')
              : []
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center">
            <div className="absolute inset-0 bg-overlay" onClick={() => setOrderStatusConfirm(null)} />
            <div className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl">
              <div className="mb-4 flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-full ${cfg.danger ? 'bg-red-500/15' : 'bg-accent/15'}`}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cfg.danger ? 'text-red-400' : 'text-accent'}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-text">{cfg.title}</h3>
                  <p className="mt-0.5 text-xs text-muted">{cfg.message}</p>
                </div>
              </div>
              {cascadeRuns.length > 0 && (
                <label className="mb-4 flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={orderStatusConfirm.cascade}
                    onChange={(e) => setOrderStatusConfirm({ ...orderStatusConfirm, cascade: e.target.checked })}
                    className="accent-accent"
                  />
                  Also update {cascadeRuns.length} production run{cascadeRuns.length !== 1 ? 's' : ''} to{' '}
                  {(orderStatusConfirm.newStatus === 'cancelled' || orderStatusConfirm.newStatus === 'on_hold') ? 'Flagged' : ORDER_STATUS_LABEL[orderStatusConfirm.newStatus] ?? orderStatusConfirm.newStatus}
                </label>
              )}
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setOrderStatusConfirm(null)}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
                >
                  Cancel
                </button>
                <button
                  onClick={() => executeOrderStatusChange(orderStatusConfirm.orderId, orderStatusConfirm.newStatus, orderStatusConfirm.cascade)}
                  disabled={saving}
                  className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 ${cfg.danger ? 'bg-red-500 hover:bg-red-600' : 'bg-accent hover:bg-accent-hover'}`}
                >
                  {saving ? 'Working…' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── New Production Order Modal (3-step) ────────────────── */}
      <Modal isOpen={orderModalOpen} onClose={() => { setOrderModalOpen(false); resetOrderForm() }} title={orderStep === 1 ? 'New Production Order — Select Co-Packer' : orderStep === 2 ? 'New Production Order — Add Flavors' : 'New Production Order — Ingredient Requirements'} wide={orderStep >= 2 ? '3xl' : undefined}>
        {orderStep === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="mb-1 block text-[13px] font-medium text-muted">Co-Packer</span>
                <select value={oCP} onChange={(e) => { setOCP(e.target.value); setOFlavors([{ recipeId: '', quantity: '' }]) }} required className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent">
                  <option value="">Select co-packer…</option>
                  {coPackers.map((cp) => <option key={cp.id} value={cp.id}>{cp.name}</option>)}
                </select>
              </div>
              <div>
                <span className="mb-1 block text-[13px] font-medium text-muted">Order Number</span>
                <input readOnly value={nextOrderNumber()} className="w-full rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm font-mono text-muted outline-none" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <label className="block"><span className="mb-1 block text-[13px] font-medium text-muted">Order Date</span><input type="date" value={oDate} onChange={(e) => setODate(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" /></label>
              <label className="block"><span className="mb-1 block text-[13px] font-medium text-muted">Requested Start Date</span><input type="date" value={oStartDate} onChange={(e) => setOStartDate(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" /></label>
              <div><span className="mb-1 block text-[13px] font-medium text-muted">Priority</span><select value={oPriority} onChange={(e) => setOPriority(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></div>
            </div>
            <label className="block"><span className="mb-1 block text-[13px] font-medium text-muted">Notes</span><textarea value={oNotes} onChange={(e) => setONotes(e.target.value)} rows={2} placeholder="Optional notes for the co-packer…" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent resize-none" /></label>
            <div className="flex justify-end gap-3 border-t border-border pt-4">
              <button type="button" onClick={() => { setOrderModalOpen(false); resetOrderForm() }} className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text">Cancel</button>
              <button type="button" onClick={() => setOrderStep(2)} disabled={!oCP} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">Add Flavors →</button>
            </div>
          </div>
        )}

        {orderStep === 2 && (
          <div className="space-y-4">
            <p className="text-[14px] text-muted">Add the flavors/SKUs for this production order.</p>
            <div className="space-y-3">
              {oFlavors.map((fl, idx) => {
                const recipe = recipes.find((r) => r.id === fl.recipeId)
                const cogs = recipe ? (recipeCOGS.get(recipe.id) ?? 0) : 0
                const cpFee = coPackers.find((c) => c.id === oCP)?.fee_per_unit ?? 0
                const unitCost = cogs + cpFee
                const lineTotal = fl.quantity ? Number(fl.quantity) * unitCost : 0
                return (
                  <div key={idx} className="grid grid-cols-[1fr_100px_90px_70px_90px_100px_36px] items-end gap-2">
                    <div>
                      {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">Recipe / SKU</span>}
                      <select value={fl.recipeId} onChange={(e) => { const next = [...oFlavors]; next[idx] = { ...next[idx], recipeId: e.target.value }; setOFlavors(next) }} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent">
                        <option value="">Select recipe…</option>
                        {oCPRecipes.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.sku})</option>)}
                      </select>
                    </div>
                    <div>
                      {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">Quantity</span>}
                      <input type="number" min="1" step="1" value={fl.quantity} onChange={(e) => { const next = [...oFlavors]; next[idx] = { ...next[idx], quantity: e.target.value }; setOFlavors(next) }} placeholder="e.g. 5000" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
                    </div>
                    <div>
                      {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">COGS/unit</span>}
                      <p className="rounded-lg border border-border bg-surface/50 px-2 py-2 text-[14px] font-mono text-muted">{fl.recipeId ? fmtRate(cogs) : '—'}</p>
                    </div>
                    <div>
                      {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">CP Fee</span>}
                      <p className="rounded-lg border border-border bg-surface/50 px-2 py-2 text-[14px] font-mono text-muted">{fl.recipeId ? fmtRate(cpFee) : '—'}</p>
                    </div>
                    <div>
                      {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">Total/unit</span>}
                      <p className="rounded-lg border border-border bg-surface/50 px-2 py-2 text-[14px] font-mono text-accent">{fl.recipeId ? fmtRate(unitCost) : '—'}</p>
                    </div>
                    <div>
                      {idx === 0 && <span className="mb-1 block text-[13px] font-medium text-muted">Line Total</span>}
                      <p className="rounded-lg border border-border bg-surface/50 px-2 py-2 text-[14px] font-mono text-text">{lineTotal > 0 ? fmt$(lineTotal) : '—'}</p>
                    </div>
                    <div className={idx === 0 ? 'mt-5' : ''}>
                      <button type="button" onClick={() => { if (oFlavors.length > 1) setOFlavors(oFlavors.filter((_, i) => i !== idx)) }} disabled={oFlavors.length <= 1} className="flex h-[38px] items-center justify-center rounded-lg text-muted transition-colors hover:text-red-400 disabled:opacity-30">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
            <button type="button" onClick={() => setOFlavors([...oFlavors, { recipeId: '', quantity: '' }])} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium text-accent transition-colors hover:bg-accent/10">
              <Plus size={14} /> Add Another Flavor
            </button>

            {/* Running totals */}
            <div className="flex items-center justify-between border-t border-border pt-3">
              <div className="flex gap-6 text-[14px] text-muted">
                <span>Flavors: <span className="font-medium text-text">{validFlavors.length}</span></span>
                <span>Total Units: <span className="font-mono font-medium text-text">{orderTotalUnits.toLocaleString()}</span></span>
              </div>
              <span className="font-mono text-sm font-semibold text-text">{fmt$(orderTotalCost)}</span>
            </div>

            <div className="flex justify-end gap-3 border-t border-border pt-4">
              <button type="button" onClick={() => setOrderStep(1)} className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text">← Back</button>
              <button type="button" onClick={() => setOrderStep(3)} disabled={validFlavors.length === 0} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">Check Ingredients →</button>
            </div>
          </div>
        )}

        {orderStep === 3 && (
          <div className="space-y-4">
            <MRPPanel
              rows={orderMRPRows}
              summary={orderMRPSummary}
              cpName={coPackers.find((c) => c.id === oCP)?.name ?? '—'}
              conversions={conversions}
              onCreatePOs={() => { setMRPContext({ rows: orderMRPRows, cpId: oCP, cpName: coPackers.find((c) => c.id === oCP)?.name ?? '—', orderId: null }); setMRPPOOpen(true) }}
            />
            <div className="flex justify-end gap-3 border-t border-border pt-4">
              <button type="button" onClick={() => setOrderStep(2)} className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text">← Back</button>
              <button type="button" onClick={handleCreateOrder} disabled={saving} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">{saving ? 'Creating…' : `Create Order (${validFlavors.length} flavor${validFlavors.length !== 1 ? 's' : ''})`}</button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── MRP Create PO Modal ────────────────────────────────── */}
      <MRPCreatePOModal
        isOpen={mrpPOOpen}
        onClose={() => { setMRPPOOpen(false); setMRPContext(null) }}
        onCreated={load}
        shortfallRows={mrpContext?.rows ?? editMRPRows}
        coPackerId={mrpContext?.cpId ?? editRun?.co_packer_id ?? ''}
        cpName={mrpContext?.cpName ?? editCP?.name ?? '—'}
        ingredients={ingredients}
        suppliers={suppliers}
        supplierContacts={supplierContacts}
        supplierIngredients={supplierIngredients}
        purchaseOrders={purchaseOrders}
        coPackers={coPackers}
        conversions={conversions}
        productionOrderId={mrpContext?.orderId ?? null}
      />

    </div>
  )
}
