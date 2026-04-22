import type { Env, JsonRecord } from './types';
import { preview } from './logger';

export async function ensureSchema(env: Env): Promise<void> {
	await env.BRIDGE_DB.prepare(`
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
		)
	`).run();
	await env.BRIDGE_DB.prepare(`
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
		)
	`).run();
	await env.BRIDGE_DB.prepare(`
		CREATE TABLE IF NOT EXISTS message_map (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			upmind_message_id TEXT UNIQUE,
			zoho_message_id TEXT UNIQUE,
			ticket_map_id INTEGER,
			direction TEXT NOT NULL DEFAULT 'upmind_to_zoho',
			checksum TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		)
	`).run();
	await env.BRIDGE_DB.prepare(`
		CREATE TABLE IF NOT EXISTS raw_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_key TEXT UNIQUE,
			origin_system TEXT NOT NULL,
			event_name TEXT,
			payload_json TEXT NOT NULL,
			sanitized_preview_json TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		)
	`).run();
	await env.BRIDGE_DB.prepare(`
		CREATE TABLE IF NOT EXISTS processed_events (
			event_key TEXT PRIMARY KEY,
			origin_system TEXT NOT NULL,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP,
			expires_at TEXT
		)
	`).run();
	await env.BRIDGE_DB.prepare(`
		CREATE TABLE IF NOT EXISTS event_failures (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_key TEXT NOT NULL,
			origin_system TEXT NOT NULL,
			event_name TEXT,
			error_message TEXT,
			payload_json TEXT,
			retry_count INTEGER DEFAULT 0,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT DEFAULT CURRENT_TIMESTAMP
		)
	`).run();
	await env.BRIDGE_DB.prepare(`
		CREATE TABLE IF NOT EXISTS oauth_tokens (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			provider TEXT NOT NULL UNIQUE,
			access_token TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			updated_at TEXT DEFAULT CURRENT_TIMESTAMP
		)
	`).run();
	await env.BRIDGE_DB.prepare(`
		CREATE TABLE IF NOT EXISTS sync_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			direction TEXT NOT NULL,
			object_type TEXT NOT NULL,
			object_id TEXT,
			action TEXT NOT NULL,
			status TEXT NOT NULL,
			message TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		)
	`).run();
	await env.BRIDGE_DB.prepare(`
		CREATE TABLE IF NOT EXISTS upmind_login_hints (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ip_address TEXT NOT NULL,
			upmind_client_id TEXT NOT NULL,
			email TEXT NOT NULL,
			full_name TEXT,
			expires_at INTEGER NOT NULL,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		)
	`).run();

	await ensureColumn(env, 'contact_map', 'full_name', 'TEXT');
	await ensureColumn(env, 'contact_map', 'first_name', 'TEXT');
	await ensureColumn(env, 'contact_map', 'last_name', 'TEXT');
	await ensureColumn(env, 'contact_map', 'last_synced_at', 'TEXT');
	await ensureColumn(env, 'ticket_map', 'upmind_reference', 'TEXT');
	await ensureColumn(env, 'ticket_map', 'created_origin', 'TEXT');
	await ensureColumn(env, 'ticket_map', 'last_synced_at', 'TEXT');
	await ensureColumn(env, 'message_map', 'direction', "TEXT DEFAULT 'upmind_to_zoho'");
	await ensureColumn(env, 'message_map', 'checksum', 'TEXT');
	await ensureColumn(env, 'raw_events', 'sanitized_preview_json', 'TEXT');

	await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_contact_map_email ON contact_map(email)').run();
	await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_ticket_map_reference ON ticket_map(upmind_reference)').run();
	await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_ticket_map_client ON ticket_map(upmind_client_id)').run();
	await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_message_map_ticket ON message_map(ticket_map_id)').run();
	await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_message_map_checksum ON message_map(checksum)').run();
	await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_event_failures_event_key ON event_failures(event_key)').run();
	await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_upmind_login_hints_ip_expires ON upmind_login_hints(ip_address, expires_at)').run();
}

async function ensureColumn(env: Env, table: string, column: string, definition: string): Promise<void> {
	try {
		await env.BRIDGE_DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
	} catch (error) {
		const message = String(error).toLowerCase();
		if (!message.includes('duplicate column') && !message.includes('already exists')) {
			throw error;
		}
	}
}

export async function isDuplicateEvent(env: Env, eventKey: string): Promise<boolean> {
	const row = await env.BRIDGE_DB.prepare('SELECT event_key FROM processed_events WHERE event_key = ?1 LIMIT 1').bind(eventKey).first();
	return Boolean(row);
}

export async function markProcessed(env: Env, eventKey: string, originSystem: string): Promise<void> {
	await env.BRIDGE_DB.prepare(`
		INSERT OR IGNORE INTO processed_events (event_key, origin_system, expires_at)
		VALUES (?1, ?2, datetime('now', '+14 day'))
	`).bind(eventKey, originSystem).run();
}

export async function storeRawEvent(env: Env, originSystem: string, eventName: string, eventKey: string, payload: JsonRecord): Promise<void> {
	await env.BRIDGE_DB.prepare(`
		INSERT OR IGNORE INTO raw_events (event_key, origin_system, event_name, payload_json, sanitized_preview_json)
		VALUES (?1, ?2, ?3, ?4, ?5)
	`).bind(eventKey, originSystem, eventName, JSON.stringify(payload), preview(payload)).run();
}

export async function recordFailure(env: Env, input: { eventKey: string; originSystem: string; eventName: string; error: unknown; payload: JsonRecord }): Promise<void> {
	await env.BRIDGE_DB.prepare(`
		INSERT INTO event_failures (event_key, origin_system, event_name, error_message, payload_json)
		VALUES (?1, ?2, ?3, ?4, ?5)
	`).bind(input.eventKey, input.originSystem, input.eventName, String(input.error), JSON.stringify(input.payload)).run();
}

export async function audit(env: Env, input: { direction: string; objectType: string; objectId?: string; action: string; status: string; message?: string }): Promise<void> {
	await env.BRIDGE_DB.prepare(`
		INSERT INTO sync_audit (direction, object_type, object_id, action, status, message)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6)
	`).bind(input.direction, input.objectType, input.objectId ?? null, input.action, input.status, input.message ?? null).run();
}

export async function storeUpmindLoginHint(env: Env, input: { ipAddress?: string; clientId?: string; email?: string; fullName?: string }): Promise<void> {
	if (!input.ipAddress || !input.clientId || !input.email) return;
	const now = Math.floor(Date.now() / 1000);
	const ttl = Number(env.UPMIND_LOGIN_HINT_TTL_SECONDS || 900);
	const expiresAt = now + (Number.isFinite(ttl) && ttl > 0 ? ttl : 900);

	await env.BRIDGE_DB.prepare('DELETE FROM upmind_login_hints WHERE expires_at <= ?1').bind(now).run();
	await env.BRIDGE_DB.prepare(`
		INSERT INTO upmind_login_hints (ip_address, upmind_client_id, email, full_name, expires_at)
		VALUES (?1, ?2, ?3, ?4, ?5)
	`).bind(input.ipAddress, input.clientId, input.email, input.fullName ?? null, expiresAt).run();
}

export async function getUpmindLoginHintByIp(env: Env, ipAddress?: string): Promise<{ clientId: string; email: string; name?: string } | null> {
	if (!ipAddress) return null;
	const now = Math.floor(Date.now() / 1000);
	const row = await env.BRIDGE_DB.prepare(`
		SELECT upmind_client_id, email, full_name
		FROM upmind_login_hints
		WHERE ip_address = ?1 AND expires_at > ?2
		ORDER BY id DESC
		LIMIT 1
	`).bind(ipAddress, now).first<{ upmind_client_id: string; email: string; full_name?: string }>();

	return row ? { clientId: row.upmind_client_id, email: row.email, name: row.full_name || undefined } : null;
}
