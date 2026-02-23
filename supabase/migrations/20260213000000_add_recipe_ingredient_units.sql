-- Rename column for generic unit support
ALTER TABLE recipe_ingredients RENAME COLUMN quantity_per_unit_oz TO quantity_per_unit;

-- Add unit column (defaults to 'oz' for backward compat)
ALTER TABLE recipe_ingredients ADD COLUMN unit text NOT NULL DEFAULT 'oz';

-- Unit conversions lookup table
CREATE TABLE unit_conversions (
  from_unit text NOT NULL,
  to_unit text NOT NULL,
  multiplier numeric NOT NULL,
  PRIMARY KEY (from_unit, to_unit)
);

ALTER TABLE unit_conversions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON unit_conversions FOR ALL USING (true) WITH CHECK (true);

-- Seed conversions
INSERT INTO unit_conversions (from_unit, to_unit, multiplier) VALUES
  ('oz','lbs',0.0625), ('lbs','oz',16),
  ('g','lbs',0.00220462), ('lbs','g',453.592),
  ('g','oz',0.035274), ('oz','g',28.3495),
  ('g','kg',0.001), ('kg','g',1000),
  ('kg','lbs',2.20462), ('lbs','kg',0.453592),
  ('oz','kg',0.0283495), ('kg','oz',35.274),
  ('ml','l',0.001), ('l','ml',1000),
  -- same-unit identity conversions
  ('oz','oz',1), ('lbs','lbs',1), ('g','g',1), ('kg','kg',1),
  ('ml','ml',1), ('l','l',1), ('pcs','pcs',1);
