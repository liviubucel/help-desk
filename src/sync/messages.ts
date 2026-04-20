import type { Env, NormalizedUpmindEvent } from '../types';
import { addZohoTicketComment } from '../zoho/tickets';
import { messageChecksum } from './dedupe';
import { syncTicketFromUpmind } from './tickets';

export async function syncMessageFromUpmind(env: Env, event: NormalizedUpmindEvent): Promise<string | undefined> {
	if (!event.ticket?.id || !event.message?.id) return undefined;

	const existing = await env.BRIDGE_DB.prepare('SELECT zoho_message_id FROM message_map WHERE upmind_message_id = ?1 LIMIT 1')
		.bind(event.message.id)
		.first<{ zoho_message_id?: string }>();
	if (existing?.zoho_message_id && !existing.zoho_message_id.startsWith('pending-')) return existing.zoho_message_id;

	const zohoTicketId = await syncTicketFromUpmind(env, event);
	if (!zohoTicketId) throw new Error(`Cannot sync message ${event.message.id}: missing Zoho ticket`);

	const checksum = await messageChecksum(event.ticket.id, event.message.body || '', 'upmind_to_zoho');
	const duplicateByChecksum = await env.BRIDGE_DB.prepare('SELECT zoho_message_id FROM message_map WHERE checksum = ?1 LIMIT 1')
		.bind(checksum)
		.first<{ zoho_message_id?: string }>();
	if (duplicateByChecksum?.zoho_message_id) return duplicateByChecksum.zoho_message_id;

	const zohoMessageId = await addZohoTicketComment(env, zohoTicketId, event.message);
	const ticketMap = await env.BRIDGE_DB.prepare('SELECT id FROM ticket_map WHERE upmind_ticket_id = ?1 LIMIT 1')
		.bind(event.ticket.id)
		.first<{ id: number }>();

	await env.BRIDGE_DB.prepare(`
		INSERT INTO message_map (upmind_message_id, zoho_message_id, ticket_map_id, direction, checksum)
		VALUES (?1, ?2, ?3, 'upmind_to_zoho', ?4)
		ON CONFLICT(upmind_message_id) DO UPDATE SET
			zoho_message_id = COALESCE(excluded.zoho_message_id, message_map.zoho_message_id),
			checksum = COALESCE(excluded.checksum, message_map.checksum)
	`).bind(event.message.id, zohoMessageId ?? `pending-zoho-message-${event.message.id}`, ticketMap?.id ?? null, checksum).run();

	return zohoMessageId;
}

