-- Add supplier_item_name to supplier_ingredients
-- Stores the name the supplier uses for this ingredient (appears on PO PDFs)
ALTER TABLE supplier_ingredients
  ADD COLUMN IF NOT EXISTS supplier_item_name text;
