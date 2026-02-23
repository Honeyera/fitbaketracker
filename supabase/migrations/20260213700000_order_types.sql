-- Add order type and payment tracking columns to purchase_orders
ALTER TABLE purchase_orders
  ADD COLUMN order_type text NOT NULL DEFAULT 'po',
  ADD COLUMN order_reference text,
  ADD COLUMN payment_method text,
  ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid';
