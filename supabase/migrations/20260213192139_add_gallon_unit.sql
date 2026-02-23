-- Add gallon (gal) unit conversions
INSERT INTO unit_conversions (from_unit, to_unit, multiplier) VALUES
  ('gal', 'l',   3.78541),
  ('l',   'gal', 0.264172),
  ('gal', 'ml',  3785.41),
  ('ml',  'gal', 0.000264172),
  ('gal', 'oz',  128),
  ('oz',  'gal', 0.0078125),
  ('gal', 'gal', 1)
ON CONFLICT DO NOTHING;
