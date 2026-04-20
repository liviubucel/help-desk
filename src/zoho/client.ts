import type { Env, JsonRecord } from '../types';
import { requireZohoConfig } from '../config';
import { logInfo } from '../logger';
import { stripUndefined } from '../utils/json';
import { getZohoAccessToken } from '../zoho-oauth';

export async function zohoRequest(env: Env, method: string, path: string, body?: JsonRecord): Promise<JsonRecord> {
	requireZohoConfig(env);
	const accessToken = await getZohoAccessToken(env);
	const baseUrl = (env.ZDK_BASE_URL || 'https://desk.zoho.com/api/v1').replace(/\/$/, '');
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			authorization: `Zoho-oauthtoken ${accessToken}`,
			'content-type': 'application/json',
			...(env.ZDK_ORG_ID ? { orgId: env.ZDK_ORG_ID } : {}),
			...(env.ZDK_IGNORE_SOURCE_ID ? { sourceId: env.ZDK_IGNORE_SOURCE_ID } : {})
		},
		body: body ? JSON.stringify(stripUndefined(body)) : undefined
	});
	const raw = await response.text();
	let parsed: JsonRecord = {};
	if (raw) {
		try {
			const data = JSON.parse(raw);
			parsed = data && typeof data === 'object' && !Array.isArray(data) ? data : { value: data };
		} catch {
			parsed = { raw };
		}
	}
	logInfo({ source: 'zoho-api', method, path, status: response.status, ok: response.ok });
	if (!response.ok) throw new Error(`Zoho API failed: ${method} ${path} (${response.status})`);
	return parsed;
}

export function readZohoId(response: JsonRecord): string | undefined {
	const direct = response.id;
	if (typeof direct === 'string') return direct;
	const data = response.data;
	if (Array.isArray(data) && data[0] && typeof data[0] === 'object' && typeof (data[0] as JsonRecord).id === 'string') {
		return (data[0] as JsonRecord).id as string;
	}
	if (data && typeof data === 'object' && typeof (data as JsonRecord).id === 'string') return (data as JsonRecord).id as string;
	return undefined;
}

