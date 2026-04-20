import type { Env, NormalizedClient } from '../types';
import { zohoRequest, readZohoId } from './client';

export async function findZohoContactIdByEmail(env: Env, email: string): Promise<string | undefined> {
	const response = await zohoRequest(env, 'GET', `/contacts/search?email=${encodeURIComponent(email)}`);
	return readZohoId(response);
}

export async function createZohoContact(env: Env, client: NormalizedClient): Promise<string> {
	if (!client.email) throw new Error('Cannot create Zoho contact without email');
	const response = await zohoRequest(env, 'POST', '/contacts', {
		email: client.email,
		firstName: client.firstName,
		lastName: client.lastName || client.fullName || 'Unknown'
	});
	const id = readZohoId(response);
	if (!id) throw new Error('Zoho contact create response did not include id');
	return id;
}

export async function updateZohoContact(env: Env, zohoContactId: string, client: NormalizedClient): Promise<void> {
	await zohoRequest(env, 'PATCH', `/contacts/${zohoContactId}`, {
		email: client.email,
		firstName: client.firstName,
		lastName: client.lastName || client.fullName
	});
}

