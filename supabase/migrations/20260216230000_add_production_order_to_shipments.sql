ALTER TABLE shipments_to_copacker
  ADD COLUMN IF NOT EXISTS production_order_id uuid REFERENCES production_orders(id);
