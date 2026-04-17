// Type imports for Cloudflare Workers
import type { ScheduledEvent, ExecutionContext } from './cloudflare-workers';
// Scheduled event handler for Cloudflare Cron Triggers
export async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  try {
    await runMaintenanceSync(env);
  } catch (err: unknown) {
    // Do not log secrets or tokens
    let msg = 'Scheduled sync error';
    if (typeof err === 'object' && err && 'message' in err) {
      msg += ': ' + (err as any).message;
    } else if (typeof err === 'string') {
      msg += ': ' + err;
    }
    console.error(msg);
  }
}

import { handleCronSync } from './cron';

import type { Env } from './types';
import { getZohoAccessToken } from './zoho-oauth';

type JsonRecord = Record<string, unknown>;

import { checkUpmindWebhookSignature, getEventFailures, recordEventFailure } from './webhooks';

export default {
  scheduled,

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return withCors(request, env, new Response(null, { status: 204 }));
    }

    // --- CRON SYNC ENDPOINT ---
    if (request.method === 'POST' && url.pathname === '/cron/sync') {
      const adminToken = env.ADMIN_TOKEN;
      function isAdmin(req: Request): boolean {
        if (!adminToken) return false;
        const header = req.headers.get('x-admin-token') || req.headers.get('authorization');
        return header === adminToken || header === `Bearer ${adminToken}`;
      }
      if (!isAdmin(request)) return json({ ok: false, error: 'Unauthorized' }, 401);
      try {
        const result = await runMaintenanceSync(env);
        return json(result);
      } catch (err: any) {
        return json({ ok: false, error: err.message || 'Cron sync error' }, 500);
      }
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: true,
        service: 'help-desk-bridge',
        time: new Date().toISOString(),
        config: configStatus(env)
      });
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/webhooks/upmind') {
      return json({ ok: true, webhook: 'upmind', validation: true, config: configStatus(env) });
    }

    if (request.method === 'GET' && url.pathname === '/asap-bootstrap.js') {
      return javascript(ASAP_BOOTSTRAP_JS);
    }

    if (request.method === 'GET' && url.pathname === '/support') {
      return html(SUPPORT_PAGE_HTML);
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/upmind') {
      // Verify Upmind webhook signature
      const valid = await checkUpmindWebhookSignature(request.clone(), env);
      if (!valid) {
        return json({ ok: false, error: 'Invalid Upmind webhook signature' }, 401);
      }
      return handleUpmindWebhook(request, env);
    }

    // --- AUTH ENDPOINTS ---

    if (request.method === 'POST' && url.pathname === '/auth/upmind-api-client-context') {
      try {
        const client = await resolveClientFromUpmindApiHandoff(request, env);
        await syncUpmindClientToZoho({
          upmind_client_id: client.clientId,
          email: client.email,
          name: client.name,
          bridge_origin: 'upmind-api-sso'
        }, env);
        return withCors(request, env, json({
          authenticated: true,
          source: 'upmind_api',
          clientId: client.clientId,
          email: client.email,
          name: client.name
        }));
      } catch (err: any) {
        return withCors(request, env, json({
          authenticated: false,
          source: 'upmind_api',
          error: err.message || 'Invalid Upmind client'
        }, 401));
      }
    }

    if (request.method === 'GET' && url.pathname === '/auth/upmind-client-context') {
      const { resolveAuthenticatedUpmindClientWithSource } = await import('./auth');
      const resolved = await resolveAuthenticatedUpmindClientWithSource(request, env);
      if (resolved.client) {
        return withCors(request, env, json({
          authenticated: true,
          source: resolved.source ?? 'none',
          clientId: resolved.client.clientId,
          email: resolved.client.email,
          name: resolved.client.name
        }));
      }
      return withCors(request, env, json({
        authenticated: false,
        source: resolved.source ?? 'none',
        reason: resolved.reason ?? 'no valid identity source found'
      }));
    }


    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/auth/asap-jwt') {
      const {
        resolveAuthenticatedUpmindClient,
        generateZohoAsapJwt
      } = await import('./auth');
      try {
        const client = request.method === 'POST'
          ? await resolveClientFromUpmindApiHandoff(request, env)
          : await resolveAuthenticatedUpmindClient(request, env);
        if (!client) return withCors(request, env, json({ ok: false, error: 'Not authenticated' }, 401));
        await syncUpmindClientToZoho({
          upmind_client_id: client.clientId,
          email: client.email,
          name: client.name,
          bridge_origin: request.method === 'POST' ? 'upmind-api-sso' : 'upmind-jwt-sso'
        }, env);
        const token = await generateZohoAsapJwt(client, env);
        if (url.searchParams.get('format') === 'plain' || url.searchParams.has('user_token')) return withCors(request, env, text(token));
        return withCors(request, env, json({ token }));
      } catch (err: any) {
        return withCors(request, env, json({ ok: false, error: err.message || 'JWT error' }, 400));
      }
    }


    if (request.method === 'GET' && url.pathname === '/auth/helpcenter-jwt') {
      const { resolveAuthenticatedUpmindClient, generateZohoHelpCenterJwt } = await import('./auth');
      const client = await resolveAuthenticatedUpmindClient(request, env);
      if (!client) return withCors(request, env, json({ ok: false, error: 'Not authenticated' }, 401));
      try {
        const token = await generateZohoHelpCenterJwt(client, env);
        return withCors(request, env, json({ token }));
      } catch (err: any) {
        return withCors(request, env, json({ ok: false, error: err.message || 'JWT error' }, 400));
      }
    }

    if (request.method === 'GET' && url.pathname === '/auth/helpcenter-launch') {
      const { resolveAuthenticatedUpmindClient, generateZohoHelpCenterJwt } = await import('./auth');
      const client = await resolveAuthenticatedUpmindClient(request, env);
      if (!client) return withCors(request, env, json({ ok: false, error: 'Not authenticated' }, 401));
      try {
        const token = await generateZohoHelpCenterJwt(client, env);
        const launchUrl = env.ZOHO_HELP_CENTER_URL ? `${env.ZOHO_HELP_CENTER_URL}?jwt=${encodeURIComponent(token)}` : undefined;
        return withCors(request, env, json({ token, launchUrl, email: client.email }));
      } catch (err: any) {
        return withCors(request, env, json({ ok: false, error: err.message || 'JWT error' }, 400));
      }
    }

    if (request.method === 'GET' && url.pathname === '/auth/helpcenter-jwt-redirect') {
      const { resolveAuthenticatedUpmindClient, generateZohoHelpCenterJwt } = await import('./auth');
      const client = await resolveAuthenticatedUpmindClient(request, env);
      if (!client) return withCors(request, env, json({ ok: false, error: 'Not authenticated' }, 401));
      const terminal = env.ZOHO_HC_JWT_TERMINAL_URL;
      if (!terminal) return withCors(request, env, json({ ok: false, error: 'Missing ZOHO_HC_JWT_TERMINAL_URL' }, 400));
      try {
        const token = await generateZohoHelpCenterJwt(client, env);
        const returnTo = url.searchParams.get('return_to') ?? '/';
        const redirectUrl = `${terminal}${encodeURIComponent(token)}&return_to=${encodeURIComponent(returnTo)}`;
        return Response.redirect(redirectUrl, 302);
      } catch (err: any) {
        return withCors(request, env, json({ ok: false, error: err.message || 'JWT error' }, 400));
      }
    }

    // --- ADMIN/DEBUG/BACKFILL ENDPOINTS ---
    // Admin token protection (dedicated token only)
    const adminToken = env.ADMIN_TOKEN;
    function isAdmin(req: Request): boolean {
      if (!adminToken) return false;
      const header = req.headers.get('x-admin-token') || req.headers.get('authorization');
      return header === adminToken || header === `Bearer ${adminToken}`;
    }

    // Admin: health, config, DB status
    if (url.pathname === '/admin/health' && isAdmin(request)) {
      return json({ ok: true, time: new Date().toISOString(), config: configStatus(env) });
    }
    if (url.pathname === '/admin/db-status' && isAdmin(request)) {
      // Show table row counts (for debug)
      const tables = ['contact_map', 'processed_events', 'raw_events', 'oauth_tokens', 'event_failures'];
      const counts: Record<string, number> = {};
      for (const table of tables) {
        try {
          const row = await env.BRIDGE_DB.prepare(`SELECT COUNT(*) as n FROM ${table}`).first<{ n: number }>();
          counts[table] = row?.n ?? 0;
        } catch {
          counts[table] = -1;
        }
      }
      return json({ ok: true, counts });
    }

    if (url.pathname === '/admin/failures' && isAdmin(request)) {
      return json({ ok: true, failures: await getEventFailures(env) });
    }

    // Debug: fetch raw event by eventKey
    if (url.pathname.startsWith('/debug/raw-event/') && isAdmin(request)) {
      const eventKey = url.pathname.replace('/debug/raw-event/', '');
      const row = await env.BRIDGE_DB.prepare('SELECT * FROM raw_events WHERE event_key = ?1 LIMIT 1').bind(eventKey).first();
      return json({ ok: true, eventKey, row });
    }

    // Backfill: reprocess a raw event by eventKey (dangerous, for admin only)
    if (url.pathname.startsWith('/backfill/reprocess/') && isAdmin(request)) {
      const eventKey = url.pathname.replace('/backfill/reprocess/', '');
      const row = await env.BRIDGE_DB.prepare('SELECT * FROM raw_events WHERE event_key = ?1 LIMIT 1').bind(eventKey).first();
      if (!row) return json({ ok: false, error: 'Event not found' }, 404);
      try {
        const payload = JSON.parse(String(row.payload_json));
        await handleUpmindWebhook(new Request('https://dummy', { method: 'POST', body: JSON.stringify(payload) }), env);
        return json({ ok: true, reprocessed: true, eventKey });
      } catch (err: any) {
        return json({ ok: false, error: err.message || 'Reprocess error' }, 500);
      }
    }

    // Fallback 404
    return json({ ok: false, error: 'Not found' }, 404);
  }
};

async function runMaintenanceSync(env: Env): Promise<JsonRecord> {
  let cronResult: JsonRecord = { ok: true, cronError: null };
  try {
    cronResult = await handleCronSync(env) as JsonRecord;
  } catch (error) {
    cronResult = { ok: false, cronError: error instanceof Error ? error.message : String(error) };
    console.error(`Cron pending sync error: ${cronResult.cronError}`);
  }

  let retryResult: JsonRecord = { failuresRetried: 0, failuresRetrySucceeded: 0 };
  try {
    retryResult = await retryFailedRawEvents(env);
  } catch (error) {
    retryResult = { failuresRetried: 0, failuresRetrySucceeded: 0, retryError: error instanceof Error ? error.message : String(error) };
    console.error(`Cron retry sync error: ${retryResult.retryError}`);
  }

  return { ...cronResult, ...retryResult };
}

async function retryFailedRawEvents(env: Env, limit = 10): Promise<JsonRecord> {
  await ensureSchema(env);

  const rows = await env.BRIDGE_DB.prepare(`
    SELECT
      ef.event_key,
      ef.origin_system,
      ef.event_name,
      re.payload_json
    FROM event_failures ef
    JOIN raw_events re ON re.event_key = ef.event_key
    LEFT JOIN processed_events pe ON pe.event_key = ef.event_key
    WHERE pe.event_key IS NULL
    ORDER BY ef.id ASC
    LIMIT ?1
  `).bind(limit).all<{
    event_key: string;
    origin_system: string;
    event_name: string;
    payload_json: string;
  }>();

  let retried = 0;
  let retrySucceeded = 0;

  for (const row of rows.results ?? []) {
    retried++;
    try {
      const payload = JSON.parse(row.payload_json);
      const response = await handleUpmindWebhook(new Request('https://internal/retry', {
        method: 'POST',
        body: JSON.stringify(payload)
      }), env);
      if (response.ok && response.status < 300) retrySucceeded++;
    } catch (error) {
      console.log(JSON.stringify({
        source: 'retry-failed-events',
        ok: false,
        eventKey: row.event_key,
        error: String(error)
      }));
    }
  }

  return { failuresRetried: retried, failuresRetrySucceeded: retrySucceeded };
}

async function handleUpmindWebhook(request: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  const payload = await readPayload(request);
  let clientId: string | undefined = extractUpmindClientId(payload);
  const eventName = normalizeEventName(firstNonEmpty([
    readString(payload.hook_code),
    readString(payload.hook_category),
    readString(payload.event),
    readString(payload.name),
    readString(payload.type),
    readString(payload.action),
    recursiveFindString(payload, ['hook_code', 'hook_category', 'event', 'eventName', 'eventType', 'type', 'action'])
  ])) ?? 'upmind.unknown';
  const eventKey = await computeEventKey('upmind', request, payload);

  if (!clientId && payload.object && typeof payload.object === 'object') {
    clientId = (payload.object as any).client_id || (payload.object as any).clientId || clientId;
  }

  console.log(JSON.stringify({
    source: 'upmind',
    eventName,
    eventKey,
    clientId,
    keys: Object.keys(payload).slice(0, 20),
    preview: previewPayload(payload)
  }));

  if (await isDuplicate(env, eventKey)) {
    return json({ ok: true, duplicate: true, eventKey });
  }

  await storeRawEvent(env, 'upmind', eventName, eventKey, payload);

  try {
    if (clientId || extractUpmindEmail(payload)) {
      await syncUpmindClientToZoho({ ...payload, bridge_origin: 'upmind' }, env);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await recordEventFailure({
      eventKey,
      originSystem: 'upmind',
      eventName,
      errorMessage,
      payloadJson: payload
    }, env);
    return json({ ok: true, accepted: true, source: 'upmind', eventName, eventKey, sync: 'pending', error: errorMessage }, 202);
  }

  await markProcessed(env, eventKey, 'upmind');

  return json({ ok: true, source: 'upmind', eventName, eventKey, clientId, sync: 'client-only' });
}

async function ensureSchema(env: Env): Promise<void> {
  await env.BRIDGE_DB.prepare(`
    CREATE TABLE IF NOT EXISTS contact_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upmind_client_id TEXT UNIQUE,
      zoho_contact_id TEXT UNIQUE,
      email TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.BRIDGE_DB.prepare(`
    CREATE TABLE IF NOT EXISTS processed_events (
      event_key TEXT PRIMARY KEY,
      origin_system TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT
    )
  `).run();

  await env.BRIDGE_DB.prepare(`
    CREATE TABLE IF NOT EXISTS raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin_system TEXT NOT NULL,
      event_name TEXT,
      event_key TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.BRIDGE_DB.prepare(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      access_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.BRIDGE_DB.prepare(`
    CREATE TABLE IF NOT EXISTS event_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      origin_system TEXT NOT NULL,
      event_name TEXT,
      error_message TEXT,
      payload_json TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_contact_map_email ON contact_map(email)').run();
  await env.BRIDGE_DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider)').run();
  await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_event_failures_event_key ON event_failures(event_key)').run();
  await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_event_failures_origin_system ON event_failures(origin_system)').run();
}

async function readPayload(request: Request): Promise<JsonRecord> {
  const raw = await request.text();

  if (!raw || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    const params = new URLSearchParams(raw);
    const payload: JsonRecord = {};
    for (const [key, value] of params.entries()) {
      payload[key] = value;
    }
    return payload;
  }
}

export async function syncUpmindClientToZoho(payload: JsonRecord, env: Env): Promise<void> {
  const clientId = extractUpmindClientId(payload);
  const email = extractUpmindEmail(payload);

  if (!clientId || !email) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT zoho_contact_id FROM contact_map WHERE upmind_client_id = ?1 OR email = ?2 LIMIT 1'
  ).bind(clientId, email).first<{ zoho_contact_id?: string }>();

  let zohoContactId = existing?.zoho_contact_id;

  if ((!zohoContactId || zohoContactId.startsWith('pending-')) && hasZohoConfig(env)) {
    try {
      zohoContactId = await resolveOrCreateZohoContactId(env, payload, email, clientId);
    } catch (error) {
      console.log(JSON.stringify({
        source: 'zoho-api',
        action: 'resolve-or-create-contact',
        ok: false,
        email,
        upmindClientId: clientId,
        error: String(error)
      }));
    }
  } else if (!hasZohoConfig(env)) {
    console.log(JSON.stringify({ source: 'zoho-api', skipped: true, reason: 'missing-config', missing: missingZohoConfig(env) }));
  }

  zohoContactId = zohoContactId ?? `pending-zoho-${clientId}`;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO contact_map (upmind_client_id, zoho_contact_id, email, updated_at)
     VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
     ON CONFLICT(upmind_client_id) DO UPDATE SET
       zoho_contact_id = excluded.zoho_contact_id,
       email = excluded.email,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(clientId, zohoContactId, email).run();
}

async function zohoRequest(env: Env, method: string, path: string, body?: JsonRecord): Promise<JsonRecord> {
  if (!hasZohoConfig(env)) {
    const missing = missingZohoConfig(env);
    console.log(JSON.stringify({ source: 'zoho-api', skipped: true, reason: 'missing-config', missing }));
    throw new Error(`Missing Zoho config: ${missing.join(', ')}`);
  }

  const accessToken = await getZohoAccessToken(env);
  const baseUrl = (env.ZDK_BASE_URL ?? 'https://desk.zoho.com/api/v1').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'authorization': `Zoho-oauthtoken ${accessToken}`,
      'content-type': 'application/json',
      ...(env.ZDK_ORG_ID ? { orgId: env.ZDK_ORG_ID } : {}),
      ...(env.ZDK_IGNORE_SOURCE_ID ? { sourceId: env.ZDK_IGNORE_SOURCE_ID } : {})
    },
    body: body ? JSON.stringify(stripUndefined(body)) : undefined
  });

  const text = await response.text();
  let parsed: JsonRecord = {};

  if (text) {
    try {
      const jsonValue = JSON.parse(text) as unknown;
      parsed = isRecord(jsonValue) ? jsonValue : { value: jsonValue };
    } catch {
      parsed = { raw: text };
    }
  }

  console.log(JSON.stringify({ source: 'zoho-api', method, path, status: response.status, ok: response.ok, body: parsed }));

  if (!response.ok) {
    throw new Error(`Zoho API request failed: ${method} ${path} (${response.status}) ${previewPayload(parsed)}`);
  }

  return parsed;
}

function hasZohoConfig(env: Env): boolean {
  return Boolean(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN && env.ZDK_DEPARTMENT_ID);
}

function missingZohoConfig(env: Env): string[] {
  const missing: string[] = [];
  if (!env.ZOHO_CLIENT_ID) missing.push('ZOHO_CLIENT_ID');
  if (!env.ZOHO_CLIENT_SECRET) missing.push('ZOHO_CLIENT_SECRET');
  if (!env.ZOHO_REFRESH_TOKEN) missing.push('ZOHO_REFRESH_TOKEN');
  if (!env.ZDK_DEPARTMENT_ID) missing.push('ZDK_DEPARTMENT_ID');
  return missing;
}

function hasUpmindConfig(env: Env): boolean {
  return Boolean(env.UPMIND_API_BASE_URL && env.UPMIND_API_TOKEN);
}

function missingUpmindConfig(env: Env): string[] {
  const missing: string[] = [];
  if (!env.UPMIND_API_BASE_URL) missing.push('UPMIND_API_BASE_URL');
  if (!env.UPMIND_API_TOKEN) missing.push('UPMIND_API_TOKEN');
  return missing;
}

async function resolveClientFromUpmindApiHandoff(request: Request, env: Env): Promise<{ clientId: string; email: string; name?: string }> {
  const origin = request.headers.get('origin');
  if (origin && !isAllowedCorsOrigin(origin, env)) {
    throw new Error('Origin not allowed');
  }

  if (!hasUpmindConfig(env)) {
    throw new Error(`Missing Upmind config: ${missingUpmindConfig(env).join(', ')}`);
  }

  const payload = await readPayload(request);
  const clientId = firstNonEmpty([
    deepReadString(payload, ['clientId']),
    deepReadString(payload, ['client_id']),
    deepReadString(payload, ['upmindClientId']),
    deepReadString(payload, ['upmind_client_id']),
    deepReadString(payload, ['uid']),
    extractUpmindClientId(payload)
  ]);
  const email = firstNonEmpty([
    deepReadString(payload, ['email']),
    deepReadString(payload, ['clientEmail']),
    deepReadString(payload, ['client_email']),
    extractUpmindEmail(payload)
  ]);
  const issued = readNumberLike(payload.issued) ?? readNumberLike(payload.timestamp);

  if (!clientId || !email) {
    throw new Error('Missing Upmind client id or email');
  }

  if (issued && Math.abs(Date.now() - issued) > 10 * 60 * 1000) {
    throw new Error('Stale Upmind client handoff');
  }

  const upmindClient = await fetchUpmindClientById(env, clientId);
  if (!upmindClient) {
    throw new Error('Upmind client not found');
  }

  const apiEmail = extractUpmindEmail(upmindClient);
  if (!apiEmail || apiEmail.toLowerCase() !== email.toLowerCase()) {
    throw new Error('Upmind email mismatch');
  }

  const status = firstNonEmpty([
    deepReadString(upmindClient, ['status']),
    deepReadString(upmindClient, ['data', 'status']),
    deepReadString(upmindClient, ['client', 'status']),
    recursiveFindString(upmindClient, ['status'])
  ]);
  if (status && ['inactive', 'disabled', 'suspended', 'closed', 'deleted'].includes(status.toLowerCase())) {
    throw new Error('Upmind client is not active');
  }

  return {
    clientId,
    email: apiEmail,
    name: extractUpmindFullName(upmindClient) ?? readStringLike(payload.name)
  };
}

function configStatus(env: Env): JsonRecord {
  return {
    upmindApiBaseUrl: Boolean(env.UPMIND_API_BASE_URL),
    upmindApiToken: Boolean(env.UPMIND_API_TOKEN),
    upmindClientEndpointTemplate: Boolean(env.UPMIND_CLIENT_ENDPOINT_TEMPLATE),
    upmindWebhookSecret: Boolean(env.UPMIND_WEBHOOK_SECRET),
    upmindMissing: missingUpmindConfig(env),
    zohoBaseUrl: Boolean(env.ZDK_BASE_URL),
    zohoClientId: Boolean(env.ZOHO_CLIENT_ID),
    zohoClientSecret: Boolean(env.ZOHO_CLIENT_SECRET),
    zohoRefreshToken: Boolean(env.ZOHO_REFRESH_TOKEN),
    zohoOrgId: Boolean(env.ZDK_ORG_ID),
    zohoDepartmentId: Boolean(env.ZDK_DEPARTMENT_ID),
    zohoIgnoreSourceId: Boolean(env.ZDK_IGNORE_SOURCE_ID),
    zohoMissing: missingZohoConfig(env),
    zohoAsapJwtSecret: Boolean(env.ZOHO_ASAP_JWT_SECRET),
    zohoHelpCenterJwtSecret: Boolean(env.ZOHO_HC_JWT_SECRET || env.ZOHO_ASAP_JWT_SECRET),
    zohoHelpCenterJwtTerminalUrl: Boolean(env.ZOHO_HC_JWT_TERMINAL_URL),
    upmindSessionJwtSecret: Boolean(env.UPMIND_SESSION_JWT_SECRET),
    adminToken: Boolean(env.ADMIN_TOKEN)
  };
}

async function resolveOrCreateZohoContactId(env: Env, payload: JsonRecord, email: string, clientId: string): Promise<string | undefined> {
  const encodedEmail = encodeURIComponent(email);

  try {
    const existing = await zohoRequest(env, 'GET', `/contacts/search?email=${encodedEmail}`);
    const fromSearch = readString(existing.id)
      ?? deepReadString(existing, ['data', 'id'])
      ?? readZohoIdFromArray(existing.data);

    if (fromSearch) return fromSearch;
  } catch (error) {
    console.log(JSON.stringify({
      source: 'zoho-api',
      action: 'search-contact',
      ok: false,
      email,
      upmindClientId: clientId,
      error: String(error)
    }));
  }

  const created = await zohoRequest(env, 'POST', '/contacts', {
    email,
    lastName: extractUpmindLastName(payload) ?? 'Unknown'
  });

  return readString(created.id) ?? deepReadString(created, ['data', 'id']);
}

function readZohoIdFromArray(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  if (!isRecord(first)) return undefined;
  return readStringLike(first.id);
}

function extractUpmindClientId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['upmind_client_id']),
    deepReadString(payload, ['client_id']),
    deepReadString(payload, ['clientId']),
    deepReadString(payload, ['object', 'client_id']),
    deepReadString(payload, ['object', 'clientId']),
    deepReadString(payload, ['data', 'client', 'id']),
    deepReadString(payload, ['client', 'id']),
    deepReadString(payload, ['data', 'customer', 'id']),
    deepReadString(payload, ['customer', 'id']),
    recursiveFindString(payload, ['upmind_client_id', 'clientId', 'client_id', 'customerId', 'customer_id'])
  ]);
}

function extractUpmindEmail(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'email']),
    deepReadString(payload, ['client_email']),
    deepReadString(payload, ['login_email']),
    deepReadString(payload, ['notification_email']),
    deepReadString(payload, ['object', 'client', 'email']),
    deepReadString(payload, ['object', 'ticket', 'client', 'email']),
    deepReadString(payload, ['object', 'ticket', 'client', 'login_email']),
    deepReadString(payload, ['object', 'ticket', 'client', 'notification_email']),
    deepReadString(payload, ['data', 'client', 'email']),
    deepReadString(payload, ['client', 'email']),
    deepReadString(payload, ['data', 'customer', 'email']),
    deepReadString(payload, ['customer', 'email']),
    deepReadString(payload, ['email']),
    recursiveFindString(payload, ['email'])
  ]);
}

function extractUpmindFullName(payload: JsonRecord): string | undefined {
  const explicit = firstNonEmpty([
    deepReadString(payload, ['name']),
    deepReadString(payload, ['fullName']),
    deepReadString(payload, ['full_name']),
    deepReadString(payload, ['data', 'name']),
    deepReadString(payload, ['data', 'fullName']),
    deepReadString(payload, ['data', 'full_name']),
    deepReadString(payload, ['client', 'name'])
  ]);
  if (explicit) return explicit;

  const first = firstNonEmpty([
    deepReadString(payload, ['firstName']),
    deepReadString(payload, ['first_name']),
    deepReadString(payload, ['firstname']),
    deepReadString(payload, ['data', 'firstName']),
    deepReadString(payload, ['data', 'first_name']),
    deepReadString(payload, ['data', 'firstname']),
    deepReadString(payload, ['client', 'firstName']),
    deepReadString(payload, ['client', 'firstname'])
  ]);
  const last = extractUpmindLastName(payload);
  return [first, last].filter(Boolean).join(' ') || undefined;
}

function extractUpmindLastName(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['object', 'client', 'lastname']),
    deepReadString(payload, ['object', 'ticket', 'client', 'lastname']),
    deepReadString(payload, ['object', 'client', 'last_name']),
    deepReadString(payload, ['object', 'ticket', 'client', 'last_name']),
    deepReadString(payload, ['data', 'client', 'lastName']),
    deepReadString(payload, ['client', 'lastName']),
    deepReadString(payload, ['data', 'client', 'last_name']),
    deepReadString(payload, ['client', 'last_name']),
    deepReadString(payload, ['data', 'customer', 'lastName']),
    deepReadString(payload, ['customer', 'lastName']),
    deepReadString(payload, ['data', 'customer', 'last_name']),
    deepReadString(payload, ['customer', 'last_name']),
    deepReadString(payload, ['data', 'client', 'surname']),
    deepReadString(payload, ['client', 'surname']),
    recursiveFindString(payload, ['lastName', 'last_name', 'surname', 'familyName', 'family_name'])
  ]);
}

function previewPayload(payload: JsonRecord): string {
  try {
    const text = JSON.stringify(payload);
    return text.length > 800 ? `${text.slice(0, 800)}...` : text;
  } catch {
    return '[unserializable]';
  }
}

function recursiveFindString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 6 || value === null || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recursiveFindString(item, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  if (typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const [key, nested] of Object.entries(record)) {
    if (keys.includes(key)) {
      const stringValue = readStringLike(nested);
      if (stringValue) return stringValue;
    }
  }

  for (const nested of Object.values(record)) {
    const found = recursiveFindString(nested, keys, depth + 1);
    if (found) return found;
  }

  return undefined;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) return value;
  }
  return undefined;
}

function normalizeEventName(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/\s+/g, ' ').trim();
}

async function computeEventKey(origin: string, request: Request, payload: JsonRecord): Promise<string> {
  const incomingId = request.headers.get('x-upmind-delivery-id')
    || request.headers.get('x-webhook-id')
    || request.headers.get('x-request-id');

  if (incomingId) return `${origin}:${incomingId}`;

  const raw = JSON.stringify(payload);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${origin}:${raw}`));
  const hex = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${origin}:${hex}`;
}

async function isDuplicate(env: Env, eventKey: string): Promise<boolean> {
  const row = await env.BRIDGE_DB.prepare(
    'SELECT event_key FROM processed_events WHERE event_key = ?1 LIMIT 1'
  ).bind(eventKey).first();

  return Boolean(row);
}

async function markProcessed(env: Env, eventKey: string, originSystem: string): Promise<void> {
  await env.BRIDGE_DB.prepare(
    `INSERT OR IGNORE INTO processed_events (event_key, origin_system, expires_at)
     VALUES (?1, ?2, datetime('now', '+14 day'))`
  ).bind(eventKey, originSystem).run();
}

async function storeRawEvent(env: Env, originSystem: string, eventName: string, eventKey: string, payload: JsonRecord): Promise<void> {
  await env.BRIDGE_DB.prepare(
    `INSERT INTO raw_events (origin_system, event_name, event_key, payload_json)
     VALUES (?1, ?2, ?3, ?4)`
  ).bind(originSystem, eventName, eventKey, JSON.stringify(payload)).run();
}

function stripUndefined(input: JsonRecord): JsonRecord {
  const output: JsonRecord = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringLike(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function readNumberLike(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function deepReadString(source: JsonRecord, path: string[]): string | undefined {
  let current: unknown = source;

  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in (current as Record<string, unknown>))) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return readStringLike(current);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

function text(source: string, status = 200): Response {
  return new Response(source, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function html(source: string): Response {
  return new Response(source, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function javascript(source: string): Response {
  return new Response(source, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300'
    }
  });
}

function sanitizeLocalRedirect(value: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/support';
  return value;
}

function withCors(request: Request, env: Env, response: Response): Response {
  const origin = request.headers.get('origin');
  if (!origin || !isAllowedCorsOrigin(origin, env)) return response;

  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-credentials', 'true');
  headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type, authorization, x-requested-with');
  headers.set('vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function isAllowedCorsOrigin(origin: string, env: Env): boolean {
  const configured = env.CORS_ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean);
  const allowed = configured && configured.length > 0
    ? configured
    : [
      'https://portal.zebrabyte.ro',
      'https://help-desk.zebrabyte-uk.workers.dev'
    ];

  return allowed.some((allowedOrigin) => {
    if (allowedOrigin === origin) return true;
    if (allowedOrigin.endsWith('/*')) {
      return origin.startsWith(allowedOrigin.slice(0, -1));
    }
    return false;
  });
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

const ASAP_BOOTSTRAP_JS = `(() => {
  const script = document.currentScript;
  const bridgeOrigin = script && script.src ? new URL(script.src).origin : window.location.origin;
  const scriptContext = script && script.dataset ? script.dataset : {};
  const windowContext = window.ZBT_SUPPORT_CONTEXT || {};
  const upmindJwt = scriptContext.upmindJwt || windowContext.upmindJwt || windowContext.user_token || windowContext.userToken;
  const upmindClient = {
    clientId: scriptContext.clientId || windowContext.clientId || windowContext.client_id || windowContext.uid,
    email: scriptContext.email || windowContext.email,
    name: scriptContext.name || windowContext.name,
    issued: Number(scriptContext.issued || windowContext.issued || Date.now())
  };
  const authQuery = upmindJwt ? '?user_token=' + encodeURIComponent(upmindJwt) : '';
  const fetchJson = (path) => fetch(bridgeOrigin + path, { credentials: 'include' }).then((response) => response.json());
  const postJson = (path, body) => fetch(bridgeOrigin + path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then((response) => response.json());

  const hasClientHandoff = Boolean(upmindClient.clientId && upmindClient.email);
  const ensureContext = hasClientHandoff
    ? postJson('/auth/upmind-api-client-context', upmindClient)
    : fetchJson('/auth/upmind-client-context' + authQuery);

  ensureContext
    .then((ctx) => {
      if (!ctx || !ctx.authenticated) return;

      let used = false;
      const getJwtTokenCallback = async (success, failure) => {
        try {
          const data = hasClientHandoff
            ? await postJson('/auth/asap-jwt', upmindClient)
            : await fetchJson('/auth/asap-jwt' + authQuery);
          if (!data || !data.token) throw new Error('Missing token');
          success(data.token);
        } catch (error) {
          failure(error);
        }
      };

      window.ZohoDeskAsapReady(() => {
        if (used) return;
        used = true;
        ZohoDeskAsap.invoke('login', getJwtTokenCallback);
      });
    })
    .catch(() => {});
})();`;

// Helper to fetch Upmind client details by clientId
export async function fetchUpmindClientById(env: Env, clientId: string): Promise<any> {
  if (!env.UPMIND_API_BASE_URL || !env.UPMIND_API_TOKEN) return null;
  const baseUrl = env.UPMIND_API_BASE_URL.replace(/\/$/, '');
  const path = env.UPMIND_CLIENT_ENDPOINT_TEMPLATE
    ? env.UPMIND_CLIENT_ENDPOINT_TEMPLATE.replace('{clientId}', encodeURIComponent(clientId)).replace('{id}', encodeURIComponent(clientId))
    : `/clients/${encodeURIComponent(clientId)}`;
  const url = path.startsWith('https://') || path.startsWith('http://') ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${env.UPMIND_API_TOKEN}` }
  });
  if (!res.ok) return null;
  return await res.json();
}
