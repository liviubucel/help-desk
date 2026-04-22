import type { Env, JsonRecord, NormalizedClient } from '../types';
import { deepReadString, firstNonEmpty } from '../utils/json';

export function hasUpmindApiConfig(env: Env): boolean {
	return Boolean(env.UPMIND_API_BASE_URL && env.UPMIND_API_TOKEN);
}

export async function fetchUpmindClientById(env: Env, clientId: string): Promise<JsonRecord | null> {
	if (!hasUpmindApiConfig(env)) return null;
	const baseUrl = env.UPMIND_API_BASE_URL!.replace(/\/$/, '');
	const path = (env.UPMIND_CLIENT_ENDPOINT_TEMPLATE || '/clients/{clientId}')
		.replace('{clientId}', encodeURIComponent(clientId))
		.replace('{id}', encodeURIComponent(clientId));
	const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
	const response = await fetch(url, {
		headers: { authorization: `Bearer ${env.UPMIND_API_TOKEN}` }
	});
	if (!response.ok) return null;
	const data = await response.json();
	return data && typeof data === 'object' && !Array.isArray(data) ? data as JsonRecord : { value: data };
}

export function extractClientFromUpmindApiResponse(payload: JsonRecord): NormalizedClient {
	const firstName = firstNonEmpty([
		deepReadString(payload, ['firstname']),
		deepReadString(payload, ['first_name']),
		deepReadString(payload, ['data', 'firstname']),
		deepReadString(payload, ['data', 'first_name']),
		deepReadString(payload, ['data', 'data', 'firstname']),
		deepReadString(payload, ['data', 'data', 'first_name']),
		deepReadString(payload, ['client', 'firstname']),
		deepReadString(payload, ['client', 'first_name'])
	]);
	const lastName = firstNonEmpty([
		deepReadString(payload, ['lastname']),
		deepReadString(payload, ['last_name']),
		deepReadString(payload, ['data', 'lastname']),
		deepReadString(payload, ['data', 'last_name']),
		deepReadString(payload, ['data', 'data', 'lastname']),
		deepReadString(payload, ['data', 'data', 'last_name']),
		deepReadString(payload, ['client', 'lastname']),
		deepReadString(payload, ['client', 'last_name'])
	]);
	return {
		id: firstNonEmpty([
			deepReadString(payload, ['id']),
			deepReadString(payload, ['data', 'id']),
			deepReadString(payload, ['data', 'data', 'id']),
			deepReadString(payload, ['client', 'id'])
		]),
		email: firstNonEmpty([
			deepReadString(payload, ['email']),
			deepReadString(payload, ['login_email']),
			deepReadString(payload, ['notification_email']),
			deepReadString(payload, ['data', 'email']),
			deepReadString(payload, ['data', 'login_email']),
			deepReadString(payload, ['data', 'data', 'email']),
			deepReadString(payload, ['data', 'data', 'login_email']),
			deepReadString(payload, ['client', 'email']),
			deepReadString(payload, ['client', 'login_email'])
		]),
		firstName,
		lastName,
		fullName: firstNonEmpty([
			deepReadString(payload, ['fullname']),
			deepReadString(payload, ['full_name']),
			deepReadString(payload, ['data', 'fullname']),
			deepReadString(payload, ['data', 'full_name']),
			deepReadString(payload, ['data', 'data', 'fullname']),
			deepReadString(payload, ['data', 'data', 'full_name']),
			[firstName, lastName].filter(Boolean).join(' ') || undefined
		])
	};
}
