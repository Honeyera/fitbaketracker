-- Add package size information to supplier-ingredient relationships
ALTER TABLE supplier_ingredients
  ADD COLUMN IF NOT EXISTS package_size numeric,
  ADD COLUMN IF NOT EXISTS package_unit text,
  ADD COLUMN IF NOT EXISTS package_name text,
  ADD COLUMN IF NOT EXISTS price_per_package numeric,
  ADD COLUMN IF NOT EXISTS min_order_packages integer,
  ADD COLUMN IF NOT EXISTS packages_per_case integer;
