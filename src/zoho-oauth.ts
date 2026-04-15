import type { Env } from './types';

const PROVIDER = 'zoho';
const TOKEN_EXPIRY_BUFFER = 5 * 60; // 5 minutes in seconds

export async function getZohoAccessToken(env: Env): Promise<string> {
  // 1. Try to get cached token from D1
  const row = await env.BRIDGE_DB.prepare(
    'SELECT access_token, expires_at FROM oauth_tokens WHERE provider = ?1 LIMIT 1'
  ).bind(PROVIDER).first<{ access_token: string; expires_at: number }>();

  const now = Math.floor(Date.now() / 1000);
  if (row && row.access_token && row.expires_at > now + TOKEN_EXPIRY_BUFFER) {
    return row.access_token;
  }

  // 2. Refresh token from Zoho
  const clientId = env.ZOHO_CLIENT_ID;
  const clientSecret = env.ZOHO_CLIENT_SECRET;
  const refreshToken = env.ZOHO_REFRESH_TOKEN;
  const accountsUrl = env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Zoho OAuth secrets');
  }

  const url = `${accountsUrl}/oauth/v2/token`;
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    throw new Error('Failed to refresh Zoho access token');
  }

  const data = await resp.json();
  const accessToken = data.access_token;
  const expiresIn = Number(data.expires_in) || 3600;
  if (!accessToken) throw new Error('No access_token in Zoho response');

  const expiresAt = now + expiresIn;
  await env.BRIDGE_DB.prepare(
    `INSERT INTO oauth_tokens (provider, access_token, expires_at, updated_at)
     VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
     ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP`
  ).bind(PROVIDER, accessToken, expiresAt).run();

  return accessToken;
}
