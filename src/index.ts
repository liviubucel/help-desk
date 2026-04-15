import type { ScheduledEvent, ExecutionContext } from './cloudflare-workers';
import { handleCronSync } from './cron';
import type { Env } from './types';
import { getZohoAccessToken } from './zoho-oauth';
import { checkUpmindWebhookSignature } from './webhooks';

type JsonRecord = Record<string, unknown>;

type TicketMapRow = {
  id: number;
  upmind_ticket_id?: string;
  zoho_ticket_id?: string;
  upmind_client_id?: string;
  zoho_contact_id?: string;
  last_status?: string;
};

const BRIDGE_FROM_UPMIND = '[bridge-origin:upmind]';
const BRIDGE_FROM_ZOHO = '[bridge-origin:zoho]';

export const scheduled = {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    try {
      await handleCronSync(env);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Scheduled sync error: ${message}`);
    }
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/cron/sync') {
      if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
      try {
        return json(await handleCronSync(env));
      } catch (err: unknown) {
        return json({ ok: false, error: errorMessage(err) }, 500);
      }
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'help-desk-bridge', time: new Date().toISOString(), config: configStatus(env) });
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/webhooks/upmind') {
      return json({ ok: true, webhook: 'upmind', validation: true, config: configStatus(env) });
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/webhooks/zoho') {
      return json({ ok: true, webhook: 'zoho', validation: true, config: configStatus(env) });
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/upmind') {
      const valid = await checkUpmindWebhookSignature(request.clone(), env);
      if (!valid) return json({ ok: false, error: 'Invalid Upmind webhook signature' }, 401);
      return handleUpmindWebhook(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/zoho') {
      const secret = env.ZDK_WEBHOOK_SECRET;
      const header = request.headers.get('x-zoho-webhook-secret');
      if (!secret || !header || header !== secret) {
        return json({ ok: false, error: 'Missing or invalid Zoho webhook secret' }, 401);
      }
      return handleZohoWebhook(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/auth/upmind-client-context') {
      const { resolveAuthenticatedUpmindClient } = await import('./auth');
      const client = await resolveAuthenticatedUpmindClient(request, env);
      return json(client ? { authenticated: true, ...client } : { authenticated: false });
    }

    if (request.method === 'GET' && url.pathname === '/auth/asap-jwt') {
      const { resolveAuthenticatedUpmindClient, generateZohoAsapJwt } = await import('./auth');
      const client = await resolveAuthenticatedUpmindClient(request, env);
      if (!client) return json({ ok: false, error: 'Not authenticated' }, 401);
      try {
        return json({ token: await generateZohoAsapJwt(client, env) });
      } catch (err: unknown) {
        return json({ ok: false, error: errorMessage(err) }, 400);
      }
    }

    if (request.method === 'GET' && url.pathname === '/auth/helpcenter-jwt') {
      const { resolveAuthenticatedUpmindClient, generateZohoHelpCenterJwt } = await import('./auth');
      const client = await resolveAuthenticatedUpmindClient(request, env);
      if (!client) return json({ ok: false, error: 'Not authenticated' }, 401);
      try {
        return json({ token: await generateZohoHelpCenterJwt(client, env) });
      } catch (err: unknown) {
        return json({ ok: false, error: errorMessage(err) }, 400);
      }
    }

    if (request.method === 'GET' && url.pathname === '/auth/helpcenter-launch') {
      const { resolveAuthenticatedUpmindClient, generateZohoHelpCenterJwt } = await import('./auth');
      const client = await resolveAuthenticatedUpmindClient(request, env);
      if (!client) return json({ ok: false, error: 'Not authenticated' }, 401);
      try {
        const token = await generateZohoHelpCenterJwt(client, env);
        const launchUrl = env.ZOHO_HELP_CENTER_URL
          ? `${env.ZOHO_HELP_CENTER_URL}?jwt=${encodeURIComponent(token)}`
          : undefined;
        return json({ token, launchUrl, email: client.email });
      } catch (err: unknown) {
        return json({ ok: false, error: errorMessage(err) }, 400);
      }
    }

    if (request.method === 'POST' && url.pathname === '/auth/logout') {
      return json({ ok: true, loggedOut: true });
    }

    if (url.pathname === '/admin/health') {
      if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
      return json({ ok: true, time: new Date().toISOString(), config: configStatus(env) });
    }

    if (url.pathname === '/admin/db-status') {
      if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
      await ensureSchema(env);
      const tables = ['contact_map', 'ticket_map', 'message_map', 'processed_events', 'raw_events', 'event_failures', 'oauth_tokens'];
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

    if (url.pathname === '/admin/failures') {
      if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
      await ensureSchema(env);
      const rows = await env.BRIDGE_DB.prepare(
        `SELECT event_key, origin_system, event_name, error_message, retry_count, updated_at
         FROM event_failures
         ORDER BY updated_at DESC
         LIMIT 100`
      ).all();
      return json({ ok: true, failures: rows.results });
    }

    if (url.pathname.startsWith('/debug/raw-event/')) {
      if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
      const eventKey = decodeURIComponent(url.pathname.replace('/debug/raw-event/', ''));
      const row = await env.BRIDGE_DB.prepare('SELECT * FROM raw_events WHERE event_key = ?1 LIMIT 1').bind(eventKey).first();
      return json({ ok: true, eventKey, row });
    }

    if (url.pathname.startsWith('/backfill/reprocess/')) {
      if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
      await ensureSchema(env);
      const eventKey = decodeURIComponent(url.pathname.replace('/backfill/reprocess/', ''));
      const row = await env.BRIDGE_DB.prepare('SELECT * FROM raw_events WHERE event_key = ?1 LIMIT 1').bind(eventKey).first<{ origin_system: string; payload_json: string }>();
      if (!row) return json({ ok: false, error: 'Event not found' }, 404);

      await env.BRIDGE_DB.prepare('DELETE FROM processed_events WHERE event_key = ?1').bind(eventKey).run();

      try {
        const payload = JSON.parse(String(row.payload_json));
        if (row.origin_system === 'upmind') {
          return await handleUpmindWebhook(new Request('https://dummy.local/webhooks/upmind', {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'content-type': 'application/json' }
          }), env);
        }
        return await handleZohoWebhook(new Request('https://dummy.local/webhooks/zoho', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: {
            'content-type': 'application/json',
            'x-zoho-webhook-secret': env.ZDK_WEBHOOK_SECRET ?? ''
          }
        }), env);
      } catch (err: unknown) {
        await recordFailure(env, eventKey, row.origin_system, 'reprocess', err, { eventKey });
        return json({ ok: false, error: errorMessage(err) }, 500);
      }
    }

    return json({ ok: false, error: 'Not found' }, 404);
  }
};

async function handleUpmindWebhook(request: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  const payload = await readPayload(request);
  const eventName = normalizeEventName(firstNonEmpty([
    readString(payload.event),
    readString(payload.name),
    readString(payload.type),
    readString(payload.action),
    recursiveFindString(payload, ['event', 'eventName', 'eventType', 'name', 'type', 'action'])
  ])) ?? 'upmind.unknown';
  const eventKey = await computeEventKey('upmind', request, payload);

  if (JSON.stringify(payload).includes(BRIDGE_FROM_ZOHO)) {
    return json({ ok: true, ignored: true, reason: 'loop-prevention', eventKey });
  }

  if (await isDuplicate(env, eventKey)) {
    return json({ ok: true, duplicate: true, eventKey });
  }

  await storeRawEvent(env, 'upmind', eventName, eventKey, payload);

  const ticketId = extractUpmindTicketId(payload);
  const messageId = extractUpmindMessageId(payload);
  const clientId = extractUpmindClientId(payload);

  console.log(JSON.stringify({
    source: 'upmind',
    eventName,
    eventKey,
    ticketId,
    messageId,
    clientId,
    preview: previewPayload(payload)
  }));

  try {
    switch (eventName) {
      case 'Client created':
      case 'Client updated':
      case 'Client_Create':
      case 'Client_Update':
        await syncUpmindClientToZoho({ ...payload, bridge_origin: 'upmind' }, env);
        break;
      case 'Client opened new ticket':
      case 'Staff opened new ticket':
      case 'Ticket_Add':
        await syncUpmindTicketToZoho(withOriginContent(payload, BRIDGE_FROM_UPMIND, 'upmind'), env);
        break;
      case 'Client posted ticket message':
      case 'Staff replied to ticket':
      case 'Ticket client replied':
        await syncUpmindMessageToZoho(withOriginContent(payload, BRIDGE_FROM_UPMIND, 'upmind'), env);
        break;
      case 'Ticket closed':
      case 'Ticket reopened':
      case 'Ticket waiting response':
      case 'Ticket in progress':
        await syncUpmindStatusToZoho({ ...payload, bridge_origin: 'upmind' }, env);
        break;
      default:
        if (ticketId && messageId) {
          await syncUpmindMessageToZoho(withOriginContent(payload, BRIDGE_FROM_UPMIND, 'upmind'), env);
        } else if (ticketId) {
          await syncUpmindTicketToZoho(withOriginContent(payload, BRIDGE_FROM_UPMIND, 'upmind'), env);
        } else if (clientId) {
          await syncUpmindClientToZoho({ ...payload, bridge_origin: 'upmind' }, env);
        }
        break;
    }

    await markProcessed(env, eventKey, 'upmind');
    await clearFailure(env, eventKey);
    return json({ ok: true, source: 'upmind', eventName, eventKey, ticketId, messageId, clientId });
  } catch (err: unknown) {
    await recordFailure(env, eventKey, 'upmind', eventName, err, payload);
    return json({ ok: false, source: 'upmind', eventName, eventKey, error: errorMessage(err) }, 500);
  }
}

async function handleZohoWebhook(request: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  const payload = await readPayload(request);
  const eventName = normalizeEventName(firstNonEmpty([
    readString(payload.eventName),
    readString(payload.eventType),
    readString(payload.event),
    readString(payload.name),
    readString(payload.type),
    readString(payload.action),
    recursiveFindString(payload, ['eventName', 'eventType', 'event', 'name', 'type', 'action', 'module'])
  ])) ?? 'zoho.unknown';
  const eventKey = await computeEventKey('zoho', request, payload);

  if (JSON.stringify(payload).includes(BRIDGE_FROM_UPMIND)) {
    return json({ ok: true, ignored: true, reason: 'loop-prevention', eventKey });
  }

  if (await isDuplicate(env, eventKey)) {
    return json({ ok: true, duplicate: true, eventKey });
  }

  await storeRawEvent(env, 'zoho', eventName, eventKey, payload);

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
    preview: previewPayload(payload)
  }));

  try {
    switch (eventName) {
      case 'Contact_Add':
      case 'Contact_Update':
        await syncZohoContactToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
        break;
      case 'Ticket_Add':
        await syncZohoTicketToUpmind(withOriginContent(payload, BRIDGE_FROM_ZOHO, 'zoho'), env);
        break;
      case 'Ticket_Comment_Add':
      case 'Ticket_Thread_Add':
        await syncZohoReplyToUpmind(withOriginContent(payload, BRIDGE_FROM_ZOHO, 'zoho'), env);
        break;
      case 'Ticket_Update':
        await syncZohoStatusToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
        break;
      default:
        if (ticketId && messageId) {
          await syncZohoReplyToUpmind(withOriginContent(payload, BRIDGE_FROM_ZOHO, 'zoho'), env);
        } else if (ticketId && status) {
          await syncZohoStatusToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
        } else if (ticketId) {
          await syncZohoTicketToUpmind(withOriginContent(payload, BRIDGE_FROM_ZOHO, 'zoho'), env);
        } else if (contactId) {
          await syncZohoContactToUpmind({ ...payload, bridge_origin: 'zoho' }, env);
        }
        break;
    }

    await markProcessed(env, eventKey, 'zoho');
    await clearFailure(env, eventKey);
    return json({ ok: true, source: 'zoho', eventName, eventKey, ticketId, contactId, messageId, status });
  } catch (err: unknown) {
    await recordFailure(env, eventKey, 'zoho', eventName, err, payload);
    return json({ ok: false, source: 'zoho', eventName, eventKey, error: errorMessage(err) }, 500);
  }
}

function withOriginContent(payload: JsonRecord, marker: string, origin: string): JsonRecord {
  return {
    ...payload,
    bridge_origin: origin,
    content: appendOriginMarker(payload.content, marker)
  };
}

function appendOriginMarker(content: unknown, marker: string): unknown {
  if (typeof content === 'string') return content.includes(marker) ? content : `${content}\n${marker}`;
  return content;
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
    CREATE TABLE IF NOT EXISTS event_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT UNIQUE,
      origin_system TEXT NOT NULL,
      event_name TEXT,
      error_message TEXT,
      payload_json TEXT,
      retry_count INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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

  await env.BRIDGE_DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider)').run();
  await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_contact_map_email ON contact_map(email)').run();
  await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_ticket_map_upmind_client_id ON ticket_map(upmind_client_id)').run();
  await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_message_map_ticket_map_id ON message_map(ticket_map_id)').run();
}

async function readPayload(request: Request): Promise<JsonRecord> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    const params = new URLSearchParams(raw);
    const payload: JsonRecord = {};
    for (const [key, value] of params.entries()) payload[key] = value;
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
    zohoContactId = await resolveOrCreateZohoContactId(env, payload, email, clientId);
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
  const ticketId = extractUpmindTicketId(payload);
  const clientId = extractUpmindClientId(payload);
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
    if (!email && clientId && hasUpmindConfig(env)) {
      const hydrated = await fetchUpmindClientById(env, clientId);
      email = extractUpmindEmail(hydrated) ?? email;
    }

    if (email) {
      await syncUpmindClientToZoho({ ...payload, client_id: clientId, email }, env);
    }

    const zohoContactId = await resolveZohoContactMapping(env, clientId, email);
    if (!zohoContactId || zohoContactId.startsWith('pending-')) {
      throw new Error(`Cannot create Zoho ticket for Upmind ticket ${ticketId}: no Zoho contact mapping found`);
    }

    const body: JsonRecord = {
      subject,
      departmentId: env.ZDK_DEPARTMENT_ID,
      contactId: zohoContactId,
      description,
      status
    };
    if (email) body.email = email;

    const created = await zohoRequest(env, 'POST', '/tickets', body);
    zohoTicketId = readString(created.id) ?? deepReadString(created, ['data', 'id']) ?? zohoTicketId;
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
  const content = extractUpmindDescription(payload);
  if (!ticketId || !messageId) return;

  let ticket = await getTicketMapByUpmindTicketId(env, ticketId);
  if (!ticket && hasZohoConfig(env)) {
    await syncUpmindTicketToZoho(payload, env);
    ticket = await getTicketMapByUpmindTicketId(env, ticketId);
  }
  if (!ticket) throw new Error(`Cannot sync Upmind message ${messageId}: missing ticket mapping for ${ticketId}`);
  if (!content) throw new Error(`Cannot sync Upmind message ${messageId}: content is empty`);
  if (!ticket.zoho_ticket_id || ticket.zoho_ticket_id.startsWith('pending-')) {
    throw new Error(`Cannot sync Upmind message ${messageId}: Zoho ticket mapping is pending`);
  }

  let zohoMessageId: string | undefined;
  if (hasZohoConfig(env)) {
    const created = await zohoRequest(env, 'POST', `/tickets/${ticket.zoho_ticket_id}/comments`, {
      content,
      isPublic: true
    });
    zohoMessageId = readString(created.id) ?? deepReadString(created, ['data', 'id']);
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
    upmindClientId = await resolveOrCreateUpmindClientId(env, payload, email, zohoContactId);
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
  const zohoContactId = extractZohoContactId(payload);
  const status = extractZohoStatus(payload) ?? 'open';
  if (!zohoTicketId) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT upmind_ticket_id FROM ticket_map WHERE zoho_ticket_id = ?1 LIMIT 1'
  ).bind(zohoTicketId).first<{ upmind_ticket_id?: string }>();

  let upmindTicketId = existing?.upmind_ticket_id;
  if ((!upmindTicketId || upmindTicketId.startsWith('pending-')) && hasUpmindConfig(env)) {
    let upmindClientId: string | undefined;
    let email: string | undefined;

    if (zohoContactId) {
      const mapping = await env.BRIDGE_DB.prepare(
        'SELECT upmind_client_id, email FROM contact_map WHERE zoho_contact_id = ?1 LIMIT 1'
      ).bind(zohoContactId).first<{ upmind_client_id?: string; email?: string }>();
      upmindClientId = mapping?.upmind_client_id;
      email = mapping?.email;

      if ((!upmindClientId || upmindClientId.startsWith('pending-')) && hasZohoConfig(env)) {
        const hydrated = await fetchZohoContactById(env, zohoContactId);
        email = extractZohoEmail(hydrated) ?? email;
        if (email) {
          await syncZohoContactToUpmind({ ...payload, contactId: zohoContactId, email }, env);
          const refreshed = await env.BRIDGE_DB.prepare(
            'SELECT upmind_client_id FROM contact_map WHERE zoho_contact_id = ?1 OR email = ?2 LIMIT 1'
          ).bind(zohoContactId, email).first<{ upmind_client_id?: string }>();
          upmindClientId = refreshed?.upmind_client_id;
        }
      }
    }

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
  if (!zohoTicketId || !zohoMessageId) return;

  const ticket = await env.BRIDGE_DB.prepare(
    'SELECT id, upmind_ticket_id FROM ticket_map WHERE zoho_ticket_id = ?1 LIMIT 1'
  ).bind(zohoTicketId).first<{ id: number; upmind_ticket_id?: string }>();
  if (!ticket?.upmind_ticket_id || ticket.upmind_ticket_id.startsWith('pending-')) {
    throw new Error(`Cannot sync Zoho reply ${zohoMessageId}: missing Upmind ticket mapping for ${zohoTicketId}`);
  }

  const created = await upmindRequest(env, 'POST', `/tickets/${encodeURIComponent(ticket.upmind_ticket_id)}/messages`, {
    content: extractZohoDescription(payload) ?? 'Imported from Zoho'
  });
  const upmindMessageId = readString(created.id)
    ?? deepReadString(created, ['data', 'id'])
    ?? deepReadString(created, ['message', 'id'])
    ?? `pending-upmind-message-${zohoMessageId}`;

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
    await upmindRequest(env, 'PATCH', `/tickets/${encodeURIComponent(ticket.upmind_ticket_id)}`, { status });
  }

  await env.BRIDGE_DB.prepare(
    'UPDATE ticket_map SET last_status = ?2, updated_at = CURRENT_TIMESTAMP WHERE zoho_ticket_id = ?1'
  ).bind(zohoTicketId, status).run();
}

async function fetchUpmindClientById(env: Env, clientId: string): Promise<JsonRecord> {
  if (!hasUpmindConfig(env)) return {};
  try {
    return await upmindRequest(env, 'GET', `/clients/${encodeURIComponent(clientId)}`);
  } catch {
    return {};
  }
}

async function fetchZohoContactById(env: Env, zohoContactId: string): Promise<JsonRecord> {
  if (!hasZohoConfig(env)) return {};
  try {
    return await zohoRequest(env, 'GET', `/contacts/${encodeURIComponent(zohoContactId)}`);
  } catch {
    return {};
  }
}

async function resolveZohoContactMapping(env: Env, clientId?: string, email?: string): Promise<string | undefined> {
  if (!clientId && !email) return undefined;
  const row = await env.BRIDGE_DB.prepare(
    'SELECT zoho_contact_id FROM contact_map WHERE upmind_client_id = ?1 OR email = ?2 LIMIT 1'
  ).bind(clientId ?? null, email ?? null).first<{ zoho_contact_id?: string }>();
  return row?.zoho_contact_id;
}

async function upmindRequest(env: Env, method: string, path: string, body?: JsonRecord): Promise<JsonRecord> {
  if (!hasUpmindConfig(env)) throw new Error(`Missing Upmind config: ${missingUpmindConfig(env).join(', ')}`);
  const baseUrl = (env.UPMIND_API_BASE_URL ?? 'https://api.upmind.io/api').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.UPMIND_API_TOKEN}`,
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(stripUndefined(body)) : undefined
  });

  const parsed = await parseJsonResponse(response);
  console.log(JSON.stringify({ source: 'upmind-api', method, path, status: response.status, ok: response.ok }));
  if (!response.ok) throw new Error(`Upmind API request failed: ${method} ${path} (${response.status})`);
  return parsed;
}

async function zohoRequest(env: Env, method: string, path: string, body?: JsonRecord): Promise<JsonRecord> {
  if (!hasZohoConfig(env)) throw new Error(`Missing Zoho config: ${missingZohoConfig(env).join(', ')}`);
  const accessToken = await getZohoAccessToken(env);
  const baseUrl = (env.ZDK_BASE_URL ?? 'https://desk.zoho.com/api/v1').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Zoho-oauthtoken ${accessToken}`,
      orgId: String(env.ZDK_ORG_ID),
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(stripUndefined(body)) : undefined
  });

  const parsed = await parseJsonResponse(response);
  console.log(JSON.stringify({ source: 'zoho-api', method, path, status: response.status, ok: response.ok }));
  if (!response.ok) throw new Error(`Zoho API request failed: ${method} ${path} (${response.status})`);
  return parsed;
}

async function parseJsonResponse(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw: text };
  }
}

function hasZohoConfig(env: Env): boolean {
  return Boolean(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN && env.ZDK_ORG_ID && env.ZDK_DEPARTMENT_ID);
}

function missingZohoConfig(env: Env): string[] {
  const missing: string[] = [];
  if (!env.ZOHO_CLIENT_ID) missing.push('ZOHO_CLIENT_ID');
  if (!env.ZOHO_CLIENT_SECRET) missing.push('ZOHO_CLIENT_SECRET');
  if (!env.ZOHO_REFRESH_TOKEN) missing.push('ZOHO_REFRESH_TOKEN');
  if (!env.ZDK_ORG_ID) missing.push('ZDK_ORG_ID');
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
    zohoMissing: missingZohoConfig(env)
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
  } catch {
    return undefined;
  }
}

function readUpmindIdFromArray(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  return isRecord(first) ? readStringLike(first.id) : undefined;
}

async function resolveOrCreateZohoContactId(env: Env, payload: JsonRecord, email: string, clientId: string): Promise<string | undefined> {
  const encodedEmail = encodeURIComponent(email);
  const existing = await zohoRequest(env, 'GET', `/contacts/search?email=${encodedEmail}`);
  const fromSearch = readString(existing.id)
    ?? deepReadString(existing, ['data', 'id'])
    ?? readZohoIdFromArray(existing.data);
  if (fromSearch) return fromSearch;

  const created = await zohoRequest(env, 'POST', '/contacts', {
    email,
    lastName: extractUpmindLastName(payload) ?? `Upmind-${clientId}`
  });
  return readString(created.id) ?? deepReadString(created, ['data', 'id']);
}

function readZohoIdFromArray(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  return isRecord(first) ? readStringLike(first.id) : undefined;
}

async function getTicketMapByUpmindTicketId(env: Env, ticketId: string): Promise<TicketMapRow | null> {
  return env.BRIDGE_DB.prepare(
    'SELECT id, zoho_ticket_id, upmind_ticket_id, upmind_client_id, zoho_contact_id, last_status FROM ticket_map WHERE upmind_ticket_id = ?1 LIMIT 1'
  ).bind(ticketId).first<TicketMapRow>();
}

function extractUpmindTicketId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'ticket', 'id']),
    deepReadString(payload, ['ticket', 'id']),
    readString(payload.upmind_ticket_id),
    recursiveFindString(payload, ['ticketId', 'ticket_id', 'upmind_ticket_id'])
  ]);
}

function extractUpmindClientId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'client', 'id']),
    deepReadString(payload, ['client', 'id']),
    deepReadString(payload, ['data', 'customer', 'id']),
    deepReadString(payload, ['customer', 'id']),
    readString(payload.upmind_client_id),
    recursiveFindString(payload, ['clientId', 'client_id', 'customerId', 'customer_id', 'upmind_client_id'])
  ]);
}

function extractUpmindMessageId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'message', 'id']),
    deepReadString(payload, ['message', 'id']),
    deepReadString(payload, ['data', 'reply', 'id']),
    deepReadString(payload, ['reply', 'id']),
    recursiveFindString(payload, ['messageId', 'message_id', 'replyId', 'reply_id'])
  ]);
}

function extractUpmindEmail(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'client', 'email']),
    deepReadString(payload, ['client', 'email']),
    deepReadString(payload, ['data', 'customer', 'email']),
    deepReadString(payload, ['customer', 'email']),
    readString(payload.email),
    recursiveFindString(payload, ['email'])
  ]);
}

function extractUpmindLastName(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'client', 'lastName']),
    deepReadString(payload, ['client', 'lastName']),
    deepReadString(payload, ['data', 'client', 'last_name']),
    deepReadString(payload, ['client', 'last_name']),
    deepReadString(payload, ['data', 'customer', 'lastName']),
    deepReadString(payload, ['customer', 'lastName']),
    deepReadString(payload, ['data', 'customer', 'last_name']),
    deepReadString(payload, ['customer', 'last_name']),
    recursiveFindString(payload, ['lastName', 'last_name', 'surname', 'familyName', 'family_name'])
  ]);
}

function extractUpmindSubject(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'ticket', 'subject']),
    deepReadString(payload, ['ticket', 'subject']),
    deepReadString(payload, ['data', 'ticket', 'title']),
    deepReadString(payload, ['ticket', 'title']),
    readString(payload.subject),
    readString(payload.title),
    recursiveFindString(payload, ['subject', 'title'])
  ]);
}

function extractUpmindDescription(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'ticket', 'description']),
    deepReadString(payload, ['ticket', 'description']),
    deepReadString(payload, ['data', 'ticket', 'message']),
    deepReadString(payload, ['ticket', 'message']),
    deepReadString(payload, ['data', 'message', 'content']),
    deepReadString(payload, ['message', 'content']),
    readString(payload.description),
    readString(payload.content),
    readString(payload.body),
    recursiveFindString(payload, ['description', 'content', 'body', 'message'])
  ]);
}

function extractUpmindStatus(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'ticket', 'status']),
    deepReadString(payload, ['ticket', 'status']),
    readString(payload.status),
    recursiveFindString(payload, ['status', 'ticketStatus', 'ticket_status'])
  ]);
}

function extractZohoTicketId(payload: JsonRecord): string | undefined {
  const eventName = String(payload.eventName ?? payload.eventType ?? payload.event ?? '').toLowerCase();
  const explicit = firstNonEmpty([
    deepReadString(payload, ['data', 'ticketId']),
    readString(payload.ticketId),
    deepReadString(payload, ['data', 'ticket', 'id']),
    deepReadString(payload, ['ticket', 'id']),
    recursiveFindString(payload, ['ticketId', 'ticket_id'])
  ]);
  if (explicit) return explicit;
  if (eventName.includes('ticket') && !eventName.includes('comment') && !eventName.includes('thread')) {
    return firstNonEmpty([deepReadString(payload, ['data', 'id']), readString(payload.id)]);
  }
  return undefined;
}

function extractZohoContactId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'contactId']),
    readString(payload.contactId),
    recursiveFindString(payload, ['contactId', 'contact_id'])
  ]);
}

function extractZohoMessageId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'threadId']),
    readString(payload.threadId),
    deepReadString(payload, ['data', 'commentId']),
    readString(payload.commentId),
    recursiveFindString(payload, ['threadId', 'thread_id', 'commentId', 'comment_id', 'messageId', 'message_id'])
  ]);
}

function extractZohoEmail(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'email']),
    readString(payload.email),
    recursiveFindString(payload, ['email'])
  ]);
}

function extractZohoStatus(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'status']),
    readString(payload.status),
    recursiveFindString(payload, ['status'])
  ]);
}

function extractZohoSubject(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'subject']),
    readString(payload.subject),
    deepReadString(payload, ['data', 'ticket', 'subject']),
    recursiveFindString(payload, ['subject', 'title'])
  ]);
}

function extractZohoDescription(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'description']),
    readString(payload.description),
    deepReadString(payload, ['data', 'content']),
    readString(payload.content),
    deepReadString(payload, ['data', 'message']),
    readString(payload.message),
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

function recursiveFindString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recursiveFindString(item, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;

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
  return values.find((value): value is string => Boolean(value));
}

function normalizeEventName(value?: string): string | undefined {
  return value ? value.replace(/\s+/g, ' ').trim() : undefined;
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
  const row = await env.BRIDGE_DB.prepare('SELECT event_key FROM processed_events WHERE event_key = ?1 LIMIT 1').bind(eventKey).first();
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

async function recordFailure(env: Env, eventKey: string, originSystem: string, eventName: string, err: unknown, payload: JsonRecord): Promise<void> {
  await env.BRIDGE_DB.prepare(
    `INSERT INTO event_failures (event_key, origin_system, event_name, error_message, payload_json, retry_count, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(event_key) DO UPDATE SET
       error_message = excluded.error_message,
       payload_json = excluded.payload_json,
       event_name = excluded.event_name,
       retry_count = event_failures.retry_count + 1,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(eventKey, originSystem, eventName, errorMessage(err), JSON.stringify(payload)).run();
}

async function clearFailure(env: Env, eventKey: string): Promise<void> {
  await env.BRIDGE_DB.prepare('DELETE FROM event_failures WHERE event_key = ?1').bind(eventKey).run();
}

function stripUndefined(input: JsonRecord): JsonRecord {
  const output: JsonRecord = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
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
    if (!current || typeof current !== 'object' || !(key in (current as Record<string, unknown>))) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return readStringLike(current);
}

function isAdmin(request: Request, env: Env): boolean {
  const adminToken = env.ADMIN_TOKEN;
  if (!adminToken) return false;
  const header = request.headers.get('x-admin-token') || request.headers.get('authorization');
  return header === adminToken || header === `Bearer ${adminToken}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
