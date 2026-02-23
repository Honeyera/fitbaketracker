-- Add image_url column to recipes
ALTER TABLE recipes ADD COLUMN image_url text;

-- Create storage bucket for recipe images
INSERT INTO storage.buckets (id, name, public)
VALUES ('recipe-images', 'recipe-images', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access + authenticated uploads
CREATE POLICY "Public read recipe images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'recipe-images');

CREATE POLICY "Allow upload recipe images"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'recipe-images');

CREATE POLICY "Allow update recipe images"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'recipe-images');

CREATE POLICY "Allow delete recipe images"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'recipe-images');
