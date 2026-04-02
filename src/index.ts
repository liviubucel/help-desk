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

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/webhooks/zoho') {
      return json({ ok: true, webhook: 'zoho', validation: true });
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/webhooks/upmind') {
      return json({ ok: true, webhook: 'upmind', validation: true });
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

  if (await isDuplicate(env, eventKey)) {
    return json({ ok: true, duplicate: true, eventKey });
  }

  await markProcessed(env, eventKey, 'upmind');
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
    keys: Object.keys(payload).slice(0, 20),
    preview: previewPayload(payload)
  }));

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
      if (ticketId && messageId) {
        await syncUpmindMessageToZoho(payload, env);
      } else if (ticketId) {
        await syncUpmindTicketToZoho(payload, env);
      } else if (clientId) {
        await syncUpmindClientToZoho(payload, env);
      }
      break;
  }

  return json({ ok: true, source: 'upmind', eventName, eventKey, ticketId, messageId, clientId });
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

  if (await isDuplicate(env, eventKey)) {
    return json({ ok: true, duplicate: true, eventKey });
  }

  await markProcessed(env, eventKey, 'zoho');
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
    keys: Object.keys(payload).slice(0, 20),
    preview: previewPayload(payload)
  }));

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
      if (ticketId && messageId) {
        await syncZohoReplyToUpmind(payload, env);
      } else if (ticketId && status) {
        await syncZohoStatusToUpmind(payload, env);
      } else if (ticketId) {
        await syncZohoTicketToUpmind(payload, env);
      } else if (contactId) {
        await syncZohoContactToUpmind(payload, env);
      }
      break;
  }

  return json({ ok: true, source: 'zoho', eventName, eventKey, ticketId, contactId, messageId, status });
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

  await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_contact_map_email ON contact_map(email)').run();
  await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_ticket_map_upmind_client_id ON ticket_map(upmind_client_id)').run();
  await env.BRIDGE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_message_map_ticket_map_id ON message_map(ticket_map_id)').run();
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

async function syncUpmindClientToZoho(payload: JsonRecord, env: Env): Promise<void> {
  const clientId = extractUpmindClientId(payload);
  const email = extractUpmindEmail(payload);

  if (!clientId || !email) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT zoho_contact_id FROM contact_map WHERE upmind_client_id = ?1 OR email = ?2 LIMIT 1'
  ).bind(clientId, email).first<{ zoho_contact_id?: string }>();

  const zohoContactId = existing?.zoho_contact_id ?? `pending-zoho-${clientId}`;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO contact_map (upmind_client_id, zoho_contact_id, email, updated_at)
     VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
     ON CONFLICT(upmind_client_id) DO UPDATE SET
       zoho_contact_id = excluded.zoho_contact_id,
       email = excluded.email,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(clientId, zohoContactId, email).run();
}

async function syncUpmindTicketToZoho(payload: JsonRecord, env: Env): Promise<void> {
  const ticketId = extractUpmindTicketId(payload);
  const clientId = extractUpmindClientId(payload);
  const email = extractUpmindEmail(payload);
  const subject = extractUpmindSubject(payload) ?? `Upmind ticket ${ticketId ?? 'unknown'}`;
  const description = extractUpmindDescription(payload) ?? 'Imported from Upmind webhook';
  const status = mapUpmindStatusToZoho(extractUpmindStatus(payload));

  if (!ticketId) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT zoho_ticket_id FROM ticket_map WHERE upmind_ticket_id = ?1 LIMIT 1'
  ).bind(ticketId).first<{ zoho_ticket_id?: string }>();

  let zohoTicketId = existing?.zoho_ticket_id;

  if ((!zohoTicketId || zohoTicketId.startsWith('pending-')) && hasZohoConfig(env)) {
    const body: JsonRecord = {
      subject,
      departmentId: env.ZDK_DEPARTMENT_ID,
      description,
      status
    };

    if (email) {
      body.email = email;
    }

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

  const ticket = await env.BRIDGE_DB.prepare(
    'SELECT id, zoho_ticket_id FROM ticket_map WHERE upmind_ticket_id = ?1 LIMIT 1'
  ).bind(ticketId).first<{ id: number; zoho_ticket_id?: string }>();

  if (!ticket) return;

  let zohoMessageId: string | undefined;

  if (ticket.zoho_ticket_id && !ticket.zoho_ticket_id.startsWith('pending-') && content && hasZohoConfig(env)) {
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

  const upmindClientId = existing?.upmind_client_id ?? `pending-upmind-${zohoContactId}`;

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

  if (!zohoTicketId) return;

  const existing = await env.BRIDGE_DB.prepare(
    'SELECT upmind_ticket_id FROM ticket_map WHERE zoho_ticket_id = ?1 LIMIT 1'
  ).bind(zohoTicketId).first<{ upmind_ticket_id?: string }>();

  const upmindTicketId = existing?.upmind_ticket_id ?? `pending-upmind-ticket-${zohoTicketId}`;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO ticket_map (upmind_ticket_id, zoho_ticket_id, zoho_contact_id, last_status, updated_at)
     VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
     ON CONFLICT(zoho_ticket_id) DO UPDATE SET
       upmind_ticket_id = excluded.upmind_ticket_id,
       zoho_contact_id = excluded.zoho_contact_id,
       last_status = excluded.last_status,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(upmindTicketId, zohoTicketId, zohoContactId ?? null, extractZohoStatus(payload) ?? 'open').run();
}

async function syncZohoReplyToUpmind(payload: JsonRecord, env: Env): Promise<void> {
  const zohoTicketId = extractZohoTicketId(payload);
  const zohoMessageId = extractZohoMessageId(payload);

  if (!zohoTicketId || !zohoMessageId) return;

  const ticket = await env.BRIDGE_DB.prepare(
    'SELECT id, upmind_ticket_id FROM ticket_map WHERE zoho_ticket_id = ?1 LIMIT 1'
  ).bind(zohoTicketId).first<{ id: number; upmind_ticket_id?: string }>();

  if (!ticket) return;

  await env.BRIDGE_DB.prepare(
    `INSERT INTO message_map (upmind_message_id, zoho_message_id, ticket_map_id, origin_system)
     VALUES (?1, ?2, ?3, 'zoho')
     ON CONFLICT(zoho_message_id) DO NOTHING`
  ).bind(`pending-upmind-message-${zohoMessageId}`, zohoMessageId, ticket.id).run();
}

async function syncZohoStatusToUpmind(payload: JsonRecord, env: Env): Promise<void> {
  const zohoTicketId = extractZohoTicketId(payload);
  const status = extractZohoStatus(payload);

  if (!zohoTicketId || !status) return;

  await env.BRIDGE_DB.prepare(
    'UPDATE ticket_map SET last_status = ?2, updated_at = CURRENT_TIMESTAMP WHERE zoho_ticket_id = ?1'
  ).bind(zohoTicketId, status).run();
}

async function zohoRequest(env: Env, method: string, path: string, body?: JsonRecord): Promise<JsonRecord> {
  if (!hasZohoConfig(env)) {
    return {};
  }

  const baseUrl = (env.ZDK_BASE_URL ?? 'https://desk.zoho.com/api/v1').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'authorization': `Zoho-oauthtoken ${env.ZDK_ACCESS_TOKEN}`,
      'orgId': String(env.ZDK_ORG_ID),
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

  console.log(JSON.stringify({ source: 'zoho-api', method, path, status: response.status, ok: response.ok, body: parsed }));

  if (!response.ok) {
    return {};
  }

  return parsed;
}

function hasZohoConfig(env: Env): boolean {
  return Boolean(env.ZDK_BASE_URL && env.ZDK_ACCESS_TOKEN && env.ZDK_ORG_ID && env.ZDK_DEPARTMENT_ID);
}

function extractUpmindTicketId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'ticket', 'id']),
    deepReadString(payload, ['ticket', 'id']),
    recursiveFindString(payload, ['ticketId', 'ticket_id'])
  ]);
}

function extractUpmindClientId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'client', 'id']),
    deepReadString(payload, ['client', 'id']),
    deepReadString(payload, ['data', 'customer', 'id']),
    deepReadString(payload, ['customer', 'id']),
    recursiveFindString(payload, ['clientId', 'client_id', 'customerId', 'customer_id'])
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
    deepReadString(payload, ['email']),
    recursiveFindString(payload, ['email'])
  ]);
}

function extractUpmindSubject(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
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

function extractZohoTicketId(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
    deepReadString(payload, ['data', 'id']),
    deepReadString(payload, ['id']),
    deepReadString(payload, ['data', 'ticketId']),
    deepReadString(payload, ['ticketId']),
    recursiveFindString(payload, ['ticketId', 'ticket_id'])
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
  return firstNonEmpty([
    deepReadString(payload, ['data', 'threadId']),
    deepReadString(payload, ['threadId']),
    deepReadString(payload, ['data', 'commentId']),
    deepReadString(payload, ['commentId']),
    recursiveFindString(payload, ['threadId', 'thread_id', 'commentId', 'comment_id', 'messageId', 'message_id'])
  ]);
}

function extractZohoEmail(payload: JsonRecord): string | undefined {
  return firstNonEmpty([
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
