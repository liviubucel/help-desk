
-- Add client_sessions table
CREATE TABLE IF NOT EXISTS client_sessions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	upmind_client_id TEXT NOT NULL,
	session_token TEXT NOT NULL,
	created_at TEXT DEFAULT CURRENT_TIMESTAMP,
	expires_at TEXT
);

-- Extend contact_map
ALTER TABLE contact_map ADD COLUMN upmind_login_enabled INTEGER;
ALTER TABLE contact_map ADD COLUMN last_synced_at TEXT;

-- Extend ticket_map
ALTER TABLE ticket_map ADD COLUMN last_synced_direction TEXT;
ALTER TABLE ticket_map ADD COLUMN last_external_updated_at TEXT;

-- Extend message_map
ALTER TABLE message_map ADD COLUMN external_created_at TEXT;

-- Indexes for lookups
CREATE INDEX IF NOT EXISTS idx_contact_map_email ON contact_map(email);
CREATE INDEX IF NOT EXISTS idx_contact_map_upmind_client_id ON contact_map(upmind_client_id);
CREATE INDEX IF NOT EXISTS idx_contact_map_zoho_contact_id ON contact_map(zoho_contact_id);
CREATE INDEX IF NOT EXISTS idx_ticket_map_upmind_ticket_id ON ticket_map(upmind_ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_map_zoho_ticket_id ON ticket_map(zoho_ticket_id);
CREATE INDEX IF NOT EXISTS idx_message_map_upmind_message_id ON message_map(upmind_message_id);
CREATE INDEX IF NOT EXISTS idx_message_map_zoho_message_id ON message_map(zoho_message_id);
