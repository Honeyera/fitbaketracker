import { dbUpdate, dbInsert, dbInsertSingle } from './dbWrite'
import { sanitize } from './sanitizePayload'
import { supabase } from './supabase'
import { syncIngredientStatus } from './syncIngredientStatus'

/**
 * Centralized PO status sync — call this after ANY PO status change
 * from any page (Suppliers, ProductionRuns, Shipments sync).
 *
 * Handles the full side-effect chain:
 *  1. Sync status to linked shipment (create if needed)
 *  2. Update production order ingredient_status
 *
 * Fire-and-forget safe — all errors are caught and logged.
 * This does NOT update the PO status itself (caller does that).
 */
export async function syncAfterPOStatusChange(
  poId: string,
  newStatus: string,
  opts?: {
    /** If known, skip the DB lookup */
    productionOrderId?: string | null
    /** Skip shipment sync (e.g. if caller already handled it directly) */
    skipShipmentSync?: boolean
  },
): Promise<string | null> {
  const messages: string[] = []

  // 1. Sync to linked shipment
  if (!opts?.skipShipmentSync) {
    try {
      const msg = await syncPOStatusToShipment(poId, newStatus)
      if (msg) messages.push(msg)
    } catch (err) {
      console.warn('[syncAfterPOStatusChange] Shipment sync failed:', err)
    }
  }

  // 2. Update production order ingredient_status
  try {
    let prodOrderId = opts?.productionOrderId
    if (prodOrderId === undefined) {
      // Look it up
      const { data: po } = await supabase
        .from('purchase_orders')
        .select('production_order_id')
        .eq('id', poId)
        .single()
      prodOrderId = po?.production_order_id ?? null
    }
    if (prodOrderId) {
      await syncIngredientStatus(prodOrderId)
      messages.push('Procurement status updated')
    }
  } catch (err) {
    console.warn('[syncAfterPOStatusChange] Ingredient status sync failed:', err)
  }

  return messages.length > 0 ? messages.join(', ') : null
}

/* ── Internal: sync PO status to linked shipment ──────────────── */

const PO_TO_SHIPMENT_STATUS: Record<string, string> = {
  ordered: 'ordered',
  in_transit: 'in_transit',
  received: 'received',
}

async function syncPOStatusToShipment(
  poId: string,
  newStatus: string,
): Promise<string | null> {
  const mapped = PO_TO_SHIPMENT_STATUS[newStatus]
  if (!mapped) return null

  // Find existing linked shipment
  const { data: shipments } = await supabase
    .from('shipments_to_copacker')
    .select('id, status')
    .eq('purchase_order_id', poId)
    .limit(1)

  if (shipments && shipments.length > 0) {
    // Update existing shipment
    const shipment = shipments[0]
    if (shipment.status === mapped) return null // already in sync

    const payload: Record<string, unknown> = { status: mapped }
    if (mapped === 'in_transit') {
      payload.ship_date = new Date().toISOString().split('T')[0]
    }
    if (mapped === 'received') {
      payload.received_date = new Date().toISOString().split('T')[0]
    }

    await dbUpdate(
      'shipments_to_copacker',
      sanitize('shipments_to_copacker', payload),
      'id',
      shipment.id,
    )
    return `Shipment → ${mapped}`
  }

  // No shipment exists — create one for ordered/in_transit/received
  const { data: po } = await supabase
    .from('purchase_orders')
    .select('po_number, co_packer_id:destination_co_packer_id, supplier_id, shipping_carrier, tracking_number, shipping_cost, production_order_id, total_cost')
    .eq('id', poId)
    .single()
  if (!po) return null

  // Generate next shipment number
  const { data: lastShip } = await supabase
    .from('shipments_to_copacker')
    .select('shipment_number')
    .order('created_at', { ascending: false })
    .limit(1)
  const lastNum = lastShip?.[0]?.shipment_number
  const nextNum = lastNum
    ? `SHP-${String(parseInt(lastNum.replace(/\D/g, '') || '0') + 1).padStart(4, '0')}`
    : 'SHP-0001'

  const today = new Date().toISOString().split('T')[0]
  const shipPayload: Record<string, unknown> = {
    shipment_number: nextNum,
    purchase_order_id: poId,
    co_packer_id: po.co_packer_id,
    supplier_id: po.supplier_id,
    status: mapped,
    carrier: po.shipping_carrier,
    tracking_number: po.tracking_number,
    shipping_cost: po.shipping_cost,
    total_value: po.total_cost,
    cp_confirmed: false,
    production_order_id: po.production_order_id,
    notes: `Auto-created from PO ${po.po_number}`,
  }
  if (mapped === 'in_transit' || mapped === 'received') {
    shipPayload.ship_date = today
  }
  if (mapped === 'received') {
    shipPayload.received_date = today
  }

  const { data: newShipment } = await dbInsertSingle(
    'shipments_to_copacker',
    sanitize('shipments_to_copacker', shipPayload),
  )

  // Create shipment items from PO items
  if (newShipment) {
    const { data: poItems } = await supabase
      .from('purchase_order_items')
      .select('ingredient_id, quantity, unit_cost')
      .eq('purchase_order_id', poId)

    if (poItems && poItems.length > 0) {
      const shipItems = poItems
        .filter((it: { ingredient_id: string | null }) => it.ingredient_id)
        .map((it: { ingredient_id: string; quantity: number; unit_cost: number }) =>
          sanitize('shipment_items', {
            shipment_id: newShipment.id,
            ingredient_id: it.ingredient_id,
            quantity: it.quantity,
            value: it.quantity * it.unit_cost,
          }),
        )
      if (shipItems.length > 0) {
        await dbInsert('shipment_items', shipItems)
      }
    }
  }

  return `Shipment ${newShipment?.shipment_number ?? nextNum} created`
}
