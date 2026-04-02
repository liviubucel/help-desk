export interface Env {
  BRIDGE_DB: D1Database;
  UPMIND_API_BASE_URL?: string;
  UPMIND_API_TOKEN?: string;
  UPMIND_WEBHOOK_SECRET?: string;
  ZDK_BASE_URL?: string;
  ZDK_ORG_ID?: string;
  ZDK_DEPARTMENT_ID?: string;
  ZDK_ACCESS_TOKEN?: string;
  ZDK_WEBHOOK_AUDIENCE?: string;
  ZDK_WEBHOOK_ISSUER?: string;
  ZDK_IGNORE_SOURCE_ID?: string;
}

type JsonRecord = Record<string, unknown>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'help-desk-bridge', time: new Date().toISOString() });
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/upmind') {
      return handleUpmindWebhook(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/zoho') {
      return handleZohoWebhook(request, env);
    }

    return json({ ok: false, error: 'Not found' }, 404);
  }
};

async function handleUpmindWebhook(request: Request, env: Env): Promise<Response> {
  const payload = await request.json<JsonRecord>();
  const eventName = readString(payload.event) ?? readString(payload.name) ?? 'upmind.unknown';
  const eventKey = await computeEventKey('upmind', request, payload);

  if (await isDuplicate(env, eventKey)) {
    return json({ ok: true, duplicate: true, eventKey });
  }

  await markProcessed(env, eventKey, 'upmind');
  await storeRawEvent(env, 'upmind', eventName, eventKey, payload);

  switch (eventName) {
    case 'Client created':
    case 'Client updated':
    case 'Client_Create':
    case 'Client_Update':
      await syncUpmindClientToZoho(payload, env);
      break;
    case 'Client opened new ticket':
    case 'Staff opened new ticket':
    case 'Ticket_Add':
      await syncUpmindTicketToZoho(payload, env);
      break;
    case 'Client posted ticket message':
    case 'Staff replied to ticket':
    case 'Ticket client replied':
      await syncUpmindMessageToZoho(payload, env);
      break;
    case 'Ticket closed':
    case 'Ticket reopened':
    case 'Ticket waiting response':
    case 'Ticket in progress':
      await syncUpmindStatusToZoho(payload, env);
      break;
    default:
      break;
  }

  return json({ ok: true, source: 'upmind', eventName, eventKey });
}

async function handleZohoWebhook(request: Request, env: Env): Promise<Response> {
  // TODO: verify X-ZDesk-JWT against Zoho's JWK set before production use.
  const payload = await request.json<JsonRecord>();
  const eventName = readString(payload.eventName) ?? readString(payload.eventType) ?? 'zoho.unknown';
  const eventKey = await computeEventKey('zoho', request, payload);

  if (await isDuplicate(env, eventKey)) {
    return json({ ok: true, duplicate: true, eventKey });
  }

  await markProcessed(env, eventKey, 'zoho');
  await storeRawEvent(env, 'zoho', eventName, eventKey, payload);

  switch (eventName) {
    case 'Contact_Add':
    case 'Contact_Update':
      await syncZohoContactToUpmind(payload, env);
      break;
    case 'Ticket_Add':
      await syncZohoTicketToUpmind(payload, env);
      break;
    case 'Ticket_Comment_Add':
    case 'Ticket_Thread_Add':
      await syncZohoReplyToUpmind(payload, env);
      break;
    case 'Ticket_Update':
      await syncZohoStatusToUpmind(payload, env);
      break;
    default:
      break;
  }

  return json({ ok: true, source: 'zoho', eventName, eventKey });
}

async function syncUpmindClientToZoho(payload: JsonRecord, env: Env): Promise<void> {
  const clientId = deepReadString(payload, ['data', 'client', 'id']) ?? deepReadString(payload, ['client', 'id']);
  const email = deepReadString(payload, ['data', 'client', 'email']) ?? deepReadString(payload, ['client', 'email']);

  if (!clientId || !email) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT zoho_contact_id FROM contact_map WHERE upmind_client_id = ?1 OR email = ?2 LIMIT 1'
  )
    .bind(clientId, email)
    .first<{ zoho_contact_id?: string }>();

  const zohoContactId = existing?.zoho_contact_id ?? `pending-zoho-${clientId}`;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO contact_map (upmind_client_id, zoho_contact_id, email, updated_at)
     VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
     ON CONFLICT(upmind_client_id) DO UPDATE SET
       zoho_contact_id = excluded.zoho_contact_id,
       email = excluded.email,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(clientId, zohoContactId, email)
    .run();
}

async function syncUpmindTicketToZoho(payload: JsonRecord, env: Env): Promise<void> {
  const ticketId = deepReadString(payload, ['data', 'ticket', 'id']) ?? deepReadString(payload, ['ticket', 'id']);
  const clientId = deepReadString(payload, ['data', 'client', 'id']) ?? deepReadString(payload, ['client', 'id']);

  if (!ticketId) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT zoho_ticket_id FROM ticket_map WHERE upmind_ticket_id = ?1 LIMIT 1'
  )
    .bind(ticketId)
    .first<{ zoho_ticket_id?: string }>();

  const zohoTicketId = existing?.zoho_ticket_id ?? `pending-zoho-ticket-${ticketId}`;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO ticket_map (upmind_ticket_id, zoho_ticket_id, upmind_client_id, last_status, updated_at)
     VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
     ON CONFLICT(upmind_ticket_id) DO UPDATE SET
       zoho_ticket_id = excluded.zoho_ticket_id,
       upmind_client_id = excluded.upmind_client_id,
       last_status = excluded.last_status,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(ticketId, zohoTicketId, clientId ?? null, 'open')
    .run();
}

async function syncUpmindMessageToZoho(payload: JsonRecord, env: Env): Promise<void> {
  const ticketId = deepReadString(payload, ['data', 'ticket', 'id']) ?? deepReadString(payload, ['ticket', 'id']);
  const messageId = deepReadString(payload, ['data', 'message', 'id']) ?? deepReadString(payload, ['message', 'id']);

  if (!ticketId || !messageId) return;

  const ticket = await env.BRIDGE_DB.prepare(
    'SELECT id, zoho_ticket_id FROM ticket_map WHERE upmind_ticket_id = ?1 LIMIT 1'
  )
    .bind(ticketId)
    .first<{ id: number; zoho_ticket_id?: string }>();

  if (!ticket) return;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO message_map (upmind_message_id, zoho_message_id, ticket_map_id, origin_system)
     VALUES (?1, ?2, ?3, 'upmind')
     ON CONFLICT(upmind_message_id) DO NOTHING`
  )
    .bind(messageId, `pending-zoho-message-${messageId}`, ticket.id)
    .run();
}

async function syncUpmindStatusToZoho(payload: JsonRecord, env: Env): Promise<void> {
  const ticketId = deepReadString(payload, ['data', 'ticket', 'id']) ?? deepReadString(payload, ['ticket', 'id']);
  const status = deepReadString(payload, ['data', 'ticket', 'status']) ?? deepReadString(payload, ['ticket', 'status']);

  if (!ticketId || !status) return;

  await env.BRIDGE_DB.prepare(
    'UPDATE ticket_map SET last_status = ?2, updated_at = CURRENT_TIMESTAMP WHERE upmind_ticket_id = ?1'
  )
    .bind(ticketId, status)
    .run();
}

async function syncZohoContactToUpmind(payload: JsonRecord, env: Env): Promise<void> {
  const zohoContactId = deepReadString(payload, ['data', 'id']) ?? deepReadString(payload, ['id']);
  const email = deepReadString(payload, ['data', 'email']) ?? deepReadString(payload, ['email']);

  if (!zohoContactId || !email) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT upmind_client_id FROM contact_map WHERE zoho_contact_id = ?1 OR email = ?2 LIMIT 1'
  )
    .bind(zohoContactId, email)
    .first<{ upmind_client_id?: string }>();

  const upmindClientId = existing?.upmind_client_id ?? `pending-upmind-${zohoContactId}`;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO contact_map (upmind_client_id, zoho_contact_id, email, updated_at)
     VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
     ON CONFLICT(zoho_contact_id) DO UPDATE SET
       upmind_client_id = excluded.upmind_client_id,
       email = excluded.email,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(upmindClientId, zohoContactId, email)
    .run();
}

async function syncZohoTicketToUpmind(payload: JsonRecord, env: Env): Promise<void> {
  const zohoTicketId = deepReadString(payload, ['data', 'id']) ?? deepReadString(payload, ['id']);
  const zohoContactId = deepReadString(payload, ['data', 'contactId']) ?? deepReadString(payload, ['contactId']);

  if (!zohoTicketId) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT upmind_ticket_id FROM ticket_map WHERE zoho_ticket_id = ?1 LIMIT 1'
  )
    .bind(zohoTicketId)
    .first<{ upmind_ticket_id?: string }>();

  const upmindTicketId = existing?.upmind_ticket_id ?? `pending-upmind-ticket-${zohoTicketId}`;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO ticket_map (upmind_ticket_id, zoho_ticket_id, zoho_contact_id, last_status, updated_at)
     VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
     ON CONFLICT(zoho_ticket_id) DO UPDATE SET
       upmind_ticket_id = excluded.upmind_ticket_id,
       zoho_contact_id = excluded.zoho_contact_id,
       last_status = excluded.last_status,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(upmindTicketId, zohoTicketId, zohoContactId ?? null, 'open')
    .run();
}

async function syncZohoReplyToUpmind(payload: JsonRecord, env: Env): Promise<void> {
  const zohoTicketId = deepReadString(payload, ['data', 'ticketId']) ?? deepReadString(payload, ['ticketId']);
  const zohoMessageId = deepReadString(payload, ['data', 'id']) ?? deepReadString(payload, ['id']);

  if (!zohoTicketId || !zohoMessageId) return;

  const ticket = await env.BRIDGE_DB.prepare(
    'SELECT id, upmind_ticket_id FROM ticket_map WHERE zoho_ticket_id = ?1 LIMIT 1'
  )
    .bind(zohoTicketId)
    .first<{ id: number; upmind_ticket_id?: string }>();

  if (!ticket) return;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO message_map (upmind_message_id, zoho_message_id, ticket_map_id, origin_system)
     VALUES (?1, ?2, ?3, 'zoho')
     ON CONFLICT(zoho_message_id) DO NOTHING`
  )
    .bind(`pending-upmind-message-${zohoMessageId}`, zohoMessageId, ticket.id)
    .run();
}

async function syncZohoStatusToUpmind(payload: JsonRecord, env: Env): Promise<void> {
  const zohoTicketId = deepReadString(payload, ['data', 'id']) ?? deepReadString(payload, ['id']);
  const status = deepReadString(payload, ['data', 'status']) ?? deepReadString(payload, ['status']);

  if (!zohoTicketId || !status) return;

  await env.BRIDGE_DB.prepare(
    'UPDATE ticket_map SET last_status = ?2, updated_at = CURRENT_TIMESTAMP WHERE zoho_ticket_id = ?1'
  )
    .bind(zohoTicketId, status)
    .run();
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
  )
    .bind(eventKey)
    .first();

  return Boolean(row);
}

async function markProcessed(env: Env, eventKey: string, originSystem: string): Promise<void> {
  await env.BRIDGE_DB.prepare(
    `INSERT OR IGNORE INTO processed_events (event_key, origin_system, expires_at)
     VALUES (?1, ?2, datetime('now', '+14 day'))`
  )
    .bind(eventKey, originSystem)
    .run();
}

async function storeRawEvent(
  env: Env,
  originSystem: string,
  eventName: string,
  eventKey: string,
  payload: JsonRecord
): Promise<void> {
  await env.BRIDGE_DB.prepare(
    `INSERT INTO raw_events (origin_system, event_name, event_key, payload_json)
     VALUES (?1, ?2, ?3, ?4)`
  )
    .bind(originSystem, eventName, eventKey, JSON.stringify(payload))
    .run();
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function deepReadString(source: JsonRecord, path: string[]): string | undefined {
  let current: unknown = source;

  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in (current as Record<string, unknown>))) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return readString(current);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  });
}
