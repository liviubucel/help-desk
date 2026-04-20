import type { Env } from '../types';
import { audit } from '../db';

export interface WriteResult {
	ok: boolean;
	status: 'sent' | 'disabled' | 'failed';
	message?: string;
}

export interface CreateReplyInput {
	upmindTicketId: string;
	body: string;
	zohoMessageId?: string;
}

export interface UpdateStatusInput {
	upmindTicketId: string;
	status: string;
	zohoTicketId?: string;
}

export interface UpmindTicketWriteAdapter {
	enabled(): boolean;
	createReply(input: CreateReplyInput): Promise<WriteResult>;
	updateStatus(input: UpdateStatusInput): Promise<WriteResult>;
	addInternalNote?(input: CreateReplyInput): Promise<WriteResult>;
}

export function createUpmindWriteAdapter(env: Env): UpmindTicketWriteAdapter {
	const enabled = env.UPMIND_TICKET_WRITE_ENABLED === 'true' && Boolean(env.UPMIND_TICKET_WRITE_API_BASE_URL && env.UPMIND_TICKET_WRITE_API_TOKEN);
	return {
		enabled: () => enabled,
		async createReply(input) {
			if (!enabled) return disabled('createReply');
			return postToUpmind(env, `/tickets/${encodeURIComponent(input.upmindTicketId)}/replies`, { body: input.body, external_id: input.zohoMessageId });
		},
		async updateStatus(input) {
			if (!enabled) return disabled('updateStatus');
			return postToUpmind(env, `/tickets/${encodeURIComponent(input.upmindTicketId)}/status`, { status: input.status, external_id: input.zohoTicketId });
		},
		async addInternalNote(input) {
			if (!enabled) return disabled('addInternalNote');
			return postToUpmind(env, `/tickets/${encodeURIComponent(input.upmindTicketId)}/notes`, { body: input.body, external_id: input.zohoMessageId });
		}
	};
}

export async function recordReverseSyncDisabled(env: Env, objectType: string, objectId: string | undefined, action: string): Promise<WriteResult> {
	await audit(env, {
		direction: 'zoho_to_upmind',
		objectType,
		objectId,
		action,
		status: 'disabled',
		message: 'Reverse sync is disabled because writable Upmind ticket API endpoints are not configured.'
	});
	return disabled(action);
}

function disabled(action: string): WriteResult {
	return {
		ok: true,
		status: 'disabled',
		message: `Reverse sync disabled for ${action}`
	};
}

async function postToUpmind(env: Env, path: string, body: unknown): Promise<WriteResult> {
	const baseUrl = env.UPMIND_TICKET_WRITE_API_BASE_URL!.replace(/\/$/, '');
	const response = await fetch(`${baseUrl}${path}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${env.UPMIND_TICKET_WRITE_API_TOKEN}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify(body)
	});
	return {
		ok: response.ok,
		status: response.ok ? 'sent' : 'failed',
		message: response.ok ? undefined : `Upmind write API returned ${response.status}`
	};
}

