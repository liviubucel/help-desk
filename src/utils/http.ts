import type { Env } from '../types';

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...headers
		}
	});
}

export function text(source: string, status = 200, headers?: HeadersInit): Response {
	return new Response(source, {
		status,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			...headers
		}
	});
}

export function html(source: string): Response {
	return new Response(source, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store'
		}
	});
}

export function javascript(source: string): Response {
	return new Response(source, {
		headers: {
			'content-type': 'application/javascript; charset=utf-8',
			'cache-control': 'public, max-age=300'
		}
	});
}

export function isAdmin(request: Request, env: Env): boolean {
	if (!env.ADMIN_TOKEN) return false;
	const header = request.headers.get('x-admin-token') || request.headers.get('authorization');
	return header === env.ADMIN_TOKEN || header === `Bearer ${env.ADMIN_TOKEN}`;
}

export function allowedOrigins(env: Env): string[] {
	return (env.CORS_ALLOWED_ORIGINS || 'https://portal.zebrabyte.ro,https://help-desk.zebrabyte-uk.workers.dev')
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean);
}

export function isAllowedOrigin(origin: string | null, env: Env): boolean {
	if (!origin) return false;
	return allowedOrigins(env).some((allowed) => {
		if (allowed === origin) return true;
		if (allowed.endsWith('/*')) return origin.startsWith(allowed.slice(0, -1));
		return false;
	});
}

export function withCors(request: Request, env: Env, response: Response): Response {
	const origin = request.headers.get('origin');
	if (!isAllowedOrigin(origin, env)) return response;
	const headers = new Headers(response.headers);
	headers.set('access-control-allow-origin', origin!);
	headers.set('access-control-allow-credentials', 'true');
	headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
	headers.set('access-control-allow-headers', 'content-type, authorization, x-requested-with, x-admin-token');
	headers.set('vary', 'Origin');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function options(request: Request, env: Env): Response {
	return withCors(request, env, new Response(null, { status: 204 }));
}
