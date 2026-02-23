-- Add lifecycle tracking to shipments_to_copacker
-- Existing rows get status='received' (preserves current behavior)

ALTER TABLE shipments_to_copacker
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS purchase_order_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS received_date date;

-- Make ship_date nullable (ordered shipments don't have a ship date yet)
ALTER TABLE shipments_to_copacker
  ALTER COLUMN ship_date DROP NOT NULL;

-- Indexes for new query patterns
CREATE INDEX IF NOT EXISTS idx_shipments_purchase_order ON shipments_to_copacker(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments_to_copacker(status);

-- Backfill: confirmed shipments get 'confirmed' status
UPDATE shipments_to_copacker SET status = 'confirmed' WHERE cp_confirmed = true;
-- Backfill: set received_date from ship_date for existing rows
UPDATE shipments_to_copacker SET received_date = ship_date::date WHERE received_date IS NULL;
