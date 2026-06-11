import type {
  CarPlayApprovalRequest,
  CarPlayDriveSnapshot,
  CarPlayNoteRequest,
} from '../../src/shared/types';
import type { CompanionConnection } from './anvil-api';

export async function fetchDriveSnapshot(
  connection: CompanionConnection,
): Promise<CarPlayDriveSnapshot> {
  return fetchCarPlayJson(connection, '/api/carplay');
}

export async function fetchDriveApproval(
  connection: CompanionConnection,
  approvalId: string,
): Promise<CarPlayApprovalRequest> {
  return fetchCarPlayJson(connection, `/api/carplay/approvals/${encodeURIComponent(approvalId)}`);
}

export async function pauseDriveSession(
  connection: CompanionConnection,
  sessionId: string,
): Promise<void> {
  await fetchCarPlayJson(
    connection,
    `/api/carplay/sessions/${encodeURIComponent(sessionId)}/pause`,
    {
      method: 'POST',
    },
  );
}

export async function pauseAllDriveSessions(connection: CompanionConnection): Promise<void> {
  await fetchCarPlayJson(connection, '/api/carplay/sessions/pause-all', { method: 'POST' });
}

export async function declineDriveApproval(
  connection: CompanionConnection,
  approvalId: string,
): Promise<void> {
  await fetchCarPlayJson(
    connection,
    `/api/carplay/approvals/${encodeURIComponent(approvalId)}/decline`,
    { method: 'POST' },
  );
}

export async function approveDriveApproval(
  connection: CompanionConnection,
  approvalId: string,
): Promise<void> {
  await fetchCarPlayJson(
    connection,
    `/api/carplay/approvals/${encodeURIComponent(approvalId)}/approve`,
    { method: 'POST' },
  );
}

export async function markDriveApprovalForLater(
  connection: CompanionConnection,
  approvalId: string,
): Promise<void> {
  await fetchCarPlayJson(
    connection,
    `/api/carplay/approvals/${encodeURIComponent(approvalId)}/later`,
    { method: 'POST' },
  );
}

export async function createDriveNote(
  connection: CompanionConnection,
  note: CarPlayNoteRequest,
): Promise<void> {
  await fetchCarPlayJson(connection, '/api/carplay/notes', {
    method: 'POST',
    body: JSON.stringify({ ...note, source: note.source ?? 'carplay' }),
  });
}

export async function prepareDriveHandover(
  connection: CompanionConnection,
  workspaceId?: string,
): Promise<void> {
  await fetchCarPlayJson(connection, '/api/carplay/handover', {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  });
}

async function fetchCarPlayJson<T>(
  connection: CompanionConnection,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}
