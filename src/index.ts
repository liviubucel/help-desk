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
import { hmacSha256Hex, timingSafeEqual } from './utils/crypto';

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

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/webhooks/zoho') {
      return json({ ok: true, webhook: 'zoho', validation: true, config: configStatus(env) });
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

    if (request.method === 'POST' && url.pathname === '/webhooks/zoho') {
      // Zoho Desk webhooks use x-zdesk-jwt (JWT-based auth), not a shared secret
      const jwt = request.headers.get('x-zdesk-jwt');
      const customSecret = env.ZDK_WEBHOOK_SECRET;
      const customHeader = request.headers.get('x-zoho-webhook-secret');
      // If a custom secret is set, allow it as a fallback (for custom integrations only)
      if (customSecret && customHeader === customSecret) {
        return handleZohoWebhook(request, env);
      }
      // Require Zoho JWT for native Zoho Desk webhooks
      if (!jwt) {
        return json({ ok: false, error: 'Missing Zoho Desk JWT (x-zdesk-jwt)' }, 401);
      }
      if (env.ZDK_WEBHOOK_JWT_SECRET && !(await verifyWebhookJwt(jwt, env))) {
        return json({ ok: false, error: 'Invalid Zoho Desk JWT' }, 401);
      }
      return handleZohoWebhook(request, env);
    }

    // --- AUTH ENDPOINTS ---

    if (request.method === 'GET' && url.pathname === '/auth/upmind-launch') {
      const {
        createWorkerSessionCookie,
        resolveAuthenticatedUpmindClientWithSource,
        resolveSignedLaunchQuery
      } = await import('./auth');
      const queryClient = await resolveSignedLaunchQuery(request, env);
      const resolved = queryClient
        ? { authenticated: true as const, source: 'signed_launch_query' as const, client: queryClient }
        : await resolveAuthenticatedUpmindClientWithSource(request, env);

      if (!resolved.client) {
        return withCors(request, env, json({
          ok: false,
          authenticated: false,
          source: resolved.source ?? 'none',
          error: 'Invalid or missing Upmind identity'
        }, 401));
      }

      const cookie = await createWorkerSessionCookie(resolved.client, env);
      console.log(JSON.stringify({
        source: 'auth',
        action: 'upmind-launch',
        authenticated: true,
        authSource: resolved.source,
        clientId: resolved.client.clientId,
        email: resolved.client.email
      }));

      const responseMode = url.searchParams.get('response') ?? url.searchParams.get('mode');
      if (responseMode === 'json') {
        const response = json({
          ok: true,
          authenticated: true,
          source: resolved.source ?? 'none',
          clientId: resolved.client.clientId,
          email: resolved.client.email,
          name: resolved.client.name
        });
        response.headers.append('set-cookie', cookie);
        return withCors(request, env, response);
      }

      const redirectTo = sanitizeLocalRedirect(url.searchParams.get('redirect_to') ?? url.searchParams.get('redirect') ?? '/support');
      const response = Response.redirect(new URL(redirectTo, url.origin).toString(), 302);
      response.headers.append('set-cookie', cookie);
      return withCors(request, env, response);
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


    if (request.method === 'GET' && url.pathname === '/auth/asap-jwt') {
      const {
        resolveAuthenticatedUpmindClient,
        generateZohoAsapJwt,
        generateZohoAsapRejectedJwt,
        generateZohoAsapSetupValidationJwt,
        resolveClientFromUserToken
      } = await import('./auth');
      const userToken = url.searchParams.get('user_token');
      if (userToken !== null) {
        try {
          const tokenClient = await resolveClientFromUserToken(userToken, env);
          const token = tokenClient ? await generateZohoAsapJwt(tokenClient, env)
            : (userToken === '' || userToken === 'test' || userToken === 'token')
              ? await generateZohoAsapSetupValidationJwt(env)
              : await generateZohoAsapRejectedJwt(env);
          return text(token);
        } catch (err: any) {
          return text(await generateZohoAsapRejectedJwt(env));
        }
      }

      const client = await resolveAuthenticatedUpmindClient(request, env);
      if (!client) return withCors(request, env, json({ ok: false, error: 'Not authenticated' }, 401));
      try {
        const token = await generateZohoAsapJwt(client, env);
        if (url.searchParams.get('format') === 'plain') return withCors(request, env, text(token));
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

    if (request.method === 'POST' && url.pathname === '/auth/logout') {
      const { clearWorkerSessionCookie } = await import('./auth');
      const response = json({ ok: true, loggedOut: true });
      response.headers.append('set-cookie', clearWorkerSessionCookie(env));
      return withCors(request, env, response);
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
      const tables = ['contact_map', 'ticket_map', 'message_map', 'processed_events', 'raw_events', 'oauth_tokens', 'event_failures'];
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
        if (row.origin_system === 'upmind') {
          await handleUpmindWebhook(new Request('https://dummy', { method: 'POST', body: JSON.stringify(payload) }), env);
        } else if (row.origin_system === 'zoho') {
          await handleZohoWebhook(new Request('https://dummy', { method: 'POST', body: JSON.stringify(payload) }), env);
        }
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
      if (row.origin_system === 'upmind') {
        const response = await handleUpmindWebhook(new Request('https://internal/retry', {
          method: 'POST',
          body: JSON.stringify(payload)
        }), env);
        if (response.ok && response.status < 300) retrySucceeded++;
      } else if (row.origin_system === 'zoho') {
        const response = await handleZohoWebhook(new Request('https://internal/retry', {
          method: 'POST',
          body: JSON.stringify(payload)
        }), env);
        if (response.ok && response.status < 300) retrySucceeded++;
      }
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
  let ticketId: string | undefined = extractUpmindTicketId(payload);
  let messageId: string | undefined = extractUpmindMessageId(payload);
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

  // Dacă avem un webhook de tip ticket_message, încearcă să extragi din object/object_id
  if (!ticketId && payload.object && typeof payload.object === 'object') {
    ticketId = (payload.object as any).ticket_id || (payload.object as any).ticketId || ticketId;
  }
  if (!messageId && payload.object_id && payload.object_type === 'ticket_message') {
    messageId = String(payload.object_id);
  }
  if (!clientId && payload.object && typeof payload.object === 'object') {
    clientId = (payload.object as any).client_id || (payload.object as any).clientId || clientId;
  }

  console.log(JSON.stringify({
    source: 'upmind',
    eventName,
    eventKey,
    ticketId,
    messageId,
    clientId,
    keys: Object.keys(payload).slice(0, 20),
    preview: previewPayload(payload)
  }));

  if (await isDuplicate(env, eventKey)) {
    return json({ ok: true, duplicate: true, eventKey });
  }

  await storeRawEvent(env, 'upmind', eventName, eventKey, payload);

  try {
    switch (eventName) {
        // Patch: tratează explicit user_posted_ticket_message_hook
        case 'user_posted_ticket_message_hook':
        case 'client_posted_ticket_message_hook':
        case 'staff_posted_ticket_message_hook':
        case 'ticket_message':
        case 'Ticket Message':
          await syncUpmindMessageToZoho({ ...payload, bridge_origin: 'upmind' }, env);
          break;
    case 'Client created':
    case 'Client updated':
    case 'Client_Create':
    case 'Client_Update':
      await syncUpmindClientToZoho({ ...payload, bridge_origin: 'upmind' }, env);
      break;
    case 'Client opened new ticket':
    case 'Staff opened new ticket':
    case 'Ticket_Add':
      await syncUpmindTicketToZoho({ ...payload, bridge_origin: 'upmind' }, env);
      break;
    case 'Client posted ticket message':
    case 'Staff replied to ticket':
    case 'Ticket client replied':
      await syncUpmindMessageToZoho({ ...payload, bridge_origin: 'upmind' }, env);
      break;
    case 'Ticket closed':
    case 'Ticket reopened':
    case 'Ticket waiting response':
    case 'Ticket in progress':
      await syncUpmindStatusToZoho({ ...payload, bridge_origin: 'upmind' }, env);
      break;
    default:
      if (ticketId && messageId) {
        await syncUpmindMessageToZoho({ ...payload, bridge_origin: 'upmind' }, env);
      } else if (ticketId) {
        await syncUpmindTicketToZoho({ ...payload, bridge_origin: 'upmind' }, env);
      } else if (clientId) {
        await syncUpmindClientToZoho({ ...payload, bridge_origin: 'upmind' }, env);
      }
      break;
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

  return json({ ok: true, source: 'upmind', eventName, eventKey, ticketId, messageId, clientId });
}

async function handleZohoWebhook(request: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  const rawPayload = await readPayload(request);
  const payload = normalizeZohoPayload(rawPayload);
  const eventName = normalizeEventName(firstNonEmpty([
    readString(payload.eventName),
    readString(payload.eventType),
    readString(payload.event),
    readString(payload.name),
    readString(payload.type),
    readString(payload.action),
    recursiveFindString(payload, ['eventName', 'eventType', 'event', 'type', 'action', 'module'])
  ])) ?? 'zoho.unknown';
  const eventKey = await computeEventKey('zoho', request, payload);

  const ticketId = extractZohoTicketId(payload);
  const contactId = extractZohoContactId(payload);
  const messageId = extractZohoMessageId(payload);
  const status = extractZohoStatus(payload);

  console.log(JSON.stringify({
    source: 'zoho',
    eventName,
    eventKey,
    ticketId,
    contactId,
    messageId,
    status,
    keys: Object.keys(payload).slice(0, 20),
    preview: previewPayload(payload)
  }));

  if (await isDuplicate(env, eventKey)) {
    return json({ ok: true, duplicate: true, eventKey });
  }

  await storeRawEvent(env, 'zoho', eventName, eventKey, payload);

  try {
    switch (eventName) {
    case 'Contact_Add':
    case 'Contact_Update':
      await syncZohoContactToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
      break;
    case 'Ticket_Add':
      await syncZohoTicketToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
      break;
    case 'Ticket_Comment_Add':
    case 'Ticket_Thread_Add':
    case 'AGENT':
    case 'ENDUSER':
    case 'END_USER':
    case 'CUSTOMER':
      await syncZohoReplyToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
      break;
    case 'Ticket_Update':
      await syncZohoStatusToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
      break;
    default:
      if (ticketId && messageId) {
        await syncZohoReplyToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
      } else if (ticketId && status) {
        await syncZohoStatusToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
      } else if (ticketId) {
        await syncZohoTicketToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
      } else if (contactId) {
        await syncZohoContactToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
      }
      break;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await recordEventFailure({
      eventKey,
      originSystem: 'zoho',
      eventName,
      errorMessage,
      payloadJson: payload
    }, env);
    return json({ ok: true, accepted: true, source: 'zoho', eventName, eventKey, sync: 'pending', error: errorMessage }, 202);
  }

  await markProcessed(env, eventKey, 'zoho');

  return json({ ok: true, source: 'zoho', eventName, eventKey, ticketId, contactId, messageId, status });
}

// Helper to normalize Zoho webhook payloads
function normalizeZohoPayload(raw: any): any {
  if (raw && typeof raw === 'object' && Array.isArray(raw.value) && raw.value.length > 0) {
    // { value: [{ payload: ... }] }
    if (raw.value[0] && typeof raw.value[0] === 'object' && 'payload' in raw.value[0]) {
      return raw.value[0].payload;
    }
    // { value: [...] } (take first)
    return raw.value[0];
  }
  // { payload: ... }
  if (raw && typeof raw === 'object' && 'payload' in raw) {
    return raw.payload;
  }
  return raw;
// ...existing code...
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
    CREATE TABLE IF NOT EXISTS ticket_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upmind_ticket_id TEXT UNIQUE,
      zoho_ticket_id TEXT UNIQUE,
      upmind_client_id TEXT,
      zoho_contact_id TEXT,
      last_status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.BRIDGE_DB.prepare(`
    CREATE TABLE IF NOT EXISTS message_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upmind_message_id TEXT UNIQUE,
      zoho_message_id TEXT UNIQUE,
      ticket_map_id INTEGER,
      origin_system TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
  await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_ticket_map_upmind_client_id ON ticket_map(upmind_client_id)').run();
  await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_message_map_ticket_map_id ON message_map(ticket_map_id)').run();
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

export async function syncUpmindTicketToZoho(payload: JsonRecord, env: Env): Promise<void> {
  let ticketId = extractUpmindTicketId(payload);
  let clientId = extractUpmindClientId(payload);
  let email = extractUpmindEmail(payload);
  const subject = extractUpmindSubject(payload) ?? `Upmind ticket ${ticketId ?? 'unknown'}`;
  const description = extractUpmindDescription(payload) ?? 'Imported from Upmind webhook';
  const status = mapUpmindStatusToZoho(extractUpmindStatus(payload));

  if (!ticketId) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT zoho_ticket_id FROM ticket_map WHERE upmind_ticket_id = ?1 LIMIT 1'
  ).bind(ticketId).first<{ zoho_ticket_id?: string }>();

  let zohoTicketId = existing?.zoho_ticket_id;
  if ((!zohoTicketId || zohoTicketId.startsWith('pending-')) && hasZohoConfig(env)) {
    // If email is missing, try to fetch client details from Upmind API
    if ((!email || !clientId) && clientId) {
      const client = await fetchUpmindClientById(env, clientId);
      if (client && client.email) {
        email = client.email;
      }
    }
    if (email) {
      await syncUpmindClientToZoho({ ...payload, email }, env);
    }
    // Re-read mapping after possible client sync
    const zohoContactId = (clientId || email)
      ? (await env.BRIDGE_DB.prepare(
        'SELECT zoho_contact_id FROM contact_map WHERE upmind_client_id = ?1 OR email = ?2 LIMIT 1'
      ).bind(clientId ?? null, email ?? null).first<{ zoho_contact_id?: string }>())?.zoho_contact_id
      : undefined;

    if (!zohoContactId) {
      throw new Error(`Cannot create Zoho ticket for Upmind ticket ${ticketId}: no Zoho contact mapping found; sync/create the contact first`);
    }
    const body: JsonRecord = {
      subject,
      departmentId: env.ZDK_DEPARTMENT_ID,
      description,
      status
    };

    if (!zohoContactId.startsWith('pending-')) {
      body.contactId = zohoContactId;
    }

    if (email) {
      body.email = email;
    }

    try {
      const created = await zohoRequest(env, 'POST', '/tickets', body);
      zohoTicketId = readString(created.id) ?? deepReadString(created, ['data', 'id']) ?? zohoTicketId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(JSON.stringify({
        source: 'zoho-api',
        action: 'create-ticket',
        ok: false,
        upmindTicketId: ticketId,
        email,
        contactPending: zohoContactId.startsWith('pending-'),
        error: errorMessage
      }));
      throw new Error(`Cannot create Zoho ticket for Upmind ticket ${ticketId}: ${errorMessage}`);
    }
  } else if (!hasZohoConfig(env)) {
    console.log(JSON.stringify({ source: 'zoho-api', skipped: true, reason: 'missing-config', missing: missingZohoConfig(env) }));
  }

  zohoTicketId = zohoTicketId ?? `pending-zoho-ticket-${ticketId}`;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO ticket_map (upmind_ticket_id, zoho_ticket_id, upmind_client_id, last_status, updated_at)
     VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
     ON CONFLICT(upmind_ticket_id) DO UPDATE SET
       zoho_ticket_id = excluded.zoho_ticket_id,
       upmind_client_id = excluded.upmind_client_id,
       last_status = excluded.last_status,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(ticketId, zohoTicketId, clientId ?? null, status).run();
}

async function syncUpmindMessageToZoho(payload: JsonRecord, env: Env): Promise<void> {
  const ticketId = extractUpmindTicketId(payload);
  const messageId = extractUpmindMessageId(payload);
  const content = formatUpmindToZohoMessage(payload);

  if (!ticketId || !messageId) return;
  const existingMessage = await env.BRIDGE_DB.prepare(
    'SELECT zoho_message_id FROM message_map WHERE upmind_message_id = ?1 LIMIT 1'
  ).bind(messageId).first<{ zoho_message_id?: string }>();
  if (existingMessage?.zoho_message_id && !existingMessage.zoho_message_id.startsWith('pending-')) return;

  let ticket = await getTicketMapByUpmindTicketId(env, ticketId);

  if ((!ticket || !ticket.zoho_ticket_id || ticket.zoho_ticket_id.startsWith('pending-')) && hasZohoConfig(env)) {
    await syncUpmindTicketToZoho(payload, env);
    ticket = await getTicketMapByUpmindTicketId(env, ticketId);
  }

  if (!ticket) {
    throw new Error(`Cannot sync Upmind message ${messageId}: missing ticket mapping for ${ticketId}`);
  }

  let zohoMessageId: string | undefined;

  if (ticket.zoho_ticket_id && !ticket.zoho_ticket_id.startsWith('pending-') && content && hasZohoConfig(env)) {
    const created = await zohoRequest(env, 'POST', `/tickets/${ticket.zoho_ticket_id}/comments`, {
      content,
      isPublic: true
    });
    zohoMessageId = readString(created.id) ?? deepReadString(created, ['data', 'id']);
  } else if (!hasZohoConfig(env)) {
    console.log(JSON.stringify({ source: 'zoho-api', skipped: true, reason: 'missing-config', missing: missingZohoConfig(env) }));
  } else {
    throw new Error(`Cannot sync Upmind message ${messageId}: Zoho ticket is pending/missing or message content is empty`);
  }

  await env.BRIDGE_DB.prepare(
    `INSERT INTO message_map (upmind_message_id, zoho_message_id, ticket_map_id, origin_system)
     VALUES (?1, ?2, ?3, 'upmind')
     ON CONFLICT(upmind_message_id) DO UPDATE SET
       zoho_message_id = COALESCE(excluded.zoho_message_id, message_map.zoho_message_id)`
  ).bind(messageId, zohoMessageId ?? `pending-zoho-message-${messageId}`, ticket.id).run();
}

async function syncUpmindStatusToZoho(payload: JsonRecord, env: Env): Promise<void> {
  const ticketId = extractUpmindTicketId(payload);
  const status = mapUpmindStatusToZoho(extractUpmindStatus(payload));

  if (!ticketId || !status) return;

  const ticket = await env.BRIDGE_DB.prepare(
    'SELECT zoho_ticket_id FROM ticket_map WHERE upmind_ticket_id = ?1 LIMIT 1'
  ).bind(ticketId).first<{ zoho_ticket_id?: string }>();

  if (ticket?.zoho_ticket_id && !ticket.zoho_ticket_id.startsWith('pending-') && hasZohoConfig(env)) {
    await zohoRequest(env, 'PATCH', `/tickets/${ticket.zoho_ticket_id}`, { status });
  } else if (!hasZohoConfig(env)) {
    console.log(JSON.stringify({ source: 'zoho-api', skipped: true, reason: 'missing-config', missing: missingZohoConfig(env) }));
  }

  await env.BRIDGE_DB.prepare(
    'UPDATE ticket_map SET last_status = ?2, updated_at = CURRENT_TIMESTAMP WHERE upmind_ticket_id = ?1'
  ).bind(ticketId, status).run();
}

async function syncZohoContactToUpmind(payload: JsonRecord, env: Env): Promise<void> {
  const zohoContactId = extractZohoContactId(payload);
  const email = extractZohoEmail(payload);

  if (!zohoContactId || !email) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT upmind_client_id FROM contact_map WHERE zoho_contact_id = ?1 OR email = ?2 LIMIT 1'
  ).bind(zohoContactId, email).first<{ upmind_client_id?: string }>();

  let upmindClientId = existing?.upmind_client_id;

  if ((!upmindClientId || upmindClientId.startsWith('pending-')) && hasUpmindConfig(env)) {
    try {
      upmindClientId = await resolveOrCreateUpmindClientId(env, payload, email, zohoContactId);
    } catch (error) {
      console.log(JSON.stringify({
        source: 'upmind-api',
        action: 'resolve-or-create-client',
        ok: false,
        email,
        zohoContactId,
        error: String(error)
      }));
    }
  } else if (!hasUpmindConfig(env)) {
    console.log(JSON.stringify({ source: 'upmind-api', skipped: true, reason: 'missing-config', missing: missingUpmindConfig(env) }));
  }

  upmindClientId = upmindClientId ?? `pending-upmind-${zohoContactId}`;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO contact_map (upmind_client_id, zoho_contact_id, email, updated_at)
     VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
     ON CONFLICT(zoho_contact_id) DO UPDATE SET
       upmind_client_id = excluded.upmind_client_id,
       email = excluded.email,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(upmindClientId, zohoContactId, email).run();
}

async function syncZohoTicketToUpmind(payload: JsonRecord, env: Env): Promise<void> {
  const zohoTicketId = extractZohoTicketId(payload);
  let zohoContactId = extractZohoContactId(payload);
  const status = extractZohoStatus(payload) ?? 'open';

  if (!zohoTicketId) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT upmind_ticket_id FROM ticket_map WHERE zoho_ticket_id = ?1 LIMIT 1'
  ).bind(zohoTicketId).first<{ upmind_ticket_id?: string }>();

  let upmindTicketId = existing?.upmind_ticket_id;
  if ((!upmindTicketId || upmindTicketId.startsWith('pending-')) && hasUpmindConfig(env)) {
    let upmindClientId: string | undefined;

    if (!zohoContactId) {
      const fromTicketMap = await env.BRIDGE_DB.prepare(
        'SELECT zoho_contact_id FROM ticket_map WHERE zoho_ticket_id = ?1 LIMIT 1'
      ).bind(zohoTicketId).first<{ zoho_contact_id?: string }>();
      zohoContactId = fromTicketMap?.zoho_contact_id;
    }

    const zohoEmail = extractZohoEmail(payload);
    if ((zohoContactId || zohoEmail) && hasUpmindConfig(env)) {
      await syncZohoContactToUpmind(payload, env);
    }

    if (zohoContactId) {
      upmindClientId = (await env.BRIDGE_DB.prepare(
        'SELECT upmind_client_id FROM contact_map WHERE zoho_contact_id = ?1 LIMIT 1'
      ).bind(zohoContactId).first<{ upmind_client_id?: string }>())?.upmind_client_id;
    }
    if (!upmindClientId && zohoEmail) {
      upmindClientId = (await env.BRIDGE_DB.prepare(
        'SELECT upmind_client_id FROM contact_map WHERE email = ?1 LIMIT 1'
      ).bind(zohoEmail).first<{ upmind_client_id?: string }>())?.upmind_client_id;
    }

    try {
      const created = await upmindRequest(env, 'POST', '/tickets', stripUndefined({
        clientId: upmindClientId,
        subject: extractZohoSubject(payload) ?? `Zoho ticket ${zohoTicketId}`,
        description: extractZohoDescription(payload) ?? 'Imported from Zoho webhook',
        status
      }));
      upmindTicketId = readString(created.id)
        ?? deepReadString(created, ['data', 'id'])
        ?? deepReadString(created, ['ticket', 'id'])
        ?? upmindTicketId;
    } catch (error) {
      console.log(JSON.stringify({
        source: 'upmind-api',
        action: 'create-ticket',
        ok: false,
        zohoTicketId,
        error: String(error)
      }));
    }
  } else if (!hasUpmindConfig(env)) {
    console.log(JSON.stringify({ source: 'upmind-api', skipped: true, reason: 'missing-config', missing: missingUpmindConfig(env) }));
  }

  upmindTicketId = upmindTicketId ?? `pending-upmind-ticket-${zohoTicketId}`;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO ticket_map (upmind_ticket_id, zoho_ticket_id, zoho_contact_id, last_status, updated_at)
     VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
     ON CONFLICT(zoho_ticket_id) DO UPDATE SET
       upmind_ticket_id = excluded.upmind_ticket_id,
       zoho_contact_id = excluded.zoho_contact_id,
       last_status = excluded.last_status,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(upmindTicketId, zohoTicketId, zohoContactId ?? null, status).run();
}

async function syncZohoReplyToUpmind(payload: JsonRecord, env: Env): Promise<void> {
  const zohoTicketId = extractZohoTicketId(payload);
  const zohoMessageId = extractZohoMessageId(payload);
  const sourceType = deepReadString(payload, ['source', 'type']);
  const commenterType = deepReadString(payload, ['commenter', 'type']);

  if (sourceType === 'SYSTEM' && !formatZohoToUpmindMessage(payload)) return;

  if (!zohoTicketId || !zohoMessageId) {
    // Log and persist failure for missing messageId
    const errorMsg = `Missing required field(s) for Zoho reply sync: ticketId=${zohoTicketId}, messageId=${zohoMessageId}`;
    console.warn(JSON.stringify({
      source: 'zoho',
      error: errorMsg,
      ticketId: zohoTicketId,
      messageId: zohoMessageId,
      keys: Object.keys(payload).slice(0, 20),
      preview: previewPayload(payload)
    }));
    // Optionally persist failure for retry/debug
    if (zohoTicketId) {
      await recordEventFailure({
        eventKey: `zoho-missing-messageId:${zohoTicketId}:${Date.now()}`,
        originSystem: 'zoho',
        eventName: 'Ticket_Thread_Add',
        errorMessage: errorMsg,
        payloadJson: payload,
        retryCount: 0
      }, env);
    }
    return;
  }

  const existingMessage = await env.BRIDGE_DB.prepare(
    'SELECT id FROM message_map WHERE zoho_message_id = ?1 LIMIT 1'
  ).bind(zohoMessageId).first<{ id: number }>();
  if (existingMessage) return;

  const ticket = await env.BRIDGE_DB.prepare(
    'SELECT id, upmind_ticket_id FROM ticket_map WHERE zoho_ticket_id = ?1 LIMIT 1'
  ).bind(zohoTicketId).first<{ id: number; upmind_ticket_id?: string }>();

  if (!ticket) throw new Error(`Cannot sync Zoho reply ${zohoMessageId}: missing ticket mapping for Zoho ticket ${zohoTicketId}`);

  let upmindMessageId: string | undefined;
  if (ticket.upmind_ticket_id && !ticket.upmind_ticket_id.startsWith('pending-') && hasUpmindConfig(env)) {
    const content = formatZohoToUpmindMessage(payload);
    if (!content) throw new Error(`Cannot sync Zoho reply ${zohoMessageId}: empty content`);
    const created = await upmindRequest(env, 'POST', `/tickets/${encodeURIComponent(ticket.upmind_ticket_id)}/messages`, {
      body: content,
      content,
      is_private: false
    });
    upmindMessageId = readString(created.id)
      ?? deepReadString(created, ['data', 'id'])
      ?? deepReadString(created, ['message', 'id']);
  } else if (!hasUpmindConfig(env)) {
    console.log(JSON.stringify({ source: 'upmind-api', skipped: true, reason: 'missing-config', missing: missingUpmindConfig(env) }));
  } else {
    throw new Error(`Cannot sync Zoho reply ${zohoMessageId}: Upmind ticket is pending or missing`);
  }

  if (!upmindMessageId) throw new Error(`Cannot sync Zoho reply ${zohoMessageId}: Upmind did not return a message id`);

  await env.BRIDGE_DB.prepare(
    `INSERT INTO message_map (upmind_message_id, zoho_message_id, ticket_map_id, origin_system)
     VALUES (?1, ?2, ?3, 'zoho')
     ON CONFLICT(zoho_message_id) DO NOTHING`
  ).bind(upmindMessageId, zohoMessageId, ticket.id).run();
}

async function syncZohoStatusToUpmind(payload: JsonRecord, env: Env): Promise<void> {
  const zohoTicketId = extractZohoTicketId(payload);
  const status = extractZohoStatus(payload);

  if (!zohoTicketId || !status) return;

  const ticket = await env.BRIDGE_DB.prepare(
    'SELECT upmind_ticket_id FROM ticket_map WHERE zoho_ticket_id = ?1 LIMIT 1'
  ).bind(zohoTicketId).first<{ upmind_ticket_id?: string }>();

  if (ticket?.upmind_ticket_id && !ticket.upmind_ticket_id.startsWith('pending-') && hasUpmindConfig(env)) {
    try {
      await upmindRequest(env, 'PATCH', `/tickets/${encodeURIComponent(ticket.upmind_ticket_id)}`, { status });
    } catch (error) {
      console.log(JSON.stringify({
        source: 'upmind-api',
        action: 'update-ticket-status',
        ok: false,
        upmindTicketId: ticket.upmind_ticket_id,
        status,
        error: String(error)
      }));
    }
  } else if (!hasUpmindConfig(env)) {
    console.log(JSON.stringify({ source: 'upmind-api', skipped: true, reason: 'missing-config', missing: missingUpmindConfig(env) }));
  }

  await env.BRIDGE_DB.prepare(
    'UPDATE ticket_map SET last_status = ?2, updated_at = CURRENT_TIMESTAMP WHERE zoho_ticket_id = ?1'
  ).bind(zohoTicketId, status).run();
}

async function upmindRequest(env: Env, method: string, path: string, body?: JsonRecord): Promise<JsonRecord> {
  if (!hasUpmindConfig(env)) {
    const missing = missingUpmindConfig(env);
    console.log(JSON.stringify({ source: 'upmind-api', skipped: true, reason: 'missing-config', missing }));
    throw new Error(`Missing Upmind config: ${missing.join(', ')}`);
  }

  const baseUrl = (env.UPMIND_API_BASE_URL ?? 'https://api.upmind.io/api').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'authorization': `Bearer ${env.UPMIND_API_TOKEN}`,
      'content-type': 'application/json'
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

  console.log(JSON.stringify({ source: 'upmind-api', method, path, status: response.status, ok: response.ok, body: parsed }));

  if (!response.ok) {
    throw new Error(`Upmind API request failed: ${method} ${path} (${response.status})`);
  }

  return parsed;
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

function configStatus(env: Env): JsonRecord {
  return {
    upmindApiBaseUrl: Boolean(env.UPMIND_API_BASE_URL),
    upmindApiToken: Boolean(env.UPMIND_API_TOKEN),
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
    upmindContextSharedSecret: Boolean(env.UPMIND_CONTEXT_SHARED_SECRET),
    upmindSessionJwtSecret: Boolean(env.UPMIND_SESSION_JWT_SECRET),
    workerSessionJwtSecret: Boolean(env.WORKER_SESSION_JWT_SECRET || env.UPMIND_CONTEXT_SHARED_SECRET),
    workerSessionCookieName: Boolean(env.WORKER_SESSION_COOKIE_NAME),
    workerSessionTtlSeconds: Boolean(env.WORKER_SESSION_TTL_SECONDS),
    zohoWebhookJwtSecret: Boolean(env.ZDK_WEBHOOK_JWT_SECRET),
    adminToken: Boolean(env.ADMIN_TOKEN)
  };
}

async function resolveOrCreateUpmindClientId(env: Env, payload: JsonRecord, email: string, zohoContactId: string): Promise<string | undefined> {
  try {
    const encodedEmail = encodeURIComponent(email);
    const existing = await upmindRequest(env, 'GET', `/clients?email=${encodedEmail}`);
    const fromSearch = readString(existing.id)
      ?? deepReadString(existing, ['data', 'id'])
      ?? deepReadString(existing, ['client', 'id'])
      ?? readUpmindIdFromArray(existing.data);

    if (fromSearch) return fromSearch;

    const created = await upmindRequest(env, 'POST', '/clients', {
      email,
      lastName: extractUpmindLastName(payload) ?? `Zoho-${zohoContactId}`
    });

    return readString(created.id)
      ?? deepReadString(created, ['data', 'id'])
      ?? deepReadString(created, ['client', 'id']);
  } catch (error) {
    console.log(JSON.stringify({
      source: 'upmind-api',
      action: 'resolve-or-create-client',
      ok: false,
      email,
      zohoContactId,
      error: String(error)
    }));
    return undefined;
  }
}

function readUpmindIdFromArray(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  if (!isRecord(first)) return undefined;
  return readStringLike(first.id);
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

async function getTicketMapByUpmindTicketId(env: Env, ticketId: string): Promise<{ id: number; zoho_ticket_id?: string } | null> {
  return env.BRIDGE_DB.prepare(
    'SELECT id, zoho_ticket_id FROM ticket_map WHERE upmind_ticket_id = ?1 LIMIT 1'
  ).bind(ticketId).first<{ id: number; zoho_ticket_id?: string }>();
}

function extractUpmindTicketId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['upmind_ticket_id']),
    deepReadString(payload, ['ticket_id']),
    deepReadString(payload, ['ticketId']),
    deepReadString(payload, ['object', 'ticket_id']),
    deepReadString(payload, ['object', 'ticketId']),
    deepReadString(payload, ['data', 'ticket', 'id']),
    deepReadString(payload, ['ticket', 'id']),
    recursiveFindString(payload, ['upmind_ticket_id', 'ticketId', 'ticket_id'])
  ]);
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

function extractUpmindMessageId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['upmind_message_id']),
    deepReadString(payload, ['message_id']),
    deepReadString(payload, ['messageId']),
    payload.object_type === 'ticket_message' ? readStringLike(payload.object_id) : undefined,
    deepReadString(payload, ['data', 'message', 'id']),
    deepReadString(payload, ['message', 'id']),
    deepReadString(payload, ['data', 'reply', 'id']),
    deepReadString(payload, ['reply', 'id']),
    recursiveFindString(payload, ['upmind_message_id', 'messageId', 'message_id', 'replyId', 'reply_id'])
  ]);
}

function extractUpmindEmail(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
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

function extractUpmindSubject(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['object', 'ticket', 'subject']),
    deepReadString(payload, ['object', 'subject']),
    deepReadString(payload, ['data', 'ticket', 'subject']),
    deepReadString(payload, ['ticket', 'subject']),
    deepReadString(payload, ['data', 'ticket', 'title']),
    deepReadString(payload, ['ticket', 'title']),
    deepReadString(payload, ['subject']),
    deepReadString(payload, ['title']),
    recursiveFindString(payload, ['subject', 'title'])
  ]);
}

function extractUpmindDescription(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['object', 'body']),
    deepReadString(payload, ['object', 'content']),
    deepReadString(payload, ['object', 'message']),
    deepReadString(payload, ['object', 'ticket', 'description']),
    deepReadString(payload, ['object', 'ticket', 'subject']),
    deepReadString(payload, ['data', 'ticket', 'description']),
    deepReadString(payload, ['ticket', 'description']),
    deepReadString(payload, ['data', 'ticket', 'message']),
    deepReadString(payload, ['ticket', 'message']),
    deepReadString(payload, ['data', 'message', 'content']),
    deepReadString(payload, ['message', 'content']),
    deepReadString(payload, ['description']),
    deepReadString(payload, ['content']),
    deepReadString(payload, ['body']),
    recursiveFindString(payload, ['description', 'content', 'body', 'message'])
  ]);
}

function extractUpmindStatus(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'ticket', 'status']),
    deepReadString(payload, ['ticket', 'status']),
    deepReadString(payload, ['status']),
    recursiveFindString(payload, ['status', 'ticketStatus', 'ticket_status'])
  ]);
}

// Prefer explicit ticketId fields over generic id fields
function extractZohoTicketId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'ticketId']),
    deepReadString(payload, ['ticketId']),
    deepReadString(payload, ['data', 'ticket', 'id']),
    deepReadString(payload, ['ticket', 'id']),
    recursiveFindString(payload, ['ticketId', 'ticket_id']),
    // Only use data.id or id if there is strong evidence this is a ticket event
    (payload['eventName']?.toString().toLowerCase().includes('ticket') ? deepReadString(payload, ['data', 'id']) : undefined),
    (payload['eventName']?.toString().toLowerCase().includes('ticket') ? deepReadString(payload, ['id']) : undefined)
  ]);
}

function extractZohoContactId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'contactId']),
    deepReadString(payload, ['contactId']),
    recursiveFindString(payload, ['contactId', 'contact_id'])
  ]);
}

function extractZohoMessageId(payload: JsonRecord): string | undefined {
  const looksLikeComment = Boolean(
    deepReadString(payload, ['commentedTime']) ||
    deepReadString(payload, ['commenter', 'type']) ||
    deepReadString(payload, ['content']) ||
    deepReadString(payload, ['threadId']) ||
    deepReadString(payload, ['commentId'])
  );

  let id = firstNonEmpty([
    deepReadString(payload, ['data', 'threadId']),
    deepReadString(payload, ['threadId']),
    deepReadString(payload, ['data', 'commentId']),
    deepReadString(payload, ['commentId']),
    recursiveFindString(payload, ['threadId', 'thread_id', 'commentId', 'comment_id', 'messageId', 'message_id']),
    looksLikeComment ? deepReadString(payload, ['id']) : undefined
  ]);
  // If not found, try nested fields (e.g., Ticket_Thread_Add: payload.thread.id, payload.comment.id)
  if (!id && payload.thread && typeof payload.thread === 'object' && 'id' in payload.thread) {
    id = readString((payload.thread as any).id);
  }
  if (!id && payload.comment && typeof payload.comment === 'object' && 'id' in payload.comment) {
    id = readString((payload.comment as any).id);
  }
  // If still not found, try to look for id in the original raw payload shape
  if (!id && Array.isArray(payload.value) && payload.value[0] && payload.value[0].payload) {
    const nested = payload.value[0].payload;
    id = readString(nested.threadId) || readString(nested.commentId) || readString(nested.messageId) || (looksLikeComment ? readString(nested.id) : undefined);
    if (!id && nested.thread && typeof nested.thread === 'object') {
      id = readString(nested.thread.id);
    }
    if (!id && nested.comment && typeof nested.comment === 'object') {
      id = readString(nested.comment.id);
    }
  }
  return id;
}

function extractZohoEmail(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'contact', 'email']),
    deepReadString(payload, ['contact', 'email']),
    deepReadString(payload, ['commenter', 'emailAddress']),
    deepReadString(payload, ['commenter', 'email']),
    deepReadString(payload, ['data', 'email']),
    deepReadString(payload, ['email']),
    recursiveFindString(payload, ['email'])
  ]);
}

function extractZohoStatus(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'status']),
    deepReadString(payload, ['status']),
    recursiveFindString(payload, ['status'])
  ]);
}

function extractZohoSubject(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'subject']),
    deepReadString(payload, ['subject']),
    deepReadString(payload, ['data', 'ticket', 'subject']),
    recursiveFindString(payload, ['subject', 'title'])
  ]);
}

function extractZohoDescription(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'description']),
    deepReadString(payload, ['description']),
    deepReadString(payload, ['data', 'content']),
    deepReadString(payload, ['content']),
    deepReadString(payload, ['data', 'message']),
    deepReadString(payload, ['message']),
    recursiveFindString(payload, ['description', 'content', 'message', 'body'])
  ]);
}

function mapUpmindStatusToZoho(status?: string): string {
  const value = (status ?? '').toLowerCase();

  if (value.includes('close')) return 'Closed';
  if (value.includes('progress')) return 'On Hold';
  if (value.includes('wait')) return 'Open';
  if (value.includes('reopen')) return 'Open';

  return 'Open';
}

function previewPayload(payload: JsonRecord): string {
  try {
    const text = JSON.stringify(payload);
    return text.length > 800 ? `${text.slice(0, 800)}...` : text;
  } catch {
    return '[unserializable]';
  }
}

function htmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatUpmindToZohoMessage(payload: JsonRecord): string {
  const raw = extractUpmindDescription(payload) ?? '';
  const content = raw.trim();
  if (!content) return '';
  return content;
}

function formatZohoToUpmindMessage(payload: JsonRecord): string {
  const raw = htmlToText(extractZohoDescription(payload) ?? '');
  const content = raw.trim();
  if (!content) return '';
  return content;
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
  headers.set('access-control-allow-headers', 'content-type, authorization, x-upmind-client-id, x-upmind-client-email, x-upmind-client-name, x-upmind-auth-signature, x-requested-with');
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
  const fetchJson = (path) => fetch(bridgeOrigin + path, { credentials: 'include' }).then((response) => response.json());

  fetchJson('/auth/upmind-client-context')
    .then((ctx) => {
      if (!ctx || !ctx.authenticated) return;

      let used = false;
      const getJwtTokenCallback = async (success, failure) => {
        try {
          const data = await fetchJson('/auth/asap-jwt');
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

async function verifyWebhookJwt(token: string, env: Env): Promise<boolean> {
  const secret = env.ZDK_WEBHOOK_JWT_SECRET;
  if (!secret) return true;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  try {
    const [headerB64, payloadB64, signatureB64] = parts;
    const header = JSON.parse(base64urlDecode(headerB64)) as JsonRecord;
    const payload = JSON.parse(base64urlDecode(payloadB64)) as JsonRecord;
    if (header.alg !== 'HS256') return false;

    const sigHex = await hmacSha256Hex(secret, `${headerB64}.${payloadB64}`);
    const sigBytes = new Uint8Array(sigHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    const expected = base64url(sigBytes);
    if (!timingSafeEqual(new TextEncoder().encode(signatureB64), new TextEncoder().encode(expected))) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp <= now) return false;
    if (typeof payload.nbf === 'number' && payload.nbf > now) return false;
    if (env.ZDK_WEBHOOK_ISSUER && payload.iss !== env.ZDK_WEBHOOK_ISSUER) return false;
    if (env.ZDK_WEBHOOK_AUDIENCE) {
      const aud = payload.aud;
      if (Array.isArray(aud)) return aud.includes(env.ZDK_WEBHOOK_AUDIENCE);
      return aud === env.ZDK_WEBHOOK_AUDIENCE;
    }

    return true;
  } catch {
    return false;
  }
}

function base64url(input: Uint8Array): string {
  return btoa(String.fromCharCode(...input)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return atob(padded);
}

// Helper to fetch Upmind client details by clientId
export async function fetchUpmindClientById(env: Env, clientId: string): Promise<any> {
  if (!env.UPMIND_API_BASE_URL || !env.UPMIND_API_TOKEN) return null;
  const baseUrl = env.UPMIND_API_BASE_URL.replace(/\/$/, '');
  const url = `${baseUrl}/clients/${encodeURIComponent(clientId)}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${env.UPMIND_API_TOKEN}` }
  });
  if (!res.ok) return null;
  return await res.json();
}
