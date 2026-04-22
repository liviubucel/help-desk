// Shared types and interfaces for the bridge
export interface Env {
	BRIDGE_DB: D1Database;
	UPMIND_API_BASE_URL?: string;
	UPMIND_API_TOKEN?: string;
	UPMIND_CLIENT_ENDPOINT_TEMPLATE?: string;
	UPMIND_ME_ENDPOINT?: string;
	UPMIND_WEBHOOK_SECRET?: string;
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
	ZDK_IGNORE_SOURCE_ID?: string;
	ZOHO_HELP_CENTER_URL?: string;
	ZOHO_ASAP_SCRIPT_URL?: string;
	ZOHO_ASAP_ALLOWED_HOSTS?: string;
	ZOHO_ASAP_BLOCKED_HOSTS?: string;
	ZOHO_ASAP_ALLOWED_PATHS?: string;
	ZOHO_ASAP_BLOCKED_PATHS?: string;
	ZOHO_HC_JWT_TERMINAL_URL?: string;
	ADMIN_TOKEN?: string;
	ZOHO_HC_JWT_SECRET?: string;
	ZOHO_ASAP_JWT_SECRET?: string;
	ZOHO_ASAP_JWT_TTL_MS?: string;
	UPMIND_SESSION_JWT_SECRET?: string;
	UPMIND_SESSION_COOKIE_NAME?: string;
	UPMIND_SESSION_AUTH_HEADER?: string;
	UPMIND_LOGIN_URL?: string;
	CORS_ALLOWED_ORIGINS?: string;
	STATUS_MAP_JSON?: string;
	UPMIND_TICKET_WRITE_ENABLED?: string;
	UPMIND_TICKET_WRITE_API_BASE_URL?: string;
	UPMIND_TICKET_WRITE_API_TOKEN?: string;
}

export type JsonRecord = Record<string, unknown>;

export interface NormalizedClient {
	id?: string;
	email?: string;
	firstName?: string;
	lastName?: string;
	fullName?: string;
}

export interface NormalizedTicket {
	id?: string;
	reference?: string;
	subject?: string;
	status?: string;
	departmentId?: string;
	priorityId?: string;
}

export interface NormalizedMessage {
	id?: string;
	body?: string;
	isPrivate?: boolean;
	createdAt?: string;
	actorType?: 'client' | 'staff' | 'lead' | 'system' | 'unknown';
}

export interface NormalizedUpmindEvent {
	eventKey?: string;
	eventType: string;
	category?: string;
	code?: string;
	client: NormalizedClient;
	ticket?: NormalizedTicket;
	message?: NormalizedMessage;
	raw: unknown;
}

export {};
