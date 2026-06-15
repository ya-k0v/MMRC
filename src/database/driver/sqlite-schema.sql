CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  auth_source TEXT NOT NULL DEFAULT 'local' CHECK(auth_source IN ('local', 'ldap')),
  ldap_dn TEXT,
  role TEXT DEFAULT 'speaker' CHECK(role IN ('admin', 'speaker', 'hero_admin', 'manager')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME,
  is_active INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  resource TEXT,
  details TEXT,
  ip_address TEXT,
  user_agent TEXT,
  status TEXT DEFAULT 'success',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource);
CREATE INDEX IF NOT EXISTS idx_audit_log_status ON audit_log(status);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS files_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  safe_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  md5_hash TEXT NOT NULL,
  partial_md5 TEXT,
  mime_type TEXT,
  video_width INTEGER,
  video_height INTEGER,
  video_duration REAL,
  video_codec TEXT,
  video_profile TEXT,
  video_bitrate INTEGER,
  audio_codec TEXT,
  audio_bitrate INTEGER,
  audio_channels INTEGER,
  is_placeholder INTEGER DEFAULT 0,
  content_type TEXT DEFAULT 'file',
  stream_url TEXT,
  stream_protocol TEXT DEFAULT 'auto',
  pages_count INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  file_mtime INTEGER NOT NULL,
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
  last_seen DATETIME,
  current_state TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(device_type);
CREATE INDEX IF NOT EXISTS idx_devices_folder ON devices(folder);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen);

CREATE TABLE IF NOT EXISTS device_volume (
  device_id TEXT PRIMARY KEY,
  volume_level INTEGER NOT NULL DEFAULT 50 CHECK (volume_level BETWEEN 0 AND 100),
  is_muted INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS file_names (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  safe_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
  UNIQUE(device_id, safe_name)
);

CREATE INDEX IF NOT EXISTS idx_file_names_device ON file_names(device_id);
CREATE INDEX IF NOT EXISTS idx_file_names_safe ON file_names(device_id, safe_name);

CREATE TABLE IF NOT EXISTS file_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  status TEXT,
  resolution TEXT,
  original_resolution TEXT,
  needs_optimization INTEGER DEFAULT 0,
  error TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
  UNIQUE(device_id, file_name)
);

CREATE INDEX IF NOT EXISTS idx_file_statuses_device ON file_statuses(device_id);
CREATE INDEX IF NOT EXISTS idx_file_statuses_status ON file_statuses(status);
CREATE INDEX IF NOT EXISTS idx_file_statuses_device_file ON file_statuses(device_id, file_name);

CREATE TABLE IF NOT EXISTS placeholders (
  device_id TEXT PRIMARY KEY,
  placeholder_file TEXT,
  placeholder_type TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
  UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_device ON user_devices(device_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_user_device ON user_devices(user_id, device_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  description TEXT,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS update_users_timestamp
AFTER UPDATE ON users
BEGIN
  UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_files_metadata_timestamp
AFTER UPDATE ON files_metadata
BEGIN
  UPDATE files_metadata SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_devices_timestamp
AFTER UPDATE ON devices
BEGIN
  UPDATE devices SET updated_at = CURRENT_TIMESTAMP WHERE device_id = NEW.device_id;
END;

CREATE TRIGGER IF NOT EXISTS update_file_statuses_timestamp
AFTER UPDATE ON file_statuses
BEGIN
  UPDATE file_statuses SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_placeholders_timestamp
AFTER UPDATE ON placeholders
BEGIN
  UPDATE placeholders SET updated_at = CURRENT_TIMESTAMP WHERE device_id = NEW.device_id;
END;

CREATE TRIGGER IF NOT EXISTS update_settings_timestamp
AFTER UPDATE ON settings
BEGIN
  UPDATE settings SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
END;

CREATE VIEW IF NOT EXISTS file_duplicates AS
SELECT
  md5_hash, file_size,
  COUNT(*) as duplicate_count,
  GROUP_CONCAT(device_id || ':' || safe_name, ', ') as locations
FROM files_metadata
GROUP BY md5_hash, file_size
HAVING duplicate_count > 1;

CREATE VIEW IF NOT EXISTS shared_files AS
SELECT
  file_path, md5_hash,
  COUNT(*) as device_count,
  GROUP_CONCAT(device_id, ', ') as devices,
  MAX(file_size) as file_size,
  MAX(file_size) * COUNT(*) as total_space_used,
  MAX(file_size) * (COUNT(*) - 1) as space_saved
FROM files_metadata
GROUP BY file_path, md5_hash
HAVING device_count > 1;

CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO modules (id, enabled) VALUES ('hero', 0);

CREATE VIEW IF NOT EXISTS device_storage_stats AS
SELECT
  device_id,
  COUNT(*) as files_count,
  SUM(file_size) as total_size,
  MAX(created_at) as last_upload
FROM files_metadata
GROUP BY device_id;
