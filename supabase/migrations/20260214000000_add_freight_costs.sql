-- finished_goods_movements: add freight tracking
ALTER TABLE finished_goods_movements
  ADD COLUMN shipping_cost numeric,
  ADD COLUMN freight_per_unit numeric,
  ADD COLUMN freight_leg text;

-- shipments_to_copacker: add freight tracking
ALTER TABLE shipments_to_copacker
  ADD COLUMN shipping_cost numeric;

-- recipes: add freight + landed COGS fields
ALTER TABLE recipes
  ADD COLUMN estimated_freight_per_unit numeric,
  ADD COLUMN landed_cogs numeric;

-- recipe_freight_summary: cache of average freight per recipe
CREATE TABLE recipe_freight_summary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid REFERENCES recipes ON DELETE CASCADE,
  avg_freight_cp_to_warehouse numeric,
  avg_freight_warehouse_to_fba numeric,
  avg_freight_cp_to_fba numeric,
  avg_total_freight numeric,
  last_calculated timestamptz DEFAULT now(),
  UNIQUE(recipe_id)
);

ALTER TABLE recipe_freight_summary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON recipe_freight_summary
  FOR ALL USING (true) WITH CHECK (true);
