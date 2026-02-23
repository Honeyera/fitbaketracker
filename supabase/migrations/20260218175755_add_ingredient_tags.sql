-- Ingredient tags (categories/labels)
CREATE TABLE ingredient_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  color text NOT NULL DEFAULT '#6B7280',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ingredient_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON ingredient_tags
  FOR ALL USING (true) WITH CHECK (true);

-- Many-to-many link between ingredients and tags
CREATE TABLE ingredient_tag_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES ingredient_tags(id) ON DELETE CASCADE,
  UNIQUE (ingredient_id, tag_id)
);

ALTER TABLE ingredient_tag_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON ingredient_tag_links
  FOR ALL USING (true) WITH CHECK (true);

-- Seed common tags
INSERT INTO ingredient_tags (name, color) VALUES
  ('Dry Mix',       '#3B82F6'),
  ('Frosting',      '#EC4899'),
  ('Pancake',       '#F59E0B'),
  ('Bread',         '#A78BFA'),
  ('Cookie',        '#22C55E'),
  ('Muffin',        '#06B6D4'),
  ('Cake',          '#F97316'),
  ('All Products',  '#6B7280');
