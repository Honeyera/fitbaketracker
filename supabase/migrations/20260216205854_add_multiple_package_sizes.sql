-- Add is_default flag to support multiple package sizes per supplier-ingredient
ALTER TABLE supplier_ingredients
  ADD COLUMN IF NOT EXISTS is_default boolean DEFAULT false;

-- Mark all existing rows as default (currently one row per supplier+ingredient)
UPDATE supplier_ingredients SET is_default = true;

-- Prevent duplicate package sizes for the same supplier+ingredient combo
CREATE UNIQUE INDEX IF NOT EXISTS uq_si_package
  ON supplier_ingredients (
    supplier_id,
    ingredient_id,
    COALESCE(package_size, 0),
    COALESCE(package_unit, ''),
    COALESCE(package_name, '')
  );
