-- Add density column for weight/volume conversion bridging
-- density_g_per_ml: grams per milliliter (e.g. water=1.0, vanilla extract=1.03)
-- NULL means no weight/volume conversion needed
ALTER TABLE ingredients
  ADD COLUMN density_g_per_ml numeric;
