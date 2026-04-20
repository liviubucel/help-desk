import type { Env, NormalizedUpmindEvent } from '../types';
import { createZohoTicket, updateZohoTicket } from '../zoho/tickets';
import { resolveOrCreateContact } from './contacts';
import { mapUpmindStatusToZoho } from './status-map';

export async function syncTicketFromUpmind(env: Env, event: NormalizedUpmindEvent): Promise<string | undefined> {
	if (!event.ticket?.id) return undefined;
	const zohoContactId = await resolveOrCreateContact(env, event.client);
	const mappedStatus = mapUpmindStatusToZoho(env, event.code || event.eventType);

	const existing = await env.BRIDGE_DB.prepare('SELECT zoho_ticket_id FROM ticket_map WHERE upmind_ticket_id = ?1 LIMIT 1')
		.bind(event.ticket.id)
		.first<{ zoho_ticket_id?: string }>();

	let zohoTicketId = existing?.zoho_ticket_id && !existing.zoho_ticket_id.startsWith('pending-') ? existing.zoho_ticket_id : undefined;

	if (!zohoTicketId) {
		zohoTicketId = await createZohoTicket(env, {
			ticket: event.ticket,
			contactId: zohoContactId,
			email: event.client.email,
			status: mappedStatus,
			description: buildTicketDescription(event)
		});
	} else {
		await updateZohoTicket(env, zohoTicketId, {
			subject: event.ticket.subject,
			status: mappedStatus,
			contactId: zohoContactId
		});
	}

	await env.BRIDGE_DB.prepare(`
		INSERT INTO ticket_map (upmind_ticket_id, zoho_ticket_id, upmind_reference, upmind_client_id, zoho_contact_id, created_origin, last_status, last_synced_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5, 'upmind', ?6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(upmind_ticket_id) DO UPDATE SET
			zoho_ticket_id = COALESCE(excluded.zoho_ticket_id, ticket_map.zoho_ticket_id),
			upmind_reference = COALESCE(excluded.upmind_reference, ticket_map.upmind_reference),
			upmind_client_id = COALESCE(excluded.upmind_client_id, ticket_map.upmind_client_id),
			zoho_contact_id = COALESCE(excluded.zoho_contact_id, ticket_map.zoho_contact_id),
			last_status = excluded.last_status,
			last_synced_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
	`).bind(event.ticket.id, zohoTicketId ?? `pending-zoho-ticket-${event.ticket.id}`, event.ticket.reference ?? null, event.client.id ?? null, zohoContactId ?? null, mappedStatus).run();

	return zohoTicketId;
}

function buildTicketDescription(event: NormalizedUpmindEvent): string {
	return [
		event.ticket?.reference ? `Upmind reference: ${event.ticket.reference}` : undefined,
		event.ticket?.id ? `Upmind ticket id: ${event.ticket.id}` : undefined,
		event.message?.body ? `\nInitial message:\n${event.message.body}` : undefined
	].filter(Boolean).join('\n');
}

