-- Remove cross-type (weight↔volume) conversions from config table
-- Only affects unit_conversions reference data, not user data
DELETE FROM unit_conversions WHERE
  (from_unit IN ('g','kg','lbs','oz') AND to_unit IN ('ml','l','gal','fl_oz'))
  OR
  (from_unit IN ('ml','l','gal','fl_oz') AND to_unit IN ('g','kg','lbs','oz'));

-- Add fl_oz (fluid ounces) — volume unit conversions
INSERT INTO unit_conversions (from_unit, to_unit, multiplier) VALUES
  ('fl_oz', 'fl_oz', 1),
  ('fl_oz', 'ml',    29.5735),
  ('ml',    'fl_oz', 0.033814),
  ('fl_oz', 'l',     0.0295735),
  ('l',     'fl_oz', 33.814),
  ('fl_oz', 'gal',   0.0078125),
  ('gal',   'fl_oz', 128)
ON CONFLICT DO NOTHING;
