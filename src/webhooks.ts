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
