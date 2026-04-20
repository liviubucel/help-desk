import type { Env, JsonRecord } from '../types';
import { ensureSchema, isDuplicateEvent, markProcessed, recordFailure, storeRawEvent } from '../db';
import { logInfo } from '../logger';
import { readJsonPayload } from '../utils/json';
import { json } from '../utils/http';
import { verifyUpmindWebhookSignature } from '../utils/crypto';
import { eventKey as computeEventKey } from '../sync/dedupe';
import { normalizeUpmindEvent } from './normalize';
import { resolveOrCreateContact } from '../sync/contacts';
import { syncTicketFromUpmind } from '../sync/tickets';
import { syncMessageFromUpmind } from '../sync/messages';

export async function handleUpmindWebhook(request: Request, env: Env): Promise<Response> {
	await ensureSchema(env);
	const rawBody = await request.text();
	if (!(await isValidUpmindSignature(request, env, rawBody))) {
		return json({ ok: false, error: 'Invalid Upmind webhook signature' }, 401);
	}

	let payload: JsonRecord;
	try {
		payload = rawBody.trim() ? JSON.parse(rawBody) : {};
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = { value: payload };
	} catch {
		payload = await readJsonPayload(new Request(request.url, { method: request.method, body: rawBody }));
	}

	const normalized = normalizeUpmindEvent(payload);
	const key = await computeEventKey('upmind', request, payload, normalized.eventKey);

	logInfo({
		source: 'upmind-webhook',
		eventKey: key,
		eventType: normalized.eventType,
		clientId: normalized.client.id,
		email: normalized.client.email,
		ticketId: normalized.ticket?.id,
		messageId: normalized.message?.id
	});

	if (await isDuplicateEvent(env, key)) return json({ ok: true, duplicate: true, eventKey: key });

	await storeRawEvent(env, 'upmind', normalized.eventType, key, payload);

	try {
		if (normalized.message?.id && normalized.ticket?.id) {
			await syncMessageFromUpmind(env, normalized);
		} else if (normalized.ticket?.id) {
			await syncTicketFromUpmind(env, normalized);
		} else {
			await resolveOrCreateContact(env, normalized.client);
		}
		await markProcessed(env, key, 'upmind');
		return json({ ok: true, source: 'upmind', eventKey: key, eventType: normalized.eventType });
	} catch (error) {
		await recordFailure(env, { eventKey: key, originSystem: 'upmind', eventName: normalized.eventType, error, payload });
		return json({ ok: true, accepted: true, pending: true, eventKey: key, error: String(error) }, 202);
	}
}

async function isValidUpmindSignature(request: Request, env: Env, rawBody: string): Promise<boolean> {
	return verifyUpmindWebhookSignature({
		secret: env.UPMIND_WEBHOOK_SECRET || '',
		rawBody,
		signature: request.headers.get(env.UPMIND_WEBHOOK_SIGNATURE_HEADER || 'X-Webhook-Signature') || '',
		allowInsecure: env.ALLOW_INSECURE_WEBHOOKS === 'true'
	});
}

