# help-desk

Cloudflare Worker bridge for one purpose:

- sync Upmind clients to Zoho Desk contacts
- let an authenticated Upmind client log in to Zoho Desk support with an Upmind session JWT
- let an Upmind client-area handoff log in to Zoho Desk ASAP after server-side Upmind API validation

Everything else is intentionally out of scope: no Zoho-to-Upmind sync, no ticket/message sync, no signed handoff URLs, no Worker-owned session cookie, and no dev auth context.

## Auth Flow

Upmind remains the identity source. There are two supported modes.

### Mode A: Upmind JWT

1. The customer logs in to Upmind.
2. Upmind provides a short-lived JWT for that customer.
3. The support page passes that token to this Worker as:
   - `Authorization: Bearer <UPMIND_JWT>`
   - or `?user_token=<UPMIND_JWT>`
   - or cookie `upmind_session=<UPMIND_JWT>` unless `UPMIND_SESSION_COOKIE_NAME` is configured.
4. The Worker verifies the JWT with `UPMIND_SESSION_JWT_SECRET`.
5. The Worker returns a Zoho ASAP or Help Center JWT for the same customer identity.

The Upmind JWT must contain:

```json
{
  "sub": "upmind-client-id",
  "email": "client@example.com",
  "name": "Client Name",
  "exp": 1770000000
}
```

Accepted client id claims: `clientId`, `client_id`, `upmindClientId`, `upmind_client_id`, `sub`.

Accepted email claims: `email`, `clientEmail`, `client_email`.

Accepted name claims: `name`, `clientName`, `client_name`.

### Mode B: Upmind API Handoff

Use this when Upmind does not issue client JWTs. The Upmind client area must render the logged-in client id and email into the page, then this Worker verifies those values against the Upmind API before issuing the Zoho JWT.

Worker domain currently used by this project:

```text
https://help-desk.zebrabyte-uk.workers.dev
```

Upmind client-area template snippet:

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

Upmind client-area variables used here:

- `{{ client.id }}`
- `{{ client.first_name }}`
- `{{ client.last_name }}`
- `{{ client.login_email }}`

The Worker endpoint used by the bootstrap:

- `POST /auth/upmind-api-client-context`
- `POST /auth/asap-jwt`

Both endpoints:

- require the request origin to match `CORS_ALLOWED_ORIGINS`
- validate `clientId` and `email` through `UPMIND_API_BASE_URL` + `UPMIND_API_TOKEN`
- reject stale handoffs when `issued` or `timestamp` is older than 10 minutes
- sync the client to Zoho Desk before returning the Zoho JWT

## Auth Endpoints

- `GET /auth/upmind-client-context` verifies the Upmind JWT and returns safe client context.
- `GET /auth/asap-jwt` verifies the Upmind JWT and returns `{ "token": "<ZOHO_JWT>" }`.
- `GET /auth/asap-jwt?format=plain` returns the Zoho JWT as plain text.
- `POST /auth/upmind-api-client-context` validates an Upmind client handoff through the Upmind API.
- `POST /auth/asap-jwt` validates an Upmind client handoff through the Upmind API and returns `{ "token": "<ZOHO_JWT>" }`.
- `GET /auth/helpcenter-jwt` returns a Help Center JWT.
- `GET /auth/helpcenter-launch` returns `{ token, launchUrl, email }`.
- `GET /auth/helpcenter-jwt-redirect?return_to=/` redirects to the configured Zoho JWT terminal URL.

## Client Sync

`POST /webhooks/upmind` receives Upmind webhooks, verifies the Upmind webhook signature, extracts the client id and email, and creates or updates the matching Zoho Desk contact.

The maintenance sync only retries pending contact rows from `contact_map`. Tickets and messages are not synced.

## Admin Endpoints

- `GET /health`
- `POST /cron/sync`
- `GET /admin/health`
- `GET /admin/db-status`
- `GET /admin/failures`
- `GET /debug/raw-event/{eventKey}`
- `POST /backfill/reprocess/{eventKey}`

Admin/debug/backfill endpoints require `ADMIN_TOKEN`.

## Required Environment Variables

- `BRIDGE_DB`
- `UPMIND_WEBHOOK_SECRET`
- `UPMIND_SESSION_JWT_SECRET`
- `ZOHO_ASAP_JWT_SECRET`
- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZDK_DEPARTMENT_ID`
- `ADMIN_TOKEN`

Optional:

- `UPMIND_CLIENT_ENDPOINT_TEMPLATE`, defaults to `/clients/{clientId}`
- `UPMIND_SESSION_COOKIE_NAME`
- `UPMIND_SESSION_AUTH_HEADER`
- `UPMIND_WEBHOOK_SIGNATURE_HEADER`
- `ALLOW_INSECURE_WEBHOOKS`
- `UPMIND_API_BASE_URL`
- `UPMIND_API_TOKEN`
- `ZDK_BASE_URL`
- `ZDK_ORG_ID`
- `ZOHO_ACCOUNTS_URL`
- `ZOHO_HC_JWT_SECRET`
- `ZOHO_HC_JWT_TERMINAL_URL`
- `ZOHO_HELP_CENTER_URL`
- `ZOHO_ASAP_JWT_TTL_MS`
- `CORS_ALLOWED_ORIGINS`

## Zoho OAuth Token Management

Zoho Desk API calls use OAuth refresh tokens. The access token is cached in D1 in `oauth_tokens` and refreshed automatically when needed.

Run migrations in `migrations/` before deploying.

## Development

```sh
npm run dev
npm run deploy
npm run db:migrate:local
npm run db:migrate:remote
```
