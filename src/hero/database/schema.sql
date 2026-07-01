CREATE TABLE IF NOT EXISTS heroes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  birth_year TEXT,
  death_year TEXT,
  rank TEXT,
  photo_base64 TEXT,
  photo_key TEXT,
  photo_offset_x REAL DEFAULT 0,
  photo_offset_y REAL DEFAULT 0,
  photo_scale REAL DEFAULT 1,
  biography TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hero_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hero_id INTEGER NOT NULL,
  type TEXT CHECK(type IN ('photo','video')),
  media_base64 TEXT,
  media_key TEXT,
  caption TEXT,
  order_index INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (hero_id) REFERENCES heroes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hero_full_name ON heroes(full_name);
CREATE INDEX IF NOT EXISTS idx_hero_media ON hero_media(hero_id);

CREATE TRIGGER IF NOT EXISTS trg_heroes_updated
AFTER UPDATE ON heroes
FOR EACH ROW
BEGIN
  UPDATE heroes SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

