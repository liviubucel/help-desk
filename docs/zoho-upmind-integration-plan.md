# Zoho Desk + Upmind Integration Rewrite Plan

## Verdict

The current Worker is not a complete Zoho Desk + Upmind helpdesk integration. It is a partial bridge that:

- syncs Upmind client identity to Zoho Desk contacts,
- issues Zoho ASAP / Help Center JWTs,
- has early ticket/message handling inside `src/index.ts`,
- accepts Zoho webhooks but explicitly ignores them,
- does not have a robust normalized sync model,
- does not have real reverse sync from Zoho to Upmind,
- does not separate contact, ticket, message, auth, and API concerns into maintainable modules.

This explains the current symptom: the webhook can arrive, but Zoho does not reliably know who the requester is. The root issue is not that Upmind fails to send the customer. The sample Upmind payload includes the requester data, but the bridge must extract it from nested paths, resolve/create the Zoho contact first, then create/update the Zoho ticket using that contact.

## Security Note

Do not paste raw production Upmind webhook payloads into public tools or tickets. The shared sample payload contained sensitive customer data, session-like JWT values, 2FA/email code fields, phone/address data, IP data, and payment-adjacent metadata.

Recommended follow-up:

- rotate any exposed Upmind tokens if possible,
- invalidate exposed session/JWT-style values if Upmind allows it,
- avoid logging raw webhook payloads in production,
- store sanitized payload previews separately from full raw events,
- protect raw event access behind `ADMIN_TOKEN`.

## Current Repository Findings

Repository:

```text
https://github.com/liviubucel/help-desk.git
```

Current local branch:

```text
main
```

Current notable files:

- `src/index.ts`: contains most routing, Upmind webhook handling, basic contact/ticket/message sync, admin endpoints, and inline helper functions.
- `src/auth.ts`: contains JWT generation and Upmind session resolution.
- `src/webhooks.ts`: contains Upmind webhook signature check and failure recording.
- `src/upmind.ts`: placeholder.
- `src/zoho.ts`: placeholder.
- `src/zoho-oauth.ts`: Zoho OAuth token management.
- `migrations/0001_init.sql`: basic tables for contacts, tickets, messages, raw events, and processed events.
- `README.md`: explicitly says ticket/message sync and Zoho-to-Upmind sync are out of scope.

The current design is too centralized in `src/index.ts` and too incomplete for production ticket sync.

## Official Documentation Conclusions

Upmind:

- Upmind webhooks notify external systems about events.
- Upmind has client triggers.
- Upmind has ticket triggers, including new ticket, ticket closed, reopened, in progress, waiting response, and client replied.
- Upmind has ticket message triggers, including client posted message, staff replied, internal note, updates, and deletes.

Zoho Desk:

- Zoho Desk API root is `https://desk.zoho.com/api/v1`.
- API calls require `Authorization: Zoho-oauthtoken <token>`.
- API calls require `orgId` except organization endpoints.
- Zoho Desk exposes modules such as Tickets and Contacts.
- Zoho ASAP JWT requires SSO/JWT setup for authenticated users.
- Zoho ASAP has both older endpoint-style JWT behavior and newer `ZohoDeskAsap.invoke('login', callback)` behavior.

Main conclusion:

Webhooks alone are not full two-way sync. Upmind -> Zoho can be made robust using webhooks plus Zoho Desk API. Zoho -> Upmind can only be implemented honestly if writable Upmind ticket API endpoints are confirmed and configured.

## Correct Source Of Truth

Use this split:

- Upmind: identity, account, login, billing, client source of truth.
- Zoho Desk: helpdesk UI, agent workflow, knowledge base, tickets, replies, operational support source of truth.

Avoid using Upmind and Zoho as two independent active helpdesks for the same conversations unless a real bidirectional sync layer exists with strong idempotency and loop prevention.

## Required Data Flow

### Upmind Client To Zoho Contact

1. Receive Upmind client/ticket/message webhook.
2. Normalize payload.
3. Extract client id, email, first name, last name, full name.
4. Search Zoho contact by email.
5. Create Zoho contact if missing.
6. Update contact if found.
7. Save mapping in `contact_map`.

### Upmind Ticket To Zoho Ticket

1. Receive Upmind ticket event.
2. Normalize payload.
3. Ensure contact exists first.
4. Look up `ticket_map` by Upmind ticket id.
5. Create Zoho ticket if no mapping exists.
6. Update Zoho ticket if mapping exists.
7. Save Upmind ticket reference and id in mapping and optionally Zoho custom fields.

### Upmind Ticket Message To Zoho Ticket Comment

1. Receive Upmind ticket message event.
2. Normalize payload.
3. Ensure contact exists.
4. Ensure Zoho ticket exists.
5. Dedupe by Upmind message id and checksum.
6. Add Zoho public comment/reply for client-visible messages.
7. Add Zoho private/internal note for private notes if supported.
8. Save mapping in `message_map`.

### Zoho To Upmind

Only enable this if Upmind writable ticket API endpoints are confirmed.

If not confirmed:

- accept Zoho webhooks,
- store/audit them,
- mark reverse sync as disabled,
- never fake success.

## Upmind Payload Mapping

Use these primary paths for requester identity:

```text
client.id:
object.client_id
object.ticket.client.id
client.id
client_id

client.email:
object.ticket.client.email
object.ticket.client.login_email
object.ticket.client.notification_email
object.client.email
client.email
email

client.fullName:
object.ticket.client.fullname
object.ticket.client.full_name
object.ticket.client.fullName
object.client_name
object.actor_name
actor_name

client.firstName:
object.ticket.client.firstname
object.ticket.client.first_name
object.ticket.client.firstName

client.lastName:
object.ticket.client.lastname
object.ticket.client.last_name
object.ticket.client.lastName
```

Use these paths for ticket:

```text
ticket.id:
object.ticket_id
object.ticket.id
ticket_id
ticket.id

ticket.reference:
object.ticket.reference
ticket.reference

ticket.subject:
object.ticket.subject
ticket.subject
subject

ticket.departmentId:
object.ticket.ticket_department_id
object.ticket.department.id
```

Use these paths for message:

```text
message.id:
object.id
object_id
message.id

message.body:
object.body
object.content
message.body
body

message.isPrivate:
object.is_private
is_private

message.actorType:
actor_type
object.actor_type
```

For the sample payload, the correct requester email is:

```text
object.ticket.client.email
```

## Required New Project Structure

```text
src/index.ts
src/types.ts
src/config.ts
src/logger.ts
src/db.ts

src/auth/jwt.ts
src/auth/upmind-session.ts
src/auth/helpcenter.ts
src/auth/asap.ts

src/upmind/normalize.ts
src/upmind/webhooks.ts
src/upmind/api.ts
src/upmind/write-adapter.ts

src/zoho/oauth.ts
src/zoho/client.ts
src/zoho/contacts.ts
src/zoho/tickets.ts
src/zoho/auth.ts
src/zoho/webhooks.ts

src/sync/contacts.ts
src/sync/tickets.ts
src/sync/messages.ts
src/sync/status-map.ts
src/sync/dedupe.ts
src/sync/loop-prevention.ts

src/utils/crypto.ts
src/utils/http.ts
src/utils/json.ts

migrations/0001_init.sql
migrations/0002_oauth_tokens.sql
migrations/0003_sync_model.sql

tests/normalize.test.ts
tests/status-map.test.ts
tests/dedupe.test.ts
tests/jwt.test.ts
```

## Database Model

Required tables:

```text
contact_map
ticket_map
message_map
raw_events
processed_events
event_failures
oauth_tokens
sync_audit
```

### contact_map

```sql
CREATE TABLE IF NOT EXISTS contact_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upmind_client_id TEXT UNIQUE,
  zoho_contact_id TEXT UNIQUE,
  email TEXT,
  full_name TEXT,
  first_name TEXT,
  last_name TEXT,
  last_synced_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contact_map_email ON contact_map(email);
```

### ticket_map

```sql
CREATE TABLE IF NOT EXISTS ticket_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upmind_ticket_id TEXT UNIQUE,
  zoho_ticket_id TEXT UNIQUE,
  upmind_reference TEXT,
  upmind_client_id TEXT,
  zoho_contact_id TEXT,
  created_origin TEXT,
  last_status TEXT,
  last_synced_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ticket_map_reference ON ticket_map(upmind_reference);
CREATE INDEX IF NOT EXISTS idx_ticket_map_client ON ticket_map(upmind_client_id);
```

### message_map

```sql
CREATE TABLE IF NOT EXISTS message_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upmind_message_id TEXT UNIQUE,
  zoho_message_id TEXT UNIQUE,
  ticket_map_id INTEGER,
  direction TEXT NOT NULL,
  checksum TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_map_id) REFERENCES ticket_map(id)
);

CREATE INDEX IF NOT EXISTS idx_message_map_ticket ON message_map(ticket_map_id);
CREATE INDEX IF NOT EXISTS idx_message_map_checksum ON message_map(checksum);
```

### raw_events

```sql
CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT UNIQUE,
  origin_system TEXT NOT NULL,
  event_name TEXT,
  payload_json TEXT NOT NULL,
  sanitized_preview_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### processed_events

```sql
CREATE TABLE IF NOT EXISTS processed_events (
  event_key TEXT PRIMARY KEY,
  origin_system TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);
```

### event_failures

```sql
CREATE TABLE IF NOT EXISTS event_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL,
  origin_system TEXT NOT NULL,
  event_name TEXT,
  error_message TEXT,
  payload_json TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_event_failures_event_key ON event_failures(event_key);
CREATE INDEX IF NOT EXISTS idx_event_failures_origin ON event_failures(origin_system);
```

### oauth_tokens

```sql
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### sync_audit

```sql
CREATE TABLE IF NOT EXISTS sync_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

## Required Endpoints

Public:

```text
GET /health
GET /asap-bootstrap.js
GET /support
GET /webhooks/upmind
POST /webhooks/upmind
GET /webhooks/zoho
POST /webhooks/zoho
```

Auth:

```text
GET /auth/upmind-client-context
POST /auth/upmind-client-context
GET /auth/helpcenter-jwt
GET /auth/helpcenter-launch
GET /auth/helpcenter-jwt-redirect
GET /auth/asap-jwt
POST /auth/asap-jwt
GET /auth/asap-jwt-legacy
POST /auth/asap-jwt-legacy
GET /auth/logout
```

Admin:

```text
GET /admin/health
GET /admin/db-status
GET /admin/failures
GET /debug/raw-event/:eventKey
POST /backfill/reprocess/:eventKey
POST /cron/sync
```

## Required Environment Variables

```text
BRIDGE_DB
ADMIN_TOKEN
CORS_ALLOWED_ORIGINS

UPMIND_API_BASE_URL
UPMIND_API_TOKEN
UPMIND_CLIENT_ENDPOINT_TEMPLATE
UPMIND_WEBHOOK_SECRET
UPMIND_WEBHOOK_SIGNATURE_HEADER
ALLOW_INSECURE_WEBHOOKS
UPMIND_SESSION_JWT_SECRET
UPMIND_SESSION_COOKIE_NAME
UPMIND_SESSION_AUTH_HEADER

ZOHO_CLIENT_ID
ZOHO_CLIENT_SECRET
ZOHO_REFRESH_TOKEN
ZOHO_ACCOUNTS_URL
ZDK_BASE_URL
ZDK_ORG_ID
ZDK_DEPARTMENT_ID
ZDK_IGNORE_SOURCE_ID

ZOHO_ASAP_JWT_SECRET
ZOHO_HC_JWT_SECRET
ZOHO_HC_JWT_TERMINAL_URL
ZOHO_HELP_CENTER_URL
ZOHO_ASAP_JWT_TTL_MS

STATUS_MAP_JSON

UPMIND_TICKET_WRITE_ENABLED
UPMIND_TICKET_WRITE_API_BASE_URL
UPMIND_TICKET_WRITE_API_TOKEN
```

## Status Mapping

Default Upmind to Zoho status map:

```json
{
  "client_opened_new_ticket_hook": "Open",
  "lead_opened_new_ticket_hook": "Open",
  "staff_opened_new_ticket_hook": "Open",
  "ticket_client_replied_hook": "Open",
  "client_posted_ticket_message_hook": "Open",
  "ticket_in_progress_hook": "In Progress",
  "ticket_waiting_response_hook": "Waiting on Customer",
  "ticket_closed_hook": "Closed",
  "client_closed_ticket_hook": "Closed",
  "staff_closed_ticket_hook": "Closed",
  "ticket_reopened_hook": "Open",
  "scheduled_ticket_reopened_hook": "Open"
}
```

Allow override with `STATUS_MAP_JSON`.

## Copilot Rewrite Prompt

Use this exact prompt with Copilot or another code agent:

```text
You are a senior TypeScript integration engineer.

Rewrite this repository into a production-ready Cloudflare Workers + D1 bridge between Upmind and Zoho Desk.

This is not a small patch. The current project is incomplete and too contacts-focused. Refactor or replace the existing code where needed, while preserving useful working parts such as Cloudflare Worker routing, D1 usage, Zoho OAuth refresh, and JWT signing if they are correct.

BUSINESS GOAL

Use Upmind as the identity/account/billing source of truth.
Use Zoho Desk as the operational helpdesk source of truth.

The bridge must support:
- Upmind client identity -> Zoho Desk contact
- Upmind authenticated user -> Zoho ASAP / Help Center JWT login
- Upmind ticket webhook -> Zoho ticket
- Upmind ticket message webhook -> Zoho ticket comment/reply
- optional Zoho -> Upmind write-back only if configured with real Upmind writable API endpoints
- no fake bidirectional sync

IMPORTANT CONTEXT

Upmind webhook payloads can include requester data in nested paths, for example:
- object.client_name
- object.actor_name
- object.ticket.client.full_name
- object.ticket.client.firstname
- object.ticket.client.lastname
- object.ticket.client.email
- object.ticket.client.login_email
- object.ticket.client.notification_email
- object.client_id
- object.ticket.client.id
- object.ticket_id
- object.ticket.id
- object.id for ticket_message id
- object.body for message body

The requester email must be extracted primarily from:
object.ticket.client.email
with fallbacks:
object.ticket.client.login_email
object.ticket.client.notification_email
client.email
email

Do not create Zoho tickets blindly. Always resolve or create the Zoho contact first, then create/update the Zoho ticket using the Zoho contactId or email.

ARCHITECTURE REQUIREMENTS

Create a clean module structure:

src/index.ts
src/types.ts
src/config.ts
src/logger.ts
src/db.ts

src/auth/jwt.ts
src/auth/upmind-session.ts
src/auth/helpcenter.ts
src/auth/asap.ts

src/upmind/normalize.ts
src/upmind/webhooks.ts
src/upmind/api.ts
src/upmind/write-adapter.ts

src/zoho/oauth.ts
src/zoho/client.ts
src/zoho/contacts.ts
src/zoho/tickets.ts
src/zoho/auth.ts
src/zoho/webhooks.ts

src/sync/contacts.ts
src/sync/tickets.ts
src/sync/messages.ts
src/sync/status-map.ts
src/sync/dedupe.ts
src/sync/loop-prevention.ts

src/utils/crypto.ts
src/utils/http.ts
src/utils/json.ts

migrations/0001_init.sql
migrations/0002_oauth_tokens.sql
migrations/0003_sync_model.sql

tests/normalize.test.ts
tests/status-map.test.ts
tests/dedupe.test.ts
tests/jwt.test.ts

AUTH REQUIREMENTS

Implement Zoho Help Center JWT auth endpoints:

GET /auth/helpcenter-jwt
GET /auth/helpcenter-launch
GET /auth/helpcenter-jwt-redirect
GET /auth/logout

The flow:
1. Resolve authenticated Upmind client from server-verifiable source.
2. Ensure Zoho contact exists.
3. Generate JWT signed with ZOHO_HC_JWT_SECRET.
4. Redirect to ZOHO_HC_JWT_TERMINAL_URL or return JSON depending on endpoint.

Implement Zoho ASAP JWT auth endpoints:

GET /auth/asap-jwt
POST /auth/asap-jwt
GET /auth/asap-jwt-legacy
POST /auth/asap-jwt-legacy

Support both:
- legacy Zoho ASAP endpoint-style JWT flow returning plain text JWT if requested
- modern ZohoDeskAsap.invoke('login', callback) flow returning { token }

Implement:

GET /auth/upmind-client-context
POST /auth/upmind-client-context

Never trust browser-provided identity alone. If using handoff from Upmind template, verify it server-side against Upmind API when UPMIND_API_BASE_URL and UPMIND_API_TOKEN are configured. Reject handoff payloads older than 10 minutes.

WEBHOOK REQUIREMENTS

Implement:

POST /webhooks/upmind
GET /webhooks/upmind

POST /webhooks/zoho
GET /webhooks/zoho

Upmind webhook handler must:
- read raw body once
- verify signature if UPMIND_WEBHOOK_SECRET is configured
- allow insecure only if ALLOW_INSECURE_WEBHOOKS=true
- store raw payload in raw_events
- compute deterministic event key from delivery id or SHA-256 hash
- dedupe events
- normalize payload via normalizeUpmindEvent()
- route events:
  - client events -> sync contact
  - ticket events -> sync ticket
  - ticket_message events -> sync message/comment
- record failures in event_failures
- never log secrets, JWTs, access tokens, 2FA codes, phone numbers, addresses, raw full payloads, or payment details

Zoho webhook handler must:
- not be ignored
- store raw payload
- dedupe events
- detect origin marker to prevent loops
- process ticket status changes and agent replies if Zoho webhook payload contains enough information
- call Upmind write adapter only when reverse sync is enabled and configured
- otherwise record a clear skipped_reverse_sync status, not fake success

NORMALIZATION REQUIREMENTS

Create:

normalizeUpmindEvent(payload): NormalizedUpmindEvent

Return shape:

{
  eventKey?: string;
  eventType: string;
  category?: string;
  code?: string;
  client: {
    id?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
  };
  ticket?: {
    id?: string;
    reference?: string;
    subject?: string;
    status?: string;
    departmentId?: string;
    priorityId?: string;
  };
  message?: {
    id?: string;
    body?: string;
    isPrivate?: boolean;
    createdAt?: string;
    actorType?: "client" | "staff" | "lead" | "system" | "unknown";
  };
  raw: unknown;
}

This normalizer must explicitly support Upmind nested paths from the sample payload:
- object.ticket.client.email
- object.ticket.client.login_email
- object.ticket.client.notification_email
- object.ticket.client.fullname
- object.ticket.client.full_name
- object.ticket.client.firstname
- object.ticket.client.lastname
- object.ticket.reference
- object.ticket.subject
- object.ticket.status_id
- object.ticket.department.id
- object.body
- object.id
- object.ticket_id
- object.ticket.id
- object.client_id
- object.ticket.client.id
- actor_type
- hook_category
- hook_code

DATABASE REQUIREMENTS

Create migrations for:

contact_map:
- id
- upmind_client_id unique nullable
- zoho_contact_id unique nullable
- email indexed
- full_name
- first_name
- last_name
- last_synced_at
- created_at
- updated_at

ticket_map:
- id
- upmind_ticket_id unique
- zoho_ticket_id unique
- upmind_reference indexed
- upmind_client_id indexed
- zoho_contact_id
- created_origin
- last_status
- last_synced_at
- created_at
- updated_at

message_map:
- id
- upmind_message_id unique nullable
- zoho_message_id unique nullable
- ticket_map_id indexed
- direction
- checksum indexed
- created_at

raw_events:
- id
- event_key unique
- origin_system
- event_name
- payload_json
- sanitized_preview_json
- created_at

processed_events:
- event_key primary key
- origin_system
- created_at
- expires_at

event_failures:
- id
- event_key indexed
- origin_system
- event_name
- error_message
- payload_json
- retry_count
- created_at
- updated_at

oauth_tokens:
- id
- provider unique
- access_token
- expires_at
- updated_at

sync_audit:
- id
- direction
- object_type
- object_id
- action
- status
- message
- created_at

ZOHO API REQUIREMENTS

Implement Zoho OAuth refresh:
- use ZOHO_CLIENT_ID
- use ZOHO_CLIENT_SECRET
- use ZOHO_REFRESH_TOKEN
- use ZOHO_ACCOUNTS_URL
- cache access token in D1
- refresh before expiry
- never log tokens

Implement Zoho API client:
- base URL default https://desk.zoho.com/api/v1
- include Authorization: Zoho-oauthtoken <token>
- include orgId header from ZDK_ORG_ID
- include content-type JSON
- handle non-2xx responses with safe sanitized logs

Implement contacts:
- search contact by email
- create contact
- update contact
- resolveOrCreateContact(normalized.client)

Implement tickets:
- create ticket with departmentId from ZDK_DEPARTMENT_ID
- include contactId when available
- include email as fallback
- store Upmind reference/id in description or custom fields if configured
- update ticket status
- add public comment/reply for client messages
- add private/internal comment for private notes if Zoho API supports it
- handle attachments if configured; otherwise add audit note

SYNC REQUIREMENTS

Contact sync:
- Upmind client event -> Zoho contact
- search by email first
- if found, update contact and save contact_map
- if missing, create contact and save contact_map
- never create duplicate contact for same email

Ticket sync Upmind -> Zoho:
- ensure contact first
- check ticket_map
- if missing, create Zoho ticket
- if exists, update Zoho ticket
- save map
- map status via configurable status map

Message sync Upmind -> Zoho:
- ensure ticket first
- dedupe by upmind_message_id and checksum
- add comment/reply to mapped Zoho ticket
- save message_map
- do not replay duplicates

Zoho -> Upmind:
Create an interface:

interface UpmindTicketWriteAdapter {
  enabled(): boolean;
  createReply(input: CreateReplyInput): Promise<WriteResult>;
  updateStatus(input: UpdateStatusInput): Promise<WriteResult>;
  addInternalNote?(input: AddInternalNoteInput): Promise<WriteResult>;
}

Default implementation:
- disabled unless explicit UPMIND_TICKET_WRITE_API_BASE_URL and token/endpoint config exist
- logs skipped reverse sync clearly
- never pretends success

STATUS MAP REQUIREMENTS

Create configurable mapping:

Upmind -> Zoho:
- client_opened_new_ticket_hook -> Open
- lead_opened_new_ticket_hook -> Open
- staff_opened_new_ticket_hook -> Open
- ticket_client_replied_hook -> Open
- client_posted_ticket_message_hook -> Open
- ticket_in_progress_hook -> In Progress
- ticket_waiting_response_hook -> Waiting on Customer
- ticket_closed_hook -> Closed
- client_closed_ticket_hook -> Closed
- staff_closed_ticket_hook -> Closed
- ticket_reopened_hook -> Open
- scheduled_ticket_reopened_hook -> Open

Allow override through env var STATUS_MAP_JSON.

LOOP PREVENTION REQUIREMENTS

Implement:
- origin markers
- source_system fields
- event hashes
- processed_events dedupe
- message checksum dedupe
- ignore Zoho webhooks caused by this bridge if detectable
- optional ZDK_IGNORE_SOURCE_ID/sourceId header support if already present

SECURITY REQUIREMENTS

- strict CORS allowlist via CORS_ALLOWED_ORIGINS
- admin endpoints require ADMIN_TOKEN
- never log raw secrets/tokens/JWTs
- sanitize raw payload preview
- reject stale browser handoff payloads older than 10 minutes
- validate request origin for browser auth endpoints
- use no-store cache headers on auth endpoints
- do not expose stack traces in responses

ADMIN ENDPOINTS

Implement:
GET /health
GET /admin/health
GET /admin/db-status
GET /admin/failures
GET /debug/raw-event/:eventKey
POST /backfill/reprocess/:eventKey
POST /cron/sync

Admin/debug/backfill require ADMIN_TOKEN.

TESTS

Add tests for:
- normalizeUpmindEvent with nested sample payload
- email extraction from object.ticket.client.email
- fallback to login_email / notification_email
- contact resolve/create logic
- ticket map idempotency
- message checksum dedupe
- JWT generation
- status mapping
- loop prevention
- Zoho webhook reverse-sync-disabled behavior

README REQUIREMENTS

Rewrite README with:
- architecture
- source of truth decision
- auth setup
- Upmind webhook setup
- Zoho Desk OAuth setup
- Zoho Help Center JWT setup
- Zoho ASAP legacy and modern setup
- D1 migration commands
- local dev
- deployment
- env vars
- limitations
- reverse sync assumptions

KNOWN LIMITS TO DOCUMENT

- Upmind public webhook docs support event notifications.
- Full Zoho -> Upmind ticket write-back must be enabled only when real Upmind writable ticket API endpoints are confirmed and configured.
- Without confirmed Upmind write endpoints, Zoho should be treated as the operational helpdesk source of truth and Upmind tickets should be mirrored one-way into Zoho.

OUTPUT

Return:
1. proposed file tree
2. complete source code changes
3. migrations
4. updated wrangler config if needed
5. updated README
6. test commands
7. deployment checklist
8. Known Limits / Assumptions
```

## Deployment Checklist

1. Confirm Zoho Desk OAuth app scopes for contacts, tickets, comments, and organization access.
2. Generate a valid Zoho refresh token.
3. Set `ZDK_ORG_ID`.
4. Set `ZDK_DEPARTMENT_ID`.
5. Configure Zoho ASAP JWT secret.
6. Configure Zoho Help Center JWT secret and terminal URL if using Help Center login.
7. Configure Upmind webhook URL:

```text
https://help-desk.zebrabyte-uk.workers.dev/webhooks/upmind
```

8. Enable Upmind client, ticket, and ticket message triggers.
9. Configure Upmind API verification variables.
10. Run D1 migrations locally and remotely.
11. Deploy Worker.
12. Send a test Upmind client event.
13. Send a test Upmind ticket event.
14. Verify Zoho contact is created first.
15. Verify Zoho ticket is linked to the contact.
16. Verify Upmind message becomes Zoho comment.
17. Verify duplicate webhook delivery does not create duplicate tickets/messages.
18. Verify Zoho webhook is accepted and either reverse syncs or records reverse sync disabled.

## Known Limits / Assumptions

- Upmind public docs confirm webhook notifications for clients, tickets, and ticket messages.
- Public docs do not prove complete writable ticket API support for all reverse sync operations.
- Therefore, do not advertise full bidirectional sync until Upmind writable ticket endpoints are confirmed.
- Zoho Desk should be the operational support system.
- Upmind should remain the account/login/billing source.
- Browser-provided identity must be verified server-side before issuing Zoho JWTs.
