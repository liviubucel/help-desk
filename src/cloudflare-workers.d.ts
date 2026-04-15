// Minimal types for Cloudflare Worker scheduled events
export interface ScheduledEvent {
  scheduledTime: number;
  waitUntil(promise: Promise<any>): void;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
}
