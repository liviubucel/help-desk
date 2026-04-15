import { hmacSha256Hex, timingSafeEqual } from './utils/crypto';
// Helper to base64url encode a string or buffer
function base64url(input: string | Uint8Array): string {
	let str = typeof input === 'string' ? btoa(input) : btoa(String.fromCharCode(...input));
	return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Helper to sign JWT with HS256 using Web Crypto API
async function signJwtHS256(payload: any, secret: string, header: any = { alg: 'HS256', typ: 'JWT' }): Promise<string> {
	const enc = new TextEncoder();
	const headerB64 = base64url(JSON.stringify(header));
	const payloadB64 = base64url(JSON.stringify(payload));
	const data = `${headerB64}.${payloadB64}`;
	const sigHex = await hmacSha256Hex(secret, data);
	const sigBytes = new Uint8Array(sigHex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
	const sigB64 = base64url(sigBytes);
	return `${data}.${sigB64}`;
}

export async function generateZohoAsapJwt(client: AuthenticatedClient, env: Env): Promise<string> {
	const secret = env.ZOHO_ASAP_JWT_SECRET;
	if (!secret) throw new Error('Missing ZOHO_ASAP_JWT_SECRET');
	if (!client.email) throw new Error('Missing client email');
	// TODO: check login enabled, contact mapping, etc.
	const now = Math.floor(Date.now() / 1000);
	const ttl = Math.min(Number(env.ZOHO_ASAP_JWT_TTL_MS ?? 300000) / 1000, 600); // max 10 min
	const payload = {
		email: client.email,
		email_verified: true,
		not_before: now,
		not_after: now + ttl
	};
	return signJwtHS256(payload, secret);
}

export async function generateZohoHelpCenterJwt(client: AuthenticatedClient, env: Env): Promise<string> {
	const secret = env.ZOHO_HC_JWT_SECRET || env.ZOHO_ASAP_JWT_SECRET;
	if (!secret) throw new Error('Missing ZOHO_HC_JWT_SECRET');
	if (!client.email) throw new Error('Missing client email');
	const now = Math.floor(Date.now() / 1000);
	const ttl = Math.min(Number(env.ZOHO_ASAP_JWT_TTL_MS ?? 300000) / 1000, 600);
	const payload = {
		email: client.email,
		email_verified: true,
		not_before: now,
		not_after: now + ttl
	};
	return signJwtHS256(payload, secret);
}

import type { Env } from './types';

export interface AuthenticatedClient {
	clientId: string;
	email: string;
	name?: string;
}

/**
 * Pluggable resolver for authenticated Upmind client context
 */
export async function resolveAuthenticatedUpmindClient(request: Request, env: Env): Promise<AuthenticatedClient | null> {
  // Strategy A: Signed upstream header mode (reverse proxy injects headers)
  const clientId = request.headers.get('X-Upmind-Client-Id');
  const email = request.headers.get('X-Upmind-Client-Email');
  const name = request.headers.get('X-Upmind-Client-Name');
  const signature = request.headers.get('X-Upmind-Auth-Signature');
  const sharedSecret = env.UPMIND_CONTEXT_SHARED_SECRET;
  if (clientId && email && signature && sharedSecret) {
    // Canonical string: `${clientId}:${email}:${name ?? ''}`
    const canonical = `${clientId}:${email}:${name ?? ''}`;
    const expected = await hmacSha256Hex(sharedSecret, canonical);
    const sigBuf = new Uint8Array(signature.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) ?? []);
    const expBuf = new Uint8Array(expected.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) ?? []);
    if (sigBuf.length && expBuf.length && timingSafeEqual(sigBuf, expBuf)) {
      return { clientId, email, name: name || undefined };
    }
    return null;
  }

  // Strategy B: Dev mode query param (explicit dev fallback)
  if (env.ALLOW_DEV_AUTH_CONTEXT === 'true') {
    const url = new URL(request.url);
    const devClientId = url.searchParams.get('client_id');
    const devEmail = url.searchParams.get('email');
    const devName = url.searchParams.get('name');
    if (devClientId && devEmail) {
      return { clientId: devClientId, email: devEmail, name: devName || undefined };
    }
  }

  // Strategy C: Stub fallback
  return null;
}
