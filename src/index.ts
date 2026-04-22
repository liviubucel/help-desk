import type { ScheduledEvent, ExecutionContext } from './cloudflare-workers';
import type { Env, JsonRecord, NormalizedClient } from './types';
import { configStatus } from './config';
import { ensureSchema } from './db';
import { handleCronSync, retryFailedEvents } from './cron';
import { generateZohoAsapJwt, generateZohoHelpCenterJwt, resolveAuthenticatedUpmindClient } from './auth';
import { fetchUpmindClientById, extractClientFromUpmindApiResponse, hasUpmindApiConfig } from './upmind/api';
import { handleUpmindWebhook } from './upmind/webhooks';
import { handleZohoWebhook } from './zoho/webhooks';
import { resolveOrCreateContact } from './sync/contacts';
import { html, isAdmin, isAllowedOrigin, javascript, json, options, text, withCors } from './utils/http';
import { firstNonEmpty, readJsonPayload, readString } from './utils/json';

export async function scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
	try {
		await runMaintenanceSync(env);
	} catch (error) {
		console.error(JSON.stringify({ source: 'scheduled', ok: false, error: String(error) }));
	}
}

export default {
	scheduled,

	async fetch(request: Request, env: Env): Promise<Response> {
		await ensureSchema(env);
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') return options(request, env);

		if (request.method === 'GET' && url.pathname === '/health') {
			return json({ ok: true, service: 'help-desk-bridge', time: new Date().toISOString(), config: configStatus(env) });
		}

		if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/webhooks/upmind') {
			return json({ ok: true, webhook: 'upmind', validation: true, config: configStatus(env) });
		}

		if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/webhooks/zoho') {
			return json({ ok: true, webhook: 'zoho', validation: true, reverseSyncConfigured: configStatus(env).reverseSyncConfigured });
		}

		if (request.method === 'POST' && url.pathname === '/webhooks/upmind') return handleUpmindWebhook(request, env);
		if (request.method === 'POST' && url.pathname === '/webhooks/zoho') return handleZohoWebhook(request, env);

		if (request.method === 'GET' && url.pathname === '/asap-bootstrap.js') return javascript(buildAsapBootstrap(env));
		if (request.method === 'GET' && url.pathname === '/support') return html(SUPPORT_PAGE_HTML);

		if ((request.method === 'GET' || request.method === 'POST') && (url.pathname === '/auth/upmind-client-context' || url.pathname === '/auth/upmind-api-client-context')) {
			return withCors(request, env, await handleUpmindClientContext(request, env));
		}

		if ((request.method === 'GET' || request.method === 'POST') && (url.pathname === '/auth/asap-jwt' || url.pathname === '/auth/asap-jwt-legacy')) {
			return withCors(request, env, await handleAsapJwt(request, env, url.pathname.endsWith('-legacy')));
		}

		if (request.method === 'GET' && url.pathname === '/auth/helpcenter-jwt') {
			return withCors(request, env, await handleHelpCenterJwt(request, env));
		}

		if (request.method === 'GET' && url.pathname === '/auth/helpcenter-launch') {
			return withCors(request, env, await handleHelpCenterLaunch(request, env));
		}

		if (request.method === 'GET' && url.pathname === '/auth/helpcenter-jwt-redirect') {
			return withCors(request, env, await handleHelpCenterRedirect(request, env));
		}

		if (request.method === 'GET' && url.pathname === '/auth/helpcenter-login') {
			return withCors(request, env, await handleHelpCenterLogin(request, env));
		}

		if (request.method === 'GET' && url.pathname === '/auth/logout') {
			const returnTo = sanitizeLocalRedirect(url.searchParams.get('return_to') || '/support');
			return Response.redirect(returnTo, 302);
		}

		if (request.method === 'POST' && url.pathname === '/cron/sync') {
			if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
			return json(await runMaintenanceSync(env));
		}

		if (request.method === 'GET' && url.pathname === '/admin/health') {
			if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
			return json({ ok: true, time: new Date().toISOString(), config: configStatus(env) });
		}

		if (request.method === 'GET' && url.pathname === '/admin/db-status') {
			if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
			return json({ ok: true, counts: await tableCounts(env) });
		}

		if (request.method === 'GET' && url.pathname === '/admin/failures') {
			if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
			const rows = await env.BRIDGE_DB.prepare('SELECT id, event_key, origin_system, event_name, error_message, retry_count, created_at, updated_at FROM event_failures ORDER BY created_at DESC LIMIT 100').all();
			return json({ ok: true, failures: rows.results || [] });
		}

		if (request.method === 'GET' && url.pathname.startsWith('/debug/raw-event/')) {
			if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
			const eventKey = decodeURIComponent(url.pathname.replace('/debug/raw-event/', ''));
			const row = await env.BRIDGE_DB.prepare('SELECT * FROM raw_events WHERE event_key = ?1 LIMIT 1').bind(eventKey).first();
			return json({ ok: true, eventKey, row });
		}

		if (request.method === 'POST' && url.pathname.startsWith('/backfill/reprocess/')) {
			if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
			return reprocessRawEvent(env, decodeURIComponent(url.pathname.replace('/backfill/reprocess/', '')));
		}

		return json({ ok: false, error: 'Not found' }, 404);
	}
};

async function handleUpmindClientContext(request: Request, env: Env): Promise<Response> {
	try {
		const client = request.method === 'POST'
			? await resolveClientFromUpmindApiHandoff(request, env)
			: await resolveAuthenticatedUpmindClient(request, env);
		if (!client) return json({ authenticated: false, reason: 'No valid Upmind identity' }, 401);
		await tryResolveOrCreateContact(env, toNormalizedClient(client));
		return json({ authenticated: true, clientId: client.clientId, email: client.email, name: client.name });
	} catch (error) {
		return json({ authenticated: false, error: String(error) }, 401);
	}
}

async function handleAsapJwt(request: Request, env: Env, legacy: boolean): Promise<Response> {
	try {
		const client = request.method === 'POST'
			? await resolveClientFromUpmindApiHandoff(request, env)
			: await resolveAuthenticatedUpmindClient(request, env);
		if (!client) return json({ ok: false, error: 'Not authenticated' }, 401);
		await tryResolveOrCreateContact(env, toNormalizedClient(client));
		const token = await generateZohoAsapJwt(client, env);
		const url = new URL(request.url);
		if (legacy || url.searchParams.get('format') === 'plain' || url.searchParams.has('user_token')) return text(token);
		return json({ token });
	} catch (error) {
		return json({ ok: false, error: String(error) }, 400);
	}
}

async function handleHelpCenterJwt(request: Request, env: Env): Promise<Response> {
	const client = await resolveAuthenticatedUpmindClient(request, env);
	if (!client) return json({ ok: false, error: 'Not authenticated' }, 401);
	await tryResolveOrCreateContact(env, toNormalizedClient(client));
	return json({ token: await generateZohoHelpCenterJwt(client, env) });
}

async function handleHelpCenterLaunch(request: Request, env: Env): Promise<Response> {
	const client = await resolveAuthenticatedUpmindClient(request, env);
	if (!client) return json({ ok: false, error: 'Not authenticated' }, 401);
	await tryResolveOrCreateContact(env, toNormalizedClient(client));
	const token = await generateZohoHelpCenterJwt(client, env);
	const returnTo = new URL(request.url).searchParams.get('return_to') || '';
	const launchUrl = env.ZOHO_HC_JWT_TERMINAL_URL ? buildZohoJwtTerminalUrl(env.ZOHO_HC_JWT_TERMINAL_URL, token, returnTo) : undefined;
	return json({ token, launchUrl, email: client.email });
}

async function handleHelpCenterRedirect(request: Request, env: Env): Promise<Response> {
	const client = await resolveAuthenticatedUpmindClient(request, env);
	if (!client) return json({ ok: false, error: 'Not authenticated' }, 401);
	if (!env.ZOHO_HC_JWT_TERMINAL_URL) return json({ ok: false, error: 'Missing ZOHO_HC_JWT_TERMINAL_URL' }, 400);
	await tryResolveOrCreateContact(env, toNormalizedClient(client));
	const token = await generateZohoHelpCenterJwt(client, env);
	const returnTo = new URL(request.url).searchParams.get('return_to') || '/';
	return Response.redirect(buildZohoJwtTerminalUrl(env.ZOHO_HC_JWT_TERMINAL_URL, token, returnTo), 302);
}

async function handleHelpCenterLogin(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const returnTo = url.searchParams.get('return_to') || '';
	const client = await resolveAuthenticatedUpmindClient(request, env);
	if (client) {
		if (!env.ZOHO_HC_JWT_TERMINAL_URL) return json({ ok: false, error: 'Missing ZOHO_HC_JWT_TERMINAL_URL' }, 400);
		await tryResolveOrCreateContact(env, toNormalizedClient(client));
		const token = await generateZohoHelpCenterJwt(client, env);
		return Response.redirect(buildZohoJwtTerminalUrl(env.ZOHO_HC_JWT_TERMINAL_URL, token, returnTo), 302);
	}

	const callback = new URL(request.url);
	callback.pathname = '/auth/helpcenter-login';
	callback.search = '';
	if (returnTo) callback.searchParams.set('return_to', returnTo);

	const loginUrl = new URL(env.UPMIND_LOGIN_URL || 'https://portal.zebrabyte.ro/login');
	loginUrl.searchParams.set('return_to', callback.toString());
	return Response.redirect(loginUrl.toString(), 302);
}

async function resolveClientFromUpmindApiHandoff(request: Request, env: Env): Promise<{ clientId: string; email: string; name?: string }> {
	const origin = request.headers.get('origin');
	if (origin && !isAllowedOrigin(origin, env)) throw new Error('Origin not allowed');
	if (!hasUpmindApiConfig(env)) throw new Error('Missing Upmind API config');

	const payload = await readJsonPayload(request);
	const clientId = firstNonEmpty([
		readString(payload.clientId),
		readString(payload.client_id),
		readString(payload.upmindClientId),
		readString(payload.upmind_client_id),
		readString(payload.uid)
	]);
	const email = firstNonEmpty([
		readString(payload.email),
		readString(payload.clientEmail),
		readString(payload.client_email)
	]);
	const issued = Number(payload.issued || payload.timestamp || 0);

	if (!clientId || !email) throw new Error('Missing Upmind client id or email');
	if (issued && Math.abs(Date.now() - issued) > 10 * 60 * 1000) throw new Error('Stale Upmind client handoff');

	const apiPayload = await fetchUpmindClientById(env, clientId);
	if (!apiPayload) throw new Error('Upmind client not found');
	const apiClient = extractClientFromUpmindApiResponse(apiPayload);
	if (!apiClient.email || apiClient.email.toLowerCase() !== email.toLowerCase()) throw new Error('Upmind email mismatch');

	return {
		clientId,
		email: apiClient.email,
		name: apiClient.fullName || [apiClient.firstName, apiClient.lastName].filter(Boolean).join(' ') || readString(payload.name)
	};
}

function toNormalizedClient(client: { clientId: string; email: string; name?: string }): NormalizedClient {
	const parts = (client.name || '').trim().split(/\s+/).filter(Boolean);
	return {
		id: client.clientId,
		email: client.email,
		firstName: parts[0],
		lastName: parts.length > 1 ? parts.slice(1).join(' ') : undefined,
		fullName: client.name
	};
}

async function tryResolveOrCreateContact(env: Env, client: NormalizedClient): Promise<void> {
	try {
		await resolveOrCreateContact(env, client);
	} catch (error) {
		console.log(JSON.stringify({
			source: 'auth-contact-sync',
			ok: false,
			clientId: client.id,
			email: client.email,
			error: String(error)
		}));
	}
}

async function runMaintenanceSync(env: Env): Promise<JsonRecord> {
	await ensureSchema(env);
	const cron = await handleCronSync(env);
	const retry = await retryFailedEvents(env);
	return { ...cron, ...retry };
}

async function tableCounts(env: Env): Promise<Record<string, number>> {
	const tables = ['contact_map', 'ticket_map', 'message_map', 'processed_events', 'raw_events', 'oauth_tokens', 'event_failures', 'sync_audit'];
	const counts: Record<string, number> = {};
	for (const table of tables) {
		try {
			const row = await env.BRIDGE_DB.prepare(`SELECT COUNT(*) as n FROM ${table}`).first<{ n: number }>();
			counts[table] = row?.n ?? 0;
		} catch {
			counts[table] = -1;
		}
	}
	return counts;
}

async function reprocessRawEvent(env: Env, eventKey: string): Promise<Response> {
	const row = await env.BRIDGE_DB.prepare('SELECT origin_system, payload_json FROM raw_events WHERE event_key = ?1 LIMIT 1').bind(eventKey).first<{ origin_system: string; payload_json: string }>();
	if (!row) return json({ ok: false, error: 'Event not found' }, 404);
	if (row.origin_system !== 'upmind') return json({ ok: false, error: 'Only Upmind raw events can currently be reprocessed' }, 400);
	const response = await handleUpmindWebhook(new Request('https://internal/reprocess', { method: 'POST', body: row.payload_json, headers: { 'X-Webhook-Signature': 'internal' } }), { ...env, ALLOW_INSECURE_WEBHOOKS: 'true' });
	return response;
}

function sanitizeLocalRedirect(value: string): string {
	if (!value || !value.startsWith('/') || value.startsWith('//')) return '/support';
	return value;
}

function buildZohoJwtTerminalUrl(terminalUrl: string, jwt: string, returnTo: string): string {
	const url = new URL(terminalUrl);
	url.searchParams.set('jwt', jwt);
	url.searchParams.set('return_to', returnTo);
	return url.toString();
}

const SUPPORT_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Support</title>
</head>
<body>
  <main>
    <h1>Support</h1>
    <p>Loading your support session...</p>
  </main>
  <script src="/asap-bootstrap.js"></script>
</body>
</html>`;

function buildAsapBootstrap(env: Env): string {
	const zohoAsapScriptUrl = JSON.stringify(env.ZOHO_ASAP_SCRIPT_URL || '');
	const allowedHosts = JSON.stringify(splitEnvList(env.ZOHO_ASAP_ALLOWED_HOSTS));
	const blockedHosts = JSON.stringify(splitEnvList(env.ZOHO_ASAP_BLOCKED_HOSTS));
	const allowedPaths = JSON.stringify(splitEnvList(env.ZOHO_ASAP_ALLOWED_PATHS));
	const blockedPaths = JSON.stringify(splitEnvList(env.ZOHO_ASAP_BLOCKED_PATHS));
	return `(() => {
  const script = document.currentScript;
  const bridgeOrigin = script && script.src ? new URL(script.src).origin : window.location.origin;
  const scriptContext = script && script.dataset ? script.dataset : {};
  const windowContext = window.ZBT_SUPPORT_CONTEXT || {};
  const zohoAsapScriptUrl = ${zohoAsapScriptUrl};
  const allowedHosts = ${allowedHosts};
  const blockedHosts = ${blockedHosts};
  const allowedPaths = ${allowedPaths};
  const blockedPaths = ${blockedPaths};
  if (!zohoAsapScriptUrl || !isWidgetAllowed()) return;
  const upmindJwt = scriptContext.upmindJwt || windowContext.upmindJwt || windowContext.user_token || windowContext.userToken;
  const tokenKeys = window.ZBT_UPMIND_TOKEN_KEYS || [
    'access_token',
    'upmind_access_token',
    'upmind.auth.token',
    'auth._token.local',
    'auth.token'
  ];
  const upmindClient = {
    clientId: scriptContext.clientId || windowContext.clientId || windowContext.client_id || windowContext.uid,
    email: scriptContext.email || windowContext.email,
    name: scriptContext.name || windowContext.name,
    issued: Number(scriptContext.issued || windowContext.issued || Date.now())
  };
  const authQuery = upmindJwt ? '?user_token=' + encodeURIComponent(upmindJwt) : '';
  const upmindAccessToken = readTokenFromStorage();
  const authHeaders = upmindAccessToken ? { authorization: 'Bearer ' + upmindAccessToken } : {};
  const fetchJson = (path) => fetch(bridgeOrigin + path, { credentials: 'include', headers: authHeaders }).then((response) => response.json());
  const postJson = (path, body) => fetch(bridgeOrigin + path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then((response) => response.json());
  const hasClientHandoff = Boolean(upmindClient.clientId && upmindClient.email);
  const ensureContext = loadZohoAsap().then(() => hasClientHandoff
    ? postJson('/auth/upmind-client-context', upmindClient)
    : fetchJson('/auth/upmind-client-context' + authQuery));
  ensureContext.then((ctx) => {
    if (!ctx || !ctx.authenticated) return;
    const getJwtTokenCallback = async (success, failure) => {
      try {
        const data = hasClientHandoff ? await postJson('/auth/asap-jwt', upmindClient) : await fetchJson('/auth/asap-jwt' + authQuery);
        if (!data || !data.token) throw new Error('Missing token');
        success(data.token);
      } catch (error) {
        failure(error);
      }
    };
    if (!window.ZohoDeskAsapReady || !window.ZohoDeskAsap) return;
    window.ZohoDeskAsapReady && window.ZohoDeskAsapReady(() => {
      ZohoDeskAsap.invoke('login', getJwtTokenCallback);
    });
  }).catch(() => {});

  function loadZohoAsap() {
    if (document.getElementById('zohodeskasapscript')) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.type = 'text/javascript';
      s.id = 'zohodeskasapscript';
      s.defer = true;
      s.src = zohoAsapScriptUrl;
      s.onload = resolve;
      s.onerror = reject;
      const t = document.getElementsByTagName('script')[0] || document.head.firstChild;
      (t && t.parentNode ? t.parentNode : document.head).insertBefore(s, t || null);
    });
  }

  function isWidgetAllowed() {
    const host = window.location.hostname.toLowerCase();
    const path = window.location.pathname.toLowerCase();
    if (matchesHost(host, blockedHosts)) return false;
    if (matchesPath(path, blockedPaths)) return false;
    if (allowedHosts.length > 0 && !matchesHost(host, allowedHosts)) return false;
    if (allowedPaths.length > 0 && !matchesPath(path, allowedPaths)) return false;
    return true;
  }

  function matchesHost(host, patterns) {
    return patterns.some((pattern) => {
      pattern = String(pattern).toLowerCase();
      if (pattern === '*') return true;
      if (pattern.indexOf('*.') === 0) {
        const suffix = pattern.slice(1);
        return host.endsWith(suffix);
      }
      return host === pattern;
    });
  }

  function matchesPath(path, patterns) {
    return patterns.some((pattern) => {
      pattern = String(pattern).toLowerCase();
      if (pattern === '*') return true;
      return path === pattern || path.indexOf(pattern.endsWith('/') ? pattern : pattern + '/') === 0;
    });
  }

  function readTokenFromStorage() {
    const stores = [window.localStorage, window.sessionStorage];
    for (const storage of stores) {
      try {
        for (const key of tokenKeys) {
          const token = extractToken(storage.getItem(key));
          if (token) return token;
        }
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          const token = key ? extractToken(storage.getItem(key)) : null;
          if (token) return token;
        }
      } catch (_) {}
    }
    return null;
  }

  function extractToken(value) {
    if (!value) return null;
    if (value.indexOf('Bearer ') === 0) return value.slice(7);
    if (/^[A-Za-z0-9._~+/-]{20,}$/.test(value)) return value;
    try {
      const parsed = JSON.parse(value);
      const token = parsed && (parsed.access_token || parsed.accessToken || parsed.token || parsed.id_token);
      return typeof token === 'string' ? token.replace(/^Bearer\\s+/i, '') : null;
    } catch (_) {
      return null;
    }
  }
})();`;
}

function splitEnvList(value?: string): string[] {
	return (value || '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}
