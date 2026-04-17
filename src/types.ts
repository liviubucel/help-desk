// Shared types and interfaces for the bridge
export interface Env {
	BRIDGE_DB: D1Database;
	UPMIND_API_BASE_URL?: string;
	UPMIND_API_TOKEN?: string;
	UPMIND_WEBHOOK_SECRET?: string;
	UPMIND_CONTEXT_SHARED_SECRET?: string;
	ALLOW_DEV_AUTH_CONTEXT?: string;
	ALLOW_INSECURE_WEBHOOKS?: string;
	UPMIND_WEBHOOK_SIGNATURE_HEADER?: string;
	ZDK_BASE_URL?: string;
	ZDK_ORG_ID?: string;
	ZDK_DEPARTMENT_ID?: string;
	// ZOHO OAuth2 secrets (do not log)
	ZOHO_CLIENT_ID?: string;
	ZOHO_CLIENT_SECRET?: string;
	ZOHO_REFRESH_TOKEN?: string;
	ZOHO_ACCOUNTS_URL?: string;
	ZDK_WEBHOOK_AUDIENCE?: string;
	ZDK_WEBHOOK_ISSUER?: string;
	ZDK_WEBHOOK_JWT_SECRET?: string;
	ZDK_IGNORE_SOURCE_ID?: string;
	ZDK_WEBHOOK_SECRET?: string;
	ZOHO_HELP_CENTER_URL?: string;
	ZOHO_HC_JWT_TERMINAL_URL?: string;
	ADMIN_TOKEN?: string;
	ZOHO_HC_JWT_SECRET?: string;
	ZOHO_ASAP_JWT_SECRET?: string;
	ZOHO_ASAP_JWT_TTL_MS?: string;
	UPMIND_SESSION_JWT_SECRET?: string;
	UPMIND_SESSION_COOKIE_NAME?: string;
	UPMIND_SESSION_AUTH_HEADER?: string;
	WORKER_SESSION_JWT_SECRET?: string;
	WORKER_SESSION_COOKIE_NAME?: string;
	WORKER_SESSION_TTL_SECONDS?: string;
	CORS_ALLOWED_ORIGINS?: string;
}

export {};
