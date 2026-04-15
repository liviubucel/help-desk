// Shared types and interfaces for the bridge
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
	ZOHO_HELP_CENTER_URL?: string;
	ADMIN_TOKEN?: string;
	ZOHO_HC_JWT_SECRET?: string;
	ZOHO_ASAP_JWT_SECRET?: string;
}

export {};
