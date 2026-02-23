-- Add price_unit column to supplier_ingredients
-- NULL means "same as ingredient's inventory unit" (resolved in app code)
ALTER TABLE supplier_ingredients
  ADD COLUMN price_unit text;
