import { getDb } from '../db/database.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  ACTIVATION_EVENT_NAMES,
  buildActivationMeasurementReport,
  isActivationEventName,
  sanitizeActivationEventPayload,
  type ActivationEventName,
  type ActivationEventRow,
  type ActivationMeasurementReport,
} from '../../shared/activation-measurement.js';

/**
 * Local-first activation metrics (§7 Measurement). Events are written to the
 * `activation_events` SQLite table and are NEVER transmitted — they exist only
 * for local funnel analysis and are independent of the crash-reporting consent
 * flag (`telemetryEnabled` only gates Sentry).
 */

/** The `metrics:track` IPC handler allowlists these local-only events. */
export const ACTIVATION_EVENTS = new Set<string>(ACTIVATION_EVENT_NAMES);

/** One ID per Electron main-process lifetime. Renderer and main events share it. */
const APP_RUN_ID = randomUUID();

/** Payloads larger than this are dropped rather than bloating the table. */
const MAX_PAYLOAD_BYTES = 4096;

export type { ActivationEventRow } from '../../shared/activation-measurement.js';

function findPendingJourneyId(): string | null {
  const row = getDb()
    .prepare(
      `SELECT started.journey_id
       FROM activation_events AS started
       WHERE started.event = 'onboarding_started'
         AND started.journey_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM activation_events AS completed
           WHERE completed.journey_id = started.journey_id
             AND completed.event = 'change_applied'
         )
       ORDER BY started.id DESC
       LIMIT 1`,
    )
    .get() as { journey_id: string } | undefined;
  return row?.journey_id ?? null;
}

function journeyIdForEvent(event: ActivationEventName): string | null {
  const pending = findPendingJourneyId();
  if (pending) return pending;
  if (event !== 'pull_request_opened') return null;

  // A successful commit precedes provider delivery. Keep a real PR-open event
  // on the journey that produced its commit, without reopening a completed one.
  const row = getDb()
    .prepare(
      `SELECT journey_id FROM activation_events
       WHERE app_run_id = ? AND event = 'change_applied'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(APP_RUN_ID) as { journey_id: string } | undefined;
  return row?.journey_id ?? null;
}

function changeSummaryKey(payload?: Record<string, unknown>): string | null {
  const turnId = typeof payload?.turnId === 'string' ? payload.turnId.trim() : '';
  if (!turnId || turnId.length > 1024) return null;
  const threadId = typeof payload?.threadId === 'string' ? payload.threadId.trim() : '';
  if (threadId.length > 1024) return null;
  return createHash('sha256')
    .update(JSON.stringify([threadId, turnId]))
    .digest('hex');
}

function hasRecordedChangeSummary(summaryKey: string): boolean {
  const rows = getDb()
    .prepare(
      `SELECT payload FROM activation_events
       WHERE event = 'change_summary_viewed' AND payload IS NOT NULL`,
    )
    .all() as Array<{ payload: string }>;
  return rows.some((row) => {
    try {
      const payload: unknown = JSON.parse(row.payload);
      return (
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        'summaryKey' in payload &&
        payload.summaryKey === summaryKey
      );
    } catch {
      return false;
    }
  });
}

/**
 * Record one activation event. Never throws to the caller — a metrics write
 * must not break the flow it measures, so failures are logged and swallowed.
 */
export function trackActivationEvent(
  event: ActivationEventName,
  payload?: Record<string, unknown>,
): void {
  try {
    if (!isActivationEventName(event)) return;
    const eventName = event;
    const summaryKey = eventName === 'change_summary_viewed' ? changeSummaryKey(payload) : null;
    if (eventName === 'change_summary_viewed' && !summaryKey) return;
    const safePayload = sanitizeActivationEventPayload(
      eventName,
      eventName === 'change_summary_viewed' ? { ...(payload ?? {}), summaryKey } : payload,
    );
    let serialized: string | null = null;
    if (safePayload !== undefined) {
      const json = JSON.stringify(safePayload);
      serialized = Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES ? json : null;
    }
    const pendingJourneyId = findPendingJourneyId();
    if (eventName === 'onboarding_started' && pendingJourneyId) return;
    if (
      eventName === 'change_summary_viewed' &&
      summaryKey &&
      hasRecordedChangeSummary(summaryKey)
    ) {
      return;
    }
    const journeyId =
      eventName === 'onboarding_started'
        ? randomUUID()
        : eventName === 'pull_request_opened'
          ? journeyIdForEvent(eventName)
          : pendingJourneyId;

    if (eventName === 'chat_composer_enabled') {
      const existing = journeyId
        ? getDb()
            .prepare(
              `SELECT 1 FROM activation_events
               WHERE event = ? AND journey_id = ? LIMIT 1`,
            )
            .get(eventName, journeyId)
        : getDb()
            .prepare(
              `SELECT 1 FROM activation_events
               WHERE event = ? AND app_run_id = ? LIMIT 1`,
            )
            .get(eventName, APP_RUN_ID);
      if (existing) return;
    }

    getDb()
      .prepare(
        `INSERT INTO activation_events (event, payload, app_run_id, journey_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(eventName, serialized, APP_RUN_ID, journeyId, new Date().toISOString());
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
            'SELECT id, event, app_run_id, journey_id, payload, created_at FROM activation_events WHERE created_at >= ? ORDER BY id',
          )
          .all(since)
      : db
          .prepare(
            'SELECT id, event, app_run_id, journey_id, payload, created_at FROM activation_events ORDER BY id',
          )
          .all()
  ) as ActivationEventRow[];
}

/** Local read API for the CLI and any future in-app diagnostics surface. */
export function getActivationMeasurementReport(): ActivationMeasurementReport {
  return buildActivationMeasurementReport(listActivationEvents());
}
