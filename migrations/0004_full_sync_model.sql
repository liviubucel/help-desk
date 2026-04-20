ALTER TABLE contact_map ADD COLUMN full_name TEXT;
ALTER TABLE contact_map ADD COLUMN first_name TEXT;
ALTER TABLE contact_map ADD COLUMN last_name TEXT;

ALTER TABLE ticket_map ADD COLUMN upmind_reference TEXT;
ALTER TABLE ticket_map ADD COLUMN created_origin TEXT;
ALTER TABLE ticket_map ADD COLUMN last_synced_at TEXT;

ALTER TABLE message_map ADD COLUMN direction TEXT DEFAULT 'upmind_to_zoho';
ALTER TABLE message_map ADD COLUMN checksum TEXT;

ALTER TABLE raw_events ADD COLUMN sanitized_preview_json TEXT;

CREATE TABLE IF NOT EXISTS sync_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ticket_map_reference ON ticket_map(upmind_reference);
CREATE INDEX IF NOT EXISTS idx_message_map_checksum ON message_map(checksum);
