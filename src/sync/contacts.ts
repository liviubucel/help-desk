import type { Env, NormalizedClient } from '../types';
import { createZohoContact, findZohoContactIdByEmail, updateZohoContact } from '../zoho/contacts';

export async function resolveOrCreateContact(env: Env, client: NormalizedClient): Promise<string | undefined> {
	if (!client.id && !client.email) return undefined;

	const existingMap = await env.BRIDGE_DB.prepare(`
		SELECT zoho_contact_id FROM contact_map
		WHERE (upmind_client_id = ?1 AND ?1 IS NOT NULL) OR (email = ?2 AND ?2 IS NOT NULL)
		LIMIT 1
	`).bind(client.id ?? null, client.email ?? null).first<{ zoho_contact_id?: string }>();

	let zohoContactId = existingMap?.zoho_contact_id && !existingMap.zoho_contact_id.startsWith('pending-')
		? existingMap.zoho_contact_id
		: undefined;

	if (!zohoContactId && client.email) {
		zohoContactId = await findZohoContactIdByEmail(env, client.email);
	}
	if (!zohoContactId && client.email) {
		zohoContactId = await createZohoContact(env, client);
	} else if (zohoContactId) {
		await updateZohoContact(env, zohoContactId, client);
	}

	const storedId = zohoContactId || (client.id ? `pending-zoho-${client.id}` : undefined);
	if (client.id || client.email) {
		await env.BRIDGE_DB.prepare(`
			INSERT INTO contact_map (upmind_client_id, zoho_contact_id, email, full_name, first_name, last_name, last_synced_at, updated_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
			ON CONFLICT(upmind_client_id) DO UPDATE SET
				zoho_contact_id = COALESCE(excluded.zoho_contact_id, contact_map.zoho_contact_id),
				email = COALESCE(excluded.email, contact_map.email),
				full_name = COALESCE(excluded.full_name, contact_map.full_name),
				first_name = COALESCE(excluded.first_name, contact_map.first_name),
				last_name = COALESCE(excluded.last_name, contact_map.last_name),
				last_synced_at = CURRENT_TIMESTAMP,
				updated_at = CURRENT_TIMESTAMP
		`).bind(client.id ?? client.email ?? null, storedId ?? null, client.email ?? null, client.fullName ?? null, client.firstName ?? null, client.lastName ?? null).run();
	}

	return zohoContactId;
}

