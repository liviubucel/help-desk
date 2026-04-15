# help-desk

Bridge bidirecțional între Upmind și Zoho Desk, rulat pe Cloudflare Workers + D1.

## Ce face
- sincronizează contacte, tickete și mesaje în ambele sensuri
- verifică webhook-urile Upmind prin HMAC
- protejează webhook-urile Zoho prin secret header
- emite JWT pentru Zoho ASAP și Help Center
- ține evidența evenimentelor brute, a evenimentelor procesate și a eșecurilor
- folosește refresh automat pentru tokenurile Zoho OAuth

## Endpointuri

### Health
- `GET /health`

### Webhooks
- `POST /webhooks/upmind`
- `POST /webhooks/zoho`
- `GET|HEAD /webhooks/upmind`
- `GET|HEAD /webhooks/zoho`

### Auth
- `GET /auth/upmind-client-context`
- `GET /auth/asap-jwt`
- `GET /auth/helpcenter-jwt`
- `GET /auth/helpcenter-launch`
- `POST /auth/logout`

### Admin / debug / retry
- `POST /cron/sync`
- `GET /admin/health`
- `GET /admin/db-status`
- `GET /admin/failures`
- `GET /debug/raw-event/{eventKey}`
- `GET /backfill/reprocess/{eventKey}`

## Variabile de mediu

### D1
- `BRIDGE_DB`

### Upmind
- `UPMIND_API_BASE_URL`
- `UPMIND_API_TOKEN`
- `UPMIND_WEBHOOK_SECRET`
- `UPMIND_CONTEXT_SHARED_SECRET`
- `ALLOW_DEV_AUTH_CONTEXT`
- `ALLOW_INSECURE_WEBHOOKS`
- `UPMIND_WEBHOOK_SIGNATURE_HEADER`

### Zoho Desk / OAuth
- `ZDK_BASE_URL`
- `ZDK_ORG_ID`
- `ZDK_DEPARTMENT_ID`
- `ZDK_WEBHOOK_SECRET`
- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZOHO_ACCOUNTS_URL`

### Zoho ASAP / Help Center
- `ZOHO_HELP_CENTER_URL`
- `ZOHO_HC_JWT_SECRET`
- `ZOHO_ASAP_JWT_SECRET`
- `ZOHO_ASAP_JWT_TTL_MS`

### Admin
- `ADMIN_TOKEN`

## Comportament important
- evenimentele sunt marcate ca procesate doar după sync reușit
- eșecurile sunt salvate în `event_failures`
- `backfill/reprocess/{eventKey}` șterge mai întâi markerul din `processed_events`, apoi reexecută evenimentul
- `cron/sync` folosește chei normalizate compatibile cu extractor-ele din `src/index.ts`
- proiectul folosește refresh automat Zoho OAuth; nu folosi `ZDK_ACCESS_TOKEN` static

## Migrații
Rulează migrațiile D1 din directorul `migrations/`.

## Scripts
- `npm run dev`
- `npm run deploy`
- `npm run db:migrate:local`
- `npm run db:migrate:remote`
