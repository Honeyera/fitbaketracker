-- Add support for co-packer provided ingredients
-- Some recipe ingredients are sourced by the co-packer (not by FitBake)
-- They charge a per-unit fee instead of FitBake purchasing and shipping

ALTER TABLE recipe_ingredients
  ADD COLUMN IF NOT EXISTS provided_by text NOT NULL DEFAULT 'fitbake',
  ADD COLUMN IF NOT EXISTS cp_charge_per_unit numeric,
  ADD COLUMN IF NOT EXISTS cp_charge_unit text;
