// Crypto helpers: HMAC, timingSafeEqual, etc.

/**
 * Timing-safe buffer comparison
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a[i] ^ b[i];
	}
	return result === 0;
}

/**
 * HMAC SHA256 hex digest using Web Crypto API
 */
export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
	return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies Upmind webhook signature
 */
export async function verifyUpmindWebhookSignature({
	secret,
	rawBody,
	signature,
	allowInsecure,
	expectedHeader = 'X-Webhook-Signature',
}: {
	secret: string;
	rawBody: string;
	signature: string;
	allowInsecure?: boolean;
	expectedHeader?: string;
}): Promise<boolean> {
	if (allowInsecure) return true;
	if (!secret || !signature) return false;
	const expected = await hmacSha256Hex(secret, rawBody);

	const candidates = [
		signature,
		signature.replace(/^sha256=/i, ''),
		signature.replace(/^hmac-sha256=/i, '')
	].filter(Boolean);

	try {
		return candidates.some((candidate) => timingSafeEqual(
			new TextEncoder().encode(candidate.toLowerCase()),
			new TextEncoder().encode(expected)
		));
	} catch {
		return false;
	}
}
