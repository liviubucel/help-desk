import type { Env, JsonRecord } from './types';

export function configStatus(env: Env): JsonRecord {
	return {
		upmindApiBaseUrl: Boolean(env.UPMIND_API_BASE_URL),
		upmindApiToken: Boolean(env.UPMIND_API_TOKEN),
		upmindWebhookSecret: Boolean(env.UPMIND_WEBHOOK_SECRET),
		upmindSessionJwtSecret: Boolean(env.UPMIND_SESSION_JWT_SECRET),
		upmindLoginUrl: Boolean(env.UPMIND_LOGIN_URL),
		zohoBaseUrl: Boolean(env.ZDK_BASE_URL),
		zohoClientId: Boolean(env.ZOHO_CLIENT_ID),
		zohoClientSecret: Boolean(env.ZOHO_CLIENT_SECRET),
		zohoRefreshToken: Boolean(env.ZOHO_REFRESH_TOKEN),
		zohoOrgId: Boolean(env.ZDK_ORG_ID),
		zohoDepartmentId: Boolean(env.ZDK_DEPARTMENT_ID),
		zohoAsapJwtSecret: Boolean(env.ZOHO_ASAP_JWT_SECRET),
		zohoHelpCenterJwtSecret: Boolean(env.ZOHO_HC_JWT_SECRET || env.ZOHO_ASAP_JWT_SECRET),
		adminToken: Boolean(env.ADMIN_TOKEN),
		reverseSyncConfigured: env.UPMIND_TICKET_WRITE_ENABLED === 'true' && Boolean(env.UPMIND_TICKET_WRITE_API_BASE_URL && env.UPMIND_TICKET_WRITE_API_TOKEN)
	};
}

export function requireZohoConfig(env: Env): void {
	const missing = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZDK_DEPARTMENT_ID']
		.filter((key) => !env[key as keyof Env]);
	if (missing.length > 0) throw new Error(`Missing Zoho config: ${missing.join(', ')}`);
}
