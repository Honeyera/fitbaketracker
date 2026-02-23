import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { format } from 'date-fns'
import { fmt$, fmtDate } from '../lib/format'
import PageHeader from '../components/PageHeader'
import CPFilterBar from '../components/CPFilterBar'
import DataTable, { type Column } from '../components/DataTable'
import CPBadge from '../components/CPBadge'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import ConfirmDialog from '../components/ConfirmDialog'
import { PageSkeleton } from '../components/Skeleton'
import { useToast } from '../components/Toast'
import { useAuth } from '../contexts/AuthContext'
import { logActivity } from '../lib/activityLog'
import { Plus, X, Trash2, ChevronRight } from 'lucide-react'
import { syncIngredientStatus } from '../lib/syncIngredientStatus'
import { sanitize } from '../lib/sanitizePayload'
import { dbInsert, dbUpdate, dbDelete } from '../lib/dbWrite'
import type {
  ShipmentToCopacker,
  ShipmentItem,
  Ingredient,
  CoPacker,
  PurchaseOrder,
  PurchaseOrderItem,
  IngredientInventory,
  Supplier,
  ProductionOrder,
  IngredientTag,
  IngredientTagLink,
} from '../types/database'

/* ── Status config ────────────────────────────────────────── */

const STATUS_BADGE: Record<string, 'gray' | 'cyan' | 'green' | 'red'> = {
  ordered: 'gray',
  in_transit: 'cyan',
  received: 'green',
  confirmed: 'green',
  cancelled: 'red',
}

const STATUS_LABELS: Record<string, string> = {
  ordered: 'Ordered',
  in_transit: 'In Transit',
  received: 'Received',
  confirmed: '\u2713 Confirmed',
  cancelled: 'Cancelled',
}

const STATUS_FILTERS = ['all', 'ordered', 'in_transit', 'received', 'confirmed'] as const

const STATUSES = ['ordered', 'in_transit', 'received', 'confirmed', 'cancelled'] as const

const NEXT_STATUS: Record<string, string> = {
  ordered: 'in_transit',
  in_transit: 'received',
  received: 'confirmed',
}

const INVENTORY_STATUSES = new Set(['received', 'confirmed'])

/* ── Row type for the table ─────────────────────────────────── */

interface Row extends Record<string, unknown> {
  id: string
  shipment_number: string
  co_packer_id: string | null
  supplier_name: string
  ship_date: string | null
  received_date: string | null
  items: string
  total_value: number
  tracking_number: string | null
  status: string
  purchase_order_id: string | null
  production_order_id: string | null
  production_order_number: string
}

/* ── Edit line-item type ────────────────────────────────────── */

interface EditLine {
  id: string | null   // null = new unsaved line
  ingredient_id: string
  quantity: number
  lot_number: string
  value: number
  _deleted?: boolean
}

/* ================================================================ */

export default function Shipments() {
  const toast = useToast()
  const { can, appUser } = useAuth()

  const [shipments, setShipments] = useState<ShipmentToCopacker[]>([])
  const [shipmentItems, setShipmentItems] = useState<ShipmentItem[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [poItems, setPOItems] = useState<PurchaseOrderItem[]>([])
  const [inventory, setInventory] = useState<IngredientInventory[]>([])
  const [productionOrders, setProductionOrders] = useState<ProductionOrder[]>([])
  const [tags, setTags] = useState<IngredientTag[]>([])
  const [tagLinks, setTagLinks] = useState<IngredientTagLink[]>([])
  const [cpFilter, setCpFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [prodOrderFilter, setProdOrderFilter] = useState('all')
  const [loading, setLoading] = useState(true)

  /* edit modal */
  const [editShipment, setEditShipment] = useState<ShipmentToCopacker | null>(null)
  const [editForm, setEditForm] = useState({
    co_packer_id: '',
    status: 'ordered',
    ship_date: '',
    received_date: '',
    carrier: '',
    tracking_number: '',
    shipping_cost: '',
    notes: '',
    production_order_id: '',
  })
  const [editLines, setEditLines] = useState<EditLine[]>([])
  const [saving, setSaving] = useState(false)

  /* confirm dialogs */
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmStatusChange, setConfirmStatusChange] = useState<{
    shipmentId: string
    fromStatus: string
    toStatus: string
    message: string
  } | null>(null)
  const [confirmBulk, setConfirmBulk] = useState(false)

  /* ── Data loading ─────────────────────────────────────────── */

  async function load() {
    const [shipRes, itemsRes, ingRes, cpRes, supRes, poRes, poiRes, invRes, prodOrderRes, tagsRes, tagLinksRes] = await safeBatch(() => Promise.all([
      supabase.from('shipments_to_copacker').select('*').order('created_at', { ascending: false }),
      supabase.from('shipment_items').select('*'),
      supabase.from('ingredients').select('*').order('name'),
      supabase.from('co_packers').select('*').order('name'),
      supabase.from('suppliers').select('*').order('name'),
      supabase.from('purchase_orders').select('*'),
      supabase.from('purchase_order_items').select('*'),
      supabase.from('ingredient_inventory').select('*'),
      supabase.from('production_orders').select('*').order('created_at', { ascending: false }),
      supabase.from('ingredient_tags').select('*').order('name'),
      supabase.from('ingredient_tag_links').select('*'),
    ]))
    setShipments(shipRes.data ?? [])
    setShipmentItems(itemsRes.data ?? [])
    setIngredients(ingRes.data ?? [])
    setCoPackers(cpRes.data ?? [])
    setSuppliers(supRes.data ?? [])
    setPurchaseOrders(poRes.data ?? [])
    setPOItems(poiRes.data ?? [])
    setInventory(invRes.data ?? [])
    setProductionOrders(prodOrderRes.data ?? [])
    setTags(tagsRes.data ?? [])
    setTagLinks(tagLinksRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => safeLoad(load, setLoading), [])

  /* ── Derive status helper ───────────────────────────────── */

  function deriveStatus(s: ShipmentToCopacker): string {
    return s.status ?? (s.cp_confirmed ? 'confirmed' : 'received')
  }

  /* ── Ingredient tag label helper ────────────────────────── */

  function ingTagLabel(ingredientId: string): string {
    const ingTags = tagLinks
      .filter((l) => l.ingredient_id === ingredientId)
      .map((l) => tags.find((t) => t.id === l.tag_id)?.name)
      .filter(Boolean)
    return ingTags.length > 0 ? ` [${ingTags.join(', ')}]` : ''
  }

  /* ── Build table rows ─────────────────────────────────────── */

  /** Resolve supplier name: direct supplier_id first, then via linked PO */
  function getSupplierName(s: ShipmentToCopacker): string {
    if (s.supplier_id) {
      return suppliers.find((sup) => sup.id === s.supplier_id)?.name ?? ''
    }
    if (s.purchase_order_id) {
      const po = purchaseOrders.find((p) => p.id === s.purchase_order_id)
      if (po?.supplier_id) {
        return suppliers.find((sup) => sup.id === po.supplier_id)?.name ?? ''
      }
    }
    return ''
  }

  /** Resolve production order ID: direct field, then via linked PO */
  function resolveProductionOrderId(s: ShipmentToCopacker): string | null {
    if (s.production_order_id) return s.production_order_id
    if (s.purchase_order_id) {
      const po = purchaseOrders.find((p) => p.id === s.purchase_order_id)
      if (po?.production_order_id) return po.production_order_id
    }
    return null
  }

  const rows: Row[] = useMemo(() => {
    let filtered = shipments
    if (cpFilter !== 'all') {
      filtered = filtered.filter((s) => s.co_packer_id === cpFilter)
    }
    return filtered
      .map((s) => {
        const sItems = shipmentItems.filter((si) => si.shipment_id === s.id)
        const itemDescs = sItems.map((si) => {
          const ing = ingredients.find((i) => i.id === si.ingredient_id)
          return `${ing?.name ?? '?'} \u00d7 ${Math.round(si.quantity).toLocaleString()} ${ing?.unit ?? ''}`
        })
        const status = deriveStatus(s)
        const prodOrderId = resolveProductionOrderId(s)
        const prodOrder = prodOrderId ? productionOrders.find((o) => o.id === prodOrderId) : null
        return {
          id: s.id,
          shipment_number: s.shipment_number,
          co_packer_id: s.co_packer_id,
          supplier_name: getSupplierName(s),
          ship_date: s.ship_date,
          received_date: s.received_date,
          items: itemDescs.join(', '),
          total_value: s.total_value ?? 0,
          tracking_number: s.tracking_number,
          status,
          purchase_order_id: s.purchase_order_id,
          production_order_id: prodOrderId,
          production_order_number: prodOrder?.order_number ?? '',
        }
      })
      .filter((r) => statusFilter === 'all' || r.status === statusFilter)
      .filter((r) => prodOrderFilter === 'all' || r.production_order_id === prodOrderFilter)
  }, [shipments, shipmentItems, ingredients, suppliers, purchaseOrders, productionOrders, cpFilter, statusFilter, prodOrderFilter])

  /* ── Inventory helpers ──────────────────────────────────── */

  async function addInventoryForShipment(shipmentId: string, cpId: string | null) {
    const items = shipmentItems.filter((si) => si.shipment_id === shipmentId)
    for (const item of items) {
      if (!item.ingredient_id || item.quantity <= 0) continue
      const existing = inventory.find(
        (iv) => iv.ingredient_id === item.ingredient_id && iv.location_type === 'copacker' && iv.co_packer_id === cpId,
      )
      if (existing) {
        const { error } = await dbUpdate('ingredient_inventory',
          sanitize('ingredient_inventory', {
            quantity: (existing.quantity ?? 0) + item.quantity,
            updated_at: new Date().toISOString(),
          }),
          'id', existing.id)
        if (error) throw new Error(`Inventory update failed: ${error.message}`)
      } else {
        const { error } = await dbInsert('ingredient_inventory',
          sanitize('ingredient_inventory', {
            ingredient_id: item.ingredient_id,
            location_type: 'copacker',
            co_packer_id: cpId,
            quantity: item.quantity,
            updated_at: new Date().toISOString(),
          }),
        )
        if (error) throw new Error(`Inventory insert failed: ${error.message}`)
      }
    }
  }

  async function reverseInventoryForShipment(shipmentId: string, cpId: string | null) {
    const items = shipmentItems.filter((si) => si.shipment_id === shipmentId)
    for (const item of items) {
      if (!item.ingredient_id || item.quantity <= 0) continue
      const existing = inventory.find(
        (iv) => iv.ingredient_id === item.ingredient_id && iv.location_type === 'copacker' && iv.co_packer_id === cpId,
      )
      if (existing) {
        const newQty = Math.max(0, (existing.quantity ?? 0) - item.quantity)
        const { error } = await dbUpdate('ingredient_inventory',
          sanitize('ingredient_inventory', { quantity: newQty, updated_at: new Date().toISOString() }),
          'id', existing.id)
        if (error) throw new Error(`Inventory reversal failed: ${error.message}`)
      }
    }
  }

  /* ── Open edit modal ────────────────────────────────────── */

  function openEdit(row: Row) {
    const s = shipments.find((sh) => sh.id === row.id)
    if (!s) return
    setEditShipment(s)
    const status = deriveStatus(s)
    setEditForm({
      co_packer_id: s.co_packer_id ?? '',
      status,
      ship_date: s.ship_date ?? '',
      received_date: s.received_date ?? '',
      carrier: s.carrier ?? '',
      tracking_number: s.tracking_number ?? '',
      shipping_cost: s.shipping_cost != null ? String(s.shipping_cost) : '',
      notes: s.notes ?? '',
      production_order_id: s.production_order_id ?? '',
    })
    const items = shipmentItems.filter((si) => si.shipment_id === s.id)
    setEditLines(
      items.map((si) => ({
        id: si.id,
        ingredient_id: si.ingredient_id ?? '',
        quantity: si.quantity,
        lot_number: si.lot_number ?? '',
        value: si.value ?? 0,
      })),
    )
  }

  function closeEdit() {
    setEditShipment(null)
  }

  /* ── Save edit ──────────────────────────────────────────── */

  async function handleSaveEdit() {
    if (!editShipment) return
    setSaving(true)

    // Safety timeout: if the entire save takes >15s, abort
    const saveTimeout = setTimeout(() => {
      setSaving(false)
      toast.error('Save timed out. Please try again.')
    }, 15000)

    try {
      const oldStatus = deriveStatus(editShipment)
      const newStatus = editForm.status
      const cpId = editForm.co_packer_id || null

      // Handle inventory transitions
      const wasInventoried = INVENTORY_STATUSES.has(oldStatus)
      const willBeInventoried = INVENTORY_STATUSES.has(newStatus)

      if (!wasInventoried && willBeInventoried) {
        await addInventoryForShipment(editShipment.id, cpId)
      } else if (wasInventoried && !willBeInventoried) {
        await reverseInventoryForShipment(editShipment.id, editShipment.co_packer_id)
      }

      // Calculate total_value from lines
      const activeLines = editLines.filter((l) => !l._deleted && l.ingredient_id)
      const totalValue = activeLines.reduce((s, l) => s + l.value, 0)

      // Update shipment record
      const { error: updateErr } = await dbUpdate('shipments_to_copacker',
        sanitize('shipments_to_copacker', {
          co_packer_id: cpId,
          status: newStatus,
          ship_date: editForm.ship_date || null,
          received_date: editForm.received_date || null,
          carrier: editForm.carrier || null,
          tracking_number: editForm.tracking_number || null,
          shipping_cost: editForm.shipping_cost ? Number(editForm.shipping_cost) : null,
          notes: editForm.notes || null,
          total_value: totalValue,
          cp_confirmed: newStatus === 'confirmed',
          cp_confirmed_date: newStatus === 'confirmed' ? format(new Date(), 'yyyy-MM-dd') : editShipment.cp_confirmed_date,
          production_order_id: editForm.production_order_id || null,
        }),
        'id', editShipment.id)
      if (updateErr) throw new Error(updateErr.message)

      // Update/insert/delete line items
      for (const line of editLines) {
        if (line._deleted && line.id) {
          const { error } = await dbDelete('shipment_items', 'id', line.id)
          if (error) throw new Error(error.message)
        } else if (!line._deleted && line.id) {
          const { error } = await dbUpdate('shipment_items',
            sanitize('shipment_items', {
              ingredient_id: line.ingredient_id || null,
              quantity: line.quantity,
              lot_number: line.lot_number || null,
              value: line.value,
            }),
            'id', line.id)
          if (error) throw new Error(error.message)
        } else if (!line._deleted && !line.id && line.ingredient_id) {
          const { error } = await dbInsert('shipment_items',
            sanitize('shipment_items', {
              shipment_id: editShipment.id,
              ingredient_id: line.ingredient_id || null,
              quantity: line.quantity,
              lot_number: line.lot_number || null,
              value: line.value,
            }),
          )
          if (error) throw new Error(error.message)
        }
      }

      toast.success(`Shipment ${editShipment.shipment_number} updated`)
      logActivity(appUser?.id, 'update_shipment', 'shipment', editShipment.id)
      const syncOrderId = editForm.production_order_id || editShipment.production_order_id
      if (syncOrderId) syncIngredientStatus(syncOrderId)
      closeEdit()
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save shipment')
    } finally {
      clearTimeout(saveTimeout)
      setSaving(false)
    }
  }

  /* ── Delete shipment ────────────────────────────────────── */

  async function handleDeleteShipment() {
    if (!editShipment) return
    setSaving(true)

    try {
      const status = deriveStatus(editShipment)

      // Reverse inventory if it was received/confirmed
      if (INVENTORY_STATUSES.has(status)) {
        await reverseInventoryForShipment(editShipment.id, editShipment.co_packer_id)
      }

      // Delete items then shipment
      await dbDelete('shipment_items', 'shipment_id', editShipment.id)
      await dbDelete('shipments_to_copacker', 'id', editShipment.id)

      toast.success(`Shipment ${editShipment.shipment_number} deleted`)
      logActivity(appUser?.id, 'delete_shipment', 'shipment', editShipment.id)
      if (editShipment.production_order_id) syncIngredientStatus(editShipment.production_order_id)
      setConfirmDelete(false)
      closeEdit()
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete shipment')
    } finally {
      setSaving(false)
    }
  }

  /* ── Inline status advance ──────────────────────────────── */

  async function handleInlineStatusChange(shipmentId: string, newStatus: string) {
    const s = shipments.find((sh) => sh.id === shipmentId)
    if (!s) return
    const oldStatus = deriveStatus(s)

    const goingToInventory = !INVENTORY_STATUSES.has(oldStatus) && INVENTORY_STATUSES.has(newStatus)
    const leavingInventory = INVENTORY_STATUSES.has(oldStatus) && !INVENTORY_STATUSES.has(newStatus)

    if (goingToInventory || leavingInventory) {
      const cpName = coPackers.find((c) => c.id === s.co_packer_id)?.name ?? 'co-packer'
      const itemCount = shipmentItems.filter((si) => si.shipment_id === shipmentId).length
      setConfirmStatusChange({
        shipmentId,
        fromStatus: oldStatus,
        toStatus: newStatus,
        message: goingToInventory
          ? `This will add ${itemCount} item(s) to ${cpName} inventory.`
          : `This will remove ${itemCount} item(s) from ${cpName} inventory.`,
      })
      return
    }

    await executeStatusChange(shipmentId, oldStatus, newStatus)
  }

  async function executeStatusChange(shipmentId: string, oldStatus: string, newStatus: string) {
    const s = shipments.find((sh) => sh.id === shipmentId)
    if (!s) return

    try {
      const wasInventoried = INVENTORY_STATUSES.has(oldStatus)
      const willBeInventoried = INVENTORY_STATUSES.has(newStatus)

      if (!wasInventoried && willBeInventoried) {
        await addInventoryForShipment(shipmentId, s.co_packer_id)
      } else if (wasInventoried && !willBeInventoried) {
        await reverseInventoryForShipment(shipmentId, s.co_packer_id)
      }

      const updateData: Record<string, unknown> = {
        status: newStatus,
      }
      if (newStatus === 'in_transit' && !s.ship_date) {
        updateData.ship_date = format(new Date(), 'yyyy-MM-dd')
      }
      if (newStatus === 'received' && !s.received_date) {
        updateData.received_date = format(new Date(), 'yyyy-MM-dd')
        updateData.cp_confirmed = false
      }
      if (newStatus === 'confirmed') {
        updateData.cp_confirmed = true
        updateData.cp_confirmed_date = format(new Date(), 'yyyy-MM-dd')
      }

      const { error } = await dbUpdate('shipments_to_copacker',
        sanitize('shipments_to_copacker', updateData),
        'id', shipmentId)
      if (error) throw new Error(error.message)

      logActivity(appUser?.id, 'update_shipment_status', 'shipment', shipmentId, { status: newStatus })
      if (s.production_order_id) syncIngredientStatus(s.production_order_id)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update status')
    }
  }

  async function confirmInlineStatusChange() {
    if (!confirmStatusChange) return
    setSaving(true)
    try {
      await executeStatusChange(
        confirmStatusChange.shipmentId,
        confirmStatusChange.fromStatus,
        confirmStatusChange.toStatus,
      )
      setConfirmStatusChange(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update status')
    } finally {
      setSaving(false)
    }
  }

  /* ── Bulk confirm ───────────────────────────────────────── */

  const receivedCount = useMemo(
    () => shipments.filter((s) => deriveStatus(s) === 'received').length,
    [shipments],
  )

  async function handleBulkConfirm() {
    setSaving(true)
    try {
      const receivedShipments = shipments.filter((s) => deriveStatus(s) === 'received')
      for (const s of receivedShipments) {
        const { error } = await dbUpdate('shipments_to_copacker',
          sanitize('shipments_to_copacker', {
            status: 'confirmed',
            cp_confirmed: true,
            cp_confirmed_date: format(new Date(), 'yyyy-MM-dd'),
          }),
          'id', s.id)
        if (error) throw new Error(error.message)
      }
      toast.success(`${receivedShipments.length} shipment(s) confirmed`)
      setConfirmBulk(false)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to bulk confirm')
    } finally {
      setSaving(false)
    }
  }

  /* ── Edit line helpers ──────────────────────────────────── */

  function updateEditLine(idx: number, field: keyof EditLine, value: string | number) {
    setEditLines((prev) => {
      const next = [...prev]
      const line = { ...next[idx] }
      if (field === 'ingredient_id') {
        line.ingredient_id = value as string
        // Auto-recalc value
        const ing = ingredients.find((i) => i.id === value)
        line.value = Math.round(line.quantity * (ing?.unit_cost ?? 0) * 100) / 100
      } else if (field === 'quantity') {
        line.quantity = Number(value) || 0
        const ing = ingredients.find((i) => i.id === line.ingredient_id)
        line.value = Math.round(line.quantity * (ing?.unit_cost ?? 0) * 100) / 100
      } else if (field === 'lot_number') {
        line.lot_number = value as string
      } else if (field === 'value') {
        line.value = Number(value) || 0
      }
      next[idx] = line
      return next
    })
  }

  function removeEditLine(idx: number) {
    setEditLines((prev) => {
      const next = [...prev]
      if (next[idx].id) {
        next[idx] = { ...next[idx], _deleted: true }
      } else {
        next.splice(idx, 1)
      }
      return next
    })
  }

  function addEditLine() {
    setEditLines((prev) => [...prev, { id: null, ingredient_id: '', quantity: 0, lot_number: '', value: 0 }])
  }

  /* ── PO diff warnings ──────────────────────────────────── */

  function getPOWarnings(): string[] {
    if (!editShipment?.purchase_order_id) return []
    const poLineItems = poItems.filter((pi) => pi.purchase_order_id === editShipment.purchase_order_id)
    const warnings: string[] = []
    const activeLines = editLines.filter((l) => !l._deleted)

    for (const poi of poLineItems) {
      if (!poi.ingredient_id) continue
      const ing = ingredients.find((i) => i.id === poi.ingredient_id)
      const shipLine = activeLines.find((l) => l.ingredient_id === poi.ingredient_id)
      const shipQty = shipLine?.quantity ?? 0
      if (Math.abs(shipQty - poi.quantity) > 0.01) {
        warnings.push(`PO ordered ${Math.round(poi.quantity).toLocaleString()} ${ing?.unit ?? ''} of ${ing?.name ?? '?'}, shipment shows ${Math.round(shipQty).toLocaleString()} ${ing?.unit ?? ''}`)
      }
    }
    return warnings
  }

  /* ── Status change message for edit modal ───────────────── */

  function getStatusChangeWarning(): string | null {
    if (!editShipment) return null
    const oldStatus = deriveStatus(editShipment)
    const newStatus = editForm.status
    if (oldStatus === newStatus) return null

    const cpName = coPackers.find((c) => c.id === (editForm.co_packer_id || editShipment.co_packer_id))?.name ?? 'co-packer'
    const itemCount = editLines.filter((l) => !l._deleted && l.ingredient_id).length

    const wasInventoried = INVENTORY_STATUSES.has(oldStatus)
    const willBeInventoried = INVENTORY_STATUSES.has(newStatus)

    if (!wasInventoried && willBeInventoried) {
      return `This will add ${itemCount} item(s) to ${cpName} inventory.`
    }
    if (wasInventoried && !willBeInventoried) {
      return `This will remove ${itemCount} item(s) from ${cpName} inventory.`
    }
    return null
  }

  /* ── Delete message ─────────────────────────────────────── */

  function getDeleteMessage(): string {
    if (!editShipment) return ''
    const status = deriveStatus(editShipment)
    const cpName = coPackers.find((c) => c.id === editShipment.co_packer_id)?.name ?? 'co-packer'
    const parts: string[] = []

    if (INVENTORY_STATUSES.has(status)) {
      parts.push(`This shipment added inventory to ${cpName}. Deleting it will reverse those inventory changes.`)
    }
    if (editShipment.purchase_order_id) {
      const po = purchaseOrders.find((p) => p.id === editShipment.purchase_order_id)
      parts.push(`This shipment was auto-created from PO ${po?.po_number ?? '?'}. The PO will not be deleted.`)
    }
    parts.push(`Delete shipment ${editShipment.shipment_number}?`)
    return parts.join(' ')
  }

  /* ── Columns ──────────────────────────────────────────────── */

  const columns: Column<Row>[] = useMemo(
    () => [
      {
        label: 'Ship #',
        key: 'shipment_number',
        width: '110px',
        render: (row) => (
          <span className="font-mono font-medium text-accent">{row.shipment_number}</span>
        ),
      },
      {
        label: 'From',
        key: 'supplier_name',
        width: '130px',
        render: (row) => (
          <span className="text-xs text-text">
            {(row.supplier_name as string) || '\u2014'}
          </span>
        ),
      },
      {
        label: 'Co-Packer',
        key: 'co_packer_id',
        width: '110px',
        render: (row) =>
          row.co_packer_id ? <CPBadge coPackerId={row.co_packer_id as string} /> : '\u2014',
      },
      {
        label: 'Prod. Order',
        key: 'production_order_number',
        width: '120px',
        render: (row) =>
          row.production_order_number ? (
            <span className="inline-block rounded-full bg-purple-500/15 px-2 py-0.5 text-[11px] font-medium text-purple-400">
              {row.production_order_number as string}
            </span>
          ) : (
            <span className="text-muted">{'\u2014'}</span>
          ),
      },
      {
        label: 'Ship Date',
        key: 'ship_date',
        width: '120px',
        render: (row) => (
          <span className="text-text">
            {row.ship_date ? fmtDate(row.ship_date as string) : '\u2014'}
          </span>
        ),
      },
      {
        label: 'Received',
        key: 'received_date',
        width: '120px',
        render: (row) => (
          <span className="text-text">
            {row.received_date ? fmtDate(row.received_date as string) : '\u2014'}
          </span>
        ),
      },
      {
        label: 'Items',
        key: 'items',
        render: (row) => (
          <span className="text-xs text-muted">{row.items as string}</span>
        ),
      },
      {
        label: 'Total Value',
        key: 'total_value',
        align: 'right',
        width: '110px',
        render: (row) => (
          <span className="font-mono font-medium text-text">
            {fmt$(row.total_value as number)}
          </span>
        ),
      },
      {
        label: 'Tracking',
        key: 'tracking_number',
        width: '140px',
        render: (row) => (
          <span className="font-mono text-xs text-muted">
            {(row.tracking_number as string) || '\u2014'}
          </span>
        ),
      },
      {
        label: 'Status',
        key: 'status',
        align: 'center',
        width: '180px',
        render: (row) => {
          const st = row.status as string
          const next = NEXT_STATUS[st]
          return (
            <div className="flex items-center justify-center gap-1" onClick={(e) => e.stopPropagation()}>
              <Badge color={STATUS_BADGE[st] ?? 'gray'}>
                {STATUS_LABELS[st] ?? st}
              </Badge>
              {next && (
                <button
                  onClick={() => handleInlineStatusChange(row.id, next)}
                  title={`Advance to ${STATUS_LABELS[next]}`}
                  className="rounded p-0.5 text-muted transition-colors hover:bg-hover-strong hover:text-accent"
                >
                  <ChevronRight size={14} />
                </button>
              )}
            </div>
          )
        },
      },
    ],
    [shipments, shipmentItems, inventory, coPackers],
  )

  /* ── Render ───────────────────────────────────────────────── */

  if (loading) return <PageSkeleton />

  // Linked PO info for edit modal
  const linkedPO = editShipment?.purchase_order_id
    ? purchaseOrders.find((p) => p.id === editShipment.purchase_order_id)
    : null

  // Linked production order for edit modal
  const linkedProdOrderId = editShipment ? resolveProductionOrderId(editShipment) : null
  const linkedProdOrder = linkedProdOrderId
    ? productionOrders.find((o) => o.id === linkedProdOrderId)
    : null

  // Production orders matching this shipment's co-packer (for edit dropdown)
  const editCPProductionOrders = productionOrders.filter(
    (o) => o.co_packer_id === editForm.co_packer_id,
  )

  const statusChangeWarning = getStatusChangeWarning()
  const poWarnings = getPOWarnings()

  return (
    <div>
      <PageHeader title="Shipments to Co-Packer" subtitle="Track inbound ingredient deliveries to co-packers" />

      {/* CP Filter */}
      <CPFilterBar selected={cpFilter} onSelect={setCpFilter} />

      {/* Status Filter + Prod Order Filter + Bulk Confirm */}
      <div className="mb-4 flex items-center gap-4">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                statusFilter === f
                  ? 'bg-accent text-white'
                  : 'bg-card text-muted hover:text-text'
              }`}
            >
              {f === 'all' ? 'All' : STATUS_LABELS[f] ?? f}
            </button>
          ))}
        </div>
        <select
          value={prodOrderFilter}
          onChange={(e) => setProdOrderFilter(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
        >
          <option value="all">All Prod. Orders</option>
          {productionOrders
            .filter((o) => shipments.some((s) => resolveProductionOrderId(s) === o.id))
            .map((o) => (
              <option key={o.id} value={o.id}>{o.order_number}</option>
            ))}
        </select>
        {receivedCount > 0 && (
          <button
            onClick={() => setConfirmBulk(true)}
            className="ml-auto rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700"
          >
            Confirm All Received ({receivedCount})
          </button>
        )}
      </div>

      {/* Shipment History Table */}
      <DataTable
        columns={columns}
        data={rows}
        onRowClick={openEdit}
        emptyMessage="No shipments yet"
        emptyHint="Shipments will appear here once deliveries are recorded"
      />

      {/* ── Edit Shipment Modal ── */}
      <Modal
        isOpen={!!editShipment}
        onClose={closeEdit}
        title=""
        wide="xl"
      >
        {editShipment && (
          <div className="space-y-5">
            {/* Header */}
            <div className="flex items-center gap-3 -mt-2">
              <span className="font-mono text-lg font-semibold text-accent">{editShipment.shipment_number}</span>
              {editShipment.co_packer_id && <CPBadge coPackerId={editShipment.co_packer_id} />}
              <Badge color={STATUS_BADGE[editForm.status] ?? 'gray'}>
                {STATUS_LABELS[editForm.status] ?? editForm.status}
              </Badge>
            </div>

            {/* Shipped From + Linked PO + Production Order chain */}
            {(() => {
              const supName = editShipment ? getSupplierName(editShipment) : ''
              const hasParts = supName || linkedPO || linkedProdOrder
              if (!hasParts) return null
              return (
                <p className="text-xs text-muted">
                  {supName && <>From <span className="font-medium text-text">{supName}</span></>}
                  {linkedPO && (
                    <>{supName ? ' ' : ''}(PO <span className="font-mono font-medium text-accent">{linkedPO.po_number}</span>)</>
                  )}
                  {linkedProdOrder && (
                    <> {'\u2192'} For: <span className="inline-block rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[11px] font-medium text-purple-400">{linkedProdOrder.order_number}</span></>
                  )}
                </p>
              )
            })()}

            {/* Fields */}
            <div className="grid grid-cols-3 gap-4">
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Co-Packer</span>
                <select
                  value={editForm.co_packer_id}
                  onChange={(e) => setEditForm((f) => ({ ...f, co_packer_id: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                >
                  <option value="">None</option>
                  {coPackers.map((cp) => (
                    <option key={cp.id} value={cp.id}>{cp.name} ({cp.short_code})</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Status</span>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                >
                  {STATUSES.map((st) => (
                    <option key={st} value={st}>{STATUS_LABELS[st] ?? st}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Ship Date</span>
                <input
                  type="date"
                  value={editForm.ship_date}
                  onChange={(e) => setEditForm((f) => ({ ...f, ship_date: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </label>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Production Order</span>
                <select
                  value={editForm.production_order_id}
                  onChange={(e) => setEditForm((f) => ({ ...f, production_order_id: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                >
                  <option value="">None</option>
                  {editCPProductionOrders.map((o) => (
                    <option key={o.id} value={o.id}>{o.order_number}</option>
                  ))}
                </select>
              </label>
            </div>

            {(editForm.status === 'received' || editForm.status === 'confirmed') && (
              <div className="grid grid-cols-3 gap-4">
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Received Date</span>
                  <input
                    type="date"
                    value={editForm.received_date}
                    onChange={(e) => setEditForm((f) => ({ ...f, received_date: e.target.value }))}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                  />
                </label>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Carrier</span>
                <input
                  value={editForm.carrier}
                  onChange={(e) => setEditForm((f) => ({ ...f, carrier: e.target.value }))}
                  placeholder="FedEx, UPS, etc."
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Tracking Number</span>
                <input
                  value={editForm.tracking_number}
                  onChange={(e) => setEditForm((f) => ({ ...f, tracking_number: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm font-mono text-text outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Shipping Cost</span>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted">$</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={editForm.shipping_cost}
                    onChange={(e) => setEditForm((f) => ({ ...f, shipping_cost: e.target.value }))}
                    className="w-full rounded-lg border border-border bg-surface pl-7 pr-3 py-2 text-sm font-mono text-text outline-none focus:border-accent"
                  />
                </div>
              </label>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs text-muted">Notes</span>
              <textarea
                value={editForm.notes}
                onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent resize-none"
              />
            </label>

            {/* Status change warning */}
            {statusChangeWarning && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                {statusChangeWarning}
              </div>
            )}

            {/* Line Items */}
            <div className="border-t border-border pt-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wider text-muted">Line Items</p>
                <button
                  type="button"
                  onClick={addEditLine}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-accent hover:bg-accent/10"
                >
                  <Plus size={14} /> Add Item
                </button>
              </div>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border bg-surface/50 text-muted">
                      <th className="px-3 py-2 font-medium">Ingredient</th>
                      <th className="px-3 py-2 font-medium text-right" style={{ width: 100 }}>Qty</th>
                      <th className="px-3 py-2 font-medium" style={{ width: 120 }}>Lot #</th>
                      <th className="px-3 py-2 font-medium text-right" style={{ width: 100 }}>Value</th>
                      <th className="w-10 px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {editLines.map((line, idx) => {
                      if (line._deleted) return null
                      const ing = ingredients.find((i) => i.id === line.ingredient_id)
                      return (
                        <tr key={line.id ?? `new-${idx}`} className="border-b border-border last:border-0">
                          <td className="px-3 py-2">
                            <select
                              value={line.ingredient_id}
                              onChange={(e) => updateEditLine(idx, 'ingredient_id', e.target.value)}
                              className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-accent"
                            >
                              <option value="">Ingredient...</option>
                              {ingredients.map((i) => (
                                <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <input
                                type="number"
                                step="any"
                                value={line.quantity || ''}
                                onChange={(e) => updateEditLine(idx, 'quantity', e.target.value)}
                                className="w-20 rounded border border-border bg-surface px-2 py-1 text-right text-xs font-mono text-text outline-none focus:border-accent"
                              />
                              {ing && <span className="text-[10px] text-muted">{ing.unit}</span>}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <input
                              value={line.lot_number}
                              onChange={(e) => updateEditLine(idx, 'lot_number', e.target.value)}
                              placeholder="Lot #"
                              className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text placeholder:text-muted/50 outline-none focus:border-accent"
                            />
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-medium text-text">
                            {fmt$(line.value)}
                          </td>
                          <td className="px-3 py-2">
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
              <p className="mt-2 text-right text-xs text-muted">
                Total: <span className="font-mono font-medium text-text">
                  {fmt$(editLines.filter((l) => !l._deleted).reduce((s, l) => s + l.value, 0))}
                </span>
              </p>
            </div>

            {/* PO quantity diff warnings */}
            {poWarnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400 space-y-1">
                {poWarnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between border-t border-border pt-4">
              {can('delete_any') && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10"
              >
                <Trash2 size={14} /> Delete Shipment
              </button>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeEdit}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={saving}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Delete Confirm ── */}
      <ConfirmDialog
        isOpen={confirmDelete}
        title="Delete Shipment"
        message={getDeleteMessage()}
        confirmLabel="Delete"
        danger
        loading={saving}
        onConfirm={handleDeleteShipment}
        onCancel={() => setConfirmDelete(false)}
      />

      {/* ── Inline Status Change Confirm ── */}
      <ConfirmDialog
        isOpen={!!confirmStatusChange}
        title="Confirm Status Change"
        message={confirmStatusChange?.message ?? ''}
        confirmLabel="Continue"
        danger={false}
        loading={saving}
        onConfirm={confirmInlineStatusChange}
        onCancel={() => setConfirmStatusChange(null)}
      />

      {/* ── Bulk Confirm ── */}
      <ConfirmDialog
        isOpen={confirmBulk}
        title="Confirm All Received"
        message={`Confirm ${receivedCount} shipment(s) as verified by co-packer?`}
        confirmLabel={`Confirm ${receivedCount}`}
        danger={false}
        loading={saving}
        onConfirm={handleBulkConfirm}
        onCancel={() => setConfirmBulk(false)}
      />
    </div>
  )
}
