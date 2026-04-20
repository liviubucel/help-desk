import type { Env } from '../types';

const DEFAULT_STATUS_MAP: Record<string, string> = {
	client_opened_new_ticket_hook: 'Open',
	lead_opened_new_ticket_hook: 'Open',
	staff_opened_new_ticket_hook: 'Open',
	ticket_client_replied_hook: 'Open',
	client_posted_ticket_message_hook: 'Open',
	ticket_in_progress_hook: 'In Progress',
	ticket_waiting_response_hook: 'Waiting on Customer',
	ticket_closed_hook: 'Closed',
	client_closed_ticket_hook: 'Closed',
	staff_closed_ticket_hook: 'Closed',
	ticket_reopened_hook: 'Open',
	scheduled_ticket_reopened_hook: 'Open'
};

export function mapUpmindStatusToZoho(env: Env, eventType: string, fallback = 'Open'): string {
	const configured = parseStatusMap(env.STATUS_MAP_JSON);
	return configured[eventType] || DEFAULT_STATUS_MAP[eventType] || fallback;
}

function parseStatusMap(value?: string): Record<string, string> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
	} catch {
		return {};
	}
}

