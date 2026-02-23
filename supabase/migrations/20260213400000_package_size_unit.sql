-- Rename package_size_oz → package_size and add package_size_unit column
ALTER TABLE recipes RENAME COLUMN package_size_oz TO package_size;
ALTER TABLE recipes ADD COLUMN package_size_unit text NOT NULL DEFAULT 'oz';
