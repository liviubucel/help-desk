import type { JsonRecord } from '../types';

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim().length > 0) return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return undefined;
}

export function readBoolean(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (['true', '1', 'yes'].includes(normalized)) return true;
		if (['false', '0', 'no'].includes(normalized)) return false;
	}
	return undefined;
}

export function deepRead(source: unknown, path: string[]): unknown {
	let current = source;
	for (const key of path) {
		if (!isRecord(current) || !(key in current)) return undefined;
		current = current[key];
	}
	return current;
}

export function deepReadString(source: unknown, path: string[]): string | undefined {
	return readString(deepRead(source, path));
}

export function firstNonEmpty(values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		if (value && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

export function recursiveFindString(value: unknown, keys: string[], depth = 0): string | undefined {
	if (depth > 7 || value === null || value === undefined) return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = recursiveFindString(item, keys, depth + 1);
			if (found) return found;
		}
		return undefined;
	}
	if (!isRecord(value)) return undefined;

	for (const [key, nested] of Object.entries(value)) {
		if (keys.includes(key)) {
			const found = readString(nested);
			if (found) return found;
		}
	}

	for (const nested of Object.values(value)) {
		const found = recursiveFindString(nested, keys, depth + 1);
		if (found) return found;
	}

	return undefined;
}

export async function readJsonPayload(request: Request): Promise<JsonRecord> {
	const raw = await request.text();
	if (!raw.trim()) return {};
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : { value: parsed };
	} catch {
		const params = new URLSearchParams(raw);
		const payload: JsonRecord = {};
		for (const [key, value] of params.entries()) payload[key] = value;
		return payload;
	}
}

export function stripUndefined(input: JsonRecord): JsonRecord {
	const output: JsonRecord = {};
	for (const [key, value] of Object.entries(input)) {
		if (value !== undefined) output[key] = value;
	}
	return output;
}

