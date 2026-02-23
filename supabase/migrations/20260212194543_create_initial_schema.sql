-- ============================================================
-- FitBake Multi Co-Packer Production Tracking — Initial Schema
-- ============================================================

-- --------------------------------------------------------
-- 1. Co-Packers
-- --------------------------------------------------------
create table co_packers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  short_code    text not null,
  color         text,
  location      text,
  contact_name  text,
  contact_email text,
  contact_phone text,
  fee_per_unit  numeric,
  payment_terms text,
  min_order_qty integer,
  monthly_capacity integer,
  status        text default 'active',
  notes         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- --------------------------------------------------------
-- 2. Ingredients
-- --------------------------------------------------------
create table ingredients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  category        text,
  unit            text not null default 'lbs',
  unit_cost       numeric not null,
  reorder_point   numeric,
  shelf_life_days integer,
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- --------------------------------------------------------
-- 3. Ingredient Inventory
-- --------------------------------------------------------
create table ingredient_inventory (
  id              uuid primary key default gen_random_uuid(),
  ingredient_id   uuid not null references ingredients on delete cascade,
  location_type   text not null,
  co_packer_id    uuid references co_packers on delete set null,
  quantity        numeric not null default 0,
  lot_number      text,
  expiration_date date,
  updated_at      timestamptz default now()
);

-- --------------------------------------------------------
-- 4. Suppliers
-- --------------------------------------------------------
create table suppliers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  contact_name    text,
  contact_email   text,
  contact_phone   text,
  lead_time_days  integer,
  payment_terms   text,
  rating          numeric,
  notes           text,
  created_at      timestamptz default now()
);

-- --------------------------------------------------------
-- 5. Supplier ↔ Ingredient link
-- --------------------------------------------------------
create table supplier_ingredients (
  id              uuid primary key default gen_random_uuid(),
  supplier_id     uuid not null references suppliers on delete cascade,
  ingredient_id   uuid not null references ingredients on delete cascade,
  supplier_sku    text,
  price_per_unit  numeric
);

-- --------------------------------------------------------
-- 6. Purchase Orders
-- --------------------------------------------------------
create table purchase_orders (
  id                      uuid primary key default gen_random_uuid(),
  po_number               text not null unique,
  supplier_id             uuid references suppliers,
  status                  text default 'draft',
  order_date              date,
  eta_date                date,
  destination_type        text,
  destination_co_packer_id uuid references co_packers,
  total_cost              numeric,
  tracking_number         text,
  notes                   text,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

-- --------------------------------------------------------
-- 7. Purchase Order Items
-- --------------------------------------------------------
create table purchase_order_items (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders on delete cascade,
  ingredient_id     uuid references ingredients,
  quantity          numeric not null,
  unit_cost         numeric not null,
  received_quantity numeric default 0
);

-- --------------------------------------------------------
-- 8. Shipments to Co-Packer
-- --------------------------------------------------------
create table shipments_to_copacker (
  id               uuid primary key default gen_random_uuid(),
  shipment_number  text not null unique,
  co_packer_id     uuid references co_packers,
  ship_date        date not null,
  carrier          text,
  tracking_number  text,
  total_value      numeric,
  cp_confirmed     boolean default false,
  cp_confirmed_date date,
  notes            text,
  created_at       timestamptz default now()
);

-- --------------------------------------------------------
-- 9. Shipment Items
-- --------------------------------------------------------
create table shipment_items (
  id              uuid primary key default gen_random_uuid(),
  shipment_id     uuid not null references shipments_to_copacker on delete cascade,
  ingredient_id   uuid references ingredients,
  quantity        numeric not null,
  lot_number      text,
  value           numeric
);

-- --------------------------------------------------------
-- 10. Recipes / BOM
-- --------------------------------------------------------
create table recipes (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  sku               text not null unique,
  co_packer_id      uuid references co_packers,
  package_size_oz   numeric,
  expected_yield_pct numeric default 96.5,
  waste_tolerance_pct numeric default 2.5,
  status            text default 'active',
  ingredient_cogs   numeric,
  notes             text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- --------------------------------------------------------
-- 11. Recipe Ingredients
-- --------------------------------------------------------
create table recipe_ingredients (
  id                    uuid primary key default gen_random_uuid(),
  recipe_id             uuid not null references recipes on delete cascade,
  ingredient_id         uuid references ingredients,
  quantity_per_unit_oz  numeric not null,
  tolerance_pct         numeric default 2,
  unique (recipe_id, ingredient_id)
);

-- --------------------------------------------------------
-- 12. Production Runs
-- --------------------------------------------------------
create table production_runs (
  id                 uuid primary key default gen_random_uuid(),
  run_number         text not null unique,
  co_packer_id       uuid references co_packers,
  recipe_id          uuid references recipes,
  requested_quantity integer not null,
  produced_quantity  integer,
  status             text default 'requested',
  requested_date     date,
  started_date       date,
  completed_date     date,
  waste_pct          numeric,
  waste_cost         numeric,
  cp_notes           text,
  your_notes         text,
  priority           text default 'normal',
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- --------------------------------------------------------
-- 13. Reconciliation Lines
-- --------------------------------------------------------
create table reconciliation_lines (
  id                 uuid primary key default gen_random_uuid(),
  production_run_id  uuid not null references production_runs on delete cascade,
  ingredient_id      uuid references ingredients,
  theoretical_usage  numeric,
  actual_usage       numeric,
  variance_qty       numeric,
  variance_pct       numeric,
  variance_cost      numeric,
  status             text default 'pending',
  notes              text
);

-- --------------------------------------------------------
-- 14. Finished Goods Movements
-- --------------------------------------------------------
create table finished_goods_movements (
  id                 uuid primary key default gen_random_uuid(),
  date               date not null,
  recipe_id          uuid references recipes,
  co_packer_id       uuid references co_packers,
  production_run_id  uuid references production_runs,
  quantity           integer not null,
  from_location      text not null,
  to_location        text not null,
  fba_shipment_id    text,
  tracking_number    text,
  status             text default 'in_transit',
  notes              text,
  created_at         timestamptz default now()
);

-- --------------------------------------------------------
-- 15. Packaging Materials
-- --------------------------------------------------------
create table packaging_materials (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sku         text,
  unit_cost   numeric,
  notes       text,
  created_at  timestamptz default now()
);

-- --------------------------------------------------------
-- 16. Packaging Inventory
-- --------------------------------------------------------
create table packaging_inventory (
  id                    uuid primary key default gen_random_uuid(),
  packaging_material_id uuid not null references packaging_materials on delete cascade,
  location_type         text,
  co_packer_id          uuid references co_packers,
  quantity              integer default 0,
  updated_at            timestamptz default now()
);


-- ============================================================
-- INDEXES on foreign keys & status columns
-- ============================================================

-- ingredient_inventory
create index idx_ingredient_inventory_ingredient on ingredient_inventory (ingredient_id);
create index idx_ingredient_inventory_copacker  on ingredient_inventory (co_packer_id);

-- supplier_ingredients
create index idx_supplier_ingredients_supplier   on supplier_ingredients (supplier_id);
create index idx_supplier_ingredients_ingredient on supplier_ingredients (ingredient_id);

-- purchase_orders
create index idx_purchase_orders_supplier    on purchase_orders (supplier_id);
create index idx_purchase_orders_dest_cp     on purchase_orders (destination_co_packer_id);
create index idx_purchase_orders_status      on purchase_orders (status);

-- purchase_order_items
create index idx_po_items_po         on purchase_order_items (purchase_order_id);
create index idx_po_items_ingredient on purchase_order_items (ingredient_id);

-- shipments_to_copacker
create index idx_shipments_copacker on shipments_to_copacker (co_packer_id);

-- shipment_items
create index idx_shipment_items_shipment   on shipment_items (shipment_id);
create index idx_shipment_items_ingredient on shipment_items (ingredient_id);

-- recipes
create index idx_recipes_copacker on recipes (co_packer_id);
create index idx_recipes_status   on recipes (status);

-- recipe_ingredients
create index idx_recipe_ingredients_recipe     on recipe_ingredients (recipe_id);
create index idx_recipe_ingredients_ingredient on recipe_ingredients (ingredient_id);

-- production_runs
create index idx_production_runs_copacker on production_runs (co_packer_id);
create index idx_production_runs_recipe   on production_runs (recipe_id);
create index idx_production_runs_status   on production_runs (status);

-- reconciliation_lines
create index idx_reconciliation_run        on reconciliation_lines (production_run_id);
create index idx_reconciliation_ingredient on reconciliation_lines (ingredient_id);
create index idx_reconciliation_status     on reconciliation_lines (status);

-- finished_goods_movements
create index idx_fg_movements_recipe   on finished_goods_movements (recipe_id);
create index idx_fg_movements_copacker on finished_goods_movements (co_packer_id);
create index idx_fg_movements_run      on finished_goods_movements (production_run_id);
create index idx_fg_movements_status   on finished_goods_movements (status);

-- packaging_inventory
create index idx_packaging_inv_material on packaging_inventory (packaging_material_id);
create index idx_packaging_inv_copacker on packaging_inventory (co_packer_id);

-- co_packers status
create index idx_co_packers_status on co_packers (status);


-- ============================================================
-- Auto-update updated_at trigger
-- ============================================================
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_co_packers_updated_at
  before update on co_packers
  for each row execute function set_updated_at();

create trigger trg_ingredients_updated_at
  before update on ingredients
  for each row execute function set_updated_at();

create trigger trg_ingredient_inventory_updated_at
  before update on ingredient_inventory
  for each row execute function set_updated_at();

create trigger trg_purchase_orders_updated_at
  before update on purchase_orders
  for each row execute function set_updated_at();

create trigger trg_recipes_updated_at
  before update on recipes
  for each row execute function set_updated_at();

create trigger trg_production_runs_updated_at
  before update on production_runs
  for each row execute function set_updated_at();

create trigger trg_packaging_inventory_updated_at
  before update on packaging_inventory
  for each row execute function set_updated_at();


-- ============================================================
-- Row Level Security — permissive for single-user app
-- ============================================================
alter table co_packers              enable row level security;
alter table ingredients             enable row level security;
alter table ingredient_inventory    enable row level security;
alter table suppliers               enable row level security;
alter table supplier_ingredients    enable row level security;
alter table purchase_orders         enable row level security;
alter table purchase_order_items    enable row level security;
alter table shipments_to_copacker   enable row level security;
alter table shipment_items          enable row level security;
alter table recipes                 enable row level security;
alter table recipe_ingredients      enable row level security;
alter table production_runs         enable row level security;
alter table reconciliation_lines    enable row level security;
alter table finished_goods_movements enable row level security;
alter table packaging_materials     enable row level security;
alter table packaging_inventory     enable row level security;

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'co_packers','ingredients','ingredient_inventory','suppliers',
      'supplier_ingredients','purchase_orders','purchase_order_items',
      'shipments_to_copacker','shipment_items','recipes','recipe_ingredients',
      'production_runs','reconciliation_lines','finished_goods_movements',
      'packaging_materials','packaging_inventory'
    ])
  loop
    execute format(
      'create policy "Allow all for %1$s" on %1$I for all to authenticated, anon using (true) with check (true)',
      t
    );
  end loop;
end;
$$;
