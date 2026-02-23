-- Add package snapshot fields to purchase_order_items
-- so PO PDFs remain correct even if supplier packages change later
ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS qty_packages numeric,
  ADD COLUMN IF NOT EXISTS package_name text,
  ADD COLUMN IF NOT EXISTS package_size numeric,
  ADD COLUMN IF NOT EXISTS package_unit text;
