import { dbUpdate } from './dbWrite'
import { sanitize } from './sanitizePayload'
import { supabase } from './supabase'

/**
 * Bidirectional sync between Purchase Orders and linked Shipments.
 *
 * These functions use dbUpdate (raw fetch) directly — they don't go through
 * React state handlers, so there's no risk of infinite sync loops.
 */

const PO_TO_SHIPMENT_STATUS: Record<string, string> = {
  ordered: 'ordered',
  in_transit: 'in_transit',
  received: 'received',
}

const SHIPMENT_TO_PO_STATUS: Record<string, string> = {
  ordered: 'ordered',
  in_transit: 'in_transit',
  received: 'received',
  confirmed: 'received',
}

/** After updating a PO, sync shared fields to its linked shipment. */
export async function syncPOtoShipment(
  poId: string,
  updatedFields: Record<string, unknown>,
): Promise<string | null> {
  try {
    const { data: shipments } = await supabase
      .from('shipments_to_copacker')
      .select('id')
      .eq('purchase_order_id', poId)
      .limit(1)

    if (!shipments || shipments.length === 0) return null

    const shipmentId = shipments[0].id
    const syncPayload: Record<string, unknown> = {}
    const synced: string[] = []

    if ('tracking_number' in updatedFields) {
      syncPayload.tracking_number = updatedFields.tracking_number
      synced.push('Tracking number')
    }
    if ('shipping_carrier' in updatedFields) {
      syncPayload.carrier = updatedFields.shipping_carrier
      synced.push('Carrier')
    }
    if ('shipping_cost' in updatedFields) {
      syncPayload.shipping_cost = updatedFields.shipping_cost
      synced.push('Shipping cost')
    }
    if ('status' in updatedFields) {
      const mapped = PO_TO_SHIPMENT_STATUS[updatedFields.status as string]
      if (mapped) {
        syncPayload.status = mapped
        synced.push('Status')
        if (mapped === 'in_transit') {
          syncPayload.ship_date = new Date().toISOString().split('T')[0]
        }
        if (mapped === 'received') {
          syncPayload.received_date = new Date().toISOString().split('T')[0]
        }
      }
    }

    if (Object.keys(syncPayload).length === 0) return null

    await dbUpdate(
      'shipments_to_copacker',
      sanitize('shipments_to_copacker', syncPayload),
      'id',
      shipmentId,
    )

    return `${synced.join(', ')} synced to linked shipment`
  } catch (err) {
    console.warn('PO → Shipment sync failed (non-blocking):', err)
    return null
  }
}

/**
 * Bulk backfill: for every shipment that has a tracking_number and a linked PO,
 * copy tracking_number + carrier to the PO if the PO's tracking_number is empty.
 * Fire-and-forget — call once after data loads.
 */
export async function backfillShipmentTrackingToPOs(): Promise<number> {
  try {
    const { data: ships } = await supabase
      .from('shipments_to_copacker')
      .select('id, purchase_order_id, tracking_number, carrier, shipping_cost, status')
      .not('purchase_order_id', 'is', null)

    if (!ships || ships.length === 0) return 0

    const poIds = [...new Set(ships.map((s) => s.purchase_order_id).filter(Boolean))] as string[]
    if (poIds.length === 0) return 0

    const { data: pos } = await supabase
      .from('purchase_orders')
      .select('id, tracking_number, shipping_carrier')
      .in('id', poIds)

    if (!pos) return 0

    const poMap = new Map(pos.map((p) => [p.id, p]))
    let count = 0

    for (const ship of ships) {
      if (!ship.purchase_order_id || !ship.tracking_number) continue
      const po = poMap.get(ship.purchase_order_id)
      if (!po) continue
      // Only backfill if PO is missing tracking
      if (po.tracking_number) continue

      const syncPayload: Record<string, unknown> = {
        tracking_number: ship.tracking_number,
      }
      if (ship.carrier) syncPayload.shipping_carrier = ship.carrier

      await dbUpdate(
        'purchase_orders',
        sanitize('purchase_orders', syncPayload),
        'id',
        po.id,
      )
      count++
    }

    if (count > 0) console.log(`[backfill] Synced tracking from ${count} shipment(s) to POs`)
    return count
  } catch (err) {
    console.warn('Backfill shipment→PO tracking failed (non-blocking):', err)
    return 0
  }
}

/** After updating a Shipment, sync shared fields back to its linked PO. */
export async function syncShipmentToPO(
  purchaseOrderId: string | null,
  updatedFields: Record<string, unknown>,
): Promise<string | null> {
  try {
    if (!purchaseOrderId) return null

    const syncPayload: Record<string, unknown> = {}
    const synced: string[] = []

    if ('tracking_number' in updatedFields) {
      syncPayload.tracking_number = updatedFields.tracking_number
      synced.push('Tracking number')
    }
    if ('carrier' in updatedFields) {
      syncPayload.shipping_carrier = updatedFields.carrier
      synced.push('Carrier')
    }
    if ('shipping_cost' in updatedFields) {
      syncPayload.shipping_cost = updatedFields.shipping_cost
      synced.push('Shipping cost')
    }
    if ('status' in updatedFields) {
      const mapped = SHIPMENT_TO_PO_STATUS[updatedFields.status as string]
      if (mapped) {
        syncPayload.status = mapped
        synced.push('Status')
      }
    }

    if (Object.keys(syncPayload).length === 0) return null

    await dbUpdate(
      'purchase_orders',
      sanitize('purchase_orders', syncPayload),
      'id',
      purchaseOrderId,
    )

    return `${synced.join(', ')} synced to linked PO`
  } catch (err) {
    console.warn('Shipment → PO sync failed (non-blocking):', err)
    return null
  }
}
