import type { Env, JsonRecord } from './types';
import { normalizeUpmindEvent } from './upmind/normalize';
import { syncMessageFromUpmind } from './sync/messages';
import { syncTicketFromUpmind } from './sync/tickets';
import { resolveOrCreateContact } from './sync/contacts';
import { markProcessed } from './db';

export async function handleCronSync(env: Env): Promise<JsonRecord> {
	const pendingContacts = await env.BRIDGE_DB.prepare(`
		SELECT upmind_client_id, email, full_name, first_name, last_name
		FROM contact_map
		WHERE zoho_contact_id LIKE 'pending-%' OR zoho_contact_id IS NULL
		LIMIT 100
	`).all<{
		upmind_client_id?: string;
		email?: string;
		full_name?: string;
		first_name?: string;
		last_name?: string;
	}>();

	let contactsSynced = 0;
	let contactSyncFailed = 0;
	for (const row of pendingContacts.results || []) {
		try {
			await resolveOrCreateContact(env, {
				id: row.upmind_client_id,
				email: row.email,
				fullName: row.full_name,
				firstName: row.first_name,
				lastName: row.last_name
			});
			contactsSynced++;
		} catch {
			contactSyncFailed++;
		}
	}

	return { ok: true, contactsSynced, contactSyncFailed };
}

export async function retryFailedEvents(env: Env, limit = 10): Promise<JsonRecord> {
	const rows = await env.BRIDGE_DB.prepare(`
		SELECT ef.event_key, ef.origin_system, ef.event_name, re.payload_json
		FROM event_failures ef
		JOIN raw_events re ON re.event_key = ef.event_key
		LEFT JOIN processed_events pe ON pe.event_key = ef.event_key
		WHERE pe.event_key IS NULL AND ef.origin_system = 'upmind'
		ORDER BY ef.id ASC
		LIMIT ?1
	`).bind(limit).all<{
		event_key: string;
		origin_system: string;
		event_name: string;
		payload_json: string;
	}>();

	let failuresRetried = 0;
	let failuresRetrySucceeded = 0;
	for (const row of rows.results || []) {
		failuresRetried++;
		try {
			const payload = JSON.parse(row.payload_json);
			const event = normalizeUpmindEvent(payload);
			if (event.message?.id && event.ticket?.id) {
				await syncMessageFromUpmind(env, event);
			} else if (event.ticket?.id) {
				await syncTicketFromUpmind(env, event);
			} else {
				await resolveOrCreateContact(env, event.client);
			}
			await markProcessed(env, row.event_key, row.origin_system);
			failuresRetrySucceeded++;
		} catch {
			// Leave the failure queued for a later run.
		}
	}

	return { failuresRetried, failuresRetrySucceeded };
}
