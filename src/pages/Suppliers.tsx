import { useEffect, useRef, useState, type FormEvent } from 'react'
import { format } from 'date-fns'
import { supabase } from '../lib/supabase'
import { sanitize } from '../lib/sanitizePayload'
import { dbInsert, dbInsertSingle, dbUpdate, dbDelete, dbDeleteIn } from '../lib/dbWrite'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { fmt$, fmtRate, fmtDate, fmtQty } from '../lib/format'
import { downloadCSV } from '../lib/csv'
import { type ConversionMap, getConversionFactorWithDensity, loadConversions, normalizeUnit, RECIPE_UNITS } from '../lib/conversions'
import PageHeader from '../components/PageHeader'
import DataTable, { type Column } from '../components/DataTable'
import Badge from '../components/Badge'
import CPBadge from '../components/CPBadge'
import Modal from '../components/Modal'
import ConfirmDialog from '../components/ConfirmDialog'
import { PageSkeleton } from '../components/Skeleton'
import { useToast } from '../components/Toast'
import { Plus, Star, Mail, Clock, CreditCard, Trash2, Download, Upload, X, Pencil, PackageSearch, FileDown, Printer } from 'lucide-react'
import Papa from 'papaparse'
import { generatePO_PDF, type POPDFData } from '../lib/generatePO_PDF'
import SearchInput from '../components/SearchInput'
import { useAuth } from '../contexts/AuthContext'
import { logActivity } from '../lib/activityLog'
import CostGuard from '../components/CostGuard'
import type {
  Supplier,
  Ingredient,
  IngredientInventory,
  CoPacker,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderInsert,
  PurchaseOrderItemInsert,
  SupplierIngredient,
  SupplierContact,
  PurchaseOrderUpdate,
  ShipmentToCopacker,
  ShipmentItemInsert,
  ProductionOrder,
  ProductionRun,
  RecipeIngredient,
  IngredientTag,
  IngredientTagLink,
} from '../types/database'
import { nextShipmentNumber, findDefaultSI, findAllSIOptions, findSupplierOptions } from '../lib/mrp'
import { syncIngredientStatus } from '../lib/syncIngredientStatus'

/* ────────── helpers ────────── */

const STATUS_BADGE: Record<string, 'gray' | 'accent' | 'cyan' | 'green' | 'red'> = {
  draft: 'gray',
  ordered: 'accent',
  in_transit: 'cyan',
  received: 'green',
  cancelled: 'red',
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  ordered: 'Ordered',
  in_transit: 'In Transit',
  received: 'Received',
  cancelled: 'Cancelled',
}

const PO_FILTERS = ['all', 'ordered', 'in_transit', 'received'] as const

const ORDER_TYPES = [
  { value: 'po', label: 'Purchase Order', prefix: '#', icon: '📄' },
  { value: 'email', label: 'Email Order', prefix: 'EM-', icon: '✉️' },
  { value: 'online', label: 'Online Order', prefix: 'ON-', icon: '🌐' },
  { value: 'phone', label: 'Phone Order', prefix: 'PH-', icon: '📞' },
  { value: 'standing_order', label: 'Standing Order', prefix: 'SO-', icon: '🔄' },
  { value: 'other', label: 'Other', prefix: 'OR-', icon: '📋' },
] as const

const ORDER_TYPE_FILTERS = ['all', 'po', 'email', 'online', 'phone', 'standing_order'] as const

const PAYMENT_METHODS = [
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'ach', label: 'ACH / Bank Transfer' },
  { value: 'wire', label: 'Wire Transfer' },
  { value: 'check', label: 'Check' },
  { value: 'net_terms', label: 'Net Terms' },
  { value: 'other', label: 'Other' },
] as const

const PAYMENT_STATUSES = [
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'paid', label: 'Paid' },
  { value: 'partial', label: 'Partial' },
  { value: 'refunded', label: 'Refunded' },
] as const

const SHIPPING_METHODS = [
  'Ground',
  'Freight (LTL)',
  'Freight (FTL)',
  'Express / Overnight',
  'Free Shipping',
  'Included in Price',
  'Pickup',
  'Other',
] as const

const CONTACT_ROLES = ['Sales Rep', 'Account Manager', 'Billing', 'Owner', 'Shipping', 'Other'] as const
const PACKAGE_NAMES = ['bag', 'box', 'drum', 'pail', 'case', 'bottle', 'jar', 'bucket', 'carton', 'tote', 'other'] as const

interface ContactRow {
  id: string | null  // null = unsaved new row
  name: string
  email: string
  phone: string
  role: string
  is_primary: boolean
  _deleted?: boolean
}

/* ────────── CSV import types ────────── */

interface CSVSupplierRow {
  supplier_name: string
  supplier_id: string
  lead_time_days: string
  payment_terms: string
  rating: string
  notes: string
  contact_name: string
  contact_email: string
  contact_phone: string
  contact_role: string
  additional_contacts: string
  ingredient_name: string
  supplier_item_name: string
  price_per_unit: string
  price_unit: string
  package_size: string
  package_unit: string
  package_name: string
  price_per_package: string
  supplier_sku: string
  min_order_packages: string
  packages_per_case: string
  is_default: string
}

interface ParsedContact {
  name: string
  email: string
  phone: string
  role: string
  is_primary: boolean
}

interface ParsedIngredient {
  ingredient_name: string
  ingredient_id: string | null
  supplier_item_name: string
  price_per_unit: number | null
  price_unit: string
  package_size: number | null
  package_unit: string
  package_name: string
  price_per_package: number | null
  supplier_sku: string
  min_order_packages: number | null
  packages_per_case: number | null
  is_default: boolean
}

interface ParsedSupplierGroup {
  supplier_id: string | null
  supplier_name: string
  lead_time_days: number | null
  payment_terms: string
  rating: number | null
  notes: string
  contacts: ParsedContact[]
  ingredients: ParsedIngredient[]
}

interface ImportChanges {
  fieldsChanged: string[]
  contactsAdded: number
  contactsRemoved: number
  ingredientsAdded: string[]
  ingredientsUpdated: string[]
  ingredientsRemoved: string[]
}

interface ImportDiff {
  newSuppliers: ParsedSupplierGroup[]
  updatedSuppliers: { group: ParsedSupplierGroup; changes: ImportChanges }[]
  errors: { row: number; message: string }[]
  warnings: { row: number; message: string }[]
}

/* ────────── flat row type for DataTable ────────── */

interface PORow extends Record<string, unknown> {
  id: string
  po_number: string
  order_type: string
  supplierName: string
  items: string
  total_cost: number | null
  shipping_cost: number | null
  shipping_method: string | null
  destination_type: string | null
  destination_co_packer_id: string | null
  order_date: string | null
  eta_date: string | null
  status: string
  production_order_id: string | null
}

/* ────────── line-item state for the create modal ────────── */

type CostSource = 'supplier' | 'last_cost' | 'weighted_avg' | 'manual' | ''

interface LineItem {
  ingredient_id: string
  quantity: number
  unit_cost: number
  quantity_unit: string
  cost_source: CostSource
  selectedSIId?: string
  qtyPackages?: number
  packageName?: string
  packageSize?: number
  packageUnit?: string
  pricePerPackage?: number
}

interface EditLineItem {
  id: string | null  // null = new unsaved line
  ingredient_id: string
  quantity: number
  unit_cost: number
  quantity_unit: string
  cost_source: CostSource
  received_quantity: number | null
  _deleted?: boolean
  selectedSIId?: string
  qtyPackages?: number
  packageName?: string
  packageSize?: number
  packageUnit?: string
  pricePerPackage?: number
}

/* ════════════════════════════════════════════════════════════ */

export default function Suppliers() {
  const toast = useToast()
  const { can, appUser } = useAuth()

  /* loading state */
  const [loading, setLoading] = useState(true)

  /* shared lookup data */
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [supplierIngredients, setSupplierIngredients] = useState<SupplierIngredient[]>([])
  const [supplierContacts, setSupplierContacts] = useState<SupplierContact[]>([])
  const [conversions, setConversions] = useState<ConversionMap>(new Map())

  /* PO data */
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [poItems, setPOItems] = useState<PurchaseOrderItem[]>([])
  const [inventory, setInventory] = useState<IngredientInventory[]>([])
  const [tags, setTags] = useState<IngredientTag[]>([])
  const [tagLinks, setTagLinks] = useState<IngredientTagLink[]>([])
  const [shipments, setShipments] = useState<ShipmentToCopacker[]>([])
  const [productionOrders, setProductionOrders] = useState<ProductionOrder[]>([])
  const [prodOrderRuns, setProdOrderRuns] = useState<ProductionRun[]>([])
  const [prodOrderRecipeIngs, setProdOrderRecipeIngs] = useState<RecipeIngredient[]>([])
  const [poFilter, setPOFilter] = useState<string>('all')
  const [poTypeFilter, setPOTypeFilter] = useState<string>('all')
  const [supplierSearch, setSupplierSearch] = useState('')
  const [poSearch, setPOSearch] = useState('')

  /* modals */
  const [poModalOpen, setPOModalOpen] = useState(false)
  const [supplierModalOpen, setSupplierModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  /* supplier edit modal */
  const [detailSupplier, setDetailSupplier] = useState<Supplier | null>(null)
  const [editForm, setEditForm] = useState({
    name: '', lead_time_days: '', payment_terms: '', rating: '', notes: '',
  })
  const [editContacts, setEditContacts] = useState<ContactRow[]>([])
  const [detailIngredients, setDetailIngredients] = useState<
    {
      si_id: string; ingredient_id: string; name: string; unit: string
      price_per_unit: number | null; price_unit: string
      package_size: number | null; package_unit: string; package_name: string
      price_per_package: number | null; supplier_sku: string
      supplier_item_name: string
      min_order_packages: number | null; packages_per_case: number | null
      is_default: boolean
    }[]
  >([])
  const [addIngId, setAddIngId] = useState('')
  const [debugLog, setDebugLog] = useState<string[]>([])
  const dbg = (msg: string) => {
    const ts = new Date().toLocaleTimeString()
    setDebugLog((prev) => [...prev, `${ts}: ${msg}`])
    console.log(`[SUPPLIER-DEBUG] ${ts}: ${msg}`)
  }

  /* confirm dialog for supplier delete */
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [pendingDeleteSupplier, setPendingDeleteSupplier] = useState<Supplier | null>(null)

  /* CSV import */
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importDiff, setImportDiff] = useState<ImportDiff | null>(null)
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  /* confirm dialog for cancel status */
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false)
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null)

  /* PO edit modal */
  const [editPO, setEditPO] = useState<PurchaseOrder | null>(null)
  const [editPOForm, setEditPOForm] = useState({
    supplier_id: '',
    status: 'draft',
    order_type: 'po',
    order_reference: '',
    order_date: '',
    eta_date: '',
    destination_co_packer_id: '',
    tracking_number: '',
    notes: '',
    payment_method: '',
    payment_status: 'unpaid',
    shipping_cost: '',
    shipping_method: '',
    shipping_carrier: '',
    include_shipping_in_cost: false,
    production_order_id: '',
  })
  const [editPOLines, setEditPOLines] = useState<EditLineItem[]>([])
  const [confirmDeletePOOpen, setConfirmDeletePOOpen] = useState(false)

  /* PO form state */
  const [poSupplier, setPOSupplier] = useState('')
  const [poLines, setPOLines] = useState<LineItem[]>([{ ingredient_id: '', quantity: 0, unit_cost: 0, quantity_unit: '', cost_source: '' }])
  const [poDestCP, setPODestCP] = useState('')
  const [poOrderDate, setPOOrderDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [poEtaDate, setPOEtaDate] = useState('')
  const [poOrderType, setPOOrderType] = useState('po')
  const [poOrderRef, setPOOrderRef] = useState('')
  const [poShippingCost, setPOShippingCost] = useState('')
  const [poShippingMethod, setPOShippingMethod] = useState('')
  const [poShippingCarrier, setPOShippingCarrier] = useState('')
  const [poIncludeShipping, setPOIncludeShipping] = useState(false)
  const [poInitialStatus, setPOInitialStatus] = useState<'draft' | 'ordered' | 'in_transit'>('draft')
  const [poProductionOrder, setPOProductionOrder] = useState('')
  /* price comparison popup */
  const [priceCompareIngId, setPriceCompareIngId] = useState<string | null>(null)

  async function load() {
    const [supRes, ingRes, cpRes, siRes, scRes, poRes, poiRes, invRes, shipRes, convMap, prodOrderRes, tagRes, tagLinkRes] = await safeBatch(() => Promise.all([
      supabase.from('suppliers').select('*').order('name'),
      supabase.from('ingredients').select('*').order('name'),
      supabase.from('co_packers').select('*').order('name'),
      supabase.from('supplier_ingredients').select('*'),
      supabase.from('supplier_contacts').select('*'),
      supabase.from('purchase_orders').select('*').order('order_date', { ascending: false }),
      supabase.from('purchase_order_items').select('*'),
      supabase.from('ingredient_inventory').select('*'),
      supabase.from('shipments_to_copacker').select('*'),
      loadConversions(),
      supabase.from('production_orders').select('*').order('created_at', { ascending: false }),
      supabase.from('ingredient_tags').select('*').order('name'),
      supabase.from('ingredient_tag_links').select('*'),
    ]))
    setSuppliers(supRes.data ?? [])
    setIngredients(ingRes.data ?? [])
    setCoPackers(cpRes.data ?? [])
    setSupplierIngredients(siRes.data ?? [])
    setSupplierContacts(scRes.data ?? [])
    setPurchaseOrders(poRes.data ?? [])
    setPOItems(poiRes.data ?? [])
    setInventory(invRes.data ?? [])
    setShipments(shipRes.data ?? [])
    setProductionOrders(prodOrderRes.data ?? [])
    setTags(tagRes.data ?? [])
    setTagLinks(tagLinkRes.data ?? [])
    setConversions(convMap)
    setLoading(false)
  }

  useEffect(() => safeLoad(load, setLoading), [])

  /* ────── Fetch production runs + recipe ingredients for linked production order ────── */
  const activeProdOrderId = poProductionOrder || editPOForm.production_order_id
  useEffect(() => {
    if (!activeProdOrderId) {
      setProdOrderRuns([])
      setProdOrderRecipeIngs([])
      return
    }
    let cancelled = false
    ;(async () => {
      const { data: runs } = await supabase
        .from('production_runs')
        .select('*')
        .eq('production_order_id', activeProdOrderId)
      if (cancelled) return
      setProdOrderRuns(runs ?? [])
      const recipeIds = [...new Set((runs ?? []).map((r) => r.recipe_id).filter(Boolean))] as string[]
      if (recipeIds.length === 0) { setProdOrderRecipeIngs([]); return }
      const { data: ri } = await supabase
        .from('recipe_ingredients')
        .select('*')
        .in('recipe_id', recipeIds)
      if (cancelled) return
      setProdOrderRecipeIngs(ri ?? [])
    })()
    return () => { cancelled = true }
  }, [activeProdOrderId])

  /* ────── Ingredient tag label helper ────── */

  function ingTagLabel(ingredientId: string): string {
    const ingTags = tagLinks
      .filter((l) => l.ingredient_id === ingredientId)
      .map((l) => tags.find((t) => t.id === l.tag_id)?.name)
      .filter(Boolean)
    return ingTags.length > 0 ? ` [${ingTags.join(', ')}]` : ''
  }

  /* ────── Inline inventory context for PO line items ────── */

  function renderIngredientContext(ingredientId: string, coPackerId: string) {
    if (!ingredientId || !coPackerId) return null
    const ing = ingredients.find((i) => i.id === ingredientId)
    if (!ing) return null
    const cp = coPackers.find((c) => c.id === coPackerId)
    const cpName = cp?.name ?? 'CP'
    const unit = ing.unit || 'lbs'

    // At CP: sum inventory rows matching ingredient + copacker location
    const atCP = inventory
      .filter((inv) => inv.ingredient_id === ingredientId && inv.location_type === 'copacker' && inv.co_packer_id === coPackerId)
      .reduce((sum, inv) => sum + inv.quantity, 0)

    // In transit: sum PO item quantities where parent PO is in_transit destined for this CP
    const inTransitPOIds = new Set(
      purchaseOrders
        .filter((po) => po.status === 'in_transit' && po.destination_co_packer_id === coPackerId)
        .map((po) => po.id)
    )
    const inTransit = poItems
      .filter((pi) => pi.ingredient_id === ingredientId && inTransitPOIds.has(pi.purchase_order_id))
      .reduce((sum, pi) => sum + pi.quantity, 0)

    // Recipe need (if production order linked)
    let recipeNeed = 0
    if (activeProdOrderId && prodOrderRuns.length > 0) {
      for (const run of prodOrderRuns) {
        if (!run.recipe_id) continue
        const ris = prodOrderRecipeIngs.filter((ri) => ri.recipe_id === run.recipe_id && ri.ingredient_id === ingredientId)
        for (const ri of ris) {
          const factor = getConversionFactorWithDensity(conversions, ri.unit, unit, ing.density_g_per_ml)
          recipeNeed += ri.quantity_per_unit * run.requested_quantity * factor
        }
      }
      recipeNeed = Math.round(recipeNeed * 100) / 100
    }

    // Color logic
    const hasInventory = inventory.some((inv) => inv.ingredient_id === ingredientId && inv.location_type === 'copacker' && inv.co_packer_id === coPackerId)
    let color = 'text-muted'
    if (!hasInventory || atCP === 0) {
      color = 'text-red-400'
    } else if (ing.reorder_point != null && atCP <= ing.reorder_point) {
      color = 'text-amber-400'
    } else {
      color = 'text-emerald-400'
    }

    const shortfall = recipeNeed > 0 ? recipeNeed - atCP - inTransit : 0

    return (
      <div className="text-[13px] leading-snug mt-0.5">
        <span className={color}>
          At {cpName}: {hasInventory ? fmtQty(atCP, unit) : 'none'}
        </span>
        {inTransit > 0 && (
          <span className="text-muted"> · 🚚 {fmtQty(inTransit, unit)} in transit</span>
        )}
        {recipeNeed > 0 && (
          <span className="text-muted">
            {' · Need: '}{fmtQty(recipeNeed, unit)}
            {shortfall > 0 && <span className="text-red-400"> · Shortfall: {fmtQty(shortfall, unit)}</span>}
          </span>
        )}
      </div>
    )
  }

  /* ────── Order number generation ────── */

  function nextOrderNumber(type: string): string {
    const meta = ORDER_TYPES.find((t) => t.value === type) ?? ORDER_TYPES[0]
    if (type === 'po') {
      const nums = purchaseOrders
        .filter((p) => (p.order_type ?? 'po') === 'po')
        .map((p) => { const m = p.po_number.match(/#?(\d+)/); return m ? parseInt(m[1], 10) : 0 })
        .filter((n) => !isNaN(n) && n > 0)
      return `#${Math.max(...nums, 1000) + 1}`
    }
    const existing = purchaseOrders
      .filter((p) => p.order_type === type)
      .map((p) => { const m = p.po_number.match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0 })
      .filter((n) => !isNaN(n) && n > 0)
    const next = Math.max(...existing, 0) + 1
    return `${meta.prefix}${String(next).padStart(3, '0')}`
  }

  /* ────── PO table rows ────── */

  const poRows: PORow[] = purchaseOrders
    .filter((po) => poFilter === 'all' || po.status === poFilter)
    .filter((po) => poTypeFilter === 'all' || (po.order_type ?? 'po') === poTypeFilter)
    .map((po) => {
      const sup = suppliers.find((s) => s.id === po.supplier_id)
      const items = poItems
        .filter((pi) => pi.purchase_order_id === po.id)
        .map((pi) => {
          const ing = ingredients.find((i) => i.id === pi.ingredient_id)
          const unit = pi.quantity_unit ?? ing?.unit ?? ''
          if (pi.qty_packages && pi.package_size && pi.package_name) {
            return `${ing?.name ?? '?'} (${pi.qty_packages} × ${pi.package_size} ${unit} ${pi.package_name}s — ${Math.round(pi.quantity).toLocaleString()} ${unit})`
          }
          return `${ing?.name ?? '?'} (${Math.round(pi.quantity).toLocaleString()} ${unit})`
        })
        .join(', ')

      return {
        id: po.id,
        po_number: po.po_number,
        order_type: po.order_type ?? 'po',
        supplierName: sup?.name ?? '—',
        items,
        total_cost: po.total_cost,
        shipping_cost: po.shipping_cost,
        shipping_method: po.shipping_method,
        destination_type: po.destination_type,
        destination_co_packer_id: po.destination_co_packer_id,
        order_date: po.order_date,
        eta_date: po.eta_date,
        status: po.status ?? 'draft',
        production_order_id: po.production_order_id,
      }
    })
    .filter((row) => {
      if (!poSearch) return true
      const q = poSearch.toLowerCase()
      const po = purchaseOrders.find((p) => p.id === row.id)
      const typeMeta = ORDER_TYPES.find((t) => t.value === row.order_type)
      return (
        row.po_number.toLowerCase().includes(q) ||
        row.supplierName.toLowerCase().includes(q) ||
        row.items.toLowerCase().includes(q) ||
        (po?.tracking_number ?? '').toLowerCase().includes(q) ||
        (typeMeta?.label ?? '').toLowerCase().includes(q)
      )
    })

  const poColumns: Column<PORow>[] = [
    {
      label: 'Order #',
      key: 'po_number',
      width: '120px',
      render: (r) => {
        const meta = ORDER_TYPES.find((t) => t.value === r.order_type) ?? ORDER_TYPES[0]
        return (
          <span className="text-[14px] font-mono font-semibold text-text">
            <span title={meta.label}>{meta.icon}</span> {r.po_number}
          </span>
        )
      },
    },
    {
      label: 'Supplier',
      key: 'supplierName',
      width: '160px',
      render: (r) => <span className="text-[14px] text-text">{r.supplierName}</span>,
    },
    {
      label: 'Items',
      key: 'items',
      render: (r) => <span className="text-[14px] text-muted leading-relaxed">{r.items}</span>,
    },
    {
      label: 'Total',
      key: 'total_cost',
      align: 'right',
      width: '110px',
      render: (r) => <CostGuard><span className="text-[14px] font-mono font-semibold text-text">{fmt$(r.total_cost as number | null)}</span></CostGuard>,
    },
    {
      label: 'Shipping',
      key: 'shipping_cost',
      align: 'right',
      width: '90px',
      render: (r) => {
        if (r.shipping_method === 'Free Shipping' || r.shipping_method === 'Included in Price') {
          return <CostGuard><span className="text-[14px] text-emerald-400">Free</span></CostGuard>
        }
        return r.shipping_cost ? <CostGuard><span className="text-[14px] font-mono text-text">{fmt$(r.shipping_cost as number)}</span></CostGuard> : <span className="text-muted">—</span>
      },
    },
    {
      label: 'Destination',
      key: 'destination_type',
      width: '120px',
      render: (r) =>
        r.destination_co_packer_id ? (
          <CPBadge coPackerId={r.destination_co_packer_id as string} />
        ) : (
          <span className="text-[13px] text-muted">--</span>
        ),
    },
    {
      label: 'Prod Order',
      key: 'production_order_id',
      width: '100px',
      render: (r) => {
        if (!r.production_order_id) return null
        const order = productionOrders.find((o) => o.id === r.production_order_id)
        if (!order) return null
        return <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[13px] font-mono text-accent">{order.order_number}</span>
      },
    },
    {
      label: 'Ordered',
      key: 'order_date',
      width: '120px',
      render: (r) => <span className="text-[14px] text-muted">{fmtDate(r.order_date as string | null)}</span>,
    },
    {
      label: 'ETA',
      key: 'eta_date',
      width: '120px',
      render: (r) => <span className="text-[14px] text-muted">{fmtDate(r.eta_date as string | null)}</span>,
    },
    {
      label: 'Status',
      key: 'status',
      width: '120px',
      align: 'center',
      render: (r) => (
        <StatusDropdown
          status={r.status as string}
          onChangeStatus={(s) => handleStatusChange(r.id as string, s)}
        />
      ),
    },
    {
      label: '',
      key: 'id',
      width: '70px',
      render: (r) => (
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => handleDownloadPDF(r.id)}
            title="Download PDF"
            className="rounded p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-accent"
          >
            <FileDown size={14} />
          </button>
          <button
            type="button"
            onClick={() => handlePrintPDF(r.id)}
            title="Print PO"
            className="rounded p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-accent"
          >
            <Printer size={14} />
          </button>
        </div>
      ),
    },
  ]

  async function handleStatusChange(poId: string, newStatus: string) {
    if (newStatus === 'cancelled') {
      setPendingCancelId(poId)
      setConfirmCancelOpen(true)
      return
    }

    try {
      const poMaybe = purchaseOrders.find((p) => p.id === poId)
      if (!poMaybe) throw new Error('PO not found')
      const po = poMaybe
      const items = poItems.filter((pi) => pi.purchase_order_id === poId)
      const sup = suppliers.find((s) => s.id === po.supplier_id)
      const today = format(new Date(), 'yyyy-MM-dd')

      // Helper: create shipment + items for this PO (used by 'ordered' and as fallback)
      async function createShipmentForPO(shipmentStatus: string, shipDate: string | null) {
        const shipNum = nextShipmentNumber(shipments)
        const totalValue = items.reduce((s, it) => s + it.quantity * it.unit_cost, 0)

        const { data: newShipment } = await dbInsertSingle('shipments_to_copacker',
          sanitize('shipments_to_copacker', {
            shipment_number: shipNum,
            purchase_order_id: poId,
            co_packer_id: po.destination_co_packer_id,
            supplier_id: po.supplier_id,
            status: shipmentStatus,
            ship_date: shipDate,
            carrier: po.shipping_carrier,
            tracking_number: po.tracking_number,
            shipping_cost: po.shipping_cost,
            total_value: totalValue,
            cp_confirmed: false,
            production_order_id: po.production_order_id,
            notes: `Auto-created from PO ${po.po_number} — ${sup?.name ?? 'Unknown supplier'}`,
          }),
        )

        if (newShipment) {
          const shipmentItems = items
            .filter((it) => it.ingredient_id)
            .map((it) => sanitize('shipment_items', {
              shipment_id: newShipment.id,
              ingredient_id: it.ingredient_id,
              quantity: it.quantity,
              value: it.quantity * it.unit_cost,
            }))
          if (shipmentItems.length > 0) {
            await dbInsert('shipment_items', shipmentItems)
          }
        }
        return newShipment
      }

      // Find existing linked shipment
      const linkedShipment = shipments.find((s) => s.purchase_order_id === poId)

      if (newStatus === 'ordered') {
        // Auto-create shipment with 'ordered' status
        const newShipment = await createShipmentForPO('ordered', null)
        await dbUpdate('purchase_orders', sanitize('purchase_orders', { status: newStatus }), 'id', poId)
        toast.success(`PO ${po.po_number} placed — Shipment ${newShipment?.shipment_number ?? ''} created for tracking`)

      } else if (newStatus === 'in_transit') {
        if (linkedShipment) {
          // Update existing shipment
          await dbUpdate('shipments_to_copacker',
            sanitize('shipments_to_copacker', {
              status: 'in_transit',
              ship_date: today,
              carrier: po.shipping_carrier,
              tracking_number: po.tracking_number,
            }),
          'id', linkedShipment.id)
        } else {
          // Skipped 'ordered' — create shipment now
          await createShipmentForPO('in_transit', today)
        }
        await dbUpdate('purchase_orders', sanitize('purchase_orders', { status: newStatus }), 'id', poId)
        toast.success(`PO ${po.po_number} in transit — Shipment updated`)

      } else if (newStatus === 'received') {
        // Update linked shipment (or create if skipped earlier steps)
        if (linkedShipment) {
          await dbUpdate('shipments_to_copacker',
            sanitize('shipments_to_copacker', {
              status: 'received',
              received_date: today,
            }),
          'id', linkedShipment.id)
        } else {
          await createShipmentForPO('received', today)
        }

        // ── Existing inventory/cost logic (unchanged) ──
        // Pre-compute shipping allocation per item (in inventory units) if "include shipping" is on
        const shippingAlloc = new Map<string, number>()
        if (po.include_shipping_in_cost && po.shipping_cost && po.shipping_cost > 0) {
          const totalValue = items.reduce((s, it) => s + it.quantity * it.unit_cost, 0)
          for (const it of items) {
            if (!it.ingredient_id || totalValue <= 0) continue
            const lineValue = it.quantity * it.unit_cost
            const allocated = po.shipping_cost * (lineValue / totalValue)
            const recQty = it.received_quantity ?? it.quantity
            const ing2 = ingredients.find((i) => i.id === it.ingredient_id)
            const lu = it.quantity_unit ?? ing2?.unit ?? 'lbs'
            const iu = ing2?.unit ?? 'lbs'
            let qtyInIU = recQty
            if (normalizeUnit(lu) !== normalizeUnit(iu)) {
              try {
                const f = getConversionFactorWithDensity(conversions, lu, iu, ing2?.density_g_per_ml)
                qtyInIU = recQty * f
              } catch { /* use unconverted */ }
            }
            if (qtyInIU > 0) shippingAlloc.set(it.ingredient_id, allocated / qtyInIU)
          }
        }

        for (const item of items) {
          if (!item.ingredient_id) continue
          const receivedQty = item.received_quantity ?? item.quantity
          if (receivedQty <= 0) continue

          const ing = ingredients.find((i) => i.id === item.ingredient_id)
          if (!ing) continue

          // Convert from PO line unit to ingredient's inventory unit
          const lineUnit = item.quantity_unit ?? ing.unit
          const invUnit = ing.unit
          const needsConversion = normalizeUnit(lineUnit) !== normalizeUnit(invUnit)

          let receivedInInvUnit = receivedQty
          let costInInvUnit = item.unit_cost
          if (needsConversion) {
            try {
              const factor = getConversionFactorWithDensity(conversions, lineUnit, invUnit, ing.density_g_per_ml)
              receivedInInvUnit = Math.round(receivedQty * factor * 10000) / 10000
              costInInvUnit = Math.round((item.unit_cost / factor) * 10000) / 10000
            } catch (err) {
              console.warn(`Unit conversion failed for ${ing.name}: ${lineUnit} → ${invUnit}`, err)
            }
          }

          // Add shipping allocation to cost (already in inv units)
          const shippingAddon = shippingAlloc.get(item.ingredient_id) ?? 0
          const effectiveCost = costInInvUnit + shippingAddon

          // a. Get current total quantity across ALL locations (in inventory units)
          const currentTotalQty = inventory
            .filter((iv) => iv.ingredient_id === item.ingredient_id)
            .reduce((s, iv) => s + (iv.quantity ?? 0), 0)

          // b+c. Calculate new weighted average cost (in inventory units)
          const currentValue = currentTotalQty * ing.unit_cost
          const newValue = receivedInInvUnit * effectiveCost
          const newTotalQty = currentTotalQty + receivedInInvUnit
          const newUnitCost = newTotalQty > 0
            ? Math.round(((currentValue + newValue) / newTotalQty) * 10000) / 10000
            : effectiveCost

          // d. Update ingredient: weighted avg cost + last_cost (in inventory units)
          await dbUpdate('ingredients', sanitize('ingredients', {
            unit_cost: newUnitCost,
            last_cost: effectiveCost,
          }), 'id', item.ingredient_id)

          // e. Add received quantity (in inventory units) to inventory at destination
          const locationType = 'copacker'
          const cpId = po.destination_co_packer_id

          const existingInv = inventory.find(
            (iv) =>
              iv.ingredient_id === item.ingredient_id &&
              iv.location_type === locationType &&
              iv.co_packer_id === cpId,
          )

          if (existingInv) {
            await dbUpdate('ingredient_inventory',
              sanitize('ingredient_inventory', {
                quantity: (existingInv.quantity ?? 0) + receivedInInvUnit,
                updated_at: new Date().toISOString(),
              }),
            'id', existingInv.id)
          } else {
            await dbInsert('ingredient_inventory',
              sanitize('ingredient_inventory', {
                ingredient_id: item.ingredient_id,
                location_type: locationType,
                co_packer_id: cpId,
                quantity: receivedInInvUnit,
                updated_at: new Date().toISOString(),
              }),
            )
          }

          // f. Log cost history (in inventory units, includes shipping if applicable)
          await dbInsert('ingredient_cost_history', sanitize('ingredient_cost_history', {
            ingredient_id: item.ingredient_id,
            purchase_order_id: poId,
            unit_cost: effectiveCost,
            quantity: receivedInInvUnit,
            date: today,
          }))
        }

        await dbUpdate('purchase_orders', sanitize('purchase_orders', { status: newStatus }), 'id', poId)
        const cpName = coPackers.find((c) => c.id === po.destination_co_packer_id)?.name ?? 'co-packer'
        toast.success(`PO ${po.po_number} received — Inventory added to ${cpName}`)
      } else {
        // Generic status update (e.g. draft)
        await dbUpdate('purchase_orders', sanitize('purchase_orders', { status: newStatus }), 'id', poId)
      }

      if (po.production_order_id) syncIngredientStatus(po.production_order_id)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update status')
    }
  }

  async function confirmCancel() {
    if (!pendingCancelId) return
    try {
      const cancelledPO = purchaseOrders.find((p) => p.id === pendingCancelId)
      await dbUpdate('purchase_orders', sanitize('purchase_orders', { status: 'cancelled' }), 'id', pendingCancelId)
      if (cancelledPO?.production_order_id) syncIngredientStatus(cancelledPO.production_order_id)
      setConfirmCancelOpen(false)
      setPendingCancelId(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to cancel PO')
    }
  }

  /* ────── PO edit ────── */

  function openEditPO(poRow: PORow) {
    const po = purchaseOrders.find((p) => p.id === poRow.id)
    if (!po) return
    setEditPO(po)
    setEditPOForm({
      supplier_id: po.supplier_id ?? '',
      status: po.status ?? 'draft',
      order_type: po.order_type ?? 'po',
      order_reference: po.order_reference ?? '',
      order_date: po.order_date ?? '',
      eta_date: po.eta_date ?? '',
      destination_co_packer_id: po.destination_co_packer_id ?? '',
      tracking_number: po.tracking_number ?? '',
      notes: po.notes ?? '',
      payment_method: po.payment_method ?? '',
      payment_status: po.payment_status ?? 'unpaid',
      shipping_cost: po.shipping_cost != null ? String(po.shipping_cost) : '',
      shipping_method: po.shipping_method ?? '',
      shipping_carrier: po.shipping_carrier ?? '',
      include_shipping_in_cost: po.include_shipping_in_cost ?? false,
      production_order_id: po.production_order_id ?? '',
    })
    setEditPOLines(
      poItems
        .filter((pi) => pi.purchase_order_id === po.id)
        .map((pi) => {
          const ing = ingredients.find((ig) => ig.id === pi.ingredient_id)
          return {
            id: pi.id,
            ingredient_id: pi.ingredient_id ?? '',
            quantity: pi.quantity,
            unit_cost: pi.unit_cost,
            quantity_unit: pi.quantity_unit ?? ing?.unit ?? 'lbs',
            cost_source: '' as CostSource,
            received_quantity: pi.received_quantity,
            qtyPackages: pi.qty_packages ?? undefined,
            packageName: pi.package_name ?? undefined,
            packageSize: pi.package_size ?? undefined,
            packageUnit: pi.package_unit ?? undefined,
            pricePerPackage: pi.qty_packages && pi.package_size
              ? Math.round(pi.unit_cost * pi.package_size * 100) / 100
              : undefined,
          }
        }),
    )
  }

  function updateEditLine(idx: number, field: keyof EditLineItem, value: string | number) {
    setEditPOLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l
        if (field === 'ingredient_id') {
          const newIngId = value as string
          const si = findDefaultSI(supplierIngredients, editPOForm.supplier_id, newIngId)
          const ing = ingredients.find((ig) => ig.id === newIngId)
          const defaultUnit = si?.price_unit ?? ing?.unit ?? 'lbs'
          const { cost, source } = resolveLineCost(editPOForm.supplier_id, newIngId, defaultUnit)
          if (si?.package_size && si.package_unit && si.package_name && si.price_per_package != null) {
            return {
              ...l,
              ingredient_id: newIngId,
              quantity_unit: si.package_unit,
              unit_cost: Math.round((si.price_per_package / si.package_size) * 10000) / 10000,
              cost_source: 'supplier' as CostSource,
              packageName: si.package_name,
              packageSize: si.package_size,
              packageUnit: si.package_unit,
              pricePerPackage: si.price_per_package,
              qtyPackages: undefined,
              quantity: 0,
            }
          }
          return { ...l, ingredient_id: newIngId, unit_cost: cost, quantity_unit: defaultUnit, cost_source: source, packageName: undefined, packageSize: undefined, packageUnit: undefined, pricePerPackage: undefined, qtyPackages: undefined }
        }
        if (field === 'qtyPackages') {
          const pkgQty = Number(value) || 0
          const pkgSize = l.packageSize ?? 0
          return { ...l, qtyPackages: pkgQty, quantity: Math.round(pkgQty * pkgSize * 10000) / 10000 }
        }
        if (field === 'pricePerPackage') {
          const ppp = Number(value) || 0
          const pkgSize = l.packageSize ?? 1
          return { ...l, pricePerPackage: ppp, unit_cost: Math.round((ppp / pkgSize) * 10000) / 10000, cost_source: 'manual' as CostSource }
        }
        if (field === 'quantity_unit') {
          const newUnit = value as string
          if (l.cost_source !== 'manual' && l.ingredient_id) {
            const { cost, source } = resolveLineCost(editPOForm.supplier_id, l.ingredient_id, newUnit)
            return { ...l, quantity_unit: newUnit, unit_cost: cost, cost_source: source }
          }
          const oldUnit = l.quantity_unit
          let cost = l.unit_cost
          if (oldUnit && newUnit && l.ingredient_id) {
            const ing = ingredients.find((ig) => ig.id === l.ingredient_id)
            if (normalizeUnit(oldUnit) !== normalizeUnit(newUnit)) {
              try {
                const factor = getConversionFactorWithDensity(conversions, newUnit, oldUnit, ing?.density_g_per_ml)
                cost = Math.round(l.unit_cost * factor * 10000) / 10000
              } catch { /* keep current cost */ }
            }
          }
          return { ...l, quantity_unit: newUnit, unit_cost: cost }
        }
        if (field === 'unit_cost') {
          return { ...l, unit_cost: Number(value) || 0, cost_source: 'manual' as CostSource }
        }
        if (field === 'quantity' || field === 'received_quantity') {
          return { ...l, [field]: Number(value) || 0 }
        }
        return l
      }),
    )
  }

  function addEditLine() {
    setEditPOLines((prev) => [
      ...prev,
      { id: null, ingredient_id: '', quantity: 0, unit_cost: 0, quantity_unit: '', cost_source: '' as CostSource, received_quantity: null },
    ])
  }

  function handleEditSupplierChange(newSupplierId: string) {
    const oldSupplierId = editPOForm.supplier_id
    setEditPOForm({ ...editPOForm, supplier_id: newSupplierId })
    if (!newSupplierId || editPOLines.every((l) => !l.ingredient_id || l._deleted)) return
    let changed = false
    setEditPOLines((prev) =>
      prev.map((line) => {
        if (!line.ingredient_id || line._deleted || line.cost_source === 'manual') return line
        const si = findDefaultSI(supplierIngredients, newSupplierId, line.ingredient_id)
        const defaultUnit = si?.price_unit ?? line.quantity_unit
        const { cost, source } = resolveLineCost(newSupplierId, line.ingredient_id, defaultUnit)
        if (cost !== line.unit_cost || defaultUnit !== line.quantity_unit) changed = true
        return { ...line, unit_cost: cost, cost_source: source, quantity_unit: defaultUnit }
      }),
    )
    if (changed && oldSupplierId) toast.success('Prices updated for new supplier')
  }

  function removeEditLine(idx: number) {
    setEditPOLines((prev) => {
      const line = prev[idx]
      if (line.id) {
        // Mark existing DB row for deletion
        return prev.map((l, i) => (i === idx ? { ...l, _deleted: true } : l))
      }
      // Remove unsaved row entirely
      return prev.filter((_, i) => i !== idx)
    })
  }

  const editPOTotal = editPOLines
    .filter((l) => !l._deleted)
    .reduce((s, l) => s + l.quantity * l.unit_cost, 0)

  const editSupplierIngIds = new Set(
    supplierIngredients
      .filter((si) => si.supplier_id === editPOForm.supplier_id)
      .map((si) => si.ingredient_id),
  )

  async function handleSavePO() {
    if (!editPO) return

    // Validate line items before saving
    const activeLines = editPOLines.filter((l) => !l._deleted && l.ingredient_id)
    for (const line of activeLines) {
      const ing = ingredients.find((i) => i.id === line.ingredient_id)
      const name = ing?.name ?? 'item'
      if (!isFinite(line.quantity) || line.quantity < 0) {
        toast.error(`Invalid quantity for ${name}`)
        return
      }
      if (!isFinite(line.unit_cost) || line.unit_cost < 0) {
        toast.error(`Invalid rate for ${name}`)
        return
      }
    }

    setSaving(true)
    console.log('[DEBUG] Edit PO: Starting save...')
    try {
      const safeTotalCost = isFinite(editPOTotal) ? editPOTotal : 0

      const update: PurchaseOrderUpdate = {
        supplier_id: editPOForm.supplier_id || null,
        status: editPOForm.status,
        order_date: editPOForm.order_date || null,
        eta_date: editPOForm.eta_date || null,
        destination_type: 'copacker',
        destination_co_packer_id: editPOForm.destination_co_packer_id || null,
        tracking_number: editPOForm.tracking_number || null,
        notes: editPOForm.notes || null,
        total_cost: safeTotalCost,
        order_reference: editPOForm.order_reference || null,
        payment_method: editPOForm.payment_method || null,
        payment_status: editPOForm.payment_status,
        shipping_cost: editPOForm.shipping_cost ? Number(editPOForm.shipping_cost) : null,
        shipping_method: editPOForm.shipping_method || null,
        shipping_carrier: editPOForm.shipping_carrier || null,
        shipping_per_unit_weight: editPOForm.shipping_cost ? computeEditShippingPerWeight() : null,
        include_shipping_in_cost: editPOForm.include_shipping_in_cost,
        production_order_id: editPOForm.production_order_id || null,
      }

      console.log('[DEBUG] Step 1: Updating PO header...')
      const { error } = await dbUpdate('purchase_orders', sanitize('purchase_orders', update), 'id', editPO.id)
      if (error) throw new Error('PO header update failed: ' + error.message)
      console.log('[DEBUG] Step 1 done. Processing line items...')

      // Handle line items: delete removed, then batch update/insert
      const toDeleteIds = editPOLines
        .filter((line) => line._deleted && line.id)
        .map((line) => line.id!)
      if (toDeleteIds.length > 0) {
        console.log(`[DEBUG] Step 2a: Deleting ${toDeleteIds.length} removed items...`)
        const { error: delErr } = await dbDeleteIn('purchase_order_items', 'id', toDeleteIds)
        if (delErr) throw new Error('Failed to delete line items: ' + delErr.message)
        console.log('[DEBUG] Step 2a done.')
      }

      const toUpdate = editPOLines.filter((line) => !line._deleted && line.id)
      if (toUpdate.length > 0) {
        console.log(`[DEBUG] Step 2b: Updating ${toUpdate.length} existing items...`)
        for (let i = 0; i < toUpdate.length; i++) {
          const line = toUpdate[i]
          console.log(`[DEBUG] Updating item ${i + 1}/${toUpdate.length} (id: ${line.id})...`)
          const { error: updErr } = await dbUpdate('purchase_order_items', sanitize('purchase_order_items', {
            ingredient_id: line.ingredient_id || null,
            quantity: line.quantity,
            unit_cost: line.unit_cost,
            quantity_unit: line.quantity_unit || null,
            received_quantity: line.received_quantity,
            qty_packages: line.qtyPackages ?? null,
            package_name: line.packageName ?? null,
            package_size: line.packageSize ?? null,
            package_unit: line.packageUnit ?? null,
          }), 'id', line.id!)
          if (updErr) throw new Error(`Failed to update item ${i + 1}: ${updErr.message}`)
        }
        console.log('[DEBUG] Step 2b done.')
      }

      const newItemPayloads = editPOLines
        .filter((line) => !line._deleted && !line.id && line.ingredient_id && line.quantity > 0)
        .map((line) => sanitize('purchase_order_items', {
          purchase_order_id: editPO.id,
          ingredient_id: line.ingredient_id,
          quantity: line.quantity,
          unit_cost: line.unit_cost,
          quantity_unit: line.quantity_unit || null,
          received_quantity: line.received_quantity ?? 0,
          qty_packages: line.qtyPackages ?? null,
          package_name: line.packageName ?? null,
          package_size: line.packageSize ?? null,
          package_unit: line.packageUnit ?? null,
        }))
      if (newItemPayloads.length > 0) {
        console.log(`[DEBUG] Step 2c: Batch inserting ${newItemPayloads.length} new items...`)
        console.log('[DEBUG] New item payloads:', JSON.stringify(newItemPayloads, null, 2))
        const { error: insertErr } = await dbInsert('purchase_order_items', newItemPayloads)
        if (insertErr) throw new Error('Line items save failed: ' + insertErr.message)
        console.log('[DEBUG] Step 2c done.')
      }

      console.log('[DEBUG] Step 3: All saved, closing modal...')
      toast.success('Purchase order updated')
      logActivity(appUser?.id, 'update_po', 'purchase_order', editPO.id)
      setEditPO(null)
      load()
    } catch (err) {
      console.error('[DEBUG] Edit PO save error:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to update PO')
    } finally {
      console.log('[DEBUG] Finally block — resetting saving state')
      setSaving(false)
    }
  }

  async function handleDeletePO() {
    if (!editPO) return
    try {
      // Delete items first (FK constraint)
      await dbDelete('purchase_order_items', 'purchase_order_id', editPO.id)
      const { error } = await dbDelete('purchase_orders', 'id', editPO.id)
      if (error) throw error
      toast.success(`Deleted PO ${editPO.po_number}`)
      logActivity(appUser?.id, 'delete_po', 'purchase_order', editPO.id)
      setConfirmDeletePOOpen(false)
      setEditPO(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete PO')
    }
  }

  // Can this PO be deleted? Only draft/ordered can be freely deleted
  const editPOCanDelete = editPO
    ? ['draft', 'ordered'].includes(editPO.status ?? '')
    : false
  const editPODeleteWarning = editPO?.status === 'in_transit'

  /* ────── PO PDF ────── */

  function buildPDFData(poId: string): POPDFData | null {
    const po = purchaseOrders.find((p) => p.id === poId)
    if (!po) return null
    const sup = suppliers.find((s) => s.id === po.supplier_id)
    const contact = supplierContacts.find((c) => c.supplier_id === po.supplier_id && c.is_primary)
      ?? supplierContacts.find((c) => c.supplier_id === po.supplier_id)
    const cp = coPackers.find((c) => c.id === po.destination_co_packer_id)
    const items = poItems
      .filter((pi) => pi.purchase_order_id === poId)
      .map((pi) => {
        const ing = ingredients.find((i) => i.id === pi.ingredient_id)
        // Find the supplier ingredient to get supplier_item_name and SKU
        const si = po.supplier_id
          ? supplierIngredients.find((s) => s.supplier_id === po.supplier_id && s.ingredient_id === pi.ingredient_id)
          : null
        return {
          name: ing?.name ?? 'Unknown',
          supplier_item_name: si?.supplier_item_name ?? null,
          supplier_sku: si?.supplier_sku ?? null,
          quantity: pi.quantity,
          unit: pi.quantity_unit ?? ing?.unit ?? 'unit',
          unit_cost: pi.unit_cost,
          qty_packages: pi.qty_packages,
          package_name: pi.package_name,
          package_size: pi.package_size,
          package_unit: pi.package_unit,
        }
      })
    return {
      po_number: po.po_number,
      order_type: po.order_type ?? 'po',
      order_reference: po.order_reference,
      order_date: po.order_date,
      supplier_name: sup?.name ?? 'Unknown Supplier',
      contact_name: contact?.name ?? null,
      contact_email: contact?.email ?? null,
      contact_phone: contact?.phone ?? null,
      destination_type: 'copacker',
      destination_name: cp?.name ?? null,
      destination_location: cp?.location ?? null,
      receiving_hours: cp?.receiving_hours ?? null,
      receiving_notes: cp?.receiving_notes ?? null,
      items,
      shipping_cost: po.shipping_cost,
      shipping_method: po.shipping_method,
      shipping_carrier: po.shipping_carrier,
    }
  }

  function handleDownloadPDF(poId: string) {
    const data = buildPDFData(poId)
    if (!data) return
    generatePO_PDF(data, 'download')
  }

  function handlePrintPDF(poId: string) {
    const data = buildPDFData(poId)
    if (!data) return
    generatePO_PDF(data, 'print')
  }

  /* ────── CSV export ────── */

  function handleExportCSV() {
    const csvColumns = [
      { key: 'po_number', label: 'PO #' },
      { key: 'supplierName', label: 'Supplier' },
      { key: 'items', label: 'Items' },
      { key: 'total_cost', label: 'Total' },
      { key: 'destination_type', label: 'Destination' },
      { key: 'order_date', label: 'Ordered' },
      { key: 'eta_date', label: 'ETA' },
      { key: 'status', label: 'Status' },
    ]
    downloadCSV(poRows, csvColumns, 'purchase-orders')
  }

  /* ────── Supplier CSV export/import ────── */

  function downloadInstructions() {
    const ingList = ingredients
      .map((i) => `  - ${i.name}${i.category ? ` (${i.category})` : ''} [${i.unit}]`)
      .join('\n')

    const text = `FitBake Supplier CSV — Editing Instructions
============================================

COLUMN REFERENCE
- supplier_name (required): Name of the supplier
- supplier_id: Leave blank for NEW suppliers. Do NOT edit for existing ones.
- lead_time_days: Numeric (e.g. 7)
- payment_terms: Free text (e.g. "Net 30")
- rating: 1-5 scale (can be decimal, e.g. 4.5)
- notes: Free text
- contact_name / contact_email / contact_phone / contact_role: Primary contact info
- additional_contacts: Semicolon-separated additional contacts.
  Format: Name|email|phone|role;Name|email|phone|role
  Example: Jane Doe|jane@co.com|555-1234|Billing;Bob|bob@co.com||Shipping
- ingredient_name: Must match an existing ingredient name (see list below)
- supplier_item_name: What the supplier calls this ingredient (appears on PO documents)
- price_per_unit: Numeric price this supplier charges per unit of the ingredient
- price_unit: Unit for the price (e.g. lbs, kg, oz, gal)
- package_size: Numeric size of one package (e.g. 50 for a 50 lb bag)
- package_unit: Unit of the package size (e.g. lbs, kg, oz, gal)
- package_name: Type of package (bag, box, drum, pail, case, bottle, jar, bucket, carton, tote, other)
- price_per_package: Price per package (e.g. 160.00)
- supplier_sku: Supplier's SKU/product code for this ingredient
- min_order_packages: Minimum number of packages per order
- packages_per_case: How many packages come in one case (leave blank if N/A)
- is_default: Whether this is the default package option for the ingredient (true/false)

EDITING RULES
1. To UPDATE an existing supplier: edit any fields in rows that have a supplier_id
2. To ADD a new supplier: fill in blank rows at the bottom (leave supplier_id blank)
3. One row per supplier-ingredient-package combination
4. If a supplier has multiple ingredients, repeat the supplier info on each row
5. Supplier fields (name, lead_time, contacts, etc.) are taken from the FIRST row for each supplier
6. To REMOVE an ingredient from a supplier, delete that entire row
7. To ADD a new ingredient to an existing supplier, add a new row with the same supplier_id

AVAILABLE INGREDIENTS (ingredient_name must match exactly):
${ingList}

When done, save as CSV and send back for import.
`

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'fitbake-suppliers-INSTRUCTIONS.txt'
    link.click()
    URL.revokeObjectURL(url)
  }

  function handleExportSuppliers() {
    const today = format(new Date(), 'yyyy-MM-dd')
    const rows: Record<string, unknown>[] = []

    for (const sup of suppliers) {
      const contacts = supplierContacts.filter((c) => c.supplier_id === sup.id)
      const primary = contacts.find((c) => c.is_primary) ?? contacts[0]
      const additional = contacts
        .filter((c) => c.id !== primary?.id)
        .map((c) => `${c.name}|${c.email ?? ''}|${c.phone ?? ''}|${c.role ?? ''}`)
        .join(';')

      const sis = supplierIngredients.filter((s) => s.supplier_id === sup.id)

      const baseRow = {
        supplier_name: sup.name,
        supplier_id: sup.id,
        lead_time_days: sup.lead_time_days ?? '',
        payment_terms: sup.payment_terms ?? '',
        rating: sup.rating ?? '',
        notes: sup.notes ?? '',
        contact_name: primary?.name ?? '',
        contact_email: primary?.email ?? '',
        contact_phone: primary?.phone ?? '',
        contact_role: primary?.role ?? '',
        additional_contacts: additional,
      }

      if (sis.length === 0) {
        rows.push({
          ...baseRow, ingredient_name: '', supplier_item_name: '', price_per_unit: '', price_unit: '',
          package_size: '', package_unit: '', package_name: '', price_per_package: '',
          supplier_sku: '', min_order_packages: '', packages_per_case: '',
          is_default: '',
        })
      } else {
        for (const si of sis) {
          const ing = ingredients.find((i) => i.id === si.ingredient_id)
          rows.push({
            ...baseRow,
            ingredient_name: ing?.name ?? '',
            supplier_item_name: si.supplier_item_name ?? '',
            price_per_unit: si.price_per_unit ?? '',
            price_unit: si.price_unit ?? '',
            package_size: si.package_size ?? '',
            package_unit: si.package_unit ?? '',
            package_name: si.package_name ?? '',
            price_per_package: si.price_per_package ?? '',
            supplier_sku: si.supplier_sku ?? '',
            min_order_packages: si.min_order_packages ?? '',
            packages_per_case: si.packages_per_case ?? '',
            is_default: si.is_default ? 'true' : 'false',
          })
        }
      }
    }

    // Add 12 blank rows for new suppliers
    for (let i = 0; i < 12; i++) {
      rows.push({
        supplier_name: '', supplier_id: '', lead_time_days: '',
        payment_terms: '', rating: '', notes: '',
        contact_name: '', contact_email: '', contact_phone: '', contact_role: '',
        additional_contacts: '', ingredient_name: '', supplier_item_name: '', price_per_unit: '', price_unit: '',
        package_size: '', package_unit: '', package_name: '', price_per_package: '',
        supplier_sku: '', min_order_packages: '', packages_per_case: '',
        is_default: '',
      })
    }

    const columns = [
      { key: 'supplier_name', label: 'supplier_name' },
      { key: 'supplier_id', label: 'supplier_id' },
      { key: 'lead_time_days', label: 'lead_time_days' },
      { key: 'payment_terms', label: 'payment_terms' },
      { key: 'rating', label: 'rating' },
      { key: 'notes', label: 'notes' },
      { key: 'contact_name', label: 'contact_name' },
      { key: 'contact_email', label: 'contact_email' },
      { key: 'contact_phone', label: 'contact_phone' },
      { key: 'contact_role', label: 'contact_role' },
      { key: 'additional_contacts', label: 'additional_contacts' },
      { key: 'ingredient_name', label: 'ingredient_name' },
      { key: 'supplier_item_name', label: 'supplier_item_name' },
      { key: 'price_per_unit', label: 'price_per_unit' },
      { key: 'price_unit', label: 'price_unit' },
      { key: 'package_size', label: 'package_size' },
      { key: 'package_unit', label: 'package_unit' },
      { key: 'package_name', label: 'package_name' },
      { key: 'price_per_package', label: 'price_per_package' },
      { key: 'supplier_sku', label: 'supplier_sku' },
      { key: 'min_order_packages', label: 'min_order_packages' },
      { key: 'packages_per_case', label: 'packages_per_case' },
      { key: 'is_default', label: 'is_default' },
    ]

    downloadCSV(rows, columns, `fitbake-suppliers-${today}`)
    setTimeout(() => downloadInstructions(), 200)
  }

  function handleExportIngredients() {
    const today = format(new Date(), 'yyyy-MM-dd')
    const data = ingredients.map((i) => ({
      ingredient_name: i.name,
      category: i.category ?? '',
      unit: i.unit,
      current_avg_cost: Number(i.unit_cost).toFixed(4),
      current_last_cost: i.last_cost != null ? Number(i.last_cost).toFixed(4) : '',
    }))
    downloadCSV(data, [
      { key: 'ingredient_name', label: 'ingredient_name' },
      { key: 'category', label: 'category' },
      { key: 'unit', label: 'unit' },
      { key: 'current_avg_cost', label: 'current_avg_cost' },
      { key: 'current_last_cost', label: 'current_last_cost' },
    ], `fitbake-ingredients-reference-${today}`)
  }

  /* ────── CSV import logic ────── */

  function computeImportDiff(rawRows: CSVSupplierRow[]): ImportDiff {
    const ingMap = new Map<string, string>()
    for (const ing of ingredients) {
      ingMap.set(ing.name.trim().toLowerCase(), ing.id)
    }

    const errors: ImportDiff['errors'] = []
    const warnings: ImportDiff['warnings'] = []

    // Group rows by supplier
    const groups = new Map<string, { rows: CSVSupplierRow[]; rowIndices: number[]; isNew: boolean }>()

    rawRows.forEach((row, idx) => {
      const name = (row.supplier_name ?? '').trim()
      const id = (row.supplier_id ?? '').trim()
      if (!name && !id) return // skip blank row

      if (!name) {
        errors.push({ row: idx + 2, message: 'Missing supplier_name' })
        return
      }

      const key = id || `__new__${name.toLowerCase()}`
      if (!groups.has(key)) {
        groups.set(key, { rows: [], rowIndices: [], isNew: !id })
      }
      groups.get(key)!.rows.push(row)
      groups.get(key)!.rowIndices.push(idx + 2)
    })

    const newSuppliers: ParsedSupplierGroup[] = []
    const updatedSuppliers: ImportDiff['updatedSuppliers'] = []

    for (const [, { rows: gRows, rowIndices, isNew }] of groups) {
      const first = gRows[0]
      const supplierId = isNew ? null : first.supplier_id.trim()

      // Validate existing supplier
      if (supplierId && !suppliers.find((s) => s.id === supplierId)) {
        errors.push({ row: rowIndices[0], message: `supplier_id "${supplierId}" not found in database` })
        continue
      }

      // Parse primary contact
      const parsedContacts: ParsedContact[] = []
      const primaryName = (first.contact_name ?? '').trim()
      if (primaryName) {
        parsedContacts.push({
          name: primaryName,
          email: (first.contact_email ?? '').trim(),
          phone: (first.contact_phone ?? '').trim(),
          role: (first.contact_role ?? '').trim() || 'Sales Rep',
          is_primary: true,
        })
      }

      // Parse additional_contacts
      const addlRaw = (first.additional_contacts ?? '').trim()
      if (addlRaw) {
        for (const entry of addlRaw.split(';')) {
          const parts = entry.split('|')
          const aName = (parts[0] ?? '').trim()
          if (!aName) continue
          parsedContacts.push({
            name: aName,
            email: (parts[1] ?? '').trim(),
            phone: (parts[2] ?? '').trim(),
            role: (parts[3] ?? '').trim() || 'Sales Rep',
            is_primary: false,
          })
        }
      }

      // Parse ingredients from all rows
      const parsedIngredients: ParsedIngredient[] = []
      const seenIngPkgs = new Set<string>()
      for (let i = 0; i < gRows.length; i++) {
        const ingName = (gRows[i].ingredient_name ?? '').trim()
        if (!ingName) continue

        const ingKey = ingName.toLowerCase()
        const pkgKey = `${ingKey}|${(gRows[i].package_size ?? '')}|${(gRows[i].package_unit ?? '')}|${(gRows[i].package_name ?? '')}`
        if (seenIngPkgs.has(pkgKey)) {
          warnings.push({ row: rowIndices[i], message: `Duplicate ingredient+package "${ingName}" for this supplier` })
          continue
        }
        seenIngPkgs.add(pkgKey)

        const ingId = ingMap.get(ingKey) ?? null
        if (!ingId) {
          errors.push({ row: rowIndices[i], message: `Ingredient "${ingName}" not found in system` })
        }
        parsedIngredients.push({
          ingredient_name: ingName,
          ingredient_id: ingId,
          supplier_item_name: (gRows[i].supplier_item_name ?? '').trim(),
          price_per_unit: gRows[i].price_per_unit ? parseFloat(gRows[i].price_per_unit) : null,
          price_unit: (gRows[i].price_unit ?? '').trim(),
          package_size: gRows[i].package_size ? parseFloat(gRows[i].package_size) : null,
          package_unit: (gRows[i].package_unit ?? '').trim(),
          package_name: (gRows[i].package_name ?? '').trim(),
          price_per_package: gRows[i].price_per_package ? parseFloat(gRows[i].price_per_package) : null,
          supplier_sku: (gRows[i].supplier_sku ?? '').trim(),
          min_order_packages: gRows[i].min_order_packages ? parseInt(gRows[i].min_order_packages, 10) : null,
          packages_per_case: gRows[i].packages_per_case ? parseInt(gRows[i].packages_per_case, 10) : null,
          is_default: (gRows[i].is_default ?? '').trim().toLowerCase() === 'true',
        })
      }

      const group: ParsedSupplierGroup = {
        supplier_id: supplierId,
        supplier_name: first.supplier_name.trim(),
        lead_time_days: first.lead_time_days ? parseInt(first.lead_time_days, 10) : null,
        payment_terms: (first.payment_terms ?? '').trim(),
        rating: first.rating ? parseFloat(first.rating) : null,
        notes: (first.notes ?? '').trim(),
        contacts: parsedContacts,
        ingredients: parsedIngredients.filter((pi) => pi.ingredient_id !== null),
      }

      if (isNew) {
        newSuppliers.push(group)
      } else {
        const existing = suppliers.find((s) => s.id === supplierId)!
        const fieldsChanged: string[] = []
        if (group.supplier_name !== existing.name) fieldsChanged.push('name')
        if (group.lead_time_days !== existing.lead_time_days) fieldsChanged.push('lead_time_days')
        if (group.payment_terms !== (existing.payment_terms ?? '')) fieldsChanged.push('payment_terms')
        if (group.rating !== existing.rating) fieldsChanged.push('rating')
        if (group.notes !== (existing.notes ?? '')) fieldsChanged.push('notes')

        const existingContacts = supplierContacts.filter((c) => c.supplier_id === supplierId)
        const contactsAdded = Math.max(0, group.contacts.length - existingContacts.length)
        const contactsRemoved = Math.max(0, existingContacts.length - group.contacts.length)

        const existingSIs = supplierIngredients.filter((s) => s.supplier_id === supplierId)
        const existingIngIds = new Set(existingSIs.map((s) => s.ingredient_id))
        const csvIngIds = new Set(group.ingredients.map((i) => i.ingredient_id!))

        const ingredientsAdded = group.ingredients
          .filter((i) => !existingIngIds.has(i.ingredient_id!))
          .map((i) => i.ingredient_name)

        const ingredientsRemoved = existingSIs
          .filter((s) => !csvIngIds.has(s.ingredient_id))
          .map((s) => {
            const ing = ingredients.find((i) => i.id === s.ingredient_id)
            return ing?.name ?? '?'
          })

        const ingredientsUpdated = group.ingredients
          .filter((i) => {
            if (!existingIngIds.has(i.ingredient_id!)) return false
            const existingSI = existingSIs.find((s) => s.ingredient_id === i.ingredient_id)
            if (!existingSI) return false
            return existingSI.price_per_unit !== i.price_per_unit ||
              (existingSI.price_unit ?? '') !== i.price_unit ||
              existingSI.package_size !== i.package_size ||
              (existingSI.package_unit ?? '') !== i.package_unit ||
              (existingSI.package_name ?? '') !== i.package_name ||
              existingSI.price_per_package !== i.price_per_package ||
              (existingSI.supplier_sku ?? '') !== i.supplier_sku ||
              (existingSI.supplier_item_name ?? '') !== i.supplier_item_name ||
              existingSI.min_order_packages !== i.min_order_packages ||
              existingSI.packages_per_case !== i.packages_per_case
          })
          .map((i) => i.ingredient_name)

        updatedSuppliers.push({
          group,
          changes: { fieldsChanged, contactsAdded, contactsRemoved, ingredientsAdded, ingredientsUpdated, ingredientsRemoved },
        })
      }
    }

    return { newSuppliers, updatedSuppliers, errors, warnings }
  }

  function handleImportFileSelect(file: File) {
    Papa.parse<CSVSupplierRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete(results) {
        const diff = computeImportDiff(results.data)
        setImportDiff(diff)
        setImportModalOpen(true)
      },
    })
  }

  async function handleConfirmImport() {
    if (!importDiff) return
    setImporting(true)

    try {
      let successCount = 0

      // New suppliers
      for (const group of importDiff.newSuppliers) {
        const { data: sup, error } = await dbInsertSingle('suppliers', sanitize('suppliers', {
          name: group.supplier_name,
          lead_time_days: group.lead_time_days,
          payment_terms: group.payment_terms || null,
          rating: group.rating,
          notes: group.notes || null,
        }))

        if (error || !sup) {
          toast.error(`Failed to create ${group.supplier_name}: ${error?.message ?? 'unknown error'}`)
          continue
        }

        for (const c of group.contacts) {
          await dbInsert('supplier_contacts', sanitize('supplier_contacts', {
            supplier_id: sup.id,
            name: c.name,
            email: c.email || null,
            phone: c.phone || null,
            role: c.role || null,
            is_primary: c.is_primary,
          }))
        }

        for (const ing of group.ingredients) {
          if (!ing.ingredient_id) continue
          await dbInsert('supplier_ingredients', sanitize('supplier_ingredients', {
            supplier_id: sup.id,
            ingredient_id: ing.ingredient_id,
            price_per_unit: ing.price_per_unit,
            price_unit: ing.price_unit || null,
            package_size: ing.package_size,
            package_unit: ing.package_unit || null,
            package_name: ing.package_name || null,
            price_per_package: ing.price_per_package,
            supplier_sku: ing.supplier_sku || null,
            supplier_item_name: ing.supplier_item_name || null,
            min_order_packages: ing.min_order_packages,
            packages_per_case: ing.packages_per_case,
            is_default: ing.is_default,
          }))
        }
        successCount++
      }

      // Updated suppliers
      for (const { group, changes } of importDiff.updatedSuppliers) {
        const supId = group.supplier_id!

        if (changes.fieldsChanged.length > 0) {
          await dbUpdate('suppliers', sanitize('suppliers', {
            name: group.supplier_name,
            lead_time_days: group.lead_time_days,
            payment_terms: group.payment_terms || null,
            rating: group.rating,
            notes: group.notes || null,
          }), 'id', supId)
        }

        // Replace contacts: delete existing, re-insert from CSV
        const existingContacts = supplierContacts.filter((c) => c.supplier_id === supId)
        for (const ec of existingContacts) {
          await dbDelete('supplier_contacts', 'id', ec.id)
        }
        for (const c of group.contacts) {
          await dbInsert('supplier_contacts', sanitize('supplier_contacts', {
            supplier_id: supId,
            name: c.name,
            email: c.email || null,
            phone: c.phone || null,
            role: c.role || null,
            is_primary: c.is_primary,
          }))
        }

        // Diff supplier_ingredients
        const existingSIs = supplierIngredients.filter((s) => s.supplier_id === supId)
        const csvIngIds = new Set(group.ingredients.map((i) => i.ingredient_id!))

        // Remove ingredients not in CSV
        for (const si of existingSIs) {
          if (!csvIngIds.has(si.ingredient_id)) {
            await dbDelete('supplier_ingredients', 'id', si.id)
          }
        }

        // Add or update ingredients
        for (const ing of group.ingredients) {
          if (!ing.ingredient_id) continue
          const siData = {
            price_per_unit: ing.price_per_unit,
            price_unit: ing.price_unit || null,
            package_size: ing.package_size,
            package_unit: ing.package_unit || null,
            package_name: ing.package_name || null,
            price_per_package: ing.price_per_package,
            supplier_sku: ing.supplier_sku || null,
            supplier_item_name: ing.supplier_item_name || null,
            min_order_packages: ing.min_order_packages,
            packages_per_case: ing.packages_per_case,
            is_default: ing.is_default,
          }
          const existingSI = existingSIs.find((s) => s.ingredient_id === ing.ingredient_id)
          if (existingSI) {
            await dbUpdate('supplier_ingredients', sanitize('supplier_ingredients', siData), 'id', existingSI.id)
          } else {
            await dbInsert('supplier_ingredients', sanitize('supplier_ingredients', {
              supplier_id: supId,
              ingredient_id: ing.ingredient_id,
              ...siData,
            }))
          }
        }
        successCount++
      }

      const parts: string[] = []
      if (importDiff.newSuppliers.length > 0) parts.push(`${importDiff.newSuppliers.length} new`)
      if (importDiff.updatedSuppliers.length > 0) parts.push(`${importDiff.updatedSuppliers.length} updated`)
      toast.success(`Import complete: ${parts.join(', ')} supplier${successCount !== 1 ? 's' : ''}`)
      setImportModalOpen(false)
      setImportDiff(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  /** Render a cost source label below the unit cost input */
  function costSourceLabel(source: CostSource, ingredientId: string, supplierId: string, _lineUnit: string) {
    if (!source || !ingredientId) return null
    const ing = ingredients.find((i) => i.id === ingredientId)
    if (source === 'supplier') {
      const si = findDefaultSI(supplierIngredients, supplierId, ingredientId)
      // Show conversion note if supplier price_unit differs from line unit
      const priceUnit = si?.price_unit ?? ''
      const invUnit = ing?.unit ?? ''
      let conversionNote = ''
      if (priceUnit && invUnit && normalizeUnit(priceUnit) !== normalizeUnit(invUnit) && si?.price_per_unit != null) {
        try {
          const factor = getConversionFactorWithDensity(conversions, priceUnit, invUnit, ing?.density_g_per_ml)
          const converted = Math.round(si.price_per_unit * factor * 100) / 100
          conversionNote = ` (${fmtRate(converted)}/${invUnit})`
        } catch { /* skip */ }
      }
      return <p className="mt-0.5 text-[13px] text-blue-400"><CostGuard>Supplier price{conversionNote}</CostGuard></p>
    }
    if (source === 'last_cost') {
      const dateStr = ing?.updated_at ? fmtDate(ing.updated_at) : ''
      return <p className="mt-0.5 text-[13px] text-muted"><CostGuard>Last purchase{dateStr ? ` · ${dateStr}` : ''}</CostGuard></p>
    }
    if (source === 'weighted_avg') {
      return <p className="mt-0.5 text-[13px] text-amber-400"><CostGuard>Weighted avg — no supplier price</CostGuard></p>
    }
    if (source === 'manual') {
      return <p className="mt-0.5 text-[13px] text-muted">Manual entry</p>
    }
    return null
  }

  /* ────── PO create ────── */

  function resetPOForm() {
    setPOSupplier('')
    setPOLines([{ ingredient_id: '', quantity: 0, unit_cost: 0, quantity_unit: '', cost_source: '' }])
    setPODestCP('')
    setPOOrderDate(format(new Date(), 'yyyy-MM-dd'))
    setPOEtaDate('')
    setPOOrderType('po')
    setPOOrderRef('')
    setPOShippingCost('')
    setPOShippingMethod('')
    setPOShippingCarrier('')
    setPOIncludeShipping(false)
    setPOInitialStatus('draft')
    setPOProductionOrder('')
  }

  function addLine() {
    setPOLines([...poLines, { ingredient_id: '', quantity: 0, unit_cost: 0, quantity_unit: '', cost_source: '' }])
  }

  function handleSupplierChange(newSupplierId: string) {
    const oldSupplierId = poSupplier
    setPOSupplier(newSupplierId)
    if (!newSupplierId || poLines.every((l) => !l.ingredient_id)) return
    // Recalculate prices for all lines with ingredients
    let changed = false
    const next = poLines.map((line) => {
      if (!line.ingredient_id || line.cost_source === 'manual') return line
      const si = findDefaultSI(supplierIngredients, newSupplierId, line.ingredient_id)
      const defaultUnit = si?.price_unit ?? line.quantity_unit
      const { cost, source } = resolveLineCost(newSupplierId, line.ingredient_id, defaultUnit)
      if (cost !== line.unit_cost || defaultUnit !== line.quantity_unit) changed = true
      return { ...line, unit_cost: cost, cost_source: source, quantity_unit: defaultUnit, selectedSIId: si?.id }
    })
    setPOLines(next)
    if (changed && oldSupplierId) toast.success('Prices updated for new supplier')
  }

  /** Resolve cost + source for a line item given supplier + ingredient */
  function resolveLineCost(supplierId: string, ingredientId: string, lineUnit: string): { cost: number; source: CostSource } {
    const ing = ingredients.find((i) => i.id === ingredientId)
    const si = findDefaultSI(supplierIngredients, supplierId, ingredientId)
    if (si?.price_per_unit != null) {
      return { cost: si.price_per_unit, source: 'supplier' }
    }
    if (ing) {
      // Prefer last_cost, fall back to weighted avg
      const hasLastCost = ing.last_cost != null && ing.last_cost > 0
      const baseCost = hasLastCost ? ing.last_cost! : ing.unit_cost
      const source: CostSource = hasLastCost ? 'last_cost' : 'weighted_avg'
      const invUnit = ing.unit
      if (normalizeUnit(lineUnit) !== normalizeUnit(invUnit)) {
        try {
          const factor = getConversionFactorWithDensity(conversions, lineUnit, invUnit, ing.density_g_per_ml)
          return { cost: Math.round(baseCost * factor * 10000) / 10000, source }
        } catch {
          return { cost: baseCost, source }
        }
      }
      return { cost: baseCost, source }
    }
    return { cost: 0, source: '' }
  }

  function updateLine(idx: number, field: keyof LineItem, value: string | number) {
    const next = [...poLines]
    if (field === 'ingredient_id') {
      next[idx].ingredient_id = value as string
      const ing = ingredients.find((i) => i.id === value)
      const si = findDefaultSI(supplierIngredients, poSupplier, value as string)
      next[idx].selectedSIId = si?.id
      const defaultUnit = si?.price_unit ?? ing?.unit ?? 'lbs'
      next[idx].quantity_unit = defaultUnit
      const { cost, source } = resolveLineCost(poSupplier, value as string, defaultUnit)
      next[idx].unit_cost = cost
      next[idx].cost_source = source
      // Auto-populate package fields + per-unit cost if SI has package data
      if (si?.package_size && si.package_unit && si.package_name && si.price_per_package != null) {
        next[idx].packageName = si.package_name
        next[idx].packageSize = si.package_size
        next[idx].packageUnit = si.package_unit
        next[idx].pricePerPackage = si.price_per_package
        next[idx].quantity_unit = si.package_unit
        next[idx].unit_cost = Math.round((si.price_per_package / si.package_size) * 10000) / 10000
        next[idx].cost_source = 'supplier'
        // Reset to package-entry mode
        next[idx].qtyPackages = undefined
        next[idx].quantity = 0
      } else {
        next[idx].packageName = undefined
        next[idx].packageSize = undefined
        next[idx].packageUnit = undefined
        next[idx].pricePerPackage = undefined
        next[idx].qtyPackages = undefined
      }
      // Auto-link "other" ingredient to this supplier
      if (poSupplier && value && !supplierIngIds.has(value as string)) {
        dbInsertSingle('supplier_ingredients', sanitize('supplier_ingredients', { supplier_id: poSupplier, ingredient_id: value as string }))
          .then(({ data }) => {
            if (data) setSupplierIngredients((prev) => [...prev, data])
          })
          .catch(() => { /* silent — non-critical auto-link */ })
      }
    } else if (field === 'qtyPackages') {
      // Package-entry mode: user enters # of packages, auto-calc total weight
      const pkgQty = Number(value) || 0
      next[idx].qtyPackages = pkgQty
      const pkgSize = next[idx].packageSize ?? 0
      next[idx].quantity = Math.round(pkgQty * pkgSize * 10000) / 10000
    } else if (field === 'pricePerPackage') {
      // Edit rate per package, auto-calc unit cost
      const ppp = Number(value) || 0
      next[idx].pricePerPackage = ppp
      const pkgSize = next[idx].packageSize ?? 1
      next[idx].unit_cost = Math.round((ppp / pkgSize) * 10000) / 10000
      next[idx].cost_source = 'manual'
    } else if (field === 'quantity_unit') {
      const oldUnit = next[idx].quantity_unit
      const newUnit = value as string
      next[idx].quantity_unit = newUnit
      if (next[idx].cost_source !== 'manual' && next[idx].ingredient_id) {
        const { cost, source } = resolveLineCost(poSupplier, next[idx].ingredient_id, newUnit)
        next[idx].unit_cost = cost
        next[idx].cost_source = source
      } else if (oldUnit && newUnit && next[idx].ingredient_id) {
        const ing = ingredients.find((i) => i.id === next[idx].ingredient_id)
        if (normalizeUnit(oldUnit) !== normalizeUnit(newUnit)) {
          try {
            const factor = getConversionFactorWithDensity(conversions, newUnit, oldUnit, ing?.density_g_per_ml)
            next[idx].unit_cost = Math.round(next[idx].unit_cost * factor * 10000) / 10000
          } catch { /* keep current cost */ }
        }
      }
    } else if (field === 'unit_cost') {
      next[idx].unit_cost = Number(value)
      next[idx].cost_source = 'manual'
    } else {
      (next[idx] as unknown as Record<string, unknown>)[field] = Number(value)
    }
    setPOLines(next)
  }

  function removeLine(idx: number) {
    if (poLines.length <= 1) return
    setPOLines(poLines.filter((_, i) => i !== idx))
  }

  const supplierIngIds = new Set(
    supplierIngredients
      .filter((si) => si.supplier_id === poSupplier)
      .map((si) => si.ingredient_id),
  )

  const poTotal = poLines.reduce((s, l) => s + l.quantity * l.unit_cost, 0)

  /** Compute shipping cost per lb for create PO */
  function computeCreateShippingPerWeight(): number | null {
    const cost = Number(poShippingCost)
    if (!cost || cost <= 0) return null
    let totalLbs = 0
    for (const line of poLines) {
      if (!line.ingredient_id || line.quantity <= 0) continue
      const ing = ingredients.find((i) => i.id === line.ingredient_id)
      const unit = line.quantity_unit || ing?.unit || 'lbs'
      try {
        const factor = getConversionFactorWithDensity(conversions, unit, 'lbs', ing?.density_g_per_ml)
        totalLbs += line.quantity * factor
      } catch {
        totalLbs += line.quantity // fallback: treat as lbs
      }
    }
    return totalLbs > 0 ? Math.round((cost / totalLbs) * 10000) / 10000 : null
  }

  /** Compute shipping cost per lb for edit PO */
  function computeEditShippingPerWeight(): number | null {
    const cost = Number(editPOForm.shipping_cost)
    if (!cost || cost <= 0) return null
    let totalLbs = 0
    for (const line of editPOLines) {
      if (line._deleted || !line.ingredient_id || line.quantity <= 0) continue
      const ing = ingredients.find((i) => i.id === line.ingredient_id)
      const unit = line.quantity_unit || ing?.unit || 'lbs'
      try {
        const factor = getConversionFactorWithDensity(conversions, unit, 'lbs', ing?.density_g_per_ml)
        totalLbs += line.quantity * factor
      } catch {
        totalLbs += line.quantity
      }
    }
    return totalLbs > 0 ? Math.round((cost / totalLbs) * 10000) / 10000 : null
  }

  const filteredSuppliers = suppliers.filter((sup) => {
    if (!supplierSearch) return true
    const q = supplierSearch.toLowerCase()
    // Match supplier name
    if (sup.name.toLowerCase().includes(q)) return true
    // Match contact names / emails
    const contacts = supplierContacts.filter((c) => c.supplier_id === sup.id)
    if (contacts.some((c) =>
      c.name.toLowerCase().includes(q) ||
      (c.email ?? '').toLowerCase().includes(q)
    )) return true
    // Match ingredient names or supplier item names
    const si = supplierIngredients.filter((s) => s.supplier_id === sup.id)
    if (si.some((s) => {
      const ing = ingredients.find((i) => i.id === s.ingredient_id)
      return ing?.name.toLowerCase().includes(q) ||
        (s.supplier_item_name ?? '').toLowerCase().includes(q)
    })) return true
    return false
  })

  async function handleCreatePO(e: FormEvent) {
    e.preventDefault()

    // Validate BEFORE setting loading state so button never gets stuck
    if (!poSupplier) { toast.error('Select a supplier'); return }
    if (!poDestCP) { toast.error('Select a destination co-packer'); return }

    const validLines = poLines.filter((l) => l.ingredient_id)
    if (validLines.length === 0) { toast.error('Add at least one ingredient'); return }

    for (const line of validLines) {
      const ing = ingredients.find((i) => i.id === line.ingredient_id)
      const name = ing?.name ?? 'item'
      if (!line.quantity || !isFinite(line.quantity) || line.quantity <= 0) {
        toast.error(`Enter a valid quantity for ${name}`)
        return
      }
      if (!isFinite(line.unit_cost) || line.unit_cost < 0) {
        toast.error(`Enter a valid rate for ${name}`)
        return
      }
    }

    setSaving(true)
    console.log('[DEBUG] Create PO: Starting save...')

    let inserted: PurchaseOrder | null = null
    let items: PurchaseOrderItemInsert[] = []
    try {
      // Step 1: Create the PO and line items (must succeed)
      const safeTotalCost = isFinite(poTotal) ? poTotal : 0

      const po: PurchaseOrderInsert = {
        po_number: nextOrderNumber(poOrderType),
        order_type: poOrderType,
        order_reference: poOrderRef || null,
        supplier_id: poSupplier || null,
        status: poInitialStatus,
        order_date: poOrderDate || null,
        eta_date: poEtaDate || null,
        destination_type: 'copacker',
        destination_co_packer_id: poDestCP || null,
        total_cost: safeTotalCost,
        shipping_cost: poShippingCost ? Number(poShippingCost) : null,
        shipping_method: poShippingMethod || null,
        shipping_carrier: poShippingCarrier || null,
        shipping_per_unit_weight: poShippingCost ? computeCreateShippingPerWeight() : null,
        include_shipping_in_cost: poIncludeShipping,
        production_order_id: poProductionOrder || null,
      }

      console.log('[DEBUG] Step 1: Inserting PO header...')
      console.log('[DEBUG] PO payload:', JSON.stringify(po, null, 2))
      const { data, error } = await dbInsertSingle('purchase_orders', sanitize('purchase_orders', po))
      if (error) throw new Error('PO save failed: ' + error.message)
      inserted = data
      console.log(`[DEBUG] Step 1 done. PO id=${inserted.id}, po_number=${inserted.po_number}`)

      items = validLines
        .filter((l) => l.quantity > 0)
        .map((l) => sanitize('purchase_order_items', {
          purchase_order_id: inserted!.id,
          ingredient_id: l.ingredient_id,
          quantity: l.quantity,
          unit_cost: l.unit_cost,
          quantity_unit: l.quantity_unit || null,
          qty_packages: l.qtyPackages ?? null,
          package_name: l.packageName ?? null,
          package_size: l.packageSize ?? null,
          package_unit: l.packageUnit ?? null,
        })) as PurchaseOrderItemInsert[]
      if (items.length > 0) {
        console.log(`[DEBUG] Step 2: Batch inserting ${items.length} line items...`)
        console.log('[DEBUG] Item payloads:', JSON.stringify(items, null, 2))
        const { error: itemsError } = await dbInsert('purchase_order_items', items)
        if (itemsError) throw new Error('Line items save failed: ' + itemsError.message)
        console.log('[DEBUG] Step 2 done. Items saved.')
      } else {
        console.log('[DEBUG] Step 2: No line items to insert (0 valid lines).')
      }

      // Step 3: Auto-create shipment (non-blocking — PO already saved)
      try {
        if (poInitialStatus !== 'draft') {
          console.log(`[DEBUG] Step 3: Auto-creating shipment (status=${poInitialStatus})...`)
          const sup = suppliers.find((s) => s.id === inserted.supplier_id)
          const shipNum = nextShipmentNumber(shipments)
          const totalValue = items.reduce((s, it) => s + it.quantity * it.unit_cost, 0)
          const shipDate = poInitialStatus === 'in_transit' ? format(new Date(), 'yyyy-MM-dd') : null

          console.log('[DEBUG] Step 3a: Inserting shipment record...')
          const { data: newShipment, error: shipErr } = await dbInsertSingle('shipments_to_copacker',
            sanitize('shipments_to_copacker', {
              shipment_number: shipNum,
              purchase_order_id: inserted.id,
              co_packer_id: inserted.destination_co_packer_id,
              supplier_id: inserted.supplier_id,
              status: poInitialStatus,
              ship_date: shipDate,
              carrier: inserted.shipping_carrier,
              tracking_number: inserted.tracking_number,
              shipping_cost: inserted.shipping_cost,
              total_value: totalValue,
              cp_confirmed: false,
              production_order_id: inserted.production_order_id,
              notes: `Auto-created from PO ${inserted.po_number} — ${sup?.name ?? 'Unknown supplier'}`,
            }),
          )

          if (shipErr) {
            console.error('[DEBUG] Step 3a FAILED: ' + shipErr.message)
            console.error('Auto-shipment creation failed:', shipErr)
          } else {
            console.log('[DEBUG] Step 3a done. Shipment created.')
          }

          if (newShipment) {
            const shipmentItems = items
              .filter((it) => it.ingredient_id)
              .map((it) => sanitize('shipment_items', {
                shipment_id: newShipment.id,
                ingredient_id: it.ingredient_id,
                quantity: it.quantity,
                value: it.quantity * it.unit_cost,
              }))
            if (shipmentItems.length > 0) {
              console.log(`[DEBUG] Step 3b: Inserting ${shipmentItems.length} shipment items...`)
              const { error: siErr } = await dbInsert('shipment_items', shipmentItems)
              if (siErr) {
                console.error('[DEBUG] Step 3b FAILED: ' + siErr.message)
                console.error('Shipment items insert failed:', siErr)
              } else {
                console.log('[DEBUG] Step 3b done.')
              }
            }
          }

          toast.success(`PO ${inserted.po_number} created${newShipment ? ` — Shipment ${newShipment.shipment_number} created for tracking` : ''}`)
        } else {
          toast.success('Purchase order created as draft')
        }
      } catch (shipErr) {
        console.error('Auto-shipment creation failed:', shipErr)
        console.error('[DEBUG] Shipment auto-create threw: ' + (shipErr instanceof Error ? shipErr.message : String(shipErr)))
        toast.success(`PO ${inserted.po_number} created (shipment auto-create failed)`)
      }

      console.log('[DEBUG] Step 4: Closing modal, reloading data...')
      logActivity(appUser?.id, 'create_po', 'purchase_order', inserted?.id)
      setPOModalOpen(false)
      resetPOForm()
      load()
    } catch (err) {
      console.error('[DEBUG] Create PO failed:', err)
      toast.error('PO SAVE FAILED: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      console.log('[DEBUG] Finally block — resetting saving state')
      setSaving(false)
    }
  }

  /* ────── Supplier create ────── */

  async function handleCreateSupplier(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    try {
      const fd = new FormData(e.currentTarget)
      const { data: sup, error } = await dbInsertSingle('suppliers', sanitize('suppliers', {
        name: fd.get('name') as string,
        lead_time_days: fd.get('lead_time_days') ? Number(fd.get('lead_time_days')) : null,
        payment_terms: (fd.get('payment_terms') as string) || null,
        rating: fd.get('rating') ? Number(fd.get('rating')) : null,
      }))
      if (error || !sup) throw error ?? new Error('Insert failed')

      // Create primary contact if name provided
      const cName = (fd.get('contact_name') as string) || ''
      if (cName.trim()) {
        await dbInsert('supplier_contacts', sanitize('supplier_contacts', {
          supplier_id: sup.id,
          name: cName.trim(),
          email: (fd.get('contact_email') as string) || null,
          phone: (fd.get('contact_phone') as string) || null,
          role: 'Sales Rep',
          is_primary: true,
        }))
      }

      toast.success('Supplier added')
      logActivity(appUser?.id, 'create_supplier', 'supplier', sup.id)
      setSupplierModalOpen(false)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add supplier')
    } finally {
      setSaving(false)
    }
  }

  /* ────── Supplier Detail modal helpers ────── */

  function openDetail(sup: Supplier) {
    setDetailSupplier(sup)
    setEditForm({
      name: sup.name,
      lead_time_days: sup.lead_time_days != null ? String(sup.lead_time_days) : '',
      payment_terms: sup.payment_terms ?? '',
      rating: sup.rating != null ? String(sup.rating) : '',
      notes: sup.notes ?? '',
    })
    setEditContacts(
      supplierContacts
        .filter((c) => c.supplier_id === sup.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          email: c.email ?? '',
          phone: c.phone ?? '',
          role: c.role ?? 'Sales Rep',
          is_primary: c.is_primary,
        })),
    )
    const sis = supplierIngredients.filter((s) => s.supplier_id === sup.id)
    setDetailIngredients(
      sis.map((s) => {
        const ing = ingredients.find((i) => i.id === s.ingredient_id)
        return {
          si_id: s.id,
          ingredient_id: s.ingredient_id,
          name: ing?.name ?? '?',
          unit: ing?.unit ?? '',
          price_per_unit: s.price_per_unit,
          price_unit: s.price_unit ?? ing?.unit ?? '',
          package_size: s.package_size,
          package_unit: s.package_unit ?? ing?.unit ?? '',
          package_name: s.package_name ?? '',
          price_per_package: s.price_per_package,
          supplier_sku: s.supplier_sku ?? '',
          supplier_item_name: s.supplier_item_name ?? '',
          min_order_packages: s.min_order_packages,
          packages_per_case: s.packages_per_case,
          is_default: s.is_default ?? false,
        }
      }),
    )
    setAddIngId('')
  }

  function updateSILocal(siId: string, fields: Partial<typeof detailIngredients[number]>) {
    setDetailIngredients((prev) => prev.map((d) => (d.si_id === siId ? { ...d, ...fields } : d)))
  }

  /** Bidirectional price sync: package total ↔ per-unit cost */
  function syncPackagePrice(
    d: typeof detailIngredients[number],
    changed: 'package' | 'unit' | 'size' | 'pkgunit',
  ): Partial<typeof detailIngredients[number]> {
    const ing = ingredients.find((i) => i.id === d.ingredient_id)
    const density = ing?.density_g_per_ml
    const pkgUnit = d.package_unit || d.unit

    // Convert package_size from package_unit to ingredient base unit
    let sizeInBaseUnit = d.package_size ?? 0
    if (sizeInBaseUnit <= 0) return {}
    if (pkgUnit !== d.unit) {
      try {
        const factor = getConversionFactorWithDensity(conversions, pkgUnit, d.unit, density)
        sizeInBaseUnit = (d.package_size ?? 0) * factor
      } catch { return {} }
    }

    if (changed === 'unit') {
      // User edited price_per_unit → calc price_per_package
      if (d.price_per_unit == null) return {}
      return {
        price_per_package: Math.round(d.price_per_unit * sizeInBaseUnit * 100) / 100,
        price_unit: d.unit,
      }
    }
    // 'package', 'size', or 'pkgunit' → calc price_per_unit from price_per_package
    if (d.price_per_package == null) return {}
    return {
      price_per_unit: Math.round((d.price_per_package / sizeInBaseUnit) * 10000) / 10000,
      price_unit: d.unit,
    }
  }

  async function handleRemoveSI(siId: string) {
    if (!siId.startsWith('temp_')) {
      const { error } = await dbDelete('supplier_ingredients', 'id', siId)
      if (error) { toast.error('Failed to remove ingredient: ' + error.message); return }
    }
    setDetailIngredients((prev) => {
      const next = prev.filter((d) => d.si_id !== siId)
      // If the removed row was default, auto-promote the first sibling
      const removed = prev.find((d) => d.si_id === siId)
      if (removed?.is_default) {
        const sibling = next.find((d) => d.ingredient_id === removed.ingredient_id)
        if (sibling) sibling.is_default = true
      }
      return [...next]
    })
    setSupplierIngredients((prev) => prev.filter((s) => s.id !== siId))
  }

  function handleAddSI() {
    if (!addIngId || !detailSupplier) return
    const ing = ingredients.find((i) => i.id === addIngId)
    const tempId = `temp_${crypto.randomUUID()}`
    setDetailIngredients((prev) => [
      ...prev,
      {
        si_id: tempId, ingredient_id: addIngId, name: ing?.name ?? '?', unit: ing?.unit ?? '',
        price_per_unit: null, price_unit: ing?.unit ?? '',
        package_size: null, package_unit: ing?.unit ?? '', package_name: '',
        price_per_package: null, supplier_sku: '', supplier_item_name: '',
        min_order_packages: null, packages_per_case: null,
        is_default: true,
      },
    ])
    setAddIngId('')
  }

  function handleAddPackageSize(ingredientId: string) {
    if (!detailSupplier) return
    const ing = ingredients.find((i) => i.id === ingredientId)
    const tempId = `temp_${crypto.randomUUID()}`
    setDetailIngredients((prev) => [
      ...prev,
      {
        si_id: tempId, ingredient_id: ingredientId,
        name: ing?.name ?? '?', unit: ing?.unit ?? '',
        price_per_unit: null, price_unit: ing?.unit ?? '',
        package_size: null, package_unit: ing?.unit ?? '', package_name: '',
        price_per_package: null, supplier_sku: '', supplier_item_name: '',
        min_order_packages: null, packages_per_case: null,
        is_default: false,
      },
    ])
  }

  function handleSetDefault(siId: string, ingredientId: string) {
    setDetailIngredients((prev) =>
      prev.map((d) => {
        if (d.ingredient_id !== ingredientId) return d
        return { ...d, is_default: d.si_id === siId }
      }),
    )
  }

  /* ────── Supplier edit save ────── */

  async function handleSaveSupplier() {
    if (!detailSupplier) return
    setDebugLog([])
    dbg('Save clicked — supplier id=' + detailSupplier.id)
    if (saving) { dbg('Already saving — aborting'); return }
    setSaving(true)

    try {
      // Step 1: Update supplier
      dbg('Step 1: Updating supplier...')
      const supplierPayload = sanitize('suppliers', {
        name: editForm.name,
        lead_time_days: editForm.lead_time_days ? Number(editForm.lead_time_days) : null,
        payment_terms: editForm.payment_terms || null,
        rating: editForm.rating ? Number(editForm.rating) : null,
        notes: editForm.notes || null,
      })
      dbg('Payload: ' + JSON.stringify(supplierPayload))

      const updateResult = await dbUpdate('suppliers', supplierPayload, 'id', detailSupplier.id)
      dbg('Supabase responded: ' + JSON.stringify(updateResult.error || 'ok'))
      if (updateResult.error) throw new Error('Update failed: ' + updateResult.error.message)
      dbg('Step 1 done')

      // Step 2: Delete old contacts
      dbg('Step 2: Deleting old contacts...')
      const delContacts = await dbDelete('supplier_contacts', 'supplier_id', detailSupplier.id)
      if (delContacts.error) dbg('Delete contacts warning: ' + delContacts.error.message)
      dbg('Step 2a: Contacts deleted')

      // Step 3: Insert contacts
      const contactPayloads = (editContacts || [])
        .filter((c) => !c._deleted && (c.name?.trim() || c.email || c.phone))
        .map((c) => sanitize('supplier_contacts', {
          supplier_id: detailSupplier.id,
          name: c.name || null,
          email: c.email || null,
          phone: c.phone || null,
          role: c.role || null,
          is_primary: c.is_primary || false,
          notes: c.notes || null,
        }))
      if (contactPayloads.length > 0) {
        dbg('Step 3: Inserting ' + contactPayloads.length + ' contacts...')
        const insContacts = await dbInsert('supplier_contacts', contactPayloads)
        if (insContacts.error) throw new Error('Contacts failed: ' + insContacts.error.message)
      }
      dbg('Step 3 done')

      // Step 4: Delete old ingredients
      dbg('Step 4: Deleting old ingredients...')
      const delIng = await dbDelete('supplier_ingredients', 'supplier_id', detailSupplier.id)
      if (delIng.error) dbg('Delete ingredients warning: ' + delIng.error.message)
      dbg('Step 4a: Old ingredients deleted')

      // Step 5: Insert ingredients
      const ingredientPayloads = (detailIngredients || [])
        .filter((d) => d.ingredient_id)
        .map((d) => sanitize('supplier_ingredients', {
          supplier_id: detailSupplier.id,
          ingredient_id: d.ingredient_id,
          price_per_unit: d.price_per_unit ? parseFloat(String(d.price_per_unit)) : null,
          price_unit: d.price_unit || null,
          package_size: d.package_size ? parseFloat(String(d.package_size)) : null,
          package_unit: d.package_unit || null,
          package_name: d.package_name || null,
          price_per_package: d.price_per_package ? parseFloat(String(d.price_per_package)) : null,
          supplier_sku: d.supplier_sku || null,
          supplier_item_name: d.supplier_item_name || null,
          min_order_packages: d.min_order_packages ? parseInt(String(d.min_order_packages)) : null,
          packages_per_case: d.packages_per_case ? parseInt(String(d.packages_per_case)) : null,
          is_default: d.is_default || false,
        }))
      if (ingredientPayloads.length > 0) {
        dbg('Step 5: Inserting ' + ingredientPayloads.length + ' ingredients...')
        ingredientPayloads.forEach((p, i) => {
          dbg('  ' + (i + 1) + ': ing=' + (p.ingredient_id as string)?.substring(0, 8) + ' pkg=' + p.package_size + ' ' + p.package_unit + ' $' + p.price_per_package)
        })
        const insIng = await dbInsert('supplier_ingredients', ingredientPayloads)
        if (insIng.error) throw new Error('Ingredients failed: ' + insIng.error.message)
      }
      dbg('Step 5 done')

      dbg('=== ALL SAVED ===')
      toast.success('Supplier updated')
      logActivity(appUser?.id, 'update_supplier', 'supplier', detailSupplier.id)
      setDetailSupplier(null)
      await load()
    } catch (err: any) {
      const msg = err?.message || JSON.stringify(err)
      dbg('ERROR: ' + msg)
      console.error('Supplier save failed:', err)
      toast.error(msg || 'Save failed')
    } finally {
      dbg('Finally — setSaving(false)')
      setSaving(false)
    }
  }

  /* ────── Supplier delete ────── */

  async function handleDeleteSupplier() {
    if (!pendingDeleteSupplier) return
    try {
      await dbDelete('supplier_ingredients', 'supplier_id', pendingDeleteSupplier.id)
      await dbUpdate('purchase_orders', sanitize('purchase_orders', { supplier_id: null }), 'supplier_id', pendingDeleteSupplier.id)
      const { error } = await dbDelete('suppliers', 'id', pendingDeleteSupplier.id)
      if (error) throw error
      toast.success(`Deleted ${pendingDeleteSupplier.name}`)
      logActivity(appUser?.id, 'delete_supplier', 'supplier', pendingDeleteSupplier.id)
      setConfirmDeleteOpen(false)
      setPendingDeleteSupplier(null)
      if (detailSupplier?.id === pendingDeleteSupplier.id) setDetailSupplier(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete supplier')
    }
  }

  /* ════════════════════ RENDER ════════════════════ */

  if (loading) return <PageSkeleton />

  return (
    <div>
      {/* ── SECTION 1: Purchase Orders ── */}
      <PageHeader title="Purchase Orders" subtitle="Track orders from ingredient suppliers">
        <button
          onClick={handleExportCSV}
          className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-[14px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
        >
          <Download size={16} />
          Export CSV
        </button>
        <button
          onClick={() => { resetPOForm(); setPOModalOpen(true) }}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white transition-colors hover:bg-accent-hover"
        >
          <Plus size={16} />
          New Purchase Order
        </button>
      </PageHeader>

      {/* Status filter pills + search */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          {PO_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setPOFilter(f)}
              className={`rounded-lg px-3 py-1.5 text-[14px] font-medium transition-colors ${
                poFilter === f
                  ? 'bg-accent text-white'
                  : 'border border-border text-muted hover:text-text hover:bg-hover'
              }`}
            >
              {f === 'all' ? 'All' : STATUS_LABELS[f] ?? f}
            </button>
          ))}
        </div>
        <div className="h-5 w-px bg-border" />
        <div className="flex items-center gap-2">
          {ORDER_TYPE_FILTERS.map((f) => {
            const meta = ORDER_TYPES.find((t) => t.value === f)
            return (
              <button
                key={f}
                onClick={() => setPOTypeFilter(f)}
                className={`rounded-lg px-3 py-1.5 text-[14px] font-medium transition-colors ${
                  poTypeFilter === f
                    ? 'bg-accent text-white'
                    : 'border border-border text-muted hover:text-text hover:bg-hover'
                }`}
              >
                {f === 'all' ? 'All Types' : meta ? `${meta.icon} ${meta.label.replace(' Order', '')}` : f}
              </button>
            )
          })}
        </div>
        <div className="w-64">
          <SearchInput
            placeholder="Search orders..."
            value={poSearch}
            onChange={setPOSearch}
            onClear={() => setPOSearch('')}
          />
        </div>
      </div>

      <DataTable
        columns={poColumns}
        data={poRows}
        onRowClick={openEditPO}
        emptyMessage="No purchase orders"
        emptyHint="Create your first PO to track orders"
      />

      {/* ── SECTION 2: Supplier Directory ── */}
      <div className="mt-12">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className="text-[18px] font-bold text-text">Supplier Directory</h2>
            <p className="mt-1 text-[14px] text-muted">Contact info, terms, and supplied ingredients</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportIngredients}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[14px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
              title="Download ingredient reference list for VAs"
            >
              <FileDown size={14} />
              Ingredients List
            </button>
            <button
              onClick={handleExportSuppliers}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[14px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
            >
              <Download size={14} />
              Export for Editing
            </button>
            <button
              onClick={() => importInputRef.current?.click()}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[14px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
            >
              <Upload size={14} />
              Import Updated
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleImportFileSelect(f)
                e.target.value = ''
              }}
            />
            <button
              onClick={() => setSupplierModalOpen(true)}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white transition-colors hover:bg-accent-hover"
            >
              <Plus size={16} />
              Add Supplier
            </button>
          </div>
        </div>

        <div className="mb-4 w-80">
          <SearchInput
            placeholder="Search suppliers..."
            value={supplierSearch}
            onChange={setSupplierSearch}
            onClear={() => setSupplierSearch('')}
          />
        </div>

        {filteredSuppliers.length === 0 && suppliers.length > 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <PackageSearch size={36} className="mb-3 text-muted/40" />
            <p className="text-base font-medium text-muted">No suppliers found</p>
            <p className="mt-1 text-[14px] text-muted/70">No results for &ldquo;{supplierSearch}&rdquo;</p>
            <button
              onClick={() => setSupplierSearch('')}
              className="mt-3 rounded-lg border border-border px-3 py-1.5 text-[14px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
            >
              Clear search
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {filteredSuppliers.map((sup) => {
            const si = supplierIngredients.filter((s) => s.supplier_id === sup.id)
            const contacts = supplierContacts.filter((c) => c.supplier_id === sup.id)
            const primary = contacts.find((c) => c.is_primary) ?? contacts[0]
            const otherCount = contacts.length - (primary ? 1 : 0)

            return (
              <div key={sup.id} onClick={() => openDetail(sup)} className="cursor-pointer rounded-xl border border-border bg-card p-5 transition-colors hover:border-accent/40">
                <div className="flex items-start justify-between">
                  <h3 className="text-[16px] font-bold text-text">{sup.name}</h3>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); openDetail(sup) }}
                      className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-accent"
                      title="Edit"
                    >
                      <Pencil size={14} />
                    </button>
                    {can('delete_any') && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setPendingDeleteSupplier(sup); setConfirmDeleteOpen(true) }}
                      className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                    )}
                  </div>
                </div>

                {/* Primary contact */}
                {primary && (
                  <div className="mt-3 space-y-1.5">
                    <p className="text-[14px] text-text">
                      <span className="text-[13px] text-muted">Primary:</span> {primary.name}
                      {primary.email && <span className="text-[14px] text-muted"> · {primary.email}</span>}
                      {primary.phone && <span className="text-[14px] text-muted"> · {primary.phone}</span>}
                    </p>
                    {otherCount > 0 && (
                      <p className="text-[14px] text-accent">+{otherCount} more contact{otherCount !== 1 ? 's' : ''}</p>
                    )}
                  </div>
                )}

                {/* Terms row */}
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[14px]">
                  {sup.lead_time_days != null && (
                    <span className="flex items-center gap-1.5 text-muted">
                      <Clock size={14} />
                      {sup.lead_time_days} days lead
                    </span>
                  )}
                  {sup.payment_terms && (
                    <span className="flex items-center gap-1.5 text-muted">
                      <CreditCard size={14} />
                      {sup.payment_terms}
                    </span>
                  )}
                  {sup.rating != null && (
                    <span className="flex items-center gap-1.5 text-amber" style={{ color: '#F59E0B' }}>
                      <Star size={14} fill="#F59E0B" />
                      {sup.rating.toFixed(1)}
                    </span>
                  )}
                </div>

                {/* Supplied ingredients */}
                {si.length > 0 && (
                  <div className="mt-4 border-t border-border pt-3">
                    <p className="mb-2 text-[13px] uppercase tracking-wider text-muted">
                      Supplies ({new Set(si.map((s) => s.ingredient_id)).size})
                    </p>
                    <div className="space-y-2">
                      {(() => {
                        const groups = new Map<string, typeof si>()
                        for (const s of si) {
                          const arr = groups.get(s.ingredient_id) ?? []
                          arr.push(s)
                          groups.set(s.ingredient_id, arr)
                        }
                        return Array.from(groups.entries()).map(([ingId, options]) => {
                          const ing = ingredients.find((i) => i.id === ingId)
                          const name = ing?.name ?? '?'
                          const invUnit = ing?.unit ?? ''

                          const supplierItemName = options[0]?.supplier_item_name
                          return (
                            <div key={ingId} className="text-[14px] text-text">
                              <p className="font-medium">{name}</p>
                              {supplierItemName && (
                                <p className="text-[13px] text-muted italic ml-2">Supplier calls it: &ldquo;{supplierItemName}&rdquo;</p>
                              )}
                              {options.map((s) => {
                                // Full package line: "50 lb bag — $160.00 ($3.20/lb) ★"
                                if (s.package_size && s.package_unit && s.package_name && s.price_per_package != null) {
                                  const perUnit = s.price_per_unit != null
                                    ? ` (${fmtRate(s.price_per_unit)}/${invUnit})`
                                    : ''
                                  return (
                                    <p key={s.id} className="text-muted ml-2">
                                      {s.package_size} {s.package_unit} {s.package_name} — <CostGuard><span className="font-mono">{fmt$(s.price_per_package)}</span>
                                      {perUnit && <span className="font-mono">{perUnit}</span>}</CostGuard>
                                      {s.is_default && options.length > 1 && <span className="ml-1" style={{ color: '#F59E0B' }}>★</span>}
                                    </p>
                                  )
                                }
                                // Fallback: only price_per_unit (old data)
                                if (s.price_per_unit == null) return null
                                return (
                                  <p key={s.id} className="text-muted ml-2">
                                    <CostGuard><span className="font-mono">{fmtRate(s.price_per_unit)}/{s.price_unit || invUnit}</span></CostGuard>
                                    {s.is_default && options.length > 1 && <span className="ml-1" style={{ color: '#F59E0B' }}>★</span>}
                                  </p>
                                )
                              })}
                            </div>
                          )
                        })
                      })()}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── PO Create Modal ── */}
      <Modal
        isOpen={poModalOpen}
        onClose={() => setPOModalOpen(false)}
        title="New Purchase Order"
        wide="4xl"
      >
        <form onSubmit={handleCreatePO} className="space-y-4">
          {/* Row 1: Order Type | Supplier | PO Number */}
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Order Type</span>
              <select value={poOrderType} onChange={(e) => setPOOrderType(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                {ORDER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Supplier</span>
              <select value={poSupplier} onChange={(e) => handleSupplierChange(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                <option value="">Select supplier...</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {(() => {
                if (!poSupplier) return null
                const pc = supplierContacts.find((c) => c.supplier_id === poSupplier && c.is_primary) ?? supplierContacts.find((c) => c.supplier_id === poSupplier)
                if (!pc) return null
                return <p className="mt-1 text-[13px] text-muted"><Mail size={14} className="inline mr-1" />{pc.name}{pc.email ? ` · ${pc.email}` : ''}</p>
              })()}
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">{poOrderType === 'po' ? 'PO Number' : 'Order Number'}</span>
              <input readOnly value={nextOrderNumber(poOrderType)} className="w-full rounded-lg border border-border bg-surface/50 px-2 py-1.5 text-[14px] font-mono text-muted outline-none" />
            </label>
          </div>

          {/* Order Reference (non-PO types only) */}
          {poOrderType !== 'po' && (
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Order Reference</span>
              <input value={poOrderRef} onChange={(e) => setPOOrderRef(e.target.value)} placeholder="Email subject, website order #, confirmation #, etc." className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text placeholder:text-muted/50 outline-none focus:border-accent" />
            </label>
          )}

          {/* Row 2: Order Date | ETA | Status */}
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Order Date</span>
              <input type="date" value={poOrderDate} onChange={(e) => setPOOrderDate(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">ETA Date</span>
              <input type="date" value={poEtaDate} onChange={(e) => setPOEtaDate(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Initial Status</span>
              <select value={poInitialStatus} onChange={(e) => setPOInitialStatus(e.target.value as 'draft' | 'ordered' | 'in_transit')} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                <option value="draft">Draft</option>
                <option value="ordered">Ordered</option>
                <option value="in_transit">In Transit</option>
              </select>
            </label>
          </div>

          {/* Row 3: Destination CP | Production Order */}
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Destination Co-Packer</span>
              <select value={poDestCP} onChange={(e) => setPODestCP(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                <option value="">Select co-packer...</option>
                {coPackers.map((cp) => <option key={cp.id} value={cp.id}>{cp.name} ({cp.short_code})</option>)}
              </select>
            </label>
            <label className="col-span-2 block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Production Order (optional)</span>
              <select value={poProductionOrder} onChange={(e) => setPOProductionOrder(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                <option value="">None — standalone order</option>
                {productionOrders.map((po) => {
                  const cp = coPackers.find((c) => c.id === po.co_packer_id)
                  return <option key={po.id} value={po.id}>{po.order_number} — {cp?.name ?? '—'} — {po.total_units?.toLocaleString() ?? '?'} units</option>
                })}
              </select>
            </label>
          </div>

          {/* Line Items */}
          <div className="border-t border-border pt-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[13px] font-medium uppercase tracking-wider text-muted">Line Items</p>
              <button
                type="button"
                onClick={addLine}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-[14px] text-accent hover:bg-accent/10"
              >
                <Plus size={14} /> Add Item
              </button>
            </div>
            <div className="rounded-lg border border-border">
              <table className="w-full table-fixed text-left text-[14px]">
                <thead>
                  <tr className="border-b border-border bg-surface/50 text-[13px] uppercase tracking-wider text-muted">
                    <th className="px-2 py-2 font-semibold" style={{ width: 190 }}>Ingredient</th>
                    <th className="px-2 py-2 font-semibold" style={{ width: 130 }}>Package</th>
                    <th className="px-2 py-2 font-semibold text-right" style={{ width: 65 }}>Qty</th>
                    <th className="px-2 py-2 font-semibold text-right" style={{ width: 85 }}>Total Wt</th>
                    <th className="px-2 py-2 font-semibold text-right" style={{ width: 120 }}>Rate</th>
                    <th className="px-2 py-2 font-semibold text-right" style={{ width: 120 }}>Amount</th>
                    <th className="px-2 py-2" style={{ width: 36 }} />
                  </tr>
                </thead>
                <tbody>
                  {poLines.map((line, idx) => {
                    const ing = ingredients.find((i) => i.id === line.ingredient_id)
                    const hasPkg = !!(line.packageSize && line.packageName && line.pricePerPackage != null)
                    return (
                      <tr key={idx} className="border-b border-border last:border-0">
                        {/* Ingredient */}
                        <td className="px-2 py-1.5">
                          <select value={line.ingredient_id} onChange={(e) => updateLine(idx, 'ingredient_id', e.target.value)} className="w-full truncate rounded border border-border bg-surface px-1 py-1 text-[14px] text-text outline-none focus:border-accent">
                            <option value="">Ingredient...</option>
                            {poSupplier && ingredients.filter((i) => supplierIngIds.has(i.id)).length > 0 && (
                              <optgroup label="Supplier ingredients">
                                {ingredients.filter((i) => supplierIngIds.has(i.id)).map((i) => <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>)}
                              </optgroup>
                            )}
                            {poSupplier && ingredients.filter((i) => supplierIngIds.has(i.id)).length > 0 ? (
                              <optgroup label="Other ingredients">
                                {ingredients.filter((i) => !supplierIngIds.has(i.id)).map((i) => <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>)}
                              </optgroup>
                            ) : (
                              ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>)
                            )}
                          </select>
                          {renderIngredientContext(line.ingredient_id, poDestCP)}
                        </td>
                        {/* Package */}
                        <td className="px-2 py-1.5">
                          {(() => {
                            if (!line.ingredient_id || !poSupplier) return <span className="text-[13px] text-muted/40">—</span>
                            const allSIs = findAllSIOptions(supplierIngredients, poSupplier, line.ingredient_id)
                            const withPkg = allSIs.filter((s) => s.package_size && s.package_unit && s.package_name && s.price_per_package != null)
                            if (withPkg.length === 0) return <span className="text-[13px] text-muted/40">—</span>
                            return (
                              <select
                                value={line.selectedSIId ?? ''}
                                onChange={(e) => {
                                  const si = withPkg.find((s) => s.id === e.target.value)
                                  const next = [...poLines]
                                  next[idx].selectedSIId = e.target.value
                                  if (si) {
                                    next[idx].packageName = si.package_name!
                                    next[idx].packageSize = si.package_size!
                                    next[idx].packageUnit = si.package_unit!
                                    next[idx].pricePerPackage = si.price_per_package!
                                    next[idx].quantity_unit = si.package_unit!
                                    next[idx].unit_cost = Math.round((si.price_per_package! / si.package_size!) * 10000) / 10000
                                    next[idx].cost_source = 'supplier'
                                    // Recalc total weight from current package count
                                    if (next[idx].qtyPackages) {
                                      next[idx].quantity = Math.round(next[idx].qtyPackages! * si.package_size! * 10000) / 10000
                                    }
                                  }
                                  setPOLines(next)
                                }}
                                className="w-full truncate rounded border border-border bg-surface px-1 py-1 text-[13px] text-text outline-none focus:border-accent"
                              >
                                {withPkg.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.package_size} {s.package_unit} {s.package_name}{s.is_default ? ' ★' : ''}
                                  </option>
                                ))}
                              </select>
                            )
                          })()}
                        </td>
                        {/* Qty — package mode vs weight mode */}
                        <td className="px-2 py-1.5 text-right">
                          {hasPkg ? (
                            <input type="number" step="any" placeholder="#" value={line.qtyPackages ?? ''} onChange={(e) => updateLine(idx, 'qtyPackages', e.target.value)} min={0} className="w-full rounded border border-border bg-surface px-1 py-1 text-right text-[14px] font-mono text-text outline-none focus:border-accent" />
                          ) : (
                            <div className="flex items-center justify-end gap-1">
                              <input type="number" step="any" placeholder="Qty" value={line.quantity || ''} onChange={(e) => updateLine(idx, 'quantity', e.target.value)} min={0} className="w-12 rounded border border-border bg-surface px-1 py-1 text-right text-[14px] font-mono text-text outline-none focus:border-accent" />
                              <select value={line.quantity_unit} onChange={(e) => updateLine(idx, 'quantity_unit', e.target.value)} disabled={!line.ingredient_id} className="w-14 rounded border border-border bg-surface px-0.5 py-1 text-[13px] text-text outline-none focus:border-accent disabled:opacity-40">
                                {!line.ingredient_id && <option value="">—</option>}
                                {RECIPE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                              </select>
                            </div>
                          )}
                        </td>
                        {/* Total Weight (read-only) */}
                        <td className="px-2 py-1.5 text-right text-[14px] font-mono text-muted">
                          {hasPkg ? (
                            (line.qtyPackages ?? 0) > 0
                              ? <span className="text-emerald-400">{line.quantity.toLocaleString(undefined, { maximumFractionDigits: 1 })} {line.quantity_unit}</span>
                              : '—'
                          ) : (
                            line.quantity > 0
                              ? (() => {
                                  if (!ing || !line.quantity_unit || normalizeUnit(line.quantity_unit) === normalizeUnit(ing.unit)) return <span>{line.quantity.toLocaleString()} {line.quantity_unit}</span>
                                  try {
                                    const factor = getConversionFactorWithDensity(conversions, line.quantity_unit, ing.unit, ing.density_g_per_ml)
                                    const converted = Math.round(line.quantity * factor * 100) / 100
                                    return <span className="text-emerald-400">{converted.toLocaleString()} {ing.unit}</span>
                                  } catch { return <span className="text-red-400">—</span> }
                                })()
                              : '—'
                          )}
                        </td>
                        {/* Rate — per-package or per-unit */}
                        <td className="px-2 py-1.5 text-right">
                          {hasPkg ? (
                            <>
                              <div className="flex items-center justify-end gap-0.5">
                                <span className="text-[13px] text-muted">$</span>
                                <input type="number" step="0.01" placeholder="$" value={line.pricePerPackage || ''} onChange={(e) => updateLine(idx, 'pricePerPackage', e.target.value)} className="w-full rounded border border-border bg-surface px-1 py-1 text-right text-[14px] font-mono text-text outline-none focus:border-accent" />
                              </div>
                              {costSourceLabel(line.cost_source, line.ingredient_id, poSupplier, line.quantity_unit)}
                            </>
                          ) : (
                            <>
                              <div className="flex items-center justify-end gap-0.5">
                                <input type="number" step="0.01" placeholder="$" value={line.unit_cost || ''} onChange={(e) => updateLine(idx, 'unit_cost', e.target.value)} className="w-full rounded border border-border bg-surface px-1 py-1 text-right text-[14px] font-mono text-text outline-none focus:border-accent" />
                                {line.quantity_unit && <span className="text-[13px] text-muted">/{line.quantity_unit}</span>}
                              </div>
                              {costSourceLabel(line.cost_source, line.ingredient_id, poSupplier, line.quantity_unit)}
                            </>
                          )}
                        </td>
                        {/* Amount */}
                        <td className="px-2 py-1.5 text-right font-mono font-medium text-text">
                          <CostGuard>{fmt$(line.quantity * line.unit_cost)}</CostGuard>
                        </td>
                        {/* Delete */}
                        <td className="px-2 py-1.5 text-center">
                          {poLines.length > 1 && (
                            <button type="button" onClick={() => removeLine(idx)} className="rounded p-0.5 text-muted hover:bg-hover-strong hover:text-red-400"><X size={14} /></button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex justify-end">
              <div className="w-[250px] space-y-1 text-[15px] text-right">
                <p className="text-muted">Subtotal: <CostGuard><span className="font-mono font-semibold text-text">{fmt$(poTotal)}</span></CostGuard></p>
              </div>
            </div>
          </div>

          {/* Shipping */}
          <div className="border-t border-border pt-4">
            <p className="mb-3 text-[13px] font-medium uppercase tracking-wider text-muted">Shipping</p>
            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Shipping Cost</span>
                <div className="relative">
                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[14px] text-muted">$</span>
                  <input type="number" step="0.01" min="0" value={poShippingCost} onChange={(e) => setPOShippingCost(e.target.value)} placeholder="0.00" className="w-full rounded-lg border border-border bg-surface pl-6 pr-2 py-1.5 text-[14px] font-mono text-text placeholder:text-muted/50 outline-none focus:border-accent" />
                </div>
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Method</span>
                <select value={poShippingMethod} onChange={(e) => setPOShippingMethod(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                  <option value="">Not specified</option>
                  {SHIPPING_METHODS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Carrier</span>
                <input value={poShippingCarrier} onChange={(e) => setPOShippingCarrier(e.target.value)} placeholder="FedEx, UPS, etc." className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text placeholder:text-muted/50 outline-none focus:border-accent" />
              </label>
            </div>
            {poShippingCost && Number(poShippingCost) > 0 && (
              <p className="mt-2 text-[14px] text-muted">
                <CostGuard>{(() => {
                  const perLb = computeCreateShippingPerWeight()
                  return perLb ? `${fmtRate(perLb)}/lb` : '—'
                })()}</CostGuard>
              </p>
            )}
            {(() => {
              const hasShipping = !!(poShippingCost && Number(poShippingCost) > 0)
              return (
                <>
                  <label className={`mt-3 flex items-center gap-2 ${hasShipping ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                    <input
                      type="checkbox"
                      checked={poIncludeShipping}
                      onChange={(e) => setPOIncludeShipping(e.target.checked)}
                      disabled={!hasShipping}
                      className="accent-[#3B82F6]"
                    />
                    <span className="text-[14px] text-text">Include shipping in ingredient cost</span>
                  </label>
                  {!hasShipping && (
                    <p className="ml-6 text-[13px] text-muted/60">Enter a shipping cost first</p>
                  )}
                  {hasShipping && poIncludeShipping && (
                    <div className="mt-2 space-y-1 rounded-lg bg-surface/50 px-3 py-2">
                      {poLines.filter((l) => l.ingredient_id && l.quantity > 0).map((line, idx) => {
                        const ing = ingredients.find((i) => i.id === line.ingredient_id)
                        if (!ing) return null
                        const lineValue = line.quantity * line.unit_cost
                        const pctOfTotal = poTotal > 0 ? lineValue / poTotal : 0
                        const allocated = Number(poShippingCost) * pctOfTotal
                        const shippingPerUnit = line.quantity > 0 ? allocated / line.quantity : 0
                        const effectiveCost = line.unit_cost + shippingPerUnit
                        return (
                          <p key={idx} className="text-[13px] text-muted">
                            <CostGuard>{ing.name}: <span className="text-emerald-400">+{fmtRate(shippingPerUnit)}/{line.quantity_unit || ing.unit}</span>{' '}
                            <span className="text-text">(eff: {fmtRate(effectiveCost)}/{line.quantity_unit || ing.unit})</span></CostGuard>
                          </p>
                        )
                      })}
                    </div>
                  )}
                </>
              )
            })()}
            <div className="mt-2 flex justify-end">
              <div className="w-[250px] space-y-1 text-[15px] text-right">
                {poShippingCost && Number(poShippingCost) > 0 && (
                  <>
                    <p className="text-muted">Shipping: <CostGuard><span className="font-mono text-text">{fmt$(Number(poShippingCost))}</span></CostGuard></p>
                    <p className="text-base text-muted font-bold">Grand Total: <CostGuard><span className="font-mono font-bold text-text">{fmt$(poTotal + Number(poShippingCost))}</span></CostGuard></p>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setPOModalOpen(false)}
              className="rounded-lg border border-border px-4 py-2 text-[14px] text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Creating...' : poOrderType === 'po' ? 'Create PO' : 'Create Order'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Supplier Create Modal ── */}
      <Modal
        isOpen={supplierModalOpen}
        onClose={() => setSupplierModalOpen(false)}
        title="Add Supplier"
      >
        <form onSubmit={handleCreateSupplier} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-muted">Supplier Name</span>
            <input
              name="name"
              required
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text placeholder:text-muted/50 outline-none focus:border-accent"
            />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Contact Name</span>
              <input
                name="contact_name"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Email</span>
              <input
                name="contact_email"
                type="email"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-muted">Phone</span>
            <input
              name="contact_phone"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
            />
          </label>
          <div className="grid grid-cols-3 gap-4">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Lead Time (days)</span>
              <input
                name="lead_time_days"
                type="number"
                step="1"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Payment Terms</span>
              <input
                name="payment_terms"
                placeholder="Net 30"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Rating (1-5)</span>
              <input
                name="rating"
                type="number"
                step="0.1"
                min="1"
                max="5"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
              />
            </label>
          </div>
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setSupplierModalOpen(false)}
              className="rounded-lg border border-border px-4 py-2 text-[14px] text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Add Supplier'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Supplier Edit Modal ── */}
      <Modal
        isOpen={!!detailSupplier}
        onClose={() => setDetailSupplier(null)}
        title={`Edit ${detailSupplier?.name ?? 'Supplier'}`}
        wide
      >
        {detailSupplier && (
          <div className="space-y-4">
            {/* Supplier fields */}
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Supplier Name</span>
              <input
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                required
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
              />
            </label>
            <div className="grid grid-cols-3 gap-4">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Lead Time (days)</span>
                <input
                  type="number"
                  step="1"
                  value={editForm.lead_time_days}
                  onChange={(e) => setEditForm({ ...editForm, lead_time_days: e.target.value })}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Payment Terms</span>
                <input
                  value={editForm.payment_terms}
                  onChange={(e) => setEditForm({ ...editForm, payment_terms: e.target.value })}
                  placeholder="Net 30"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Rating (1-5)</span>
                <input
                  type="number"
                  step="0.1"
                  min="1"
                  max="5"
                  value={editForm.rating}
                  onChange={(e) => setEditForm({ ...editForm, rating: e.target.value })}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-muted">Notes</span>
              <textarea
                value={editForm.notes}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                rows={2}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent resize-none"
              />
            </label>

            {/* Contacts section */}
            <div className="border-t border-border pt-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-[13px] uppercase tracking-wider text-muted">
                  Contacts ({editContacts.filter((c) => !c._deleted).length})
                </p>
                <button
                  type="button"
                  onClick={() => setEditContacts([...editContacts, { id: null, name: '', email: '', phone: '', role: 'Sales Rep', is_primary: editContacts.filter((c) => !c._deleted).length === 0 }])}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[14px] text-accent hover:bg-accent/10"
                >
                  <Plus size={14} /> Add Contact
                </button>
              </div>

              <div className="space-y-3">
                {editContacts.map((c, idx) => {
                  if (c._deleted) return null
                  return (
                    <div key={idx} className="rounded-lg border border-border p-3 space-y-2">
                      <div className="grid grid-cols-3 gap-2">
                        <input
                          placeholder="Name"
                          value={c.name}
                          onChange={(e) => {
                            const next = [...editContacts]
                            next[idx] = { ...next[idx], name: e.target.value }
                            setEditContacts(next)
                          }}
                          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-[14px] text-text outline-none focus:border-accent"
                        />
                        <input
                          type="email"
                          placeholder="Email"
                          value={c.email}
                          onChange={(e) => {
                            const next = [...editContacts]
                            next[idx] = { ...next[idx], email: e.target.value }
                            setEditContacts(next)
                          }}
                          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-[14px] text-text outline-none focus:border-accent"
                        />
                        <input
                          placeholder="Phone"
                          value={c.phone}
                          onChange={(e) => {
                            const next = [...editContacts]
                            next[idx] = { ...next[idx], phone: e.target.value }
                            setEditContacts(next)
                          }}
                          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-[14px] text-text outline-none focus:border-accent"
                        />
                      </div>
                      <div className="flex items-center gap-3">
                        <select
                          value={c.role}
                          onChange={(e) => {
                            const next = [...editContacts]
                            next[idx] = { ...next[idx], role: e.target.value }
                            setEditContacts(next)
                          }}
                          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-[14px] text-text outline-none focus:border-accent"
                        >
                          {CONTACT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <label className="flex items-center gap-1.5 text-[14px] text-muted cursor-pointer">
                          <input
                            type="radio"
                            name="primary_contact"
                            checked={c.is_primary}
                            onChange={() => {
                              setEditContacts(editContacts.map((cc, i) => ({ ...cc, is_primary: i === idx })))
                            }}
                            className="accent-[#3B82F6]"
                          />
                          Primary
                        </label>
                        {can('delete_any') && (
                        <button
                          type="button"
                          onClick={() => {
                            const next = [...editContacts]
                            next[idx] = { ...next[idx], _deleted: true }
                            setEditContacts(next)
                          }}
                          className="ml-auto rounded p-1 text-muted hover:bg-hover-strong hover:text-red-400"
                        >
                          <X size={14} />
                        </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Ingredients */}
            <div className="border-t border-border pt-4">
              <p className="mb-3 text-[13px] uppercase tracking-wider text-muted">
                Supplied Ingredients ({new Set(detailIngredients.map((d) => d.ingredient_id)).size})
              </p>

              {detailIngredients.length > 0 && (
                <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
                  {(() => {
                    const groups = new Map<string, typeof detailIngredients>()
                    for (const d of detailIngredients) {
                      const arr = groups.get(d.ingredient_id) ?? []
                      arr.push(d)
                      groups.set(d.ingredient_id, arr)
                    }
                    return Array.from(groups.entries()).map(([ingId, options]) => {
                      const first = options[0]
                      return (
                        <div key={ingId} className="rounded-lg border border-border bg-surface/30 px-3 py-3 space-y-2">
                          {/* Ingredient header */}
                          <div className="flex items-center justify-between">
                            <span className="text-[14px] font-medium text-text">
                              {first.name} <span className="text-[14px] text-muted font-normal">({first.unit})</span>
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleAddPackageSize(ingId)}
                                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[13px] text-accent hover:bg-accent/10"
                              >
                                <Plus size={14} /> Add Size
                              </button>
                              {can('delete_any') && (
                              <button
                                type="button"
                                onClick={() => { for (const d of options) handleRemoveSI(d.si_id) }}
                                className="rounded p-1 text-muted hover:bg-hover-strong hover:text-red-400"
                                title="Remove ingredient"
                              >
                                <X size={14} />
                              </button>
                              )}
                            </div>
                          </div>

                          {/* Supplier's name for this item (shared across all package sizes) */}
                          <div className="mt-1">
                            <label className="block">
                              <span className="text-[13px] text-muted">Supplier's Name for This Item</span>
                              <input
                                type="text"
                                placeholder="How the supplier lists this item"
                                value={first.supplier_item_name}
                                onChange={(e) => {
                                  // Update all SI rows for this ingredient to keep in sync
                                  for (const d of options) updateSILocal(d.si_id, { supplier_item_name: e.target.value })
                                }}
                                className="mt-0.5 w-full rounded border border-border bg-surface px-2 py-1 text-[14px] text-text outline-none focus:border-accent"
                              />
                              <span className="text-[13px] text-muted/60">This name will appear on PO documents</span>
                            </label>
                          </div>

                          {/* Package options */}
                          {options.map((d, optIdx) => {
                            const pkgLabel = d.package_name || 'pkg'
                            return (
                              <div key={d.si_id} className={`space-y-2 ${options.length > 1 ? 'ml-2 border-l-2 border-border pl-3' : ''}`}>
                                {/* Default radio + option label (only when multiple) */}
                                {options.length > 1 && (
                                  <div className="flex items-center justify-between">
                                    <label className="flex items-center gap-1.5 text-[13px] text-muted cursor-pointer">
                                      <input
                                        type="radio"
                                        name={`default_pkg_${ingId}`}
                                        checked={d.is_default}
                                        onChange={() => handleSetDefault(d.si_id, ingId)}
                                        className="accent-[#3B82F6]"
                                      />
                                      Default{d.package_size ? ` (${d.package_size} ${d.package_unit} ${pkgLabel})` : ` (option ${optIdx + 1})`}
                                    </label>
                                    {can('delete_any') && (
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveSI(d.si_id)}
                                      className="text-[13px] text-red-400 hover:underline"
                                    >
                                      Remove
                                    </button>
                                    )}
                                  </div>
                                )}

                                {/* Package: [type ▼] [size] [unit ▼]  Total: $ [cost] */}
                                <div className="flex flex-wrap items-center gap-2">
                                  <select
                                    value={d.package_name}
                                    onChange={(e) => updateSILocal(d.si_id, { package_name: e.target.value })}
                                    className="rounded border border-border bg-surface px-1 py-1 text-[14px] text-text outline-none focus:border-accent"
                                  >
                                    <option value="">type...</option>
                                    {PACKAGE_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
                                  </select>
                                  <input
                                    type="number" step="any" placeholder="size"
                                    value={d.package_size ?? ''}
                                    onChange={(e) => {
                                      const v = e.target.value ? parseFloat(e.target.value) : null
                                      const updated = { ...d, package_size: v }
                                      const synced = syncPackagePrice(updated, 'size')
                                      updateSILocal(d.si_id, { package_size: v, ...synced })
                                    }}
                                    className="w-16 rounded border border-border bg-surface px-2 py-1 text-[14px] text-text outline-none focus:border-accent"
                                  />
                                  <select
                                    value={d.package_unit}
                                    onChange={(e) => {
                                      const updated = { ...d, package_unit: e.target.value }
                                      const synced = syncPackagePrice(updated, 'pkgunit')
                                      updateSILocal(d.si_id, { package_unit: e.target.value, ...synced })
                                    }}
                                    className="rounded border border-border bg-surface px-1 py-1 text-[14px] text-text outline-none focus:border-accent"
                                  >
                                    {RECIPE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                                  </select>
                                </div>

                                {/* Cost inputs — two editable fields that sync */}
                                {(() => {
                                  const ing = ingredients.find((i) => i.id === d.ingredient_id)
                                  const invUnit = ing?.unit ?? d.unit
                                  const pkgUnit = d.package_unit || d.unit
                                  const hasPkgSize = d.package_size != null && d.package_size > 0
                                  const crossUnit = hasPkgSize && normalizeUnit(pkgUnit) !== normalizeUnit(invUnit)

                                  return (
                                    <div className="space-y-1.5">
                                      {/* Total cost per package — only when package size is set */}
                                      {hasPkgSize && (
                                        <div className="flex items-center gap-2">
                                          <span className="text-[13px] text-muted w-[140px] text-right shrink-0">Total cost per package:</span>
                                          <span className="text-[14px] text-muted">$</span>
                                          <input
                                            type="number" step="0.01" placeholder="0.00"
                                            value={d.price_per_package ?? ''}
                                            onChange={(e) => {
                                              const v = e.target.value ? parseFloat(e.target.value) : null
                                              const updated = { ...d, price_per_package: v }
                                              const synced = syncPackagePrice(updated, 'package')
                                              updateSILocal(d.si_id, { price_per_package: v, ...synced })
                                            }}
                                            className="w-24 rounded border border-border bg-surface px-2 py-1 text-[14px] text-text outline-none focus:border-accent"
                                          />
                                        </div>
                                      )}
                                      {/* Cost per inventory unit — always shown */}
                                      <div className="flex items-center gap-2">
                                        <span className="text-[13px] text-muted w-[140px] text-right shrink-0">
                                          Cost per {invUnit}:
                                        </span>
                                        <span className="text-[14px] text-muted">$</span>
                                        <input
                                          type="number" step="any" placeholder="0.00"
                                          value={d.price_per_unit ?? ''}
                                          onChange={(e) => {
                                            const v = e.target.value ? parseFloat(e.target.value) : null
                                            updateSILocal(d.si_id, { price_per_unit: v, price_unit: invUnit })
                                          }}
                                          onBlur={() => {
                                            if (!hasPkgSize) return
                                            const synced = syncPackagePrice(d, 'unit')
                                            if (Object.keys(synced).length > 0) updateSILocal(d.si_id, synced)
                                          }}
                                          className="w-24 rounded border border-border bg-surface px-2 py-1 text-[14px] text-text outline-none focus:border-accent"
                                        />
                                      </div>
                                      {/* Cross-unit conversion note */}
                                      {crossUnit && d.price_per_unit != null && (
                                        (() => {
                                          try {
                                            const factor = getConversionFactorWithDensity(conversions, invUnit, pkgUnit, ing?.density_g_per_ml)
                                            const perPkgUnit = Math.round(d.price_per_unit * factor * 10000) / 10000
                                            return (
                                              <p className="text-[13px] font-mono text-muted ml-[148px]">
                                                <CostGuard>= {fmtRate(perPkgUnit)}/{pkgUnit}</CostGuard>
                                              </p>
                                            )
                                          } catch {
                                            return <p className="text-[13px] text-red-400 ml-[148px]">No conversion {invUnit} → {pkgUnit}</p>
                                          }
                                        })()
                                      )}
                                    </div>
                                  )
                                })()}

                                {/* Secondary: SKU, Min order, Pkgs/case */}
                                <div className="flex items-center gap-2 text-[13px] text-muted">
                                  <span>SKU</span>
                                  <input
                                    type="text" placeholder="—"
                                    value={d.supplier_sku}
                                    onChange={(e) => updateSILocal(d.si_id, { supplier_sku: e.target.value })}
                                    className="w-20 rounded border border-border bg-surface px-2 py-1 text-[14px] text-text outline-none focus:border-accent"
                                  />
                                  <span className="ml-2">Min</span>
                                  <input
                                    type="number" min="1" step="1" placeholder="—"
                                    value={d.min_order_packages ?? ''}
                                    onChange={(e) => updateSILocal(d.si_id, { min_order_packages: e.target.value ? parseInt(e.target.value, 10) : null })}
                                    className="w-12 rounded border border-border bg-surface px-2 py-1 text-[14px] text-text outline-none focus:border-accent"
                                  />
                                  <span>{pkgLabel}s</span>
                                  <span className="ml-2">Per case</span>
                                  <input
                                    type="number" min="1" step="1" placeholder="—"
                                    value={d.packages_per_case ?? ''}
                                    onChange={(e) => updateSILocal(d.si_id, { packages_per_case: e.target.value ? parseInt(e.target.value, 10) : null })}
                                    className="w-12 rounded border border-border bg-surface px-2 py-1 text-[14px] text-text outline-none focus:border-accent"
                                  />
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })
                  })()}
                </div>
              )}

              {/* Add ingredient row */}
              <div className="mt-3 flex items-center gap-2">
                <select
                  value={addIngId}
                  onChange={(e) => setAddIngId(e.target.value)}
                  className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
                >
                  <option value="">Add ingredient...</option>
                  {ingredients
                    .filter((i) => !detailIngredients.some((di) => di.ingredient_id === i.id))
                    .map((i) => (
                      <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>
                    ))}
                </select>
                <button
                  type="button"
                  onClick={handleAddSI}
                  disabled={!addIngId}
                  className="rounded-lg bg-accent px-3 py-2 text-[14px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>

            {/* Debug Log Panel */}
            {debugLog.length > 0 && (
              <div style={{ background: '#1a1a2e', border: '1px solid #e91e7b', borderRadius: 8, padding: 12, marginTop: 12, maxHeight: 150, overflow: 'auto', fontSize: 12, fontFamily: 'monospace' }}>
                <div style={{ color: '#e91e7b', fontWeight: 'bold', marginBottom: 4 }}>Save Debug Log:</div>
                {debugLog.map((msg, i) => (
                  <div key={i} style={{ color: '#ccc' }}>{msg}</div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between border-t border-border pt-4">
              {can('delete_any') && (
              <button
                type="button"
                onClick={() => { setPendingDeleteSupplier(detailSupplier); setConfirmDeleteOpen(true) }}
                className="rounded-lg px-3 py-2 text-[14px] text-red-400 transition-colors hover:bg-red-400/10"
              >
                <span className="flex items-center gap-1.5"><Trash2 size={14} /> Delete Supplier</span>
              </button>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setDetailSupplier(null)}
                  className="rounded-lg border border-border px-4 py-2 text-[14px] text-muted transition-colors hover:text-text"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveSupplier}
                  disabled={saving || !editForm.name.trim()}
                  className="rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ── PO Edit Modal ── */}
      <Modal
        isOpen={!!editPO}
        onClose={() => setEditPO(null)}
        title={`Edit ${editPO?.po_number ?? 'Order'}`}
        wide="4xl"
      >
        {editPO && (
          <div className="space-y-4">
            {/* Row 1: Order Type | PO Number | Supplier */}
            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Order Type</span>
                <input readOnly value={(ORDER_TYPES.find((t) => t.value === editPOForm.order_type) ?? ORDER_TYPES[0]).label} className="w-full rounded-lg border border-border bg-surface/50 px-2 py-1.5 text-[14px] text-muted outline-none" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">{editPOForm.order_type === 'po' ? 'PO Number' : 'Order Number'}</span>
                <input readOnly value={editPO.po_number} className="w-full rounded-lg border border-border bg-surface/50 px-2 py-1.5 text-[14px] font-mono text-muted outline-none" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Supplier</span>
                <select value={editPOForm.supplier_id} onChange={(e) => handleEditSupplierChange(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                  <option value="">No supplier</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            </div>

            {/* Order Reference (for non-PO types) */}
            {editPOForm.order_type !== 'po' && (
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Order Reference</span>
                <input value={editPOForm.order_reference} onChange={(e) => setEditPOForm({ ...editPOForm, order_reference: e.target.value })} placeholder="Email subject, website order #, confirmation #, etc." className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text placeholder:text-muted/50 outline-none focus:border-accent" />
              </label>
            )}

            {/* Row 2: Order Date | ETA | Status */}
            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Order Date</span>
                <input type="date" value={editPOForm.order_date} onChange={(e) => setEditPOForm({ ...editPOForm, order_date: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">ETA Date</span>
                <input type="date" value={editPOForm.eta_date} onChange={(e) => setEditPOForm({ ...editPOForm, eta_date: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Status</span>
                <select value={editPOForm.status} onChange={(e) => setEditPOForm({ ...editPOForm, status: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                  {Object.entries(STATUS_LABELS).map(([key, lbl]) => <option key={key} value={key}>{lbl}</option>)}
                </select>
              </label>
            </div>

            {/* Row 3: Destination CP | Tracking | Production Order */}
            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Destination Co-Packer</span>
                <select value={editPOForm.destination_co_packer_id} onChange={(e) => setEditPOForm({ ...editPOForm, destination_co_packer_id: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                  <option value="">Select co-packer...</option>
                  {coPackers.map((cp) => <option key={cp.id} value={cp.id}>{cp.name} ({cp.short_code})</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Tracking Number</span>
                <input value={editPOForm.tracking_number} onChange={(e) => setEditPOForm({ ...editPOForm, tracking_number: e.target.value })} placeholder="Optional" className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text placeholder:text-muted/50 outline-none focus:border-accent" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Production Order</span>
                <select value={editPOForm.production_order_id} onChange={(e) => setEditPOForm({ ...editPOForm, production_order_id: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                  <option value="">None</option>
                  {productionOrders.map((po) => {
                    const cp = coPackers.find((c) => c.id === po.co_packer_id)
                    return <option key={po.id} value={po.id}>{po.order_number} — {cp?.name ?? '—'}</option>
                  })}
                </select>
              </label>
            </div>

            {/* Row 4: Payment Method | Payment Status | Notes */}
            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Payment Method</span>
                <select value={editPOForm.payment_method} onChange={(e) => setEditPOForm({ ...editPOForm, payment_method: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                  <option value="">Not specified</option>
                  {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Payment Status</span>
                <select value={editPOForm.payment_status} onChange={(e) => setEditPOForm({ ...editPOForm, payment_status: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent">
                  {PAYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-muted">Notes</span>
                <input value={editPOForm.notes} onChange={(e) => setEditPOForm({ ...editPOForm, notes: e.target.value })} placeholder="Optional" className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text placeholder:text-muted/50 outline-none focus:border-accent" />
              </label>
            </div>

            {/* Line Items */}
            <div className="border-t border-border pt-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-[13px] font-medium uppercase tracking-wider text-muted">Line Items</p>
                <button
                  type="button"
                  onClick={addEditLine}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[14px] text-accent hover:bg-accent/10"
                >
                  <Plus size={14} /> Add Item
                </button>
              </div>
              <div className="rounded-lg border border-border">
                <table className="w-full table-fixed text-left text-[14px]">
                  <thead>
                    <tr className="border-b border-border bg-surface/50 text-[13px] uppercase tracking-wider text-muted">
                      <th className="px-2 py-2 font-semibold" style={{ width: 190 }}>Ingredient</th>
                      <th className="px-2 py-2 font-semibold" style={{ width: 130 }}>Package</th>
                      <th className="px-2 py-2 font-semibold text-right" style={{ width: 65 }}>Qty</th>
                      <th className="px-2 py-2 font-semibold text-right" style={{ width: 85 }}>Total Wt</th>
                      <th className="px-2 py-2 font-semibold text-right" style={{ width: 120 }}>Rate</th>
                      <th className="px-2 py-2 font-semibold text-right" style={{ width: 70 }}>Recv</th>
                      <th className="px-2 py-2 font-semibold text-right" style={{ width: 120 }}>Amount</th>
                      <th className="px-2 py-2" style={{ width: 36 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {editPOLines.map((line, idx) => {
                      if (line._deleted) return null
                      const ing = ingredients.find((i) => i.id === line.ingredient_id)
                      const hasPkg = !!(line.packageSize && line.packageName && line.pricePerPackage != null)
                      return (
                        <tr key={line.id ?? `new-${idx}`} className="border-b border-border last:border-0">
                          {/* Ingredient */}
                          <td className="px-2 py-1.5">
                            <select
                              value={line.ingredient_id}
                              onChange={(e) => updateEditLine(idx, 'ingredient_id', e.target.value)}
                              className="w-full truncate rounded border border-border bg-surface px-1 py-1 text-[14px] text-text outline-none focus:border-accent"
                            >
                              <option value="">Ingredient...</option>
                              {editPOForm.supplier_id && ingredients.filter((i) => editSupplierIngIds.has(i.id)).length > 0 && (
                                <optgroup label="Supplier ingredients">
                                  {ingredients
                                    .filter((i) => editSupplierIngIds.has(i.id))
                                    .map((i) => <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>)}
                                </optgroup>
                              )}
                              {editPOForm.supplier_id && ingredients.filter((i) => editSupplierIngIds.has(i.id)).length > 0 ? (
                                <optgroup label="Other ingredients">
                                  {ingredients
                                    .filter((i) => !editSupplierIngIds.has(i.id))
                                    .map((i) => <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>)}
                                </optgroup>
                              ) : (
                                ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>)
                              )}
                            </select>
                            {(() => {
                              if (!line.ingredient_id || !editPOForm.supplier_id) return null
                              const si0 = supplierIngredients.find((s) => s.supplier_id === editPOForm.supplier_id && s.ingredient_id === line.ingredient_id)
                              if (si0?.supplier_item_name) return (
                                <p className="mt-0.5 text-[13px] text-muted italic truncate" title={si0.supplier_item_name}>
                                  {si0.supplier_item_name}
                                </p>
                              )
                              return null
                            })()}
                            {renderIngredientContext(line.ingredient_id, editPOForm.destination_co_packer_id)}
                          </td>
                          {/* Package */}
                          <td className="px-2 py-1.5">
                            {(() => {
                              if (!line.ingredient_id || !editPOForm.supplier_id) return <span className="text-[13px] text-muted/40">—</span>
                              const allSIs = findAllSIOptions(supplierIngredients, editPOForm.supplier_id, line.ingredient_id)
                              const withPkg = allSIs.filter((s) => s.package_size && s.package_unit && s.package_name && s.price_per_package != null)
                              if (withPkg.length === 0) {
                                if (line.packageName && line.packageSize && line.packageUnit) {
                                  return <p className="text-[13px] text-muted truncate">{line.packageSize} {line.packageUnit} {line.packageName}</p>
                                }
                                return <span className="text-[13px] text-muted/40">—</span>
                              }
                              return (
                                <select
                                  value={line.selectedSIId ?? ''}
                                  onChange={(e) => {
                                    const si = withPkg.find((s) => s.id === e.target.value)
                                    setEditPOLines((prev) => prev.map((l, i) => {
                                      if (i !== idx) return l
                                      if (si) {
                                        const newPPP = si.price_per_package!
                                        return {
                                          ...l,
                                          selectedSIId: e.target.value,
                                          packageName: si.package_name!,
                                          packageSize: si.package_size!,
                                          packageUnit: si.package_unit!,
                                          pricePerPackage: newPPP,
                                          quantity_unit: si.package_unit!,
                                          unit_cost: Math.round((newPPP / si.package_size!) * 10000) / 10000,
                                          cost_source: 'supplier' as CostSource,
                                          quantity: l.qtyPackages ? Math.round(l.qtyPackages * si.package_size! * 10000) / 10000 : l.quantity,
                                        }
                                      }
                                      return { ...l, selectedSIId: e.target.value }
                                    }))
                                  }}
                                  className="w-full truncate rounded border border-border bg-surface px-1 py-1 text-[13px] text-text outline-none focus:border-accent"
                                >
                                  {withPkg.map((s) => (
                                    <option key={s.id} value={s.id}>
                                      {s.package_size} {s.package_unit} {s.package_name}{s.is_default ? ' ★' : ''}
                                    </option>
                                  ))}
                                </select>
                              )
                            })()}
                          </td>
                          {/* Qty — package mode vs weight mode */}
                          <td className="px-2 py-1.5 text-right">
                            {hasPkg ? (
                              <input type="number" step="any" placeholder="#" value={line.qtyPackages ?? ''} onChange={(e) => updateEditLine(idx, 'qtyPackages', e.target.value)} min={0} className="w-full rounded border border-border bg-surface px-1 py-1 text-right text-[14px] font-mono text-text outline-none focus:border-accent" />
                            ) : (
                              <div className="flex items-center justify-end gap-1">
                                <input type="number" step="any" placeholder="Qty" value={line.quantity || ''} onChange={(e) => updateEditLine(idx, 'quantity', e.target.value)} min={0} className="w-12 rounded border border-border bg-surface px-1 py-1 text-right text-[14px] font-mono text-text outline-none focus:border-accent" />
                                <select value={line.quantity_unit} onChange={(e) => updateEditLine(idx, 'quantity_unit', e.target.value)} disabled={!line.ingredient_id} className="w-14 rounded border border-border bg-surface px-0.5 py-1 text-[13px] text-text outline-none focus:border-accent disabled:opacity-40">
                                  {!line.ingredient_id && <option value="">—</option>}
                                  {RECIPE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                                </select>
                              </div>
                            )}
                          </td>
                          {/* Total Weight (read-only) */}
                          <td className="px-2 py-1.5 text-right text-[14px] font-mono text-muted">
                            {hasPkg ? (
                              (line.qtyPackages ?? 0) > 0
                                ? <span className="text-emerald-400">{line.quantity.toLocaleString(undefined, { maximumFractionDigits: 1 })} {line.quantity_unit}</span>
                                : '—'
                            ) : (
                              line.quantity > 0
                                ? (() => {
                                    if (!ing || !line.quantity_unit || normalizeUnit(line.quantity_unit) === normalizeUnit(ing.unit)) return <span>{line.quantity.toLocaleString()} {line.quantity_unit}</span>
                                    try {
                                      const factor = getConversionFactorWithDensity(conversions, line.quantity_unit, ing.unit, ing.density_g_per_ml)
                                      const converted = Math.round(line.quantity * factor * 100) / 100
                                      return <span className="text-emerald-400">{converted.toLocaleString()} {ing.unit}</span>
                                    } catch { return <span className="text-red-400">—</span> }
                                  })()
                                : '—'
                            )}
                          </td>
                          {/* Rate — per-package or per-unit */}
                          <td className="px-2 py-1.5 text-right">
                            {hasPkg ? (
                              <>
                                <div className="flex items-center justify-end gap-0.5">
                                  <span className="text-[13px] text-muted">$</span>
                                  <input type="number" step="0.01" placeholder="$" value={line.pricePerPackage || ''} onChange={(e) => updateEditLine(idx, 'pricePerPackage', e.target.value)} className="w-full rounded border border-border bg-surface px-1 py-1 text-right text-[14px] font-mono text-text outline-none focus:border-accent" />
                                </div>
                                {costSourceLabel(line.cost_source, line.ingredient_id, editPOForm.supplier_id, line.quantity_unit)}
                              </>
                            ) : (
                              <>
                                <div className="flex items-center justify-end gap-0.5">
                                  <input type="number" step="0.01" placeholder="$" value={line.unit_cost || ''} onChange={(e) => updateEditLine(idx, 'unit_cost', e.target.value)} className="w-full rounded border border-border bg-surface px-1 py-1 text-right text-[14px] font-mono text-text outline-none focus:border-accent" />
                                  {line.quantity_unit && <span className="text-[13px] text-muted">/{line.quantity_unit}</span>}
                                </div>
                                {costSourceLabel(line.cost_source, line.ingredient_id, editPOForm.supplier_id, line.quantity_unit)}
                              </>
                            )}
                          </td>
                          {/* Received */}
                          <td className="px-2 py-1.5 text-right">
                            <input
                              type="number"
                              step="any"
                              min="0"
                              value={line.received_quantity ?? ''}
                              onChange={(e) => updateEditLine(idx, 'received_quantity', e.target.value)}
                              placeholder="—"
                              className="w-full rounded border border-border bg-surface px-2 py-1 text-right text-[14px] font-mono text-text outline-none focus:border-accent"
                            />
                          </td>
                          {/* Amount */}
                          <td className="px-2 py-1.5 text-right font-mono font-medium text-text">
                            <CostGuard>{fmt$(line.quantity * line.unit_cost)}</CostGuard>
                          </td>
                          {/* Delete */}
                          <td className="px-2 py-1.5">
                            <button
                              type="button"
                              onClick={() => removeEditLine(idx)}
                              className="rounded p-1 text-muted hover:bg-hover-strong hover:text-red-400"
                            >
                              <X size={14} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex justify-end">
                <div className="w-[250px] space-y-1 text-[15px] text-right">
                  <p className="text-muted">Subtotal: <CostGuard><span className="font-mono font-semibold text-text">{fmt$(editPOTotal)}</span></CostGuard></p>
                </div>
              </div>
            </div>

            {/* Shipping */}
            <div className="border-t border-border pt-4">
              <p className="mb-3 text-[13px] font-medium uppercase tracking-wider text-muted">Shipping</p>
              <div className="grid grid-cols-3 gap-3">
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-muted">Shipping Cost</span>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[14px] text-muted">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editPOForm.shipping_cost}
                      onChange={(e) => setEditPOForm({ ...editPOForm, shipping_cost: e.target.value })}
                      placeholder="0.00"
                      className="w-full rounded-lg border border-border bg-surface pl-6 pr-2 py-1.5 text-[14px] font-mono text-text placeholder:text-muted/50 outline-none focus:border-accent"
                    />
                  </div>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-muted">Method</span>
                  <select
                    value={editPOForm.shipping_method}
                    onChange={(e) => setEditPOForm({ ...editPOForm, shipping_method: e.target.value })}
                    className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent"
                  >
                    <option value="">Not specified</option>
                    {SHIPPING_METHODS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-muted">Carrier</span>
                  <input
                    value={editPOForm.shipping_carrier}
                    onChange={(e) => setEditPOForm({ ...editPOForm, shipping_carrier: e.target.value })}
                    placeholder="FedEx, UPS, etc."
                    className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text placeholder:text-muted/50 outline-none focus:border-accent"
                  />
                </label>
              </div>
              {editPOForm.shipping_cost && Number(editPOForm.shipping_cost) > 0 && (
                <p className="mt-2 text-[14px] text-muted">
                  <CostGuard>{(() => {
                    const perLb = computeEditShippingPerWeight()
                    return perLb ? `${fmtRate(perLb)}/lb` : '—'
                  })()}</CostGuard>
                </p>
              )}
              {(() => {
                const hasShipping = !!(editPOForm.shipping_cost && Number(editPOForm.shipping_cost) > 0)
                return (
                  <>
                    <label className={`mt-3 flex items-center gap-2 ${hasShipping ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                      <input
                        type="checkbox"
                        checked={editPOForm.include_shipping_in_cost}
                        onChange={(e) => setEditPOForm({ ...editPOForm, include_shipping_in_cost: e.target.checked })}
                        disabled={!hasShipping}
                        className="accent-[#3B82F6]"
                      />
                      <span className="text-[14px] text-text">Include shipping in ingredient cost</span>
                    </label>
                    {!hasShipping && (
                      <p className="ml-6 text-[13px] text-muted/60">Enter a shipping cost first</p>
                    )}
                    {hasShipping && editPOForm.include_shipping_in_cost && (
                      <div className="mt-2 space-y-1 rounded-lg bg-surface/50 px-3 py-2">
                        {editPOLines.filter((l) => !l._deleted && l.ingredient_id && l.quantity > 0).map((line, idx) => {
                          const ing = ingredients.find((i) => i.id === line.ingredient_id)
                          if (!ing) return null
                          const lineValue = line.quantity * line.unit_cost
                          const pctOfTotal = editPOTotal > 0 ? lineValue / editPOTotal : 0
                          const allocated = Number(editPOForm.shipping_cost) * pctOfTotal
                          const shippingPerUnit = line.quantity > 0 ? allocated / line.quantity : 0
                          const effectiveCost = line.unit_cost + shippingPerUnit
                          return (
                            <p key={idx} className="text-[13px] text-muted">
                              <CostGuard>{ing.name}: <span className="text-emerald-400">+{fmtRate(shippingPerUnit)}/{line.quantity_unit || ing.unit}</span>{' '}
                              <span className="text-text">(eff: {fmtRate(effectiveCost)}/{line.quantity_unit || ing.unit})</span></CostGuard>
                            </p>
                          )
                        })}
                      </div>
                    )}
                  </>
                )
              })()}
              <div className="mt-2 flex justify-end">
                <div className="w-[250px] space-y-1 text-[15px] text-right">
                  {editPOForm.shipping_cost && Number(editPOForm.shipping_cost) > 0 && (
                    <>
                      <p className="text-muted">Shipping: <CostGuard><span className="font-mono text-text">{fmt$(Number(editPOForm.shipping_cost))}</span></CostGuard></p>
                      <p className="text-base text-muted font-bold">Grand Total: <CostGuard><span className="font-mono font-bold text-text">{fmt$(editPOTotal + Number(editPOForm.shipping_cost))}</span></CostGuard></p>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                {can('delete_any') && (editPOCanDelete || editPODeleteWarning) && (
                  <button
                    type="button"
                    onClick={() => setConfirmDeletePOOpen(true)}
                    className="rounded-lg px-3 py-2 text-[14px] text-red-400 transition-colors hover:bg-red-400/10"
                  >
                    <span className="flex items-center gap-1.5"><Trash2 size={14} /> Delete PO</span>
                  </button>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => handleDownloadPDF(editPO.id)}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[14px] text-muted transition-colors hover:text-text hover:bg-hover"
                  title="Download PDF"
                >
                  <FileDown size={14} />
                  PDF
                </button>
                <button
                  type="button"
                  onClick={() => handlePrintPDF(editPO.id)}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[14px] text-muted transition-colors hover:text-text hover:bg-hover"
                  title="Print"
                >
                  <Printer size={14} />
                  Print
                </button>
                <button
                  type="button"
                  onClick={() => setEditPO(null)}
                  className="rounded-lg border border-border px-4 py-2 text-[14px] text-muted transition-colors hover:text-text"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSavePO}
                  disabled={saving}
                  className="rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Confirm Delete PO Dialog ── */}
      <ConfirmDialog
        isOpen={confirmDeletePOOpen}
        title={`Delete ${editPO?.po_number ?? 'this PO'}?`}
        message={
          editPODeleteWarning
            ? 'This PO is currently in transit. Deleting it will remove all line items and cannot be undone. Are you sure?'
            : 'This will permanently delete the purchase order and all its line items. This cannot be undone.'
        }
        confirmLabel="Delete PO"
        danger
        onConfirm={handleDeletePO}
        onCancel={() => setConfirmDeletePOOpen(false)}
      />

      {/* ── Confirm Cancel Dialog ── */}
      <ConfirmDialog
        isOpen={confirmCancelOpen}
        title="Cancel this PO?"
        message="This marks the order as cancelled."
        confirmLabel="Cancel PO"
        danger
        onConfirm={confirmCancel}
        onCancel={() => { setConfirmCancelOpen(false); setPendingCancelId(null) }}
      />

      {/* ── Confirm Delete Supplier Dialog ── */}
      <ConfirmDialog
        isOpen={confirmDeleteOpen}
        title={`Delete ${pendingDeleteSupplier?.name ?? 'supplier'}?`}
        message="This will also remove all ingredient links and unlink any purchase orders from this supplier. This cannot be undone."
        confirmLabel="Delete Supplier"
        danger
        onConfirm={handleDeleteSupplier}
        onCancel={() => { setConfirmDeleteOpen(false); setPendingDeleteSupplier(null) }}
      />

      {/* ── Import Preview Modal ── */}
      <Modal
        isOpen={importModalOpen}
        onClose={() => { setImportModalOpen(false); setImportDiff(null) }}
        title="Import Preview"
        wide="xl"
      >
        {importDiff && (
          <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-border bg-surface p-3 text-center">
                <p className="text-2xl font-bold text-green-400">{importDiff.newSuppliers.length}</p>
                <p className="text-[14px] text-muted">New Suppliers</p>
              </div>
              <div className="rounded-lg border border-border bg-surface p-3 text-center">
                <p className="text-2xl font-bold text-accent">{importDiff.updatedSuppliers.length}</p>
                <p className="text-[14px] text-muted">Updates</p>
              </div>
              <div className="rounded-lg border border-border bg-surface p-3 text-center">
                <p className="text-2xl font-bold text-red-400">{importDiff.errors.length}</p>
                <p className="text-[14px] text-muted">Errors</p>
              </div>
            </div>

            {/* Errors */}
            {importDiff.errors.length > 0 && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                <p className="mb-1 text-[14px] font-medium text-red-400">
                  Errors ({importDiff.errors.length}) — these rows will be skipped:
                </p>
                <ul className="max-h-32 space-y-0.5 overflow-y-auto text-[14px] text-red-300">
                  {importDiff.errors.map((e, i) => (
                    <li key={i}>Row {e.row}: {e.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Warnings */}
            {importDiff.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="mb-1 text-[14px] font-medium text-amber-400">
                  Warnings ({importDiff.warnings.length}):
                </p>
                <ul className="max-h-24 space-y-0.5 overflow-y-auto text-[14px] text-amber-300">
                  {importDiff.warnings.map((w, i) => (
                    <li key={i}>Row {w.row}: {w.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* New suppliers */}
            {importDiff.newSuppliers.length > 0 && (
              <div>
                <p className="mb-2 text-[14px] font-medium uppercase tracking-wider text-muted">New Suppliers</p>
                <div className="space-y-1">
                  {importDiff.newSuppliers.map((s, i) => (
                    <div key={i} className="rounded-lg border border-green-500/20 bg-green-500/5 px-3 py-2 text-[14px]">
                      <span className="font-medium text-text">{s.supplier_name}</span>
                      <span className="ml-2 text-[14px] text-muted">
                        {s.contacts.length} contact{s.contacts.length !== 1 ? 's' : ''},
                        {' '}{s.ingredients.length} ingredient{s.ingredients.length !== 1 ? 's' : ''}
                        {s.payment_terms && <> &middot; {s.payment_terms}</>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Updated suppliers */}
            {importDiff.updatedSuppliers.length > 0 && (
              <div>
                <p className="mb-2 text-[14px] font-medium uppercase tracking-wider text-muted">Updated Suppliers</p>
                <div className="space-y-1">
                  {importDiff.updatedSuppliers.map(({ group, changes }, i) => {
                    const hasChanges = changes.fieldsChanged.length > 0 ||
                      changes.contactsAdded > 0 || changes.contactsRemoved > 0 ||
                      changes.ingredientsAdded.length > 0 || changes.ingredientsUpdated.length > 0 ||
                      changes.ingredientsRemoved.length > 0

                    return (
                      <div key={i} className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-[14px]">
                        <span className="font-medium text-text">{group.supplier_name}</span>
                        {!hasChanges && (
                          <span className="ml-2 text-[14px] text-muted">No changes</span>
                        )}
                        {hasChanges && (
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[14px] text-muted">
                            {changes.fieldsChanged.length > 0 && (
                              <span>Fields: {changes.fieldsChanged.join(', ')}</span>
                            )}
                            {changes.contactsAdded > 0 && (
                              <span className="text-green-400">+{changes.contactsAdded} contact{changes.contactsAdded !== 1 ? 's' : ''}</span>
                            )}
                            {changes.contactsRemoved > 0 && (
                              <span className="text-red-400">-{changes.contactsRemoved} contact{changes.contactsRemoved !== 1 ? 's' : ''}</span>
                            )}
                            {changes.ingredientsAdded.length > 0 && (
                              <span className="text-green-400">+{changes.ingredientsAdded.length} ingredient{changes.ingredientsAdded.length !== 1 ? 's' : ''}</span>
                            )}
                            {changes.ingredientsUpdated.length > 0 && (
                              <span className="text-accent">~{changes.ingredientsUpdated.length} price{changes.ingredientsUpdated.length !== 1 ? 's' : ''}</span>
                            )}
                            {changes.ingredientsRemoved.length > 0 && (
                              <span className="text-red-400">-{changes.ingredientsRemoved.length} ingredient{changes.ingredientsRemoved.length !== 1 ? 's' : ''}</span>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Nothing to import */}
            {importDiff.newSuppliers.length === 0 && importDiff.updatedSuppliers.length === 0 && (
              <p className="py-4 text-center text-[14px] text-muted">
                No valid suppliers found in this CSV. Check the errors above.
              </p>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3 border-t border-border pt-4">
              <button
                onClick={() => { setImportModalOpen(false); setImportDiff(null) }}
                className="rounded-lg border border-border px-4 py-2 text-[14px] text-muted transition-colors hover:text-text"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmImport}
                disabled={importing || (importDiff.newSuppliers.length === 0 && importDiff.updatedSuppliers.length === 0)}
                className="rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {importing ? 'Importing\u2026' : 'Confirm Import'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Price Comparison Modal ── */}
      {priceCompareIngId && (() => {
        const ing = ingredients.find((i) => i.id === priceCompareIngId)
        if (!ing) return null
        const allOpts = findSupplierOptions(
          priceCompareIngId,
          ing.unit,
          suppliers,
          supplierIngredients,
          conversions,
          ing.density_g_per_ml,
          true, // allOptions
        )
        return (
          <Modal
            isOpen={true}
            onClose={() => setPriceCompareIngId(null)}
            title={`Price Comparison — ${ing.name}`}
          >
            <div className="space-y-3">
              <p className="text-[14px] text-muted">
                All supplier pricing for <span className="font-medium text-text">{ing.name}</span>, sorted by per-{ing.unit} cost.
              </p>
              {allOpts.length === 0 ? (
                <p className="py-6 text-center text-[14px] text-muted">No supplier pricing found for this ingredient.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-left text-[14px]">
                    <thead>
                      <tr className="border-b border-border bg-surface/50 text-muted">
                        <th className="px-3 py-2 font-semibold uppercase tracking-wider">Supplier</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wider">Package</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wider text-right">Per Pkg</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wider text-right">Per {ing.unit}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allOpts.map((opt, i) => (
                        <tr
                          key={opt.siId ?? `${opt.supplierId}-${i}`}
                          className={`border-b border-border last:border-0 ${
                            i === 0 ? 'bg-green-500/5' : ''
                          }`}
                        >
                          <td className="px-3 py-2 font-medium text-text">
                            {opt.supplierName}
                            {opt.isDefault && <span className="ml-1 text-amber-400">★</span>}
                          </td>
                          <td className="px-3 py-2 text-muted">
                            {opt.packageLabel ?? '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-text">
                            <CostGuard>{opt.packageLabel ? fmt$(opt.rawPrice) : '—'}</CostGuard>
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-medium text-text">
                            <CostGuard>{fmtRate(opt.pricePerUnit)}/{ing.unit}
                            {i === 0 && <span className="ml-1 text-[13px] text-green-400">best</span>}</CostGuard>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setPriceCompareIngId(null)}
                  className="rounded-lg border border-border px-4 py-2 text-[14px] text-muted transition-colors hover:text-text"
                >
                  Close
                </button>
              </div>
            </div>
          </Modal>
        )
      })()}
    </div>
  )
}

/* ────────── inline status dropdown ────────── */

function StatusDropdown({
  status,
  onChangeStatus,
}: {
  status: string
  onChangeStatus: (s: string) => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState({ top: 0, right: 0 })
  const badgeColor = STATUS_BADGE[status] ?? 'gray'
  const label = STATUS_LABELS[status] ?? status

  function toggle() {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    }
    setOpen(!open)
  }

  return (
    <div className="relative inline-block" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="cursor-pointer"
      >
        <Badge color={badgeColor}>{label}</Badge>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-36 rounded-lg border border-border bg-card py-1 shadow-xl"
            style={{ top: pos.top, right: pos.right }}
          >
            {Object.entries(STATUS_LABELS).map(([key, lbl]) => (
              <button
                key={key}
                type="button"
                onClick={(e) => { e.stopPropagation(); onChangeStatus(key); setOpen(false) }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-[14px] transition-colors hover:bg-hover ${
                  key === status ? 'text-accent font-medium' : 'text-text'
                }`}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor:
                      key === 'draft' ? '#7A8599'
                        : key === 'ordered' ? '#3B82F6'
                        : key === 'in_transit' ? '#06B6D4'
                        : key === 'received' ? '#22C55E'
                        : '#EF4444',
                  }}
                />
                {lbl}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
