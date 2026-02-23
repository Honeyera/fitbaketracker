-- Fix supplier_ingredients constraints that block multiple package sizes
-- and ensure all required columns exist

-- 1. Ensure all package-related columns exist (safety net)
ALTER TABLE supplier_ingredients
  ADD COLUMN IF NOT EXISTS package_size numeric,
  ADD COLUMN IF NOT EXISTS package_unit text,
  ADD COLUMN IF NOT EXISTS package_name text,
  ADD COLUMN IF NOT EXISTS price_per_package numeric,
  ADD COLUMN IF NOT EXISTS supplier_item_name text,
  ADD COLUMN IF NOT EXISTS supplier_sku text,
  ADD COLUMN IF NOT EXISTS min_order_packages integer,
  ADD COLUMN IF NOT EXISTS packages_per_case integer,
  ADD COLUMN IF NOT EXISTS is_default boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS price_unit text;

-- 2. Drop the old unique constraint on (supplier_id, ingredient_id) if it exists
ALTER TABLE supplier_ingredients
  DROP CONSTRAINT IF EXISTS supplier_ingredients_supplier_id_ingredient_id_key;

-- 3. Drop the uq_si_package unique index — it blocks legitimate duplicate
--    inserts when package details are null/empty (common for new rows)
DROP INDEX IF EXISTS uq_si_package;
