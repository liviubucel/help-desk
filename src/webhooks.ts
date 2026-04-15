import { verifyUpmindWebhookSignature } from './utils/crypto';

export async function checkUpmindWebhookSignature(request: Request, env: any): Promise<boolean> {
	const secret = env.UPMIND_WEBHOOK_SECRET;
	const allowInsecure = env.ALLOW_INSECURE_WEBHOOKS === 'true';
	const expectedHeader = env.UPMIND_WEBHOOK_SIGNATURE_HEADER || 'X-Webhook-Signature';
	const signature = request.headers.get(expectedHeader) || '';
	const rawBody = await request.text();
	return verifyUpmindWebhookSignature({
		secret,
		rawBody,
		signature,
		allowInsecure,
		expectedHeader
	});
}

export async function recordEventFailure(
  {
    eventKey,
    originSystem,
    eventName,
    errorMessage,
    payloadJson,
    retryCount = 0
  }: {
    eventKey: string;
    originSystem: string;
    eventName: string;
    errorMessage: string;
    payloadJson: any;
    retryCount?: number;
  },
  env: any
): Promise<void> {
  await env.BRIDGE_DB.prepare(
    `INSERT INTO event_failures (event_key, origin_system, event_name, error_message, payload_json, retry_count)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(
    eventKey,
    originSystem,
    eventName,
    errorMessage,
    JSON.stringify(payloadJson),
    retryCount
  ).run();
}

export async function getEventFailures(env: any): Promise<any[]> {
  const rows = await env.BRIDGE_DB.prepare(
    `SELECT id, event_key, origin_system, event_name, error_message, retry_count, created_at, updated_at
     FROM event_failures
     ORDER BY created_at DESC
     LIMIT 100`
  ).all();
  return rows.results || [];
}
