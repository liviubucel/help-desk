
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