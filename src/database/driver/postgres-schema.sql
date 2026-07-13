CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  auth_source TEXT NOT NULL DEFAULT 'local' CHECK(auth_source IN ('local', 'ldap')),
  ldap_dn TEXT,
  role TEXT DEFAULT 'speaker' CHECK(role IN ('admin', 'speaker', 'hero_admin', 'manager')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  token_valid_from TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource TEXT,
  details TEXT,
  ip_address TEXT,
  user_agent TEXT,
  status TEXT DEFAULT 'success',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource);
CREATE INDEX IF NOT EXISTS idx_audit_log_status ON audit_log(status);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS files_metadata (
  id SERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  safe_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  md5_hash TEXT NOT NULL,
  partial_md5 TEXT,
  mime_type TEXT,
  video_width INTEGER,
  video_height INTEGER,
  video_duration DOUBLE PRECISION,
  video_codec TEXT,
  video_profile TEXT,
  video_bitrate INTEGER,
  audio_codec TEXT,
  audio_bitrate INTEGER,
  audio_channels INTEGER,
  is_placeholder BOOLEAN DEFAULT FALSE,
  content_type TEXT DEFAULT 'file',
  stream_url TEXT,
  stream_protocol TEXT DEFAULT 'auto',
  pages_count INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  file_mtime BIGINT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(device_id, safe_name)
);

CREATE INDEX IF NOT EXISTS idx_files_device ON files_metadata(device_id);
CREATE INDEX IF NOT EXISTS idx_files_md5 ON files_metadata(md5_hash);
CREATE INDEX IF NOT EXISTS idx_files_partial_md5 ON files_metadata(partial_md5);
CREATE INDEX IF NOT EXISTS idx_files_dedup ON files_metadata(md5_hash, file_size);
CREATE INDEX IF NOT EXISTS idx_files_partial_dedup ON files_metadata(partial_md5, file_size);
CREATE INDEX IF NOT EXISTS idx_files_name ON files_metadata(safe_name);
CREATE INDEX IF NOT EXISTS idx_files_placeholder ON files_metadata(device_id, is_placeholder);
CREATE INDEX IF NOT EXISTS idx_files_path ON files_metadata(file_path);
CREATE INDEX IF NOT EXISTS idx_files_created ON files_metadata(created_at);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  device_type TEXT DEFAULT 'browser',
  platform TEXT,
  ip_address TEXT,
  capabilities TEXT,
  last_seen TIMESTAMP,
  current_state TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(device_type);
CREATE INDEX IF NOT EXISTS idx_devices_folder ON devices(folder);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen);

CREATE TABLE IF NOT EXISTS device_volume (
  device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
  volume_level INTEGER NOT NULL DEFAULT 50 CHECK (volume_level BETWEEN 0 AND 100),
  is_muted BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS file_names (
  id SERIAL PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  safe_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(device_id, safe_name)
);

CREATE INDEX IF NOT EXISTS idx_file_names_device ON file_names(device_id);
CREATE INDEX IF NOT EXISTS idx_file_names_safe ON file_names(device_id, safe_name);

CREATE TABLE IF NOT EXISTS file_statuses (
  id SERIAL PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  status TEXT,
  resolution TEXT,
  original_resolution TEXT,
  needs_optimization BOOLEAN DEFAULT FALSE,
  error TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(device_id, file_name)
);

CREATE INDEX IF NOT EXISTS idx_file_statuses_device ON file_statuses(device_id);
CREATE INDEX IF NOT EXISTS idx_file_statuses_status ON file_statuses(status);
CREATE INDEX IF NOT EXISTS idx_file_statuses_device_file ON file_statuses(device_id, file_name);

CREATE TABLE IF NOT EXISTS placeholders (
  device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
  placeholder_file TEXT,
  placeholder_type TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_device ON user_devices(device_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_user_device ON user_devices(user_id, device_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  description TEXT,
  executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_users_timestamp') THEN
    CREATE TRIGGER update_users_timestamp BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_files_metadata_timestamp') THEN
    CREATE TRIGGER update_files_metadata_timestamp BEFORE UPDATE ON files_metadata
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_devices_timestamp') THEN
    CREATE TRIGGER update_devices_timestamp BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_file_statuses_timestamp') THEN
    CREATE TRIGGER update_file_statuses_timestamp BEFORE UPDATE ON file_statuses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_placeholders_timestamp') THEN
    CREATE TRIGGER update_placeholders_timestamp BEFORE UPDATE ON placeholders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_settings_timestamp') THEN
    CREATE TRIGGER update_settings_timestamp BEFORE UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

CREATE OR REPLACE VIEW file_duplicates AS
SELECT
  md5_hash, file_size,
  COUNT(*)::INTEGER as duplicate_count,
  STRING_AGG(device_id || ':' || safe_name, ', ') as locations
FROM files_metadata
GROUP BY md5_hash, file_size
HAVING COUNT(*) > 1;

CREATE OR REPLACE VIEW shared_files AS
SELECT
  file_path, md5_hash,
  COUNT(*)::INTEGER as device_count,
  STRING_AGG(device_id, ', ') as devices,
  MAX(file_size) as file_size,
  MAX(file_size) * COUNT(*) as total_space_used,
  MAX(file_size) * (COUNT(*) - 1) as space_saved
FROM files_metadata
GROUP BY file_path, md5_hash
HAVING COUNT(*) > 1;

CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO modules (id, enabled) VALUES ('hero', FALSE)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE VIEW device_storage_stats AS
SELECT
  device_id,
  COUNT(*)::INTEGER as files_count,
  SUM(file_size) as total_size,
  MAX(created_at) as last_upload
FROM files_metadata
GROUP BY device_id;
