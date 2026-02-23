-- ============================================================
-- Auth & RBAC: app_users, activity_log, get_user_role(), RLS
-- ============================================================

-- ── 1. app_users table ─────────────────────────────────────────
CREATE TABLE app_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id     uuid UNIQUE NOT NULL,
  email       text NOT NULL,
  full_name   text NOT NULL,
  role        text NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('owner','admin','manager','viewer')),
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','invited','disabled')),
  avatar_url  text,
  phone       text,
  last_login  timestamptz,
  invited_by  uuid REFERENCES app_users(id),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;

-- ── 2. activity_log table ──────────────────────────────────────
CREATE TABLE activity_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES app_users(id),
  action      text NOT NULL,
  entity_type text,
  entity_id   uuid,
  details     jsonb,
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- ── 3. get_user_role() — SECURITY DEFINER for RLS ──────────────
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT role FROM app_users WHERE auth_id = auth.uid() LIMIT 1;
$$;

-- ── 4. RLS on app_users ────────────────────────────────────────
CREATE POLICY "app_users_select"
  ON app_users FOR SELECT
  TO authenticated
  USING (true);

-- Anon SELECT so the pre-auth setup check can count rows
CREATE POLICY "app_users_anon_select"
  ON app_users FOR SELECT
  TO anon
  USING (true);

-- Anon INSERT for bootstrap only (first user when table is empty)
CREATE POLICY "app_users_anon_bootstrap_insert"
  ON app_users FOR INSERT
  TO anon
  WITH CHECK (NOT EXISTS (SELECT 1 FROM app_users));

-- Bootstrap: allow insert when no app_users exist yet (first user)
CREATE POLICY "app_users_insert"
  ON app_users FOR INSERT
  TO authenticated
  WITH CHECK (
    NOT EXISTS (SELECT 1 FROM app_users)
    OR get_user_role() = 'owner'
  );

CREATE POLICY "app_users_update"
  ON app_users FOR UPDATE
  TO authenticated
  USING (get_user_role() = 'owner');

CREATE POLICY "app_users_delete"
  ON app_users FOR DELETE
  TO authenticated
  USING (get_user_role() = 'owner');

-- ── 5. RLS on activity_log ─────────────────────────────────────
CREATE POLICY "activity_log_select"
  ON activity_log FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "activity_log_insert"
  ON activity_log FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ── 6. Drop ALL existing permissive policies ───────────────────
-- Initial schema created: "Allow all for <table>" on 16 tables
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'co_packers','ingredients','ingredient_inventory','suppliers',
      'supplier_ingredients','purchase_orders','purchase_order_items',
      'shipments_to_copacker','shipment_items','recipes','recipe_ingredients',
      'production_runs','reconciliation_lines','finished_goods_movements',
      'packaging_materials','packaging_inventory'
    ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Allow all for %1$s" ON %1$I', t);
  END LOOP;
END;
$$;

-- Later migrations created policies with different names
DROP POLICY IF EXISTS "Allow all" ON unit_conversions;
DROP POLICY IF EXISTS "allow all" ON production_orders;
DROP POLICY IF EXISTS "allow all" ON ingredient_tags;
DROP POLICY IF EXISTS "allow all" ON ingredient_tag_links;
DROP POLICY IF EXISTS "allow all" ON fulfillment_centers;
DROP POLICY IF EXISTS "allow all" ON inventory_adjustments;
DROP POLICY IF EXISTS "allow all" ON co_packer_contacts;
DROP POLICY IF EXISTS "Allow all for supplier_contacts" ON supplier_contacts;
DROP POLICY IF EXISTS "Allow all" ON ingredient_cost_history;
DROP POLICY IF EXISTS "allow all" ON recipe_freight_summary;

-- ── 7. Create new per-table RLS policies ───────────────────────
-- All 26 data tables get: authenticated SELECT/INSERT/UPDATE,
-- DELETE restricted to owner/admin
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'co_packers','ingredients','ingredient_inventory','suppliers',
      'supplier_ingredients','purchase_orders','purchase_order_items',
      'shipments_to_copacker','shipment_items','recipes','recipe_ingredients',
      'production_runs','reconciliation_lines','finished_goods_movements',
      'packaging_materials','packaging_inventory',
      'unit_conversions','production_orders','ingredient_tags','ingredient_tag_links',
      'fulfillment_centers','inventory_adjustments','co_packer_contacts',
      'supplier_contacts','ingredient_cost_history','recipe_freight_summary'
    ])
  LOOP
    -- SELECT: all authenticated users
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
      t || '_select', t
    );
    -- INSERT: all authenticated users
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (true)',
      t || '_insert', t
    );
    -- UPDATE: all authenticated users
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (true)',
      t || '_update', t
    );
    -- DELETE: owner and admin only
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (get_user_role() IN (''owner'',''admin''))',
      t || '_delete', t
    );
  END LOOP;
END;
$$;

-- ── 8. Enable RLS on tables that may not have it yet ───────────
ALTER TABLE unit_conversions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredient_tags        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredient_tag_links   ENABLE ROW LEVEL SECURITY;
ALTER TABLE fulfillment_centers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_adjustments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE co_packer_contacts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_contacts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredient_cost_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_freight_summary ENABLE ROW LEVEL SECURITY;
