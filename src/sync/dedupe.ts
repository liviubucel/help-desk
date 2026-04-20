import { hmacSha256Hex } from '../utils/crypto';

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function eventKey(origin: string, request: Request, payload: unknown, preferredId?: string): Promise<string> {
	const headerId = request.headers.get('x-upmind-delivery-id') || request.headers.get('x-webhook-id') || request.headers.get('x-request-id');
	if (headerId) return `${origin}:${headerId}`;
	if (preferredId) return `${origin}:${preferredId}`;
	return `${origin}:${await sha256Hex(`${origin}:${JSON.stringify(payload)}`)}`;
}

export async function messageChecksum(ticketId: string, body: string, direction: string): Promise<string> {
	return hmacSha256Hex('message-checksum-v1', `${direction}:${ticketId}:${body}`);
}

