// Define allowed columns per table — prevents inserts/updates from sending
// columns that don't exist in the database (which causes PostgREST errors).
const TABLE_COLUMNS: Record<string, string[]> = {

  activity_log: [
    'id', 'user_id', 'action', 'entity_type', 'entity_id', 'details', 'created_at',
  ],

  app_users: [
    'id', 'auth_id', 'email', 'full_name', 'role', 'status', 'avatar_url',
    'phone', 'last_login', 'invited_by', 'created_at', 'updated_at',
  ],

  co_packer_contacts: [
    'id', 'co_packer_id', 'name', 'email', 'phone', 'role', 'is_primary',
    'notes', 'created_at',
  ],

  co_packers: [
    'id', 'name', 'short_code', 'color', 'location', 'fee_per_unit',
    'payment_terms', 'min_order_qty', 'monthly_capacity', 'status', 'notes',
    'created_at', 'updated_at', 'receiving_hours', 'receiving_notes',
  ],

  finished_goods_movements: [
    'id', 'date', 'recipe_id', 'co_packer_id', 'production_run_id', 'quantity',
    'from_location', 'to_location', 'fba_shipment_id', 'tracking_number',
    'status', 'notes', 'created_at', 'shipping_cost', 'freight_per_unit',
    'freight_leg', 'fulfillment_center_id', 'sales_channel',
  ],

  fulfillment_centers: [
    'id', 'name', 'type', 'code', 'location', 'contact_name', 'contact_email',
    'contact_phone', 'notes', 'status', 'created_at',
  ],

  ingredient_cost_history: [
    'id', 'ingredient_id', 'purchase_order_id', 'unit_cost', 'quantity',
    'date', 'created_at',
  ],

  ingredient_inventory: [
    'id', 'ingredient_id', 'location_type', 'co_packer_id', 'quantity',
    'lot_number', 'expiration_date', 'updated_at', 'last_count_date',
  ],

  ingredient_tag_links: [
    'id', 'ingredient_id', 'tag_id',
  ],

  ingredient_tags: [
    'id', 'name', 'color', 'created_at',
  ],

  ingredients: [
    'id', 'name', 'category', 'unit', 'unit_cost', 'reorder_point',
    'shelf_life_days', 'notes', 'created_at', 'updated_at', 'last_cost',
    'density_g_per_ml',
  ],

  inventory_adjustments: [
    'id', 'ingredient_id', 'co_packer_id', 'location_type', 'previous_quantity',
    'new_quantity', 'difference', 'reason', 'adjusted_by', 'created_at',
  ],

  packaging_inventory: [
    'id', 'packaging_material_id', 'location_type', 'co_packer_id', 'quantity',
    'updated_at',
  ],

  packaging_materials: [
    'id', 'name', 'sku', 'unit_cost', 'notes', 'created_at',
  ],

  production_run_invoices: [
    'id', 'production_run_id', 'production_order_id', 'co_packer_id',
    'invoice_number', 'invoice_date', 'total_amount', 'per_unit_cost',
    'notes', 'status', 'created_at',
  ],

  production_run_payments: [
    'id', 'invoice_id', 'payment_type', 'amount', 'payment_date',
    'payment_method', 'reference_number', 'notes', 'created_at',
    'payment_method_used', 'card_used', 'processing_fee',
  ],

  production_orders: [
    'id', 'order_number', 'co_packer_id', 'status', 'order_date',
    'requested_start_date', 'estimated_completion_date', 'priority', 'notes',
    'total_units', 'total_estimated_cost', 'created_at', 'updated_at',
    'ingredient_status',
  ],

  production_runs: [
    'id', 'run_number', 'co_packer_id', 'recipe_id', 'requested_quantity',
    'produced_quantity', 'status', 'requested_date', 'started_date',
    'completed_date', 'waste_pct', 'waste_cost', 'cp_notes', 'your_notes',
    'priority', 'created_at', 'updated_at', 'production_order_id',
  ],

  purchase_order_items: [
    'id', 'purchase_order_id', 'ingredient_id', 'quantity', 'unit_cost',
    'received_quantity', 'quantity_unit', 'qty_packages', 'package_name',
    'package_size', 'package_unit',
  ],

  po_payments: [
    'id', 'purchase_order_id', 'payment_type', 'amount', 'payment_date',
    'due_date', 'payment_method', 'reference_number', 'notes', 'status',
    'created_at', 'payment_method_used', 'card_used', 'processing_fee',
  ],

  purchase_orders: [
    'id', 'po_number', 'supplier_id', 'status', 'order_date', 'eta_date',
    'destination_type', 'destination_co_packer_id', 'total_cost',
    'tracking_number', 'notes', 'created_at', 'updated_at', 'order_type',
    'order_reference', 'payment_method', 'payment_status', 'shipping_cost',
    'shipping_method', 'shipping_carrier', 'shipping_per_unit_weight',
    'include_shipping_in_cost', 'production_order_id',
    'payment_terms', 'payment_due_date', 'amount_paid', 'card_used', 'processing_fee',
  ],

  recipe_freight_summary: [
    'id', 'recipe_id', 'avg_freight_cp_to_warehouse', 'avg_freight_warehouse_to_fba',
    'avg_freight_cp_to_fba', 'avg_total_freight', 'last_calculated',
    'avg_freight_cp_to_3pl',
  ],

  recipe_ingredients: [
    'id', 'recipe_id', 'ingredient_id', 'quantity_per_unit', 'tolerance_pct',
    'unit', 'provided_by', 'cp_charge_per_unit', 'cp_charge_unit',
  ],

  recipes: [
    'id', 'name', 'sku', 'co_packer_id', 'package_size', 'expected_yield_pct',
    'waste_tolerance_pct', 'status', 'ingredient_cogs', 'notes', 'created_at',
    'updated_at', 'package_size_unit', 'image_url', 'estimated_freight_per_unit',
    'landed_cogs',
  ],

  reconciliation_lines: [
    'id', 'production_run_id', 'ingredient_id', 'theoretical_usage',
    'actual_usage', 'variance_qty', 'variance_pct', 'variance_cost',
    'status', 'notes',
  ],

  shipment_items: [
    'id', 'shipment_id', 'ingredient_id', 'quantity', 'lot_number', 'value',
  ],

  shipments_to_copacker: [
    'id', 'shipment_number', 'co_packer_id', 'ship_date', 'carrier',
    'tracking_number', 'total_value', 'cp_confirmed', 'cp_confirmed_date',
    'notes', 'created_at', 'shipping_cost', 'status', 'purchase_order_id',
    'received_date', 'supplier_id', 'production_order_id',
  ],

  supplier_contacts: [
    'id', 'supplier_id', 'name', 'email', 'phone', 'role', 'is_primary',
    'notes', 'created_at',
  ],

  supplier_ingredients: [
    'id', 'supplier_id', 'ingredient_id', 'supplier_sku', 'price_per_unit',
    'price_unit', 'package_size', 'package_unit', 'package_name',
    'price_per_package', 'min_order_packages', 'packages_per_case',
    'is_default', 'supplier_item_name',
  ],

  suppliers: [
    'id', 'name', 'lead_time_days', 'payment_terms', 'rating', 'notes',
    'created_at', 'default_payment_method', 'default_card_used',
  ],

  unit_conversions: [
    'from_unit', 'to_unit', 'multiplier',
  ],
}

export function sanitize(table: string, payload: Record<string, any>): Record<string, any> {
  const allowed = TABLE_COLUMNS[table]
  if (!allowed) {
    console.warn('No column map for table:', table)
    return payload
  }
  const clean: Record<string, any> = {}
  for (const key of Object.keys(payload)) {
    if (allowed.includes(key) && payload[key] !== undefined) {
      clean[key] = payload[key]
    } else if (!allowed.includes(key)) {
      console.warn(`Stripped unknown column "${key}" from ${table} payload`)
    }
  }
  return clean
}
