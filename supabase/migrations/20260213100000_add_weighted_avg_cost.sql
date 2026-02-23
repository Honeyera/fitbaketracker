-- Add last_cost column to ingredients (most recent purchase price)
ALTER TABLE ingredients ADD COLUMN last_cost numeric;

-- Cost history table: tracks every PO receipt price
CREATE TABLE ingredient_cost_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  unit_cost numeric NOT NULL,
  quantity numeric NOT NULL,
  date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_cost_history_ingredient ON ingredient_cost_history(ingredient_id);
CREATE INDEX idx_cost_history_po ON ingredient_cost_history(purchase_order_id);

ALTER TABLE ingredient_cost_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON ingredient_cost_history FOR ALL USING (true) WITH CHECK (true);
