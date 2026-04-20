import type { JsonRecord, NormalizedUpmindEvent } from '../types';
import { deepRead, deepReadString, firstNonEmpty, isRecord, readBoolean, recursiveFindString } from '../utils/json';

export function normalizeUpmindEvent(payload: JsonRecord): NormalizedUpmindEvent {
	const category = firstNonEmpty([
		deepReadString(payload, ['hook_category']),
		deepReadString(payload, ['category']),
		deepReadString(payload, ['object_type'])
	]);
	const code = firstNonEmpty([
		deepReadString(payload, ['hook_code']),
		deepReadString(payload, ['event']),
		deepReadString(payload, ['eventName']),
		deepReadString(payload, ['type']),
		deepReadString(payload, ['action'])
	]);
	const object = deepRead(payload, ['object']);
	const ticketClient = deepRead(payload, ['object', 'ticket', 'client']);

	const firstName = firstNonEmpty([
		deepReadString(ticketClient, ['firstname']),
		deepReadString(ticketClient, ['first_name']),
		deepReadString(ticketClient, ['firstName']),
		deepReadString(payload, ['object', 'client', 'firstname']),
		deepReadString(payload, ['object', 'client', 'first_name']),
		deepReadString(payload, ['client', 'first_name']),
		deepReadString(payload, ['first_name'])
	]);
	const lastName = firstNonEmpty([
		deepReadString(ticketClient, ['lastname']),
		deepReadString(ticketClient, ['last_name']),
		deepReadString(ticketClient, ['lastName']),
		deepReadString(payload, ['object', 'client', 'lastname']),
		deepReadString(payload, ['object', 'client', 'last_name']),
		deepReadString(payload, ['client', 'last_name']),
		deepReadString(payload, ['last_name'])
	]);
	const fullName = firstNonEmpty([
		deepReadString(ticketClient, ['fullname']),
		deepReadString(ticketClient, ['full_name']),
		deepReadString(ticketClient, ['fullName']),
		deepReadString(payload, ['object', 'client_name']),
		deepReadString(payload, ['object', 'actor_name']),
		deepReadString(payload, ['actor_name']),
		[firstName, lastName].filter(Boolean).join(' ') || undefined
	]);

	const messageId = firstNonEmpty([
		deepReadString(payload, ['object', 'id']),
		deepReadString(payload, ['object_id']),
		deepReadString(payload, ['message', 'id']),
		deepReadString(payload, ['message_id'])
	]);
	const body = firstNonEmpty([
		deepReadString(payload, ['object', 'body']),
		deepReadString(payload, ['object', 'content']),
		deepReadString(payload, ['message', 'body']),
		deepReadString(payload, ['message', 'content']),
		deepReadString(payload, ['body']),
		deepReadString(payload, ['content'])
	]);
	const actorType = normalizeActorType(firstNonEmpty([
		deepReadString(payload, ['actor_type']),
		deepReadString(payload, ['object', 'actor_type'])
	]));

	return {
		eventKey: firstNonEmpty([
			deepReadString(payload, ['webhook_event_id']),
			deepReadString(payload, ['hook_log_id'])
		]),
		eventType: code || category || 'upmind.unknown',
		category,
		code,
		client: {
			id: firstNonEmpty([
				deepReadString(payload, ['object', 'client_id']),
				deepReadString(ticketClient, ['id']),
				deepReadString(payload, ['client_id']),
				deepReadString(payload, ['client', 'id']),
				recursiveFindString(payload, ['upmind_client_id', 'clientId', 'client_id'])
			]),
			email: firstNonEmpty([
				deepReadString(ticketClient, ['email']),
				deepReadString(ticketClient, ['login_email']),
				deepReadString(ticketClient, ['notification_email']),
				deepReadString(payload, ['object', 'client', 'email']),
				deepReadString(payload, ['client', 'email']),
				deepReadString(payload, ['email']),
				recursiveFindString(payload, ['email', 'login_email', 'notification_email'])
			]),
			firstName,
			lastName,
			fullName
		},
		ticket: {
			id: firstNonEmpty([
				deepReadString(payload, ['object', 'ticket_id']),
				deepReadString(payload, ['object', 'ticket', 'id']),
				deepReadString(payload, ['ticket_id']),
				deepReadString(payload, ['ticket', 'id'])
			]),
			reference: firstNonEmpty([
				deepReadString(payload, ['object', 'ticket', 'reference']),
				deepReadString(payload, ['ticket', 'reference'])
			]),
			subject: firstNonEmpty([
				deepReadString(payload, ['object', 'ticket', 'subject']),
				deepReadString(payload, ['ticket', 'subject']),
				deepReadString(payload, ['subject'])
			]),
			status: firstNonEmpty([
				deepReadString(payload, ['object', 'ticket', 'status']),
				deepReadString(payload, ['object', 'ticket', 'status_id']),
				deepReadString(payload, ['status'])
			]),
			departmentId: firstNonEmpty([
				deepReadString(payload, ['object', 'ticket', 'ticket_department_id']),
				deepReadString(payload, ['object', 'ticket', 'department', 'id'])
			]),
			priorityId: deepReadString(payload, ['object', 'ticket', 'priority_id'])
		},
		message: messageId || body ? {
			id: messageId,
			body,
			isPrivate: readBoolean(isRecord(object) ? object.is_private : undefined) ?? false,
			createdAt: firstNonEmpty([
				deepReadString(payload, ['object', 'created_at']),
				deepReadString(payload, ['created_at'])
			]),
			actorType
		} : undefined,
		raw: payload
	};
}

function normalizeActorType(value?: string): 'client' | 'staff' | 'lead' | 'system' | 'unknown' {
	const normalized = (value || '').toLowerCase();
	if (normalized === 'client') return 'client';
	if (['user', 'staff', 'agent'].includes(normalized)) return 'staff';
	if (normalized === 'lead') return 'lead';
	if (normalized === 'system') return 'system';
	return 'unknown';
}

