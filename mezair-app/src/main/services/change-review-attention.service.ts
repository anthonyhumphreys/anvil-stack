import { userInfo } from 'node:os';
import { getDb } from '../db/database.js';
import type { ChangeReview, ChangeReviewApi } from '../../shared/change-review-types.js';

// Only adjacent foreground observations count. Restart, sleep, and missing pulses add no time.
const lastPulse = new Map<string, { sessionId: string; at: number }>();
function readReview(id: string): ChangeReview {
  const row = getDb().prepare('SELECT record_json FROM change_reviews WHERE id = ?').get(id) as
    | { record_json: string }
    | undefined;
  if (!row) throw new Error('Review not found.');
  return JSON.parse(row.record_json) as ChangeReview;
}

/** Async review operations must retain attention recorded while their work was running. */
export function mergePersistedReviewAttention(review: ChangeReview): void {
  const row = getDb()
    .prepare('SELECT record_json FROM change_reviews WHERE id = ?')
    .get(review.id) as { record_json: string } | undefined;
  if (row)
    review.attentionSessions = (JSON.parse(row.record_json) as ChangeReview).attentionSessions;
}

export function recordReviewAttention(
  id: string,
  input: Parameters<ChangeReviewApi['recordAttention']>[1],
): void {
  if (
    !input ||
    typeof input.active !== 'boolean' ||
    typeof input.sessionId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(input.sessionId)
  ) {
    throw new Error('Invalid review attention observation.');
  }
  const review = readReview(id);
  const previous = lastPulse.get(id);
  if (!input.active) {
    if (previous?.sessionId === input.sessionId) lastPulse.delete(id);
    return;
  }
  const at = Date.now();
  const timestamp = new Date(at).toISOString();
  const sessions = (review.attentionSessions ??= []);
  let session = sessions.find((item) => item.id === input.sessionId);
  if (!session) {
    session = {
      id: input.sessionId,
      reviewer: userInfo().username,
      startedAt: timestamp,
      lastObservedAt: timestamp,
      activeMs: 0,
      provenance: 'foreground-interaction',
    };
    sessions.push(session);
  }
  const elapsed = previous?.sessionId === input.sessionId ? at - previous.at : 0;
  if (elapsed > 0 && elapsed <= 15000) session.activeMs += elapsed;
  session.lastObservedAt = timestamp;
  lastPulse.set(id, { sessionId: input.sessionId, at });
  // Attention must not reorder the review list or pretend evidence was updated.
  getDb()
    .prepare('UPDATE change_reviews SET record_json = ? WHERE id = ?')
    .run(JSON.stringify(review), id);
}
