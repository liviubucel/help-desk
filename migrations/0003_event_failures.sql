-- Migration for event_failures table
CREATE TABLE IF NOT EXISTS event_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL,
    origin_system TEXT NOT NULL,
    event_name TEXT,
    error_message TEXT,
    payload_json TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_event_failures_event_key ON event_failures(event_key);
CREATE INDEX IF NOT EXISTS idx_event_failures_origin_system ON event_failures(origin_system);
