import type { Env } from './types';
import { syncUpmindClientToZoho, syncUpmindTicketToZoho } from './index';

export async function handleCronSync(env: Env): Promise<object> {
  // Find all contacts with pending Zoho sync
  const pendingContacts = await env.BRIDGE_DB.prepare(
    "SELECT * FROM contact_map WHERE zoho_contact_id LIKE 'pending-%' OR zoho_contact_id IS NULL LIMIT 100"
  ).all();

  let contactsSynced = 0;
  for (const row of pendingContacts.results) {
    await syncUpmindClientToZoho({ upmind_client_id: row.upmind_client_id, email: row.email }, env);
    contactsSynced++;
  }

  // Find all tickets with pending Zoho sync
  const pendingTickets = await env.BRIDGE_DB.prepare(
    "SELECT * FROM ticket_map WHERE zoho_ticket_id LIKE 'pending-%' OR zoho_ticket_id IS NULL LIMIT 100"
  ).all();

  let ticketsSynced = 0;
  for (const row of pendingTickets.results) {
    // Ensure payload keys are compatible for extractors
    await syncUpmindTicketToZoho({
      upmind_ticket_id: row.upmind_ticket_id,
      upmind_client_id: row.upmind_client_id,
      ticket_id: row.upmind_ticket_id, // for legacy extractor compatibility
      client_id: row.upmind_client_id  // for legacy extractor compatibility
    }, env);
    ticketsSynced++;
  }

  return { ok: true, contactsSynced, ticketsSynced };
}
