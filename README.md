# help-desk

## Overview
This project is a production-ready bridge between Upmind and Zoho Desk, running on Cloudflare Workers with D1Database. It synchronizes tickets, contacts, and messages between the two systems, provides secure authentication, and exposes admin/debug/backfill endpoints.

## Features
- Webhook signature verification (timing-safe, HMAC SHA256)
- Idempotency and loop prevention (bridge-origin marker)
- Robust ticket/contact/message sync (bi-directional)
- JWT authentication for Zoho ASAP and Help Center
- Pluggable session resolver for Upmind
- Admin, debug, and backfill endpoints (protected)
- Modular, type-safe TypeScript codebase
- SQL migrations for schema evolution

## Endpoints

### Webhooks
- `POST /webhooks/upmind` — Receives Upmind webhooks, verifies signature, syncs to Zoho
- `POST /webhooks/zoho` — Receives Zoho webhooks, syncs to Upmind
- `GET|HEAD /webhooks/upmind` — Validation endpoint
- `GET|HEAD /webhooks/zoho` — Validation endpoint

### Auth
- `GET /auth/upmind-client-context` — Returns Upmind client context (if authenticated)
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
- `UPMIND_API_BASE_URL`, `UPMIND_API_TOKEN`, `UPMIND_WEBHOOK_SECRET`
- `ZDK_BASE_URL`, `ZDK_ORG_ID`, `ZDK_DEPARTMENT_ID`, `ZDK_ACCESS_TOKEN`
- `ZOHO_HELP_CENTER_URL`, `ZOHO_HC_JWT_SECRET`, `ZOHO_ASAP_JWT_SECRET`
- `ADMIN_TOKEN` — Secret for admin/debug/backfill endpoints

## Usage
1. Deploy to Cloudflare Workers with D1Database
2. Configure all required environment variables
3. Set Upmind and Zoho webhooks to point to the appropriate endpoints
4. Use the admin endpoints for health checks and debugging

## Security
- All webhooks are signature-verified
- Admin/debug/backfill endpoints require `ADMIN_TOKEN` (or JWT secret)
- JWTs are signed with HS256 using Web Crypto API

## Development
- TypeScript (ES2022, strict mode)
- Modular code in `src/`
- SQL migrations in `migrations/`

## License
MIT