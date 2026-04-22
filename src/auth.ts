import { hmacSha256Hex, timingSafeEqual } from './utils/crypto';
import type { Env } from './types';
import { extractClientFromUpmindApiResponse } from './upmind/api';
import { getUpmindLoginHintByIp } from './db';

export interface AuthenticatedClient {
	clientId: string;
	email: string;
	name?: string;
}

export type AuthSource = 'upmind_session_jwt' | 'upmind_access_token' | 'upmind_login_hint' | 'upmind_api' | 'none';

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
	const nowMs = Date.now();
	const notAfterMs = nowMs + getJwtTtlSeconds(env) * 1000;
	const payload = {
		sub: client.clientId,
		email: client.email,
		first_name: splitName(client.name).firstName,
		last_name: splitName(client.name).lastName,
		name: client.name,
		email_verified: true,
		iat: Math.floor(nowMs / 1000),
		nbf: Math.floor(nowMs / 1000),
		exp: Math.floor(notAfterMs / 1000),
		not_before: nowMs,
		not_after: notAfterMs
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

export async function generateZohoAsapSetupValidationJwt(env: Env): Promise<string> {
	const secret = env.ZOHO_ASAP_JWT_SECRET;
	if (!secret) throw new Error('Missing ZOHO_ASAP_JWT_SECRET');
	const nowMs = Date.now();
	return signJwtHS256({
		email: 'asap-setup-validation@zebrabyte.ro',
		email_verified: true,
		first_name: 'ASAP',
		last_name: 'Validation',
		not_before: nowMs,
		not_after: nowMs + 300000
	}, secret);
}

export async function generateZohoHelpCenterJwt(client: AuthenticatedClient, env: Env): Promise<string> {
	const secret = env.ZOHO_HC_JWT_SECRET || env.ZOHO_ASAP_JWT_SECRET;
	if (!secret) throw new Error('Missing ZOHO_HC_JWT_SECRET');
	if (!client.email) throw new Error('Missing client email');
	const nowMs = Date.now();
	const notAfterMs = nowMs + getJwtTtlSeconds(env) * 1000;
	const payload = {
		sub: client.clientId,
		email: client.email,
		first_name: splitName(client.name).firstName,
		last_name: splitName(client.name).lastName,
		name: client.name,
		email_verified: true,
		iat: Math.floor(nowMs / 1000),
		nbf: Math.floor(nowMs / 1000),
		exp: Math.floor(notAfterMs / 1000),
		not_before: nowMs,
		not_after: notAfterMs
	};
	return signJwtHS256(payload, secret);
}

function getJwtTtlSeconds(env: Env): number {
	const configuredMs = Number(env.ZOHO_ASAP_JWT_TTL_MS ?? 300000);
	const configuredSeconds = Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs / 1000 : 300;
	return Math.floor(Math.min(configuredSeconds, 600));
}

function splitName(name?: string): { firstName?: string; lastName?: string } {
  if (!name) return {};
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Resolve the authenticated Upmind client from the Upmind session JWT only.
 */
export async function resolveAuthenticatedUpmindClient(request: Request, env: Env): Promise<AuthenticatedClient | null> {
  const resolution = await resolveAuthenticatedUpmindClientWithSource(request, env);
  return resolution.client ?? null;
}

export async function resolveAuthenticatedUpmindClientWithSource(request: Request, env: Env): Promise<AuthResolution> {
  const upmindJwtClient = await resolveClientFromUpmindJwt(request, env);
  if (upmindJwtClient) return logAuthResolution({ authenticated: true, source: 'upmind_session_jwt', client: upmindJwtClient });

  const accessTokenClient = await resolveClientFromUpmindAccessToken(request, env);
  if (accessTokenClient) return logAuthResolution({ authenticated: true, source: 'upmind_access_token', client: accessTokenClient });

  const loginHintClient = await resolveClientFromUpmindLoginHint(request, env);
  if (loginHintClient) return logAuthResolution({ authenticated: true, source: 'upmind_login_hint', client: loginHintClient });

  return logAuthResolution({ authenticated: false, source: 'none', reason: 'missing or invalid Upmind identity' });
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

function readBearerToken(request: Request, env: Env): string | undefined {
  const configuredHeader = env.UPMIND_SESSION_AUTH_HEADER;
  const urlToken = new URL(request.url).searchParams.get('user_token');
  if (urlToken) return urlToken;
  const headerValue = configuredHeader ? request.headers.get(configuredHeader) : request.headers.get('authorization');
  if (!headerValue) return undefined;
  return headerValue.replace(/^Bearer\s+/i, '').trim();
}

async function resolveClientFromUpmindAccessToken(request: Request, env: Env): Promise<AuthenticatedClient | null> {
  const token = readUpmindAccessToken(request);
  if (!token) return null;

  const baseUrl = (env.UPMIND_API_BASE_URL || 'https://api.upmind.io/api').replace(/\/$/, '');
  const endpoint = env.UPMIND_ME_ENDPOINT || '/clients/me';
  const url = endpoint.startsWith('http://') || endpoint.startsWith('https://')
    ? endpoint
    : `${baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json'
    }
  });
  if (!response.ok) return null;

  const raw = await response.json().catch(() => null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const client = extractClientFromUpmindApiResponse(raw as Record<string, unknown>);
  if (!client.id || !client.email) return null;

  return {
    clientId: client.id,
    email: client.email,
    name: client.fullName || [client.firstName, client.lastName].filter(Boolean).join(' ') || undefined
  };
}

function readUpmindAccessToken(request: Request): string | undefined {
  const auth = request.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();

  const headerToken = request.headers.get('x-upmind-access-token');
  if (headerToken) return headerToken.trim();

  const urlToken = new URL(request.url).searchParams.get('upmind_access_token');
  return urlToken?.trim() || undefined;
}

async function resolveClientFromUpmindLoginHint(request: Request, env: Env): Promise<AuthenticatedClient | null> {
  const ipAddress = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || undefined;
  return getUpmindLoginHintByIp(env, ipAddress);
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
