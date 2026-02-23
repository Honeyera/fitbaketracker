-- Co-packer contacts (mirrors supplier_contacts pattern)

CREATE TABLE co_packer_contacts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  co_packer_id  uuid        NOT NULL REFERENCES co_packers(id) ON DELETE CASCADE,
  name          text        NOT NULL,
  email         text,
  phone         text,
  role          text,
  is_primary    boolean     NOT NULL DEFAULT false,
  notes         text,
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE co_packer_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON co_packer_contacts FOR ALL USING (true) WITH CHECK (true);

-- Migrate existing contact data
INSERT INTO co_packer_contacts (co_packer_id, name, email, phone, is_primary)
SELECT id, contact_name, contact_email, contact_phone, true
FROM co_packers
WHERE contact_name IS NOT NULL
   OR contact_email IS NOT NULL
   OR contact_phone IS NOT NULL;

-- Drop old columns
ALTER TABLE co_packers DROP COLUMN contact_name;
ALTER TABLE co_packers DROP COLUMN contact_email;
ALTER TABLE co_packers DROP COLUMN contact_phone;
