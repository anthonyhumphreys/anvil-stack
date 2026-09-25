import { getDb } from '../db/database.js';

/**
 * Local-first activation metrics (§7 Measurement). Events are written to the
 * `activation_events` SQLite table and are NEVER transmitted — they exist only
 * for local funnel analysis and are independent of the crash-reporting consent
 * flag (`telemetryEnabled` only gates Sentry).
 */

/** The §7 funnel event set. The `metrics:track` IPC handler allowlists these. */
export const ACTIVATION_EVENTS = new Set<string>([
  'onboarding_started',
  'onboarding_step_completed',
  'chat_composer_enabled',
  'chat_blocked_shown',
  'diff_proposed',
  'change_applied',
  'repo_index_tier_reached',
  'repo_enrich_completed',
]);

/** Payloads larger than this are dropped rather than bloating the table. */
const MAX_PAYLOAD_BYTES = 4096;

export interface ActivationEventRow {
  id: number;
  event: string;
  payload: string | null;
  created_at: string;
}

/**
 * Record one activation event. Never throws to the caller — a metrics write
 * must not break the flow it measures, so failures are logged and swallowed.
 */
export function trackActivationEvent(event: string, payload?: Record<string, unknown>): void {
  try {
    let serialized: string | null = null;
    if (payload !== undefined) {
      const json = JSON.stringify(payload);
      serialized = json.length <= MAX_PAYLOAD_BYTES ? json : null;
    }
    getDb()
      .prepare('INSERT INTO activation_events (event, payload, created_at) VALUES (?, ?, ?)')
      .run(event, serialized, new Date().toISOString());
  } catch (err) {
    console.warn('[Metrics] Failed to record activation event:', err);
  }
}

/** List recorded activation events, oldest first. `since` is an ISO timestamp. */
export function listActivationEvents(since?: string): ActivationEventRow[] {
  const db = getDb();
  return (
    since
      ? db
          .prepare(
            'SELECT id, event, payload, created_at FROM activation_events WHERE created_at >= ? ORDER BY id',
          )
          .all(since)
      : db.prepare('SELECT id, event, payload, created_at FROM activation_events ORDER BY id').all()
  ) as ActivationEventRow[];
}
