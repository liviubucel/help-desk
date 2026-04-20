import type { Env } from '../types';
import { audit, ensureSchema, isDuplicateEvent, markProcessed, recordFailure, storeRawEvent } from '../db';
import { logInfo } from '../logger';
import { eventKey as computeEventKey } from '../sync/dedupe';
import { json } from '../utils/http';
import { readJsonPayload, deepReadString, firstNonEmpty } from '../utils/json';
import { createUpmindWriteAdapter, recordReverseSyncDisabled } from '../upmind/write-adapter';

export async function handleZohoWebhook(request: Request, env: Env): Promise<Response> {
	await ensureSchema(env);
	const payload = await readJsonPayload(request);
	const eventName = firstNonEmpty([
		deepReadString(payload, ['event']),
		deepReadString(payload, ['eventName']),
		deepReadString(payload, ['action']),
		deepReadString(payload, ['type'])
	]) || 'zoho.unknown';
	const key = await computeEventKey('zoho', request, payload);

	logInfo({ source: 'zoho-webhook', eventKey: key, eventName });
	if (await isDuplicateEvent(env, key)) return json({ ok: true, duplicate: true, eventKey: key });
	await storeRawEvent(env, 'zoho', eventName, key, payload);

	try {
		const adapter = createUpmindWriteAdapter(env);
		if (!adapter.enabled()) {
			await recordReverseSyncDisabled(env, 'zoho_webhook', key, eventName);
			await markProcessed(env, key, 'zoho');
			return json({ ok: true, accepted: true, reverseSync: 'disabled', eventKey: key });
		}
		await audit(env, {
			direction: 'zoho_to_upmind',
			objectType: 'zoho_webhook',
			objectId: key,
			action: eventName,
			status: 'received',
			message: 'Reverse sync adapter is enabled, but payload-specific mapping must be configured.'
		});
		await markProcessed(env, key, 'zoho');
		return json({ ok: true, accepted: true, reverseSync: 'adapter_enabled_requires_mapping', eventKey: key });
	} catch (error) {
		await recordFailure(env, { eventKey: key, originSystem: 'zoho', eventName, error, payload });
		return json({ ok: true, accepted: true, pending: true, eventKey: key, error: String(error) }, 202);
	}
}
