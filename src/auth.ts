import { hmacSha256Hex, timingSafeEqual } from './utils/crypto';
import type { Env } from './types';

export interface AuthenticatedClient {
	clientId: string;
	email: string;
	name?: string;
}

export type AuthSource = 'signed_headers' | 'upmind_session_jwt' | 'worker_session' | 'dev_mode' | 'none';

export interface AuthResolution {
	authenticated: boolean;
	source: AuthSource;
	client?: AuthenticatedClient;
	reason?: string;
}

// Helper to base64url encode a string or buffer
function base64url(input: string | Uint8Array): string {
	let str = typeof input === 'string' ? btoa(input) : btoa(String.fromCharCode(...input));
	return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
	const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
	return atob(padded);
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
	const now = Math.floor(Date.now() / 1000);
	const ttl = getJwtTtlSeconds(env);
	const payload = {
		sub: client.clientId,
		email: client.email,
		name: client.name,
		email_verified: true,
		iat: now,
		nbf: now,
		exp: now + ttl,
		not_before: now,
		not_after: now + ttl
	};
	return signJwtHS256(payload, secret);
}

export async function generateZohoAsapRejectedJwt(env: Env): Promise<string> {
	const secret = env.ZOHO_ASAP_JWT_SECRET;
	if (!secret) throw new Error('Missing ZOHO_ASAP_JWT_SECRET');
	const nowMs = Date.now();
	return signJwtHS256({
		email: 'invalid@zebrabyte.invalid',
		email_verified: false,
		not_before: nowMs,
		not_after: nowMs + 300000
	}, secret);
}

export async function generateZohoHelpCenterJwt(client: AuthenticatedClient, env: Env): Promise<string> {
	const secret = env.ZOHO_HC_JWT_SECRET || env.ZOHO_ASAP_JWT_SECRET;
	if (!secret) throw new Error('Missing ZOHO_HC_JWT_SECRET');
	if (!client.email) throw new Error('Missing client email');
	const now = Math.floor(Date.now() / 1000);
	const ttl = getJwtTtlSeconds(env);
	const payload = {
		sub: client.clientId,
		email: client.email,
		name: client.name,
		email_verified: true,
		iat: now,
		nbf: now,
		exp: now + ttl,
		not_before: now,
		not_after: now + ttl
	};
	return signJwtHS256(payload, secret);
}

export async function resolveClientFromUserToken(userToken: string, env: Env): Promise<AuthenticatedClient | null> {
  const secret = env.WORKER_SESSION_JWT_SECRET || env.UPMIND_CONTEXT_SHARED_SECRET;
  if (!secret || !userToken) return null;

  const payload = await verifyJwtHS256(userToken, secret);
  if (!payload) return null;

  const clientId = readClaim(payload, ['clientId', 'client_id', 'sub']);
  const email = readClaim(payload, ['email', 'clientEmail', 'client_email']);
  const name = readClaim(payload, ['name', 'clientName', 'client_name']);
  if (!clientId || !email) return null;

  return { clientId, email, name };
}

export async function createWorkerSessionCookie(client: AuthenticatedClient, env: Env): Promise<string> {
  const secret = env.WORKER_SESSION_JWT_SECRET || env.UPMIND_CONTEXT_SHARED_SECRET;
  if (!secret) throw new Error('Missing WORKER_SESSION_JWT_SECRET');
  const now = Math.floor(Date.now() / 1000);
  const ttl = getWorkerSessionTtlSeconds(env);
  const token = await signJwtHS256({
    iss: 'zebrabyte-help-desk-worker',
    aud: 'zoho-support-sso',
    sub: client.clientId,
    clientId: client.clientId,
    email: client.email,
    name: client.name,
    iat: now,
    nbf: now,
    exp: now + ttl
  }, secret);

  const cookieName = env.WORKER_SESSION_COOKIE_NAME || 'ZBT_SUPPORT_SESSION';
  return `${cookieName}=${encodeURIComponent(token)}; Max-Age=${ttl}; Path=/; HttpOnly; Secure; SameSite=None`;
}

export function clearWorkerSessionCookie(env: Env): string {
  const cookieName = env.WORKER_SESSION_COOKIE_NAME || 'ZBT_SUPPORT_SESSION';
  return `${cookieName}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None`;
}

export async function resolveSignedLaunchQuery(request: Request, env: Env): Promise<AuthenticatedClient | null> {
  const sharedSecret = env.UPMIND_CONTEXT_SHARED_SECRET;
  if (!sharedSecret) return null;

  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  const email = url.searchParams.get('email');
  const name = url.searchParams.get('name') ?? '';
  const signature = url.searchParams.get('sig');
  if (!clientId || !email || !signature) return null;

  const canonical = `${clientId}:${email}:${name}`;
  if (!(await verifyHexHmac(sharedSecret, canonical, signature))) return null;

  return { clientId, email, name: name || undefined };
}

function getJwtTtlSeconds(env: Env): number {
	const configuredMs = Number(env.ZOHO_ASAP_JWT_TTL_MS ?? 300000);
	const configuredSeconds = Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs / 1000 : 300;
	return Math.floor(Math.min(configuredSeconds, 600));
}

function getWorkerSessionTtlSeconds(env: Env): number {
  const configured = Number(env.WORKER_SESSION_TTL_SECONDS ?? 3600);
  if (!Number.isFinite(configured) || configured <= 0) return 3600;
  return Math.floor(Math.min(configured, 86400));
}

/**
 * Pluggable resolver for authenticated Upmind client context
 */
export async function resolveAuthenticatedUpmindClient(request: Request, env: Env): Promise<AuthenticatedClient | null> {
  const resolution = await resolveAuthenticatedUpmindClientWithSource(request, env);
  return resolution.client ?? null;
}

export async function resolveAuthenticatedUpmindClientWithSource(request: Request, env: Env): Promise<AuthResolution> {
  const headerClient = await resolveClientFromSignedHeaders(request, env);
  if (headerClient) return logAuthResolution({ authenticated: true, source: 'signed_headers', client: headerClient });

  const upmindJwtClient = await resolveClientFromUpmindJwt(request, env);
  if (upmindJwtClient) return logAuthResolution({ authenticated: true, source: 'upmind_session_jwt', client: upmindJwtClient });

  const workerSessionClient = await resolveClientFromWorkerSession(request, env);
  if (workerSessionClient) return logAuthResolution({ authenticated: true, source: 'worker_session', client: workerSessionClient });

  const devClient = resolveClientFromDevMode(request, env);
  if (devClient) return logAuthResolution({ authenticated: true, source: 'dev_mode', client: devClient });

  return logAuthResolution({ authenticated: false, source: 'none', reason: 'no valid identity source found' });
}

async function resolveClientFromSignedHeaders(request: Request, env: Env): Promise<AuthenticatedClient | null> {
  const clientId = request.headers.get('X-Upmind-Client-Id');
  const email = request.headers.get('X-Upmind-Client-Email');
  const name = request.headers.get('X-Upmind-Client-Name');
  const signature = request.headers.get('X-Upmind-Auth-Signature');
  const sharedSecret = env.UPMIND_CONTEXT_SHARED_SECRET;
  if (clientId && email && signature && sharedSecret) {
    // Canonical string: `${clientId}:${email}:${name ?? ''}`
    const canonical = `${clientId}:${email}:${name ?? ''}`;
    if (await verifyHexHmac(sharedSecret, canonical, signature)) {
      return { clientId, email, name: name || undefined };
    }
    return null;
  }

  return null;
}

function resolveClientFromDevMode(request: Request, env: Env): AuthenticatedClient | null {
  if (env.ALLOW_DEV_AUTH_CONTEXT === 'true') {
    const url = new URL(request.url);
    const devClientId = url.searchParams.get('client_id');
    const devEmail = url.searchParams.get('email');
    const devName = url.searchParams.get('name');
    if (devClientId && devEmail) {
      return { clientId: devClientId, email: devEmail, name: devName || undefined };
    }
  }

  return null;
}

async function resolveClientFromUpmindJwt(request: Request, env: Env): Promise<AuthenticatedClient | null> {
  const secret = env.UPMIND_SESSION_JWT_SECRET;
  if (!secret) return null;

  const token = readBearerToken(request, env) ?? readCookieToken(request, env.UPMIND_SESSION_COOKIE_NAME || 'upmind_session');
  if (!token) return null;

  const payload = await verifyJwtHS256(token, secret);
  if (!payload) return null;

  const clientId = readClaim(payload, ['clientId', 'client_id', 'upmindClientId', 'upmind_client_id', 'sub']);
  const email = readClaim(payload, ['email', 'clientEmail', 'client_email']);
  const name = readClaim(payload, ['name', 'clientName', 'client_name']);
  if (!clientId || !email) return null;

  return { clientId, email, name };
}

async function resolveClientFromWorkerSession(request: Request, env: Env): Promise<AuthenticatedClient | null> {
  const secret = env.WORKER_SESSION_JWT_SECRET || env.UPMIND_CONTEXT_SHARED_SECRET;
  if (!secret) return null;

  const token = readCookieToken(request, env.WORKER_SESSION_COOKIE_NAME || 'ZBT_SUPPORT_SESSION');
  if (!token) return null;

  const payload = await verifyJwtHS256(token, secret);
  if (!payload) return null;

  const clientId = readClaim(payload, ['clientId', 'client_id', 'sub']);
  const email = readClaim(payload, ['email', 'clientEmail', 'client_email']);
  const name = readClaim(payload, ['name', 'clientName', 'client_name']);
  if (!clientId || !email) return null;

  return { clientId, email, name };
}

function readBearerToken(request: Request, env: Env): string | undefined {
  const configuredHeader = env.UPMIND_SESSION_AUTH_HEADER;
  const headerValue = configuredHeader ? request.headers.get(configuredHeader) : request.headers.get('authorization');
  if (!headerValue) return undefined;
  return headerValue.replace(/^Bearer\s+/i, '').trim();
}

function readCookieToken(request: Request, cookieName: string): string | undefined {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name === cookieName) return decodeURIComponent(valueParts.join('='));
  }

  return undefined;
}

async function verifyHexHmac(secret: string, canonical: string, signature: string): Promise<boolean> {
  const expected = await hmacSha256Hex(secret, canonical);
  const normalizedSig = signature.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedSig)) return false;
  const sigBuf = new Uint8Array(normalizedSig.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) ?? []);
  const expBuf = new Uint8Array(expected.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) ?? []);
  return sigBuf.length > 0 && expBuf.length > 0 && timingSafeEqual(sigBuf, expBuf);
}

function logAuthResolution(resolution: AuthResolution): AuthResolution {
  console.log(JSON.stringify({
    source: 'auth',
    authenticated: resolution.authenticated,
    authSource: resolution.source,
    clientId: resolution.client?.clientId,
    email: resolution.client?.email,
    reason: resolution.reason
  }));
  return resolution;
}

async function verifyJwtHS256(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;

  try {
    header = JSON.parse(base64urlDecode(headerB64));
    payload = JSON.parse(base64urlDecode(payloadB64));
  } catch {
    return null;
  }

  if (header.alg !== 'HS256') return null;

  const sigHex = await hmacSha256Hex(secret, `${headerB64}.${payloadB64}`);
  const sigBytes = new Uint8Array(sigHex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
  const expectedSignature = base64url(sigBytes);
  if (!timingSafeEqual(
    new TextEncoder().encode(signatureB64),
    new TextEncoder().encode(expectedSignature)
  )) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now) return null;
  if (typeof payload.not_after === 'number' && payload.not_after <= now) return null;
  if (typeof payload.not_before === 'number' && payload.not_before > now) return null;

  return payload;
}

function readClaim(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}
