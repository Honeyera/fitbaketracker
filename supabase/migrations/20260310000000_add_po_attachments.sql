-- PO Attachments: store supplier invoices / documents linked to a PO
CREATE TABLE po_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'invoice',  -- invoice, packing_slip, bol, receipt, other
  file_size INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_po_attachments_po ON po_attachments(purchase_order_id);

ALTER TABLE po_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage po_attachments"
  ON po_attachments FOR ALL TO authenticated USING (true) WITH CHECK (true);
