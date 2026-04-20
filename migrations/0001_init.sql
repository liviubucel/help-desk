CREATE TABLE IF NOT EXISTS contact_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upmind_client_id TEXT UNIQUE,
  zoho_contact_id TEXT UNIQUE,
  email TEXT,
  full_name TEXT,
  first_name TEXT,
  last_name TEXT,
  last_synced_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ticket_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upmind_ticket_id TEXT UNIQUE,
  zoho_ticket_id TEXT UNIQUE,
  upmind_reference TEXT,
  upmind_client_id TEXT,
  zoho_contact_id TEXT,
  created_origin TEXT,
  last_status TEXT,
  last_synced_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upmind_message_id TEXT UNIQUE,
  zoho_message_id TEXT UNIQUE,
  ticket_map_id INTEGER,
  origin_system TEXT NOT NULL,
  direction TEXT DEFAULT 'upmind_to_zoho',
  checksum TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_map_id) REFERENCES ticket_map(id)
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_key TEXT PRIMARY KEY,
  origin_system TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin_system TEXT NOT NULL,
  event_name TEXT,
  event_key TEXT,
  payload_json TEXT NOT NULL,
  sanitized_preview_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contact_map_email ON contact_map(email);
CREATE INDEX IF NOT EXISTS idx_ticket_map_upmind_client_id ON ticket_map(upmind_client_id);
CREATE INDEX IF NOT EXISTS idx_ticket_map_reference ON ticket_map(upmind_reference);
CREATE INDEX IF NOT EXISTS idx_message_map_ticket_map_id ON message_map(ticket_map_id);
CREATE INDEX IF NOT EXISTS idx_message_map_checksum ON message_map(checksum);
