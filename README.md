# help-desk

Cloudflare Worker bridge between Upmind and Zoho Desk.

Upmind is treated as the identity/account/billing source of truth. Zoho Desk is treated as the operational helpdesk source of truth.

The Worker supports:

- Upmind client identity to Zoho Desk contact sync
- Upmind session or server-verified handoff to Zoho ASAP JWT
- Upmind session to Zoho Help Center JWT
- Upmind ticket webhooks to Zoho Desk tickets
- Upmind ticket message webhooks to Zoho Desk comments
- Zoho webhook ingestion with safe reverse-sync-disabled auditing unless writable Upmind ticket API endpoints are configured

## Architecture

The app is intentionally split into small modules:

- `src/index.ts`: Worker router only
- `src/upmind/normalize.ts`: normalizes nested Upmind payloads
- `src/upmind/webhooks.ts`: Upmind webhook verification, storage, dedupe, dispatch
- `src/upmind/write-adapter.ts`: optional Zoho-to-Upmind write adapter
- `src/zoho/client.ts`: Zoho Desk API client
- `src/zoho/contacts.ts`: contact search/create/update
- `src/zoho/tickets.ts`: ticket create/update/comment helpers
- `src/sync/contacts.ts`: contact resolution and mapping
- `src/sync/tickets.ts`: Upmind ticket to Zoho ticket sync
- `src/sync/messages.ts`: Upmind message to Zoho comment sync
- `src/db.ts`: runtime schema guard, event storage, audit helpers

## Important Limit

Upmind public webhook documentation confirms outbound event notifications for clients, tickets, and ticket messages. Full Zoho to Upmind write-back must only be enabled if you have confirmed writable Upmind ticket API endpoints for replies, statuses, and internal notes.

Without those endpoints, this bridge accepts Zoho webhooks and records that reverse sync is disabled. It does not fake bidirectional sync.

## Upmind Payload Mapping

Requester email is extracted in this order:

```text
object.ticket.client.email
object.ticket.client.login_email
object.ticket.client.notification_email
object.client.email
client.email
email
```

Requester name is extracted from:

```text
object.ticket.client.fullname
object.ticket.client.full_name
object.ticket.client.firstname + object.ticket.client.lastname
object.client_name
object.actor_name
```

Ticket ids are extracted from:

```text
object.ticket_id
object.ticket.id
ticket_id
ticket.id
```

Message ids and body are extracted from:

```text
object.id
object.body
object.content
```

## Auth Flow

### Mode A: Upmind JWT

The customer logs in to Upmind and the support page passes a short-lived Upmind JWT to this Worker via:

```text
Authorization: Bearer <UPMIND_JWT>
?user_token=<UPMIND_JWT>
cookie upmind_session=<UPMIND_JWT>
```

The JWT must contain:

```json
{
  "sub": "upmind-client-id",
  "email": "client@example.com",
  "name": "Client Name",
  "exp": 1770000000
}
```

### Mode B: Upmind API Handoff

Use this when Upmind does not issue client JWTs. The Upmind client area renders the logged-in client context, then the Worker verifies it server-side against the Upmind API before issuing a Zoho JWT.

```html
<script>
  window.ZBT_SUPPORT_CONTEXT = {
    clientId: "{{ client.id }}",
    email: "{{ client.login_email|e('js') }}",
    name: "{{ client.first_name|e('js') }} {{ client.last_name|e('js') }}",
    issued: Date.now()
  };
</script>
<script src="https://help-desk.zebrabyte-uk.workers.dev/asap-bootstrap.js" defer></script>
```

Handoff payloads older than 10 minutes are rejected.

## Endpoints

Public:

```text
GET /health
GET /support
GET /asap-bootstrap.js
GET /webhooks/upmind
POST /webhooks/upmind
GET /webhooks/zoho
POST /webhooks/zoho
```

Auth:

```text
GET /auth/upmind-client-context
POST /auth/upmind-client-context
POST /auth/upmind-api-client-context
GET /auth/asap-jwt
POST /auth/asap-jwt
GET /auth/asap-jwt-legacy
POST /auth/asap-jwt-legacy
GET /auth/helpcenter-jwt
GET /auth/helpcenter-launch
GET /auth/helpcenter-jwt-redirect
GET /auth/logout
```

Admin:

```text
POST /cron/sync
GET /admin/health
GET /admin/db-status
GET /admin/failures
GET /debug/raw-event/{eventKey}
POST /backfill/reprocess/{eventKey}
```

Admin endpoints require `ADMIN_TOKEN` through `x-admin-token` or `Authorization: Bearer`.

## Required Environment Variables

Core:

```text
BRIDGE_DB
ADMIN_TOKEN
CORS_ALLOWED_ORIGINS
```

Upmind:

```text
UPMIND_WEBHOOK_SECRET
UPMIND_WEBHOOK_SIGNATURE_HEADER
ALLOW_INSECURE_WEBHOOKS
UPMIND_API_BASE_URL
UPMIND_API_TOKEN
UPMIND_CLIENT_ENDPOINT_TEMPLATE
UPMIND_SESSION_JWT_SECRET
UPMIND_SESSION_COOKIE_NAME
UPMIND_SESSION_AUTH_HEADER
```

Zoho:

```text
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
```

Optional reverse sync:

```text
UPMIND_TICKET_WRITE_ENABLED
UPMIND_TICKET_WRITE_API_BASE_URL
UPMIND_TICKET_WRITE_API_TOKEN
```

Status override:

```text
STATUS_MAP_JSON
```

## Status Mapping

Default Upmind to Zoho mapping:

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

## Development

```sh
npm run dev
npm exec tsc -- --noEmit
npm run db:migrate:local
npm run db:migrate:remote
npm run deploy
```

## Deployment Checklist

1. Configure Zoho OAuth and `ZDK_ORG_ID`.
2. Configure `ZDK_DEPARTMENT_ID`.
3. Configure Zoho ASAP JWT secret.
4. Configure Help Center JWT secret and terminal URL if using Help Center SSO.
5. Configure Upmind webhook URL:

```text
https://help-desk.zebrabyte-uk.workers.dev/webhooks/upmind
```

6. Enable Upmind client, ticket, and ticket message triggers.
7. Configure Upmind API verification variables for browser handoff auth.
8. Run D1 migrations.
9. Deploy Worker.
10. Send a test client webhook and verify `contact_map`.
11. Send a test ticket webhook and verify `ticket_map`.
12. Send a test ticket message webhook and verify `message_map`.
13. Send duplicate webhook payload and verify no duplicate ticket/comment is created.
