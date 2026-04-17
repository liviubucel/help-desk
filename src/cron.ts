import type { Env } from './types';
import { syncUpmindClientToZoho } from './index';

export async function handleCronSync(env: Env): Promise<object> {
  // Find all contacts with pending Zoho sync
  const pendingContacts = await env.BRIDGE_DB.prepare(
    "SELECT * FROM contact_map WHERE zoho_contact_id LIKE 'pending-%' OR zoho_contact_id IS NULL LIMIT 100"
  ).all();

  let contactsSynced = 0;
  let contactSyncFailed = 0;
  for (const row of pendingContacts.results) {
    try {
      await syncUpmindClientToZoho({ upmind_client_id: row.upmind_client_id, email: row.email }, env);
      contactsSynced++;
    } catch (error) {
      contactSyncFailed++;
      console.log(JSON.stringify({
        source: 'cron-sync',
        action: 'sync-contact',
        ok: false,
        upmindClientId: row.upmind_client_id,
        error: String(error)
      }));
    }
  }

  return { ok: true, contactsSynced, contactSyncFailed };
}
