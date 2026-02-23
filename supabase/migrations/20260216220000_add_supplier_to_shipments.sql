-- Add supplier_id to shipments_to_copacker so we can track which supplier shipped the ingredients
ALTER TABLE shipments_to_copacker
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id);
