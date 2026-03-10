ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_payment_method text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_card_used text;
