import { supabase } from './supabase'
import { sanitize } from './sanitizePayload'
import { safeQuery, safeBatch } from './safeQuery'
import { loadConversions } from './conversions'
import { buildProcurementRows, buildProcurementSummary } from './procurement'
import { dbUpdate } from './dbWrite'

/**
 * Recompute and persist the ingredient procurement status for a production order.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function syncIngredientStatus(productionOrderId: string): Promise<void> {
  try {
    // 1. Fetch the production order
    const { data: order } = await safeQuery(() =>
      supabase
        .from('production_orders')
        .select('*')
        .eq('id', productionOrderId)
        .single()
    )
    if (!order) return

    // 2. Fetch runs for this order
    const { data: orderRuns } = await safeQuery(() =>
      supabase
        .from('production_runs')
        .select('*')
        .eq('production_order_id', productionOrderId)
    )
    if (!orderRuns || orderRuns.length === 0) {
      // No runs → clear status
      await dbUpdate('production_orders', sanitize('production_orders', { ingredient_status: null }), 'id', productionOrderId)
      return
    }

    // 3. Gather recipe IDs from runs
    const recipeIds = [...new Set(orderRuns.map((r) => r.recipe_id).filter(Boolean))] as string[]

    // 4. Fetch recipe ingredients, ingredients, inventory, POs, PO items, conversions in parallel
    const [
      { data: recipeIngredients },
      { data: ingredients },
      { data: inventory },
      { data: purchaseOrders },
      { data: poItems },
      conversions,
    ] = await safeBatch(() => Promise.all([
      supabase.from('recipe_ingredients').select('*').in('recipe_id', recipeIds.length > 0 ? recipeIds : ['']),
      supabase.from('ingredients').select('*'),
      supabase.from('ingredient_inventory').select('*'),
      supabase.from('purchase_orders').select('*').eq('production_order_id', productionOrderId),
      supabase.from('purchase_order_items').select('*'),
      loadConversions(),
    ]))

    // 5. Filter PO items to only those belonging to linked POs
    const linkedPOIds = new Set((purchaseOrders ?? []).map((po) => po.id))
    const relevantPOItems = (poItems ?? []).filter((pi) => linkedPOIds.has(pi.purchase_order_id))

    // 6. Compute procurement status
    const rows = buildProcurementRows({
      order,
      orderRuns,
      recipeIngredients: recipeIngredients ?? [],
      ingredients: ingredients ?? [],
      inventory: inventory ?? [],
      purchaseOrders: purchaseOrders ?? [],
      poItems: relevantPOItems,
      conversions,
    })

    const summary = buildProcurementSummary(rows)

    // 7. Map overallStatus to stored value
    const statusMap: Record<string, string> = {
      ALL_READY: 'all_ready',
      IN_PROGRESS: 'in_progress',
      ACTION_NEEDED: 'action_needed',
    }
    const ingredientStatus = statusMap[summary.overallStatus] ?? null

    // 8. Persist
    await dbUpdate('production_orders', sanitize('production_orders', { ingredient_status: ingredientStatus }), 'id', productionOrderId)
  } catch (err) {
    console.error('[syncIngredientStatus] Failed for order', productionOrderId, err)
  }
}
