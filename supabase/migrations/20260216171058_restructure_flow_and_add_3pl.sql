-- Restructure: Remove warehouse concept, add 3PL/FBA fulfillment centers
-- NOTE: No data deletion. App code will simply ignore warehouse rows.

-- Create fulfillment_centers table
CREATE TABLE fulfillment_centers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL,
  code text,
  location text,
  contact_name text,
  contact_email text,
  contact_phone text,
  notes text,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE fulfillment_centers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON fulfillment_centers
  FOR ALL USING (true) WITH CHECK (true);

-- Add fulfillment_center_id and sales_channel to finished_goods_movements
ALTER TABLE finished_goods_movements
  ADD COLUMN fulfillment_center_id uuid REFERENCES fulfillment_centers ON DELETE SET NULL,
  ADD COLUMN sales_channel text;

-- Add new freight leg column (keep old columns for data preservation)
-- avg_freight_cp_to_fba already exists; add avg_freight_cp_to_3pl
ALTER TABLE recipe_freight_summary
  ADD COLUMN IF NOT EXISTS avg_freight_cp_to_3pl numeric;
