# help-desk

## Overview
Production-ready bridge between Upmind and Zoho Desk, running on Cloudflare Workers with D1Database. Synchronizes tickets, contacts, and messages between the two systems, provides secure authentication, și expune endpointuri admin/debug/backfill.

## Key Implementation Details
- **Events are marked processed only after successful sync.**
- **Failed events are tracked in the `event_failures` table** (see `migrations/0003_event_failures.sql`).
- **Contact hydration fallback:** If contact info is missing, the worker fetches it from Upmind API before syncing to Zoho.
- **Extractors support both legacy and cron/backfill key shapes** (e.g., `upmind_client_id`, `upmind_ticket_id`).
- **Loop prevention** is enforced through D1 message mapping and Zoho `sourceId` / webhook `ignoreSourceId` support.
- **Upmind-to-Zoho customer SSO** is handled by a Worker-owned secure session cookie created from a signed Upmind launch handoff.
- **Admin endpoints**: `/admin/health`, `/admin/db-status`, `/admin/failures`, `/debug/raw-event/{eventKey}`, `/backfill/reprocess/{eventKey}`.
- **Structured logging** for all major sync steps and errors (never logs secrets/tokens).

## Upmind Customer SSO to Zoho ASAP and Help Center

Upmind does not need to be a JWT identity provider. The Worker can act as the SSO broker:

1. The customer logs into the Upmind client area.
2. Upmind renders or links to the Worker launch URL:
   - `GET /auth/upmind-launch?client_id=<UPMIND_CLIENT_ID>&email=<EMAIL>&name=<NAME>&sig=<HEX_HMAC>&redirect_to=/support`
3. The Worker verifies `sig` with `UPMIND_CONTEXT_SHARED_SECRET`.
4. If valid, the Worker issues its own short-lived secure session cookie:
   - default cookie name: `ZBT_SUPPORT_SESSION`
5. The support page loads `/asap-bootstrap.js`.
6. The bootstrap calls `/auth/upmind-client-context` and `/auth/asap-jwt` with `credentials: include`.
7. `/auth/asap-jwt` returns a Zoho ASAP JWT for the same Upmind customer identity.
8. `/auth/helpcenter-jwt`, `/auth/helpcenter-launch`, and `/auth/helpcenter-jwt-redirect` use the same resolved identity for Help Center SSO.

### Identity Resolution Order

`resolveAuthenticatedUpmindClient()` checks identity sources in this production order:

1. Signed Upmind headers:
   - `X-Upmind-Client-Id`
   - `X-Upmind-Client-Email`
   - `X-Upmind-Client-Name`
   - `X-Upmind-Auth-Signature`
2. Upmind session JWT, if configured with `UPMIND_SESSION_JWT_SECRET`.
3. Worker-owned session cookie created by `/auth/upmind-launch`.
4. Dev query params only when `ALLOW_DEV_AUTH_CONTEXT === "true"`.

`GET /auth/upmind-client-context` returns safe diagnostics:

```json
{
  "authenticated": true,
  "source": "worker_session",
  "clientId": "123",
  "email": "client@example.com",
  "name": "Client Name"
}
```

### Signed Launch URL

Canonical string:

```text
${client_id}:${email}:${name ?? ''}
```

Signature:

```text
hex(hmac_sha256(UPMIND_CONTEXT_SHARED_SECRET, canonical_string))
```

Example:

```text
https://help-desk.zebrabyte-uk.workers.dev/auth/upmind-launch?client_id=12345&email=client%40example.com&name=Client%20Name&sig=<64-char-hex-hmac>&redirect_to=/support
```

For API/diagnostic launches, add `response=json`.

### Required Env Vars for Customer SSO

- `UPMIND_CONTEXT_SHARED_SECRET` — verifies signed Upmind launch params and signed headers.
- `WORKER_SESSION_JWT_SECRET` — signs the Worker-owned session cookie. If omitted, the Worker falls back to `UPMIND_CONTEXT_SHARED_SECRET`.
- `WORKER_SESSION_COOKIE_NAME` — optional, defaults to `ZBT_SUPPORT_SESSION`.
- `WORKER_SESSION_TTL_SECONDS` — optional, defaults to `3600`, max `86400`.
- `ZOHO_ASAP_JWT_SECRET` — signs Zoho ASAP JWTs.
- `ZOHO_HC_JWT_SECRET` — signs Help Center JWTs. If omitted, `ZOHO_ASAP_JWT_SECRET` is used.
- `ZOHO_HC_JWT_TERMINAL_URL` — Zoho Help Center JWT terminal URL, ending with `jwt=`.
- `CORS_ALLOWED_ORIGINS` — comma-separated origins allowed to call auth endpoints with credentials, e.g. `https://portal.zebrabyte.ro,https://help-desk.zebrabyte-uk.workers.dev`.

### Help Center Launch

- `GET /auth/helpcenter-jwt` returns a token.
- `GET /auth/helpcenter-launch` returns JSON with `{ token, launchUrl, email }`.
- `GET /auth/helpcenter-jwt-redirect?return_to=/` redirects to the Zoho terminal login URL with a generated JWT.

## Endpoints
- `/webhooks/upmind` — Upmind → Zoho sync
- `/webhooks/zoho` — Zoho → Upmind sync (accepts either `x-zoho-webhook-secret` or `x-zdesk-jwt` header for authentication)
- `/admin/health` — Service health and config status
- `/admin/db-status` — Row counts for all tables
- `/admin/failures` — Inspect failed events
- `/debug/raw-event/{eventKey}` — Fetch raw event payload by eventKey
- `/backfill/reprocess/{eventKey}` — Reprocess a raw event (dangerous)

- `BRIDGE_DB` — D1Database binding
- `UPMIND_API_BASE_URL`, `UPMIND_API_TOKEN`, `UPMIND_WEBHOOK_SECRET`, `UPMIND_CONTEXT_SHARED_SECRET`, `ALLOW_DEV_AUTH_CONTEXT`, `ALLOW_INSECURE_WEBHOOKS`, `UPMIND_WEBHOOK_SIGNATURE_HEADER`
- `ZDK_BASE_URL`, `ZDK_ORG_ID`, `ZDK_DEPARTMENT_ID`, `ZDK_ACCESS_TOKEN`, `ZDK_WEBHOOK_SECRET`
- `ZOHO_HELP_CENTER_URL`, `ZOHO_HC_JWT_SECRET`, `ZOHO_ASAP_JWT_SECRET`, `ZOHO_ASAP_JWT_TTL_MS`
- `ADMIN_TOKEN` — Secret for admin/debug/backfill endpoints

## Zoho Webhook Authentication
The `/webhooks/zoho` endpoint supports the real Zoho Desk webhook authentication mechanism:
- **Primary (native Zoho Desk):** Requires the `x-zdesk-jwt` header (JWT-based auth, sent by Zoho Desk webhooks). No shared secret is required or assumed by default.
- **Optional fallback (custom integrations only):** If you set a custom `ZDK_WEBHOOK_SECRET` in your environment, you may also send it as the `x-zoho-webhook-secret` header. This is NOT used by Zoho Desk by default and is only for custom integrations.

If neither a valid JWT nor a custom secret is present, the request will be rejected with 401.

## Migration Steps
1. Apply all migrations in `migrations/` (including `0003_event_failures.sql`).
2. Deploy updated worker code.
3. Ensure all required environment variables are set.

## Remaining Assumptions/TODOs
- Some edge cases for Upmind/Zoho API responses may require further fallback logic.
- Retry logic for failed events can be further improved.
- Ensure D1Database is not near quota/limits for production scale.

## License
MIT
## Automatizare sincronizare cu Cloudflare Cron Trigger

Sincronizarea se poate face automat folosind Workers Scheduled Triggers (cron) din Cloudflare:

1. Adaugă în wrangler.jsonc:

```
	"triggers": {
		"crons": ["0 * * * *"]
	}
```

Acest exemplu rulează sincronizarea la fiecare oră. Poți schimba expresia cron după nevoie.

2. Worker-ul va apela automat logica de sync la fiecare execuție programată, fără să fie nevoie de apel manual.

Nu este nevoie de token de admin pentru trigger automat.

## Zoho OAuth Token Management

This project now uses automatic Zoho OAuth token refresh. **Do not use a static ZDK_ACCESS_TOKEN.**

### Required Cloudflare Secrets

- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZOHO_ACCOUNTS_URL` (e.g. `https://accounts.zoho.com`)

### D1 Database Migration

Run the migration in `migrations/0002_oauth_tokens.sql` to create the `oauth_tokens` table:

```
CREATE TABLE IF NOT EXISTS oauth_tokens (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	provider TEXT NOT NULL,
	access_token TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider);
```

### How It Works

- All Zoho API calls use a helper `getZohoAccessToken(env)`.
- The helper reads the cached token from D1 and returns it if valid for at least 5 more minutes.
- If expired, it refreshes the token from Zoho using the refresh token and updates D1.
- **No secrets or tokens are ever logged.**

### Cron Sync Endpoint

A periodic/manual sync endpoint is available to ensure all Upmind clients and tickets are synced to Zoho Desk, even if webhooks are missed.

#### Endpoint

- `POST /cron/sync`
	- Requires: `x-admin-token` header (set to your `ADMIN_TOKEN`)
	- Triggers a scan for unsynced/pending contacts and tickets and pushes them to Zoho Desk.
	- Returns: `{ ok: true, contactsSynced, ticketsSynced }`

#### Usage

- Use this endpoint with a scheduler (e.g., Cloudflare Cron Triggers) or trigger manually for backfill/repair.
- Example curl:

```sh
curl -X POST https://<your-worker>/cron/sync -H "x-admin-token: <ADMIN_TOKEN>"
```

#### Purpose

This endpoint ensures robust sync between Upmind and Zoho Desk, even if webhook events are missed or delayed.
# help-desk

## Overview
This project is a production-ready bridge between Upmind and Zoho Desk, running on Cloudflare Workers with D1Database. It synchronizes tickets, contacts, and messages between the two systems, provides secure authentication, and exposes admin/debug/backfill endpoints.

## Features
- Upmind webhook signature verification (timing-safe, HMAC SHA256)
- Zoho webhook protection (shared secret header)
- Idempotency and loop prevention (bridge-origin marker)
- Robust ticket/contact/message sync (bi-directional)
- JWT authentication for Zoho ASAP and Help Center
- Pluggable session resolver for Upmind (with HMAC signature verification)
- Admin, debug, and backfill endpoints (protected)
- Modular, type-safe TypeScript codebase
- SQL migrations for schema evolution

## Endpoints

### Webhooks
- `POST /webhooks/upmind` — Receives Upmind webhooks, verifies HMAC signature, syncs to Zoho
- `POST /webhooks/zoho` — Receives Zoho webhooks, requires `x-zoho-webhook-secret` header, syncs to Upmind
- `GET|HEAD /webhooks/upmind` — Validation endpoint
- `GET|HEAD /webhooks/zoho` — Validation endpoint

### Auth
- `GET /auth/upmind-client-context` — Returns Upmind client context (if authenticated, HMAC header signature required in prod)
- `GET /auth/asap-jwt` — Issues JWT for Zoho ASAP (requires Upmind session)
- `GET /auth/helpcenter-jwt` — Issues JWT for Zoho Help Center (requires Upmind session)
- `GET /auth/helpcenter-launch` — Returns JWT and launch URL for Zoho Help Center
- `POST /auth/logout` — (Stub) Logout endpoint

### Admin/Debug/Backfill (Protected)
- `GET /admin/health` — Service health and config status
- `GET /admin/db-status` — Row counts for all tables
- `GET /debug/raw-event/{eventKey}` — Fetch raw event payload by eventKey
- `POST /backfill/reprocess/{eventKey}` — Reprocess a raw event (dangerous)

## Environment Variables (Env)
- `BRIDGE_DB` — D1Database binding
- `UPMIND_API_BASE_URL`, `UPMIND_API_TOKEN`, `UPMIND_WEBHOOK_SECRET`, `UPMIND_CONTEXT_SHARED_SECRET`, `ALLOW_DEV_AUTH_CONTEXT`, `ALLOW_INSECURE_WEBHOOKS`, `UPMIND_WEBHOOK_SIGNATURE_HEADER`
- `ZDK_BASE_URL`, `ZDK_ORG_ID`, `ZDK_DEPARTMENT_ID`, `ZDK_ACCESS_TOKEN`, `ZDK_WEBHOOK_SECRET`
- `ZOHO_HELP_CENTER_URL`, `ZOHO_HC_JWT_SECRET`, `ZOHO_ASAP_JWT_SECRET`, `ZOHO_ASAP_JWT_TTL_MS`
- `ADMIN_TOKEN` — Secret for admin/debug/backfill endpoints

## Usage
1. Deploy to Cloudflare Workers with D1Database
2. Configure all required environment variables (see above)
3. Set Upmind webhooks to `/webhooks/upmind` (HMAC signature required)
4. Set Zoho webhooks to `/webhooks/zoho` (must include `x-zoho-webhook-secret` header)
5. Use the admin endpoints for health checks and debugging

## Security
- Upmind webhooks: HMAC SHA256 signature verification
- Zoho webhooks: require `x-zoho-webhook-secret` header (shared secret)
- Upmind client context: HMAC SHA256 header signature (reverse proxy injects headers)
- Admin/debug/backfill endpoints require `ADMIN_TOKEN` only
- JWTs are signed with HS256 using Web Crypto API

## Development
- TypeScript (ES2022, strict mode)
- Modular code in `src/`
- SQL migrations in `migrations/`

## License
MIT
