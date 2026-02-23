-- Add quantity_unit column to purchase_order_items
-- NULL means "same as ingredient's inventory unit" (resolved in app code)
ALTER TABLE purchase_order_items
  ADD COLUMN quantity_unit text;
