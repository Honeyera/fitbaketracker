-- Add shipping cost tracking columns to purchase_orders
-- No data deletion — only adding new columns
ALTER TABLE purchase_orders
  ADD COLUMN shipping_cost numeric,
  ADD COLUMN shipping_method text,
  ADD COLUMN shipping_carrier text,
  ADD COLUMN shipping_per_unit_weight numeric,
  ADD COLUMN include_shipping_in_cost boolean NOT NULL DEFAULT false;
