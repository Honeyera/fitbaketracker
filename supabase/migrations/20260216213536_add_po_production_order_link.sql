-- Add optional link from purchase_orders to production_orders
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS production_order_id uuid REFERENCES production_orders(id);
