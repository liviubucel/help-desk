import type { Env, JsonRecord, NormalizedMessage, NormalizedTicket } from '../types';
import { zohoRequest, readZohoId } from './client';

export async function createZohoTicket(env: Env, input: { ticket: NormalizedTicket; contactId?: string; email?: string; description?: string; status?: string }): Promise<string> {
	const response = await zohoRequest(env, 'POST', '/tickets', {
		departmentId: env.ZDK_DEPARTMENT_ID,
		contactId: input.contactId,
		email: input.email,
		subject: input.ticket.subject || `Upmind ticket ${input.ticket.reference || input.ticket.id || ''}`.trim(),
		description: input.description || `Imported from Upmind${input.ticket.reference ? ` (${input.ticket.reference})` : ''}`,
		status: input.status || 'Open'
	});
	const id = readZohoId(response);
	if (!id) throw new Error('Zoho ticket create response did not include id');
	return id;
}

export async function updateZohoTicket(env: Env, zohoTicketId: string, patch: JsonRecord): Promise<void> {
	await zohoRequest(env, 'PATCH', `/tickets/${zohoTicketId}`, patch);
}

export async function addZohoTicketComment(env: Env, zohoTicketId: string, message: NormalizedMessage): Promise<string | undefined> {
	if (!message.body) return undefined;
	const response = await zohoRequest(env, 'POST', `/tickets/${zohoTicketId}/comments`, {
		content: message.body,
		isPublic: !message.isPrivate
	});
	return readZohoId(response);
}

