-- Audit trail for every manual inventory adjustment
CREATE TABLE inventory_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id uuid REFERENCES ingredients(id),
  co_packer_id uuid REFERENCES co_packers(id),
  location_type text NOT NULL,
  previous_quantity numeric,
  new_quantity numeric,
  difference numeric,
  reason text,
  adjusted_by text,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS with allow-all policy (matches project pattern)
ALTER TABLE inventory_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON inventory_adjustments
  FOR ALL USING (true) WITH CHECK (true);

-- Track when inventory was last physically counted
ALTER TABLE ingredient_inventory
  ADD COLUMN last_count_date timestamptz;
