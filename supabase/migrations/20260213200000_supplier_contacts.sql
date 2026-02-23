-- ── Create supplier_contacts table ──────────────────────────────
CREATE TABLE supplier_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text,
  phone       text,
  role        text,
  is_primary  boolean NOT NULL DEFAULT false,
  notes       text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX idx_supplier_contacts_supplier ON supplier_contacts(supplier_id);

ALTER TABLE supplier_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for supplier_contacts" ON supplier_contacts
  FOR ALL USING (true) WITH CHECK (true);

-- ── Migrate existing contact data ──────────────────────────────
INSERT INTO supplier_contacts (supplier_id, name, email, phone, role, is_primary)
SELECT id, contact_name, contact_email, contact_phone, 'Sales Rep', true
FROM suppliers
WHERE contact_name IS NOT NULL
   OR contact_email IS NOT NULL
   OR contact_phone IS NOT NULL;

-- ── Drop old contact columns from suppliers ────────────────────
ALTER TABLE suppliers DROP COLUMN contact_name;
ALTER TABLE suppliers DROP COLUMN contact_email;
ALTER TABLE suppliers DROP COLUMN contact_phone;
