import { supabase } from './supabase'
import { type ConversionMap, getConversionFactorWithDensity, normalizeUnit } from './conversions'
import { sanitize } from './sanitizePayload'
import { dbInsert, dbInsertSingle, dbUpdate } from './dbWrite'

/**
 * Process inventory + cost updates when a PO is marked as received.
 * Self-contained: queries Supabase for all needed data.
 * Has double-processing guard via ingredient_cost_history.
 * Returns { processed: number, skipped: number, errors: string[] }.
 */
export async function processReceivedPOInventory(
  poId: string,
  conversionMap: ConversionMap,
): Promise<{ processed: number; skipped: number; errors: string[] }> {
  const errors: string[] = []

  // Double-processing guard: check if cost_history already has entries for this PO
  const { data: alreadyProcessed } = await supabase
    .from('ingredient_cost_history')
    .select('id')
    .eq('purchase_order_id', poId)
    .limit(1)
  if (alreadyProcessed && alreadyProcessed.length > 0) {
    return { processed: 0, skipped: 1, errors: [] }
  }

  // Fetch PO
  const { data: po } = await supabase
    .from('purchase_orders')
    .select('id, po_number, destination_co_packer_id, include_shipping_in_cost, shipping_cost')
    .eq('id', poId)
    .single()
  if (!po) return { processed: 0, skipped: 0, errors: ['PO not found'] }

  // Fetch PO items
  const { data: items } = await supabase
    .from('purchase_order_items')
    .select('*')
    .eq('purchase_order_id', poId)
  if (!items || items.length === 0) return { processed: 0, skipped: 0, errors: ['No items on PO'] }

  // Fetch ingredients referenced by items
  const ingIds = [...new Set(items.map((i) => i.ingredient_id).filter(Boolean))] as string[]
  if (ingIds.length === 0) return { processed: 0, skipped: 0, errors: ['No ingredients on PO items'] }
  const { data: ings } = await supabase.from('ingredients').select('*').in('id', ingIds)
  const ingMap = new Map((ings ?? []).map((i) => [i.id, i]))

  // Fetch current inventory for destination
  const cpId = po.destination_co_packer_id
  const { data: rawInvRows } = cpId
    ? await supabase
        .from('ingredient_inventory')
        .select('*')
        .eq('location_type', 'copacker')
        .eq('co_packer_id', cpId)
        .in('ingredient_id', ingIds)
    : { data: [] as any[] }
  // Use a mutable array (never null) so push/find work across iterations
  const invRows: any[] = rawInvRows ?? []

  // Pre-compute shipping allocation per item (in inventory units)
  const shippingAlloc = new Map<string, number>()
  if (po.include_shipping_in_cost && po.shipping_cost && po.shipping_cost > 0) {
    const totalValue = items.reduce((s, it) => s + it.quantity * it.unit_cost, 0)
    for (const it of items) {
      if (!it.ingredient_id || totalValue <= 0) continue
      const lineValue = it.quantity * it.unit_cost
      const allocated = po.shipping_cost * (lineValue / totalValue)
      const recQty = (it.received_quantity != null && it.received_quantity > 0) ? it.received_quantity : it.quantity
      const ing = ingMap.get(it.ingredient_id)
      const lu = it.quantity_unit ?? ing?.unit ?? 'lbs'
      const iu = ing?.unit ?? 'lbs'
      let qtyInIU = recQty
      if (normalizeUnit(lu) !== normalizeUnit(iu)) {
        try {
          const f = getConversionFactorWithDensity(conversionMap, lu, iu, ing?.density_g_per_ml)
          qtyInIU = recQty * f
        } catch { /* use unconverted */ }
      }
      if (qtyInIU > 0) shippingAlloc.set(it.ingredient_id, allocated / qtyInIU)
    }
  }

  let processed = 0

  for (const item of items) {
    if (!item.ingredient_id) continue
    const receivedQty = (item.received_quantity != null && item.received_quantity > 0) ? item.received_quantity : item.quantity
    if (receivedQty <= 0) continue

    const ing = ingMap.get(item.ingredient_id)
    if (!ing) { errors.push(`Ingredient not found: ${item.ingredient_id}`); continue }

    try {
      // Convert from PO line unit to ingredient's inventory unit
      const lineUnit = item.quantity_unit ?? ing.unit
      const invUnit = ing.unit
      const needsConversion = normalizeUnit(lineUnit) !== normalizeUnit(invUnit)

      let receivedInInvUnit = receivedQty
      let costInInvUnit = item.unit_cost
      if (needsConversion) {
        try {
          const factor = getConversionFactorWithDensity(conversionMap, lineUnit, invUnit, ing.density_g_per_ml)
          receivedInInvUnit = Math.round(receivedQty * factor * 10000) / 10000
          costInInvUnit = Math.round((item.unit_cost / factor) * 10000) / 10000
        } catch (err) {
          console.warn(`Unit conversion failed for ${ing.name}: ${lineUnit} → ${invUnit}`, err)
        }
      }

      // Add shipping allocation to cost
      const shippingAddon = shippingAlloc.get(item.ingredient_id) ?? 0
      const effectiveCost = costInInvUnit + shippingAddon

      // Get current total quantity across ALL locations for weighted avg
      const { data: allInv } = await supabase
        .from('ingredient_inventory')
        .select('quantity')
        .eq('ingredient_id', item.ingredient_id)
      const currentTotalQty = (allInv ?? []).reduce((s, iv) => s + (iv.quantity ?? 0), 0)

      // Calculate new weighted average cost
      const currentValue = currentTotalQty * ing.unit_cost
      const newValue = receivedInInvUnit * effectiveCost
      const newTotalQty = currentTotalQty + receivedInInvUnit
      const newUnitCost = newTotalQty > 0
        ? Math.round(((currentValue + newValue) / newTotalQty) * 10000) / 10000
        : effectiveCost

      // Update ingredient: weighted avg cost + last_cost
      await dbUpdate('ingredients', sanitize('ingredients', {
        unit_cost: newUnitCost,
        last_cost: effectiveCost,
      }), 'id', item.ingredient_id)

      // Add received quantity to inventory at destination
      if (cpId) {
        const existingInv = invRows.find(
          (iv) => iv.ingredient_id === item.ingredient_id,
        )

        if (existingInv) {
          await dbUpdate('ingredient_inventory',
            sanitize('ingredient_inventory', {
              quantity: (existingInv.quantity ?? 0) + receivedInInvUnit,
              updated_at: new Date().toISOString(),
            }),
          'id', existingInv.id)
          // Update local ref so subsequent items for same ingredient stack correctly
          existingInv.quantity = (existingInv.quantity ?? 0) + receivedInInvUnit
        } else {
          const { data: inserted } = await dbInsertSingle('ingredient_inventory',
            sanitize('ingredient_inventory', {
              ingredient_id: item.ingredient_id,
              location_type: 'copacker',
              co_packer_id: cpId,
              quantity: receivedInInvUnit,
              updated_at: new Date().toISOString(),
            }),
          )
          // Add to local ref so subsequent items don't create duplicates
          if (inserted) invRows.push(inserted)
        }
      }

      // Log cost history (also serves as the double-processing marker)
      await dbInsert('ingredient_cost_history', sanitize('ingredient_cost_history', {
        ingredient_id: item.ingredient_id,
        purchase_order_id: poId,
        unit_cost: effectiveCost,
        quantity: receivedInInvUnit,
        date: new Date().toISOString().split('T')[0],
      }))

      processed++
    } catch (itemErr) {
      errors.push(`${ing.name}: ${itemErr instanceof Error ? itemErr.message : 'unknown error'}`)
    }
  }

  return { processed, skipped: 0, errors }
}
