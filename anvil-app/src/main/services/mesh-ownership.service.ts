// Session-ownership mirror (SESSION-03, spec §11) — leaf module shared by
// the handoff orchestrator and the chat turn-start gate. Nothing here
// imports session/handoff services, so no import cycle exists.
//
// The backend's `mesh_sessions` row is the generation authority; this
// table is the device's durable local mirror. `relinquished` is written
// BEFORE the backend advance so a restart honours it; absence of a row
// means an ordinary local-only session that needs no lease.

import { getDb } from '../db/database.js';

export interface SessionOwnershipRow {
  session_id: string;
  generation: number;
  owner_enrollment_id: string;
  state: 'owned' | 'relinquished';
}

export function readSessionOwnership(sessionId: string): SessionOwnershipRow | null {
  return (
    (getDb().prepare('SELECT * FROM mesh_session_ownership WHERE session_id = ?').get(sessionId) as
      | SessionOwnershipRow
      | undefined) ?? null
  );
}

export function writeSessionOwnership(
  sessionId: string,
  generation: number,
  ownerEnrollmentId: string,
  state: 'owned' | 'relinquished',
): void {
  getDb()
    .prepare(
      `INSERT INTO mesh_session_ownership (session_id, generation, owner_enrollment_id, state, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         generation = excluded.generation,
         owner_enrollment_id = excluded.owner_enrollment_id,
         state = excluded.state,
         updated_at = excluded.updated_at`,
    )
    .run(sessionId, generation, ownerEnrollmentId, state, new Date().toISOString());
}

/**
 * Turn-start gate (spec §11: "the source first durably rejects new
 * messages"). Sessions never handed off have no row and stay open; a
 * relinquished session fails closed — resuming requires a successful
 * pre-transfer cancellation (which restores `owned`) or a fresh session,
 * never an implicit local revive.
 */
export function assertSessionTurnAllowed(sessionId: string): void {
  const row = readSessionOwnership(sessionId);
  if (row !== null && row.state === 'relinquished') {
    throw new Error(
      `session-relinquished: ${sessionId} ownership moved to another device — ` +
        `start a new session or resume it there`,
    );
  }
}
