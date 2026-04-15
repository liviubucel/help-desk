import type { Env } from './types';
import { syncUpmindClientToZoho, syncUpmindTicketToZoho } from './index';

export async function handleCronSync(env: Env): Promise<object> {
  const pendingContacts = await env.BRIDGE_DB.prepare(
    `SELECT upmind_client_id, email
     FROM contact_map
     WHERE zoho_contact_id LIKE 'pending-%' OR zoho_contact_id IS NULL
     LIMIT 100`
  ).all<{ upmind_client_id: string; email: string | null }>();

  let contactsSynced = 0;
  for (const row of pendingContacts.results) {
    await syncUpmindClientToZoho(
      {
        client_id: row.upmind_client_id,
        email: row.email ?? undefined
      },
      env
    );
    contactsSynced++;
  }

  const pendingTickets = await env.BRIDGE_DB.prepare(
    `SELECT t.upmind_ticket_id, t.upmind_client_id, c.email
     FROM ticket_map t
     LEFT JOIN contact_map c ON c.upmind_client_id = t.upmind_client_id
     WHERE t.zoho_ticket_id LIKE 'pending-%' OR t.zoho_ticket_id IS NULL
     LIMIT 100`
  ).all<{ upmind_ticket_id: string; upmind_client_id: string | null; email: string | null }>();

  let ticketsSynced = 0;
  for (const row of pendingTickets.results) {
    await syncUpmindTicketToZoho(
      {
        ticket_id: row.upmind_ticket_id,
        client_id: row.upmind_client_id ?? undefined,
        email: row.email ?? undefined
      },
      env
    );
    ticketsSynced++;
  }

  return { ok: true, contactsSynced, ticketsSynced };
}
