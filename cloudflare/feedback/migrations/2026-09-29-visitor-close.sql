ALTER TABLE threads ADD COLUMN visitor_closed INTEGER NOT NULL DEFAULT 0 CHECK(visitor_closed IN (0, 1));
