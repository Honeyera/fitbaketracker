import type { Database } from './supabase'

type Tables = Database['public']['Tables']

// ── Row types (what you get back from a SELECT) ──────────────
export type CoPacker              = Tables['co_packers']['Row']
export type CoPackerContact       = Tables['co_packer_contacts']['Row']
export type Ingredient            = Tables['ingredients']['Row']
export type IngredientInventory   = Tables['ingredient_inventory']['Row']
export type InventoryAdjustment  = Tables['inventory_adjustments']['Row']
export type Supplier              = Tables['suppliers']['Row']
export type SupplierContact       = Tables['supplier_contacts']['Row']
export type SupplierIngredient    = Tables['supplier_ingredients']['Row']
export type PurchaseOrder         = Tables['purchase_orders']['Row']
export type PurchaseOrderItem     = Tables['purchase_order_items']['Row']
export type ShipmentToCopacker    = Tables['shipments_to_copacker']['Row']
export type ShipmentItem          = Tables['shipment_items']['Row']
export type Recipe                = Tables['recipes']['Row']
export type RecipeIngredient      = Tables['recipe_ingredients']['Row']
export type ProductionOrder       = Tables['production_orders']['Row']
export type ProductionRun         = Tables['production_runs']['Row']
export type ReconciliationLine    = Tables['reconciliation_lines']['Row']
export type FinishedGoodsMovement = Tables['finished_goods_movements']['Row']
export type PackagingMaterial     = Tables['packaging_materials']['Row']
export type PackagingInventory    = Tables['packaging_inventory']['Row']
export type UnitConversion        = Tables['unit_conversions']['Row']
export type IngredientCostHistory = Tables['ingredient_cost_history']['Row']
export type RecipeFreightSummary = Tables['recipe_freight_summary']['Row']
export type FulfillmentCenter    = Tables['fulfillment_centers']['Row']
export type IngredientTag        = Tables['ingredient_tags']['Row']
export type IngredientTagLink    = Tables['ingredient_tag_links']['Row']

// ── Production Run Invoice & Payment types (manual until types regen) ──
export interface ProductionRunInvoice {
  id: string
  production_run_id: string | null
  production_order_id: string | null
  co_packer_id: string | null
  invoice_number: string | null
  invoice_date: string | null
  total_amount: number
  per_unit_cost: number | null
  notes: string | null
  status: string
  created_at: string
}

export interface ProductionRunInvoiceInsert {
  id?: string
  production_run_id?: string | null
  production_order_id?: string | null
  co_packer_id?: string | null
  invoice_number?: string | null
  invoice_date?: string | null
  total_amount: number
  per_unit_cost?: number | null
  notes?: string | null
  status?: string
}

export interface ProductionRunPayment {
  id: string
  invoice_id: string | null
  payment_type: string
  amount: number
  payment_date: string | null
  payment_method: string | null
  reference_number: string | null
  notes: string | null
  created_at: string
}

export interface ProductionRunPaymentInsert {
  id?: string
  invoice_id?: string | null
  payment_type: string
  amount: number
  payment_date?: string | null
  payment_method?: string | null
  reference_number?: string | null
  notes?: string | null
}

// ── PO Payment types (manual until types regen) ──
export interface POPayment {
  id: string
  purchase_order_id: string
  payment_type: string
  amount: number
  payment_date: string | null
  due_date: string | null
  payment_method: string | null
  reference_number: string | null
  notes: string | null
  status: string
  created_at: string
}

export interface POPaymentInsert {
  id?: string
  purchase_order_id: string
  payment_type: string
  amount: number
  payment_date?: string | null
  due_date?: string | null
  payment_method?: string | null
  reference_number?: string | null
  notes?: string | null
  status?: string
}

// ── PO Attachment types (manual until types regen) ──
export interface POAttachment {
  id: string
  purchase_order_id: string
  file_name: string
  file_url: string
  file_type: string
  file_size: number | null
  notes: string | null
  created_at: string
}

export interface POAttachmentInsert {
  id?: string
  purchase_order_id: string
  file_name: string
  file_url: string
  file_type?: string
  file_size?: number | null
  notes?: string | null
}

// ── Insert types (what you pass to an INSERT) ────────────────
export type CoPackerInsert              = Tables['co_packers']['Insert']
export type CoPackerContactInsert       = Tables['co_packer_contacts']['Insert']
export type IngredientInsert            = Tables['ingredients']['Insert']
export type IngredientInventoryInsert   = Tables['ingredient_inventory']['Insert']
export type InventoryAdjustmentInsert  = Tables['inventory_adjustments']['Insert']
export type SupplierInsert              = Tables['suppliers']['Insert']
export type SupplierContactInsert       = Tables['supplier_contacts']['Insert']
export type SupplierIngredientInsert    = Tables['supplier_ingredients']['Insert']
export type PurchaseOrderInsert         = Tables['purchase_orders']['Insert']
export type PurchaseOrderItemInsert     = Tables['purchase_order_items']['Insert']
export type ShipmentToCopackerInsert    = Tables['shipments_to_copacker']['Insert']
export type ShipmentItemInsert          = Tables['shipment_items']['Insert']
export type RecipeInsert                = Tables['recipes']['Insert']
export type RecipeIngredientInsert      = Tables['recipe_ingredients']['Insert']
export type ProductionOrderInsert       = Tables['production_orders']['Insert']
export type ProductionRunInsert         = Tables['production_runs']['Insert']
export type ReconciliationLineInsert    = Tables['reconciliation_lines']['Insert']
export type FinishedGoodsMovementInsert = Tables['finished_goods_movements']['Insert']
export type PackagingMaterialInsert     = Tables['packaging_materials']['Insert']
export type PackagingInventoryInsert    = Tables['packaging_inventory']['Insert']
export type UnitConversionInsert        = Tables['unit_conversions']['Insert']
export type IngredientCostHistoryInsert = Tables['ingredient_cost_history']['Insert']
export type RecipeFreightSummaryInsert = Tables['recipe_freight_summary']['Insert']
export type FulfillmentCenterInsert    = Tables['fulfillment_centers']['Insert']
export type IngredientTagInsert        = Tables['ingredient_tags']['Insert']
export type IngredientTagLinkInsert    = Tables['ingredient_tag_links']['Insert']

// ── Update types (what you pass to an UPDATE) ────────────────
export type CoPackerUpdate              = Tables['co_packers']['Update']
export type CoPackerContactUpdate       = Tables['co_packer_contacts']['Update']
export type IngredientUpdate            = Tables['ingredients']['Update']
export type IngredientInventoryUpdate   = Tables['ingredient_inventory']['Update']
export type InventoryAdjustmentUpdate  = Tables['inventory_adjustments']['Update']
export type SupplierUpdate              = Tables['suppliers']['Update']
export type SupplierContactUpdate       = Tables['supplier_contacts']['Update']
export type SupplierIngredientUpdate    = Tables['supplier_ingredients']['Update']
export type PurchaseOrderUpdate         = Tables['purchase_orders']['Update']
export type PurchaseOrderItemUpdate     = Tables['purchase_order_items']['Update']
export type ShipmentToCopackerUpdate    = Tables['shipments_to_copacker']['Update']
export type ShipmentItemUpdate          = Tables['shipment_items']['Update']
export type RecipeUpdate                = Tables['recipes']['Update']
export type RecipeIngredientUpdate      = Tables['recipe_ingredients']['Update']
export type ProductionOrderUpdate       = Tables['production_orders']['Update']
export type ProductionRunUpdate         = Tables['production_runs']['Update']
export type ReconciliationLineUpdate    = Tables['reconciliation_lines']['Update']
export type FinishedGoodsMovementUpdate = Tables['finished_goods_movements']['Update']
export type PackagingMaterialUpdate     = Tables['packaging_materials']['Update']
export type PackagingInventoryUpdate    = Tables['packaging_inventory']['Update']
export type UnitConversionUpdate        = Tables['unit_conversions']['Update']
export type IngredientCostHistoryUpdate = Tables['ingredient_cost_history']['Update']
export type RecipeFreightSummaryUpdate = Tables['recipe_freight_summary']['Update']
export type FulfillmentCenterUpdate    = Tables['fulfillment_centers']['Update']
export type IngredientTagUpdate        = Tables['ingredient_tags']['Update']
export type IngredientTagLinkUpdate    = Tables['ingredient_tag_links']['Update']

// ── Auth & RBAC types ─────────────────────────────────────────
export type AppUserRole   = 'owner' | 'admin' | 'manager' | 'viewer'
export type AppUserStatus = 'active' | 'invited' | 'disabled'

export interface AppUser {
  id: string
  auth_id: string
  email: string
  full_name: string
  role: AppUserRole
  status: AppUserStatus
  avatar_url: string | null
  phone: string | null
  last_login: string | null
  invited_by: string | null
  created_at: string
  updated_at: string
}

export interface AppUserInsert {
  id?: string
  auth_id: string
  email: string
  full_name: string
  role?: AppUserRole
  status?: AppUserStatus
  avatar_url?: string | null
  phone?: string | null
  invited_by?: string | null
}

export interface AppUserUpdate {
  full_name?: string
  role?: AppUserRole
  status?: AppUserStatus
  avatar_url?: string | null
  phone?: string | null
  last_login?: string | null
  updated_at?: string
}

export interface ActivityLog {
  id: string
  user_id: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  details: Record<string, unknown> | null
  created_at: string
}

export interface ActivityLogInsert {
  user_id?: string | null
  action: string
  entity_type?: string | null
  entity_id?: string | null
  details?: Record<string, unknown> | null
}
