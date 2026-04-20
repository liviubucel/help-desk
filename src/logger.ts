import type { JsonRecord } from './types';

const SECRET_KEYS = [
	'token',
	'access_token',
	'refresh_token',
	'authorization',
	'secret',
	'jwt',
	'password',
	'email_2fa_code',
	'manage_notification_subs_token',
	'phone',
	'international_phone',
	'address_1',
	'address_2',
	'postcode',
	'ip',
	'source_ip'
];

export function sanitizeForLog(value: unknown, depth = 0): unknown {
	if (depth > 5) return '[truncated]';
	if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitizeForLog(item, depth + 1));
	if (!value || typeof value !== 'object') return value;
	const output: JsonRecord = {};
	for (const [key, nested] of Object.entries(value as JsonRecord)) {
		const lowered = key.toLowerCase();
		if (SECRET_KEYS.some((secret) => lowered.includes(secret))) {
			output[key] = '[redacted]';
		} else {
			output[key] = sanitizeForLog(nested, depth + 1);
		}
	}
	return output;
}

export function logInfo(event: JsonRecord): void {
	console.log(JSON.stringify(sanitizeForLog(event)));
}

export function logError(event: JsonRecord): void {
	console.error(JSON.stringify(sanitizeForLog(event)));
}

export function preview(value: unknown, max = 1000): string {
	const text = JSON.stringify(sanitizeForLog(value));
	return text.length > max ? `${text.slice(0, max)}...` : text;
}
