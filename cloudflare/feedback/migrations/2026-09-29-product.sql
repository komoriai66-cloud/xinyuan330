ALTER TABLE threads ADD COLUMN product TEXT NOT NULL DEFAULT 'ephone' CHECK(product IN ('ephone', 'uwu'));
CREATE INDEX IF NOT EXISTS threads_product_public ON threads(product, kind, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS threads_product_updated ON threads(product, updated_at DESC, id DESC);
