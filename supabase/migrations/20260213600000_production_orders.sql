-- Production Orders: groups multiple production runs into one order sent to a co-packer

CREATE TABLE production_orders (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number             text        NOT NULL UNIQUE,
  co_packer_id             uuid        REFERENCES co_packers(id),
  status                   text        NOT NULL DEFAULT 'draft',
  order_date               date,
  requested_start_date     date,
  estimated_completion_date date,
  priority                 text        NOT NULL DEFAULT 'normal',
  notes                    text,
  total_units              integer     DEFAULT 0,
  total_estimated_cost     numeric     DEFAULT 0,
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now()
);

ALTER TABLE production_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON production_orders FOR ALL USING (true) WITH CHECK (true);

-- Link production runs to an order (nullable — standalone runs still work)
ALTER TABLE production_runs
  ADD COLUMN production_order_id uuid REFERENCES production_orders(id) ON DELETE SET NULL;
