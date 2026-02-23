export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      co_packer_contacts: {
        Row: {
          co_packer_id: string
          created_at: string | null
          email: string | null
          id: string
          is_primary: boolean
          name: string
          notes: string | null
          phone: string | null
          role: string | null
        }
        Insert: {
          co_packer_id: string
          created_at?: string | null
          email?: string | null
          id?: string
          is_primary?: boolean
          name: string
          notes?: string | null
          phone?: string | null
          role?: string | null
        }
        Update: {
          co_packer_id?: string
          created_at?: string | null
          email?: string | null
          id?: string
          is_primary?: boolean
          name?: string
          notes?: string | null
          phone?: string | null
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "co_packer_contacts_co_packer_id_fkey"
            columns: ["co_packer_id"]
            isOneToOne: false
            referencedRelation: "co_packers"
            referencedColumns: ["id"]
          },
        ]
      }
      co_packers: {
        Row: {
          color: string | null
          created_at: string | null
          fee_per_unit: number | null
          id: string
          location: string | null
          min_order_qty: number | null
          monthly_capacity: number | null
          name: string
          notes: string | null
          payment_terms: string | null
          receiving_hours: string | null
          receiving_notes: string | null
          short_code: string
          status: string | null
          updated_at: string | null
        }
        Insert: {
          color?: string | null
          created_at?: string | null
          fee_per_unit?: number | null
          id?: string
          location?: string | null
          min_order_qty?: number | null
          monthly_capacity?: number | null
          name: string
          notes?: string | null
          payment_terms?: string | null
          receiving_hours?: string | null
          receiving_notes?: string | null
          short_code: string
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          color?: string | null
          created_at?: string | null
          fee_per_unit?: number | null
          id?: string
          location?: string | null
          min_order_qty?: number | null
          monthly_capacity?: number | null
          name?: string
          notes?: string | null
          payment_terms?: string | null
          receiving_hours?: string | null
          receiving_notes?: string | null
          short_code?: string
          status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      finished_goods_movements: {
        Row: {
          co_packer_id: string | null
          created_at: string | null
          date: string
          fba_shipment_id: string | null
          freight_leg: string | null
          freight_per_unit: number | null
          from_location: string
          fulfillment_center_id: string | null
          id: string
          notes: string | null
          production_run_id: string | null
          quantity: number
          recipe_id: string | null
          sales_channel: string | null
          shipping_cost: number | null
          status: string | null
          to_location: string
          tracking_number: string | null
        }
        Insert: {
          co_packer_id?: string | null
          created_at?: string | null
          date: string
          fba_shipment_id?: string | null
          freight_leg?: string | null
          freight_per_unit?: number | null
          from_location: string
          fulfillment_center_id?: string | null
          id?: string
          notes?: string | null
          production_run_id?: string | null
          quantity: number
          recipe_id?: string | null
          sales_channel?: string | null
          shipping_cost?: number | null
          status?: string | null
          to_location: string
          tracking_number?: string | null
        }
        Update: {
          co_packer_id?: string | null
          created_at?: string | null
          date?: string
          fba_shipment_id?: string | null
          freight_leg?: string | null
          freight_per_unit?: number | null
          from_location?: string
          fulfillment_center_id?: string | null
          id?: string
          notes?: string | null
          production_run_id?: string | null
          quantity?: number
          recipe_id?: string | null
          sales_channel?: string | null
          shipping_cost?: number | null
          status?: string | null
          to_location?: string
          tracking_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finished_goods_movements_co_packer_id_fkey"
            columns: ["co_packer_id"]
            isOneToOne: false
            referencedRelation: "co_packers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finished_goods_movements_fulfillment_center_id_fkey"
            columns: ["fulfillment_center_id"]
            isOneToOne: false
            referencedRelation: "fulfillment_centers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finished_goods_movements_production_run_id_fkey"
            columns: ["production_run_id"]
            isOneToOne: false
            referencedRelation: "production_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finished_goods_movements_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      fulfillment_centers: {
        Row: {
          code: string | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string | null
          id: string
          location: string | null
          name: string
          notes: string | null
          status: string | null
          type: string
        }
        Insert: {
          code?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string | null
          id?: string
          location?: string | null
          name: string
          notes?: string | null
          status?: string | null
          type: string
        }
        Update: {
          code?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string | null
          id?: string
          location?: string | null
          name?: string
          notes?: string | null
          status?: string | null
          type?: string
        }
        Relationships: []
      }
      ingredient_cost_history: {
        Row: {
          created_at: string | null
          date: string
          id: string
          ingredient_id: string
          purchase_order_id: string
          quantity: number
          unit_cost: number
        }
        Insert: {
          created_at?: string | null
          date?: string
          id?: string
          ingredient_id: string
          purchase_order_id: string
          quantity: number
          unit_cost: number
        }
        Update: {
          created_at?: string | null
          date?: string
          id?: string
          ingredient_id?: string
          purchase_order_id?: string
          quantity?: number
          unit_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "ingredient_cost_history_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingredient_cost_history_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      ingredient_inventory: {
        Row: {
          co_packer_id: string | null
          expiration_date: string | null
          id: string
          ingredient_id: string
          last_count_date: string | null
          location_type: string
          lot_number: string | null
          quantity: number
          updated_at: string | null
        }
        Insert: {
          co_packer_id?: string | null
          expiration_date?: string | null
          id?: string
          ingredient_id: string
          last_count_date?: string | null
          location_type: string
          lot_number?: string | null
          quantity?: number
          updated_at?: string | null
        }
        Update: {
          co_packer_id?: string | null
          expiration_date?: string | null
          id?: string
          ingredient_id?: string
          last_count_date?: string | null
          location_type?: string
          lot_number?: string | null
          quantity?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingredient_inventory_co_packer_id_fkey"
            columns: ["co_packer_id"]
            isOneToOne: false
            referencedRelation: "co_packers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingredient_inventory_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
        ]
      }
      ingredient_tag_links: {
        Row: {
          id: string
          ingredient_id: string
          tag_id: string
        }
        Insert: {
          id?: string
          ingredient_id: string
          tag_id: string
        }
        Update: {
          id?: string
          ingredient_id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingredient_tag_links_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingredient_tag_links_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "ingredient_tags"
            referencedColumns: ["id"]
          },
        ]
      }
      ingredient_tags: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      ingredients: {
        Row: {
          category: string | null
          created_at: string | null
          density_g_per_ml: number | null
          id: string
          last_cost: number | null
          name: string
          notes: string | null
          reorder_point: number | null
          shelf_life_days: number | null
          unit: string
          unit_cost: number
          updated_at: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          density_g_per_ml?: number | null
          id?: string
          last_cost?: number | null
          name: string
          notes?: string | null
          reorder_point?: number | null
          shelf_life_days?: number | null
          unit?: string
          unit_cost: number
          updated_at?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          density_g_per_ml?: number | null
          id?: string
          last_cost?: number | null
          name?: string
          notes?: string | null
          reorder_point?: number | null
          shelf_life_days?: number | null
          unit?: string
          unit_cost?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      inventory_adjustments: {
        Row: {
          adjusted_by: string | null
          co_packer_id: string | null
          created_at: string | null
          difference: number | null
          id: string
          ingredient_id: string | null
          location_type: string
          new_quantity: number | null
          previous_quantity: number | null
          reason: string | null
        }
        Insert: {
          adjusted_by?: string | null
          co_packer_id?: string | null
          created_at?: string | null
          difference?: number | null
          id?: string
          ingredient_id?: string | null
          location_type: string
          new_quantity?: number | null
          previous_quantity?: number | null
          reason?: string | null
        }
        Update: {
          adjusted_by?: string | null
          co_packer_id?: string | null
          created_at?: string | null
          difference?: number | null
          id?: string
          ingredient_id?: string | null
          location_type?: string
          new_quantity?: number | null
          previous_quantity?: number | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_adjustments_co_packer_id_fkey"
            columns: ["co_packer_id"]
            isOneToOne: false
            referencedRelation: "co_packers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_adjustments_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
        ]
      }
      packaging_inventory: {
        Row: {
          co_packer_id: string | null
          id: string
          location_type: string | null
          packaging_material_id: string
          quantity: number | null
          updated_at: string | null
        }
        Insert: {
          co_packer_id?: string | null
          id?: string
          location_type?: string | null
          packaging_material_id: string
          quantity?: number | null
          updated_at?: string | null
        }
        Update: {
          co_packer_id?: string | null
          id?: string
          location_type?: string | null
          packaging_material_id?: string
          quantity?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "packaging_inventory_co_packer_id_fkey"
            columns: ["co_packer_id"]
            isOneToOne: false
            referencedRelation: "co_packers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packaging_inventory_packaging_material_id_fkey"
            columns: ["packaging_material_id"]
            isOneToOne: false
            referencedRelation: "packaging_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      packaging_materials: {
        Row: {
          created_at: string | null
          id: string
          name: string
          notes: string | null
          sku: string | null
          unit_cost: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          name: string
          notes?: string | null
          sku?: string | null
          unit_cost?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          name?: string
          notes?: string | null
          sku?: string | null
          unit_cost?: number | null
        }
        Relationships: []
      }
      production_orders: {
        Row: {
          co_packer_id: string | null
          created_at: string | null
          estimated_completion_date: string | null
          id: string
          ingredient_status: string | null
          notes: string | null
          order_date: string | null
          order_number: string
          priority: string
          requested_start_date: string | null
          status: string
          total_estimated_cost: number | null
          total_units: number | null
          updated_at: string | null
        }
        Insert: {
          co_packer_id?: string | null
          created_at?: string | null
          estimated_completion_date?: string | null
          id?: string
          ingredient_status?: string | null
          notes?: string | null
          order_date?: string | null
          order_number: string
          priority?: string
          requested_start_date?: string | null
          status?: string
          total_estimated_cost?: number | null
          total_units?: number | null
          updated_at?: string | null
        }
        Update: {
          co_packer_id?: string | null
          created_at?: string | null
          estimated_completion_date?: string | null
          id?: string
          ingredient_status?: string | null
          notes?: string | null
          order_date?: string | null
          order_number?: string
          priority?: string
          requested_start_date?: string | null
          status?: string
          total_estimated_cost?: number | null
          total_units?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "production_orders_co_packer_id_fkey"
            columns: ["co_packer_id"]
            isOneToOne: false
            referencedRelation: "co_packers"
            referencedColumns: ["id"]
          },
        ]
      }
      production_runs: {
        Row: {
          co_packer_id: string | null
          completed_date: string | null
          cp_notes: string | null
          created_at: string | null
          id: string
          priority: string | null
          produced_quantity: number | null
          production_order_id: string | null
          recipe_id: string | null
          requested_date: string | null
          requested_quantity: number
          run_number: string
          started_date: string | null
          status: string | null
          updated_at: string | null
          waste_cost: number | null
          waste_pct: number | null
          your_notes: string | null
        }
        Insert: {
          co_packer_id?: string | null
          completed_date?: string | null
          cp_notes?: string | null
          created_at?: string | null
          id?: string
          priority?: string | null
          produced_quantity?: number | null
          production_order_id?: string | null
          recipe_id?: string | null
          requested_date?: string | null
          requested_quantity: number
          run_number: string
          started_date?: string | null
          status?: string | null
          updated_at?: string | null
          waste_cost?: number | null
          waste_pct?: number | null
          your_notes?: string | null
        }
        Update: {
          co_packer_id?: string | null
          completed_date?: string | null
          cp_notes?: string | null
          created_at?: string | null
          id?: string
          priority?: string | null
          produced_quantity?: number | null
          production_order_id?: string | null
          recipe_id?: string | null
          requested_date?: string | null
          requested_quantity?: number
          run_number?: string
          started_date?: string | null
          status?: string | null
          updated_at?: string | null
          waste_cost?: number | null
          waste_pct?: number | null
          your_notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "production_runs_co_packer_id_fkey"
            columns: ["co_packer_id"]
            isOneToOne: false
            referencedRelation: "co_packers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_runs_production_order_id_fkey"
            columns: ["production_order_id"]
            isOneToOne: false
            referencedRelation: "production_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_runs_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_items: {
        Row: {
          id: string
          ingredient_id: string | null
          package_name: string | null
          package_size: number | null
          package_unit: string | null
          purchase_order_id: string
          qty_packages: number | null
          quantity: number
          quantity_unit: string | null
          received_quantity: number | null
          unit_cost: number
        }
        Insert: {
          id?: string
          ingredient_id?: string | null
          package_name?: string | null
          package_size?: number | null
          package_unit?: string | null
          purchase_order_id: string
          qty_packages?: number | null
          quantity: number
          quantity_unit?: string | null
          received_quantity?: number | null
          unit_cost: number
        }
        Update: {
          id?: string
          ingredient_id?: string | null
          package_name?: string | null
          package_size?: number | null
          package_unit?: string | null
          purchase_order_id?: string
          qty_packages?: number | null
          quantity?: number
          quantity_unit?: string | null
          received_quantity?: number | null
          unit_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_items_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          created_at: string | null
          destination_co_packer_id: string | null
          destination_type: string | null
          eta_date: string | null
          id: string
          include_shipping_in_cost: boolean
          notes: string | null
          order_date: string | null
          order_reference: string | null
          order_type: string
          payment_method: string | null
          payment_status: string
          po_number: string
          production_order_id: string | null
          shipping_carrier: string | null
          shipping_cost: number | null
          shipping_method: string | null
          shipping_per_unit_weight: number | null
          status: string | null
          supplier_id: string | null
          total_cost: number | null
          tracking_number: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          destination_co_packer_id?: string | null
          destination_type?: string | null
          eta_date?: string | null
          id?: string
          include_shipping_in_cost?: boolean
          notes?: string | null
          order_date?: string | null
          order_reference?: string | null
          order_type?: string
          payment_method?: string | null
          payment_status?: string
          po_number: string
          production_order_id?: string | null
          shipping_carrier?: string | null
          shipping_cost?: number | null
          shipping_method?: string | null
          shipping_per_unit_weight?: number | null
          status?: string | null
          supplier_id?: string | null
          total_cost?: number | null
          tracking_number?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          destination_co_packer_id?: string | null
          destination_type?: string | null
          eta_date?: string | null
          id?: string
          include_shipping_in_cost?: boolean
          notes?: string | null
          order_date?: string | null
          order_reference?: string | null
          order_type?: string
          payment_method?: string | null
          payment_status?: string
          po_number?: string
          production_order_id?: string | null
          shipping_carrier?: string | null
          shipping_cost?: number | null
          shipping_method?: string | null
          shipping_per_unit_weight?: number | null
          status?: string | null
          supplier_id?: string | null
          total_cost?: number | null
          tracking_number?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_destination_co_packer_id_fkey"
            columns: ["destination_co_packer_id"]
            isOneToOne: false
            referencedRelation: "co_packers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_production_order_id_fkey"
            columns: ["production_order_id"]
            isOneToOne: false
            referencedRelation: "production_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      recipe_freight_summary: {
        Row: {
          avg_freight_cp_to_3pl: number | null
          avg_freight_cp_to_fba: number | null
          avg_freight_cp_to_warehouse: number | null
          avg_freight_warehouse_to_fba: number | null
          avg_total_freight: number | null
          id: string
          last_calculated: string | null
          recipe_id: string | null
        }
        Insert: {
          avg_freight_cp_to_3pl?: number | null
          avg_freight_cp_to_fba?: number | null
          avg_freight_cp_to_warehouse?: number | null
          avg_freight_warehouse_to_fba?: number | null
          avg_total_freight?: number | null
          id?: string
          last_calculated?: string | null
          recipe_id?: string | null
        }
        Update: {
          avg_freight_cp_to_3pl?: number | null
          avg_freight_cp_to_fba?: number | null
          avg_freight_cp_to_warehouse?: number | null
          avg_freight_warehouse_to_fba?: number | null
          avg_total_freight?: number | null
          id?: string
          last_calculated?: string | null
          recipe_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recipe_freight_summary_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: true
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      recipe_ingredients: {
        Row: {
          cp_charge_per_unit: number | null
          cp_charge_unit: string | null
          id: string
          ingredient_id: string | null
          provided_by: string
          quantity_per_unit: number
          recipe_id: string
          tolerance_pct: number | null
          unit: string
        }
        Insert: {
          cp_charge_per_unit?: number | null
          cp_charge_unit?: string | null
          id?: string
          ingredient_id?: string | null
          provided_by?: string
          quantity_per_unit: number
          recipe_id: string
          tolerance_pct?: number | null
          unit?: string
        }
        Update: {
          cp_charge_per_unit?: number | null
          cp_charge_unit?: string | null
          id?: string
          ingredient_id?: string | null
          provided_by?: string
          quantity_per_unit?: number
          recipe_id?: string
          tolerance_pct?: number | null
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipe_ingredients_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_ingredients_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      recipes: {
        Row: {
          co_packer_id: string | null
          created_at: string | null
          estimated_freight_per_unit: number | null
          expected_yield_pct: number | null
          id: string
          image_url: string | null
          ingredient_cogs: number | null
          landed_cogs: number | null
          name: string
          notes: string | null
          package_size: number | null
          package_size_unit: string
          sku: string
          status: string | null
          updated_at: string | null
          waste_tolerance_pct: number | null
        }
        Insert: {
          co_packer_id?: string | null
          created_at?: string | null
          estimated_freight_per_unit?: number | null
          expected_yield_pct?: number | null
          id?: string
          image_url?: string | null
          ingredient_cogs?: number | null
          landed_cogs?: number | null
          name: string
          notes?: string | null
          package_size?: number | null
          package_size_unit?: string
          sku: string
          status?: string | null
          updated_at?: string | null
          waste_tolerance_pct?: number | null
        }
        Update: {
          co_packer_id?: string | null
          created_at?: string | null
          estimated_freight_per_unit?: number | null
          expected_yield_pct?: number | null
          id?: string
          image_url?: string | null
          ingredient_cogs?: number | null
          landed_cogs?: number | null
          name?: string
          notes?: string | null
          package_size?: number | null
          package_size_unit?: string
          sku?: string
          status?: string | null
          updated_at?: string | null
          waste_tolerance_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "recipes_co_packer_id_fkey"
            columns: ["co_packer_id"]
            isOneToOne: false
            referencedRelation: "co_packers"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliation_lines: {
        Row: {
          actual_usage: number | null
          id: string
          ingredient_id: string | null
          notes: string | null
          production_run_id: string
          status: string | null
          theoretical_usage: number | null
          variance_cost: number | null
          variance_pct: number | null
          variance_qty: number | null
        }
        Insert: {
          actual_usage?: number | null
          id?: string
          ingredient_id?: string | null
          notes?: string | null
          production_run_id: string
          status?: string | null
          theoretical_usage?: number | null
          variance_cost?: number | null
          variance_pct?: number | null
          variance_qty?: number | null
        }
        Update: {
          actual_usage?: number | null
          id?: string
          ingredient_id?: string | null
          notes?: string | null
          production_run_id?: string
          status?: string | null
          theoretical_usage?: number | null
          variance_cost?: number | null
          variance_pct?: number | null
          variance_qty?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_lines_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_lines_production_run_id_fkey"
            columns: ["production_run_id"]
            isOneToOne: false
            referencedRelation: "production_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      shipment_items: {
        Row: {
          id: string
          ingredient_id: string | null
          lot_number: string | null
          quantity: number
          shipment_id: string
          value: number | null
        }
        Insert: {
          id?: string
          ingredient_id?: string | null
          lot_number?: string | null
          quantity: number
          shipment_id: string
          value?: number | null
        }
        Update: {
          id?: string
          ingredient_id?: string | null
          lot_number?: string | null
          quantity?: number
          shipment_id?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "shipment_items_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_items_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments_to_copacker"
            referencedColumns: ["id"]
          },
        ]
      }
      shipments_to_copacker: {
        Row: {
          carrier: string | null
          co_packer_id: string | null
          cp_confirmed: boolean | null
          cp_confirmed_date: string | null
          created_at: string | null
          id: string
          notes: string | null
          production_order_id: string | null
          purchase_order_id: string | null
          received_date: string | null
          ship_date: string | null
          shipment_number: string
          shipping_cost: number | null
          status: string | null
          supplier_id: string | null
          total_value: number | null
          tracking_number: string | null
        }
        Insert: {
          carrier?: string | null
          co_packer_id?: string | null
          cp_confirmed?: boolean | null
          cp_confirmed_date?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          production_order_id?: string | null
          purchase_order_id?: string | null
          received_date?: string | null
          ship_date?: string | null
          shipment_number: string
          shipping_cost?: number | null
          status?: string | null
          supplier_id?: string | null
          total_value?: number | null
          tracking_number?: string | null
        }
        Update: {
          carrier?: string | null
          co_packer_id?: string | null
          cp_confirmed?: boolean | null
          cp_confirmed_date?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          production_order_id?: string | null
          purchase_order_id?: string | null
          received_date?: string | null
          ship_date?: string | null
          shipment_number?: string
          shipping_cost?: number | null
          status?: string | null
          supplier_id?: string | null
          total_value?: number | null
          tracking_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shipments_to_copacker_co_packer_id_fkey"
            columns: ["co_packer_id"]
            isOneToOne: false
            referencedRelation: "co_packers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_to_copacker_production_order_id_fkey"
            columns: ["production_order_id"]
            isOneToOne: false
            referencedRelation: "production_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_to_copacker_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_to_copacker_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_contacts: {
        Row: {
          created_at: string | null
          email: string | null
          id: string
          is_primary: boolean
          name: string
          notes: string | null
          phone: string | null
          role: string | null
          supplier_id: string
        }
        Insert: {
          created_at?: string | null
          email?: string | null
          id?: string
          is_primary?: boolean
          name: string
          notes?: string | null
          phone?: string | null
          role?: string | null
          supplier_id: string
        }
        Update: {
          created_at?: string | null
          email?: string | null
          id?: string
          is_primary?: boolean
          name?: string
          notes?: string | null
          phone?: string | null
          role?: string | null
          supplier_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_contacts_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_ingredients: {
        Row: {
          id: string
          ingredient_id: string
          is_default: boolean | null
          min_order_packages: number | null
          package_name: string | null
          package_size: number | null
          package_unit: string | null
          packages_per_case: number | null
          price_per_package: number | null
          price_per_unit: number | null
          price_unit: string | null
          supplier_id: string
          supplier_item_name: string | null
          supplier_sku: string | null
        }
        Insert: {
          id?: string
          ingredient_id: string
          is_default?: boolean | null
          min_order_packages?: number | null
          package_name?: string | null
          package_size?: number | null
          package_unit?: string | null
          packages_per_case?: number | null
          price_per_package?: number | null
          price_per_unit?: number | null
          price_unit?: string | null
          supplier_id: string
          supplier_item_name?: string | null
          supplier_sku?: string | null
        }
        Update: {
          id?: string
          ingredient_id?: string
          is_default?: boolean | null
          min_order_packages?: number | null
          package_name?: string | null
          package_size?: number | null
          package_unit?: string | null
          packages_per_case?: number | null
          price_per_package?: number | null
          price_per_unit?: number | null
          price_unit?: string | null
          supplier_id?: string
          supplier_item_name?: string | null
          supplier_sku?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "supplier_ingredients_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_ingredients_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          created_at: string | null
          id: string
          lead_time_days: number | null
          name: string
          notes: string | null
          payment_terms: string | null
          rating: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          lead_time_days?: number | null
          name: string
          notes?: string | null
          payment_terms?: string | null
          rating?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          lead_time_days?: number | null
          name?: string
          notes?: string | null
          payment_terms?: string | null
          rating?: number | null
        }
        Relationships: []
      }
      unit_conversions: {
        Row: {
          from_unit: string
          multiplier: number
          to_unit: string
        }
        Insert: {
          from_unit: string
          multiplier: number
          to_unit: string
        }
        Update: {
          from_unit?: string
          multiplier?: number
          to_unit?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

