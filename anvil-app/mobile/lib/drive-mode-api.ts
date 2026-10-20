import type {
  CarPlayApprovalRequest,
  CarPlayDriveSnapshot,
  CarPlayNoteRequest,
  CarPlaySessionSummary,
  CompanionSurface,
  WorkspaceNote,
} from '../../src/shared/types';
import { requestEncryptedCompanionOperation, type CompanionConnection } from './anvil-api';

export async function fetchDriveSnapshot(
  connection: CompanionConnection,
): Promise<CarPlayDriveSnapshot> {
  if (connection.authMode === 'account') {
    return mapDriveSnapshot(
      await requestEncryptedCompanionOperation(connection, 'read.carplay-snapshot', {}),
    );
  }
  return fetchCarPlayJson(connection, '/api/carplay');
}

export async function fetchDriveApproval(
  connection: CompanionConnection,
  approvalId: string,
): Promise<CarPlayApprovalRequest> {
  if (connection.authMode === 'account') {
    const result = await requestEncryptedCompanionOperation(connection, 'read.carplay-approval', {
      approvalId,
    });
    if (result === null) throw new Error('CarPlay approval is no longer active.');
    return mapCarPlayApproval(result);
  }
  return fetchCarPlayJson(connection, `/api/carplay/approvals/${encodeURIComponent(approvalId)}`);
}

export async function pauseDriveSession(
  connection: CompanionConnection,
  sessionId: string,
): Promise<void> {
  if (connection.authMode === 'account') {
    assertMeshOk(
      await requestEncryptedCompanionOperation(connection, 'command.carplay-pause', { sessionId }),
    );
    return;
  }
  await fetchCarPlayJson(
    connection,
    `/api/carplay/sessions/${encodeURIComponent(sessionId)}/pause`,
    {
      method: 'POST',
    },
  );
}

export async function pauseAllDriveSessions(connection: CompanionConnection): Promise<void> {
  if (connection.authMode === 'account') {
    assertMeshOk(
      await requestEncryptedCompanionOperation(connection, 'command.carplay-pause-all', {}),
    );
    return;
  }
  await fetchCarPlayJson(connection, '/api/carplay/sessions/pause-all', { method: 'POST' });
}

export async function declineDriveApproval(
  connection: CompanionConnection,
  approvalId: string,
): Promise<void> {
  if (connection.authMode === 'account') {
    assertMeshOk(
      await requestEncryptedCompanionOperation(connection, 'command.carplay-approval', {
        approvalId,
        decision: 'decline',
      }),
    );
    return;
  }
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
  if (connection.authMode === 'account') {
    assertMeshOk(
      await requestEncryptedCompanionOperation(connection, 'command.carplay-approval', {
        approvalId,
        decision: 'approve',
      }),
    );
    return;
  }
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
  if (connection.authMode === 'account') {
    assertMeshOk(
      await requestEncryptedCompanionOperation(connection, 'command.carplay-approval', {
        approvalId,
        decision: 'later',
      }),
    );
    return;
  }
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
  if (connection.authMode === 'account') {
    const result = await requestEncryptedCompanionOperation(connection, 'command.carplay-note', {
      ...note,
      source: note.source ?? 'carplay',
    });
    mapWorkspaceNote(result);
    return;
  }
  await fetchCarPlayJson(connection, '/api/carplay/notes', {
    method: 'POST',
    body: JSON.stringify({ ...note, source: note.source ?? 'carplay' }),
  });
}

export async function prepareDriveHandover(
  connection: CompanionConnection,
  workspaceId?: string,
): Promise<void> {
  if (connection.authMode === 'account') {
    const result = await requestEncryptedCompanionOperation(
      connection,
      'command.carplay-handover',
      { workspaceId },
    );
    if (!isRecord(result) || !isRecord(result.thread) || !isRecord(result.session)) {
      throw new Error('The host returned a malformed Drive handover result.');
    }
    return;
  }
  await fetchCarPlayJson(connection, '/api/carplay/handover', {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertMeshOk(value: unknown): void {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error('The host did not confirm the Drive action.');
  }
}

function mapDriveSnapshot(value: unknown): CarPlayDriveSnapshot {
  if (
    !isRecord(value) ||
    typeof value.generatedAt !== 'string' ||
    value.title !== 'Anvil Drive' ||
    !isRecord(value.attention) ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.approvals) ||
    !Array.isArray(value.recentNotes) ||
    !Array.isArray(value.safeActions)
  ) {
    throw new Error('The host returned a malformed Anvil Drive snapshot.');
  }
  const attention = value.attention;
  if (
    !['pendingApprovals', 'blockedSessions', 'requiresDesktopReview', 'failedChecks'].every(
      (key) => typeof attention[key] === 'number' && Number.isFinite(attention[key]),
    )
  ) {
    throw new Error('The host returned a malformed Anvil Drive snapshot.');
  }
  const sessions = value.sessions.map(mapCarPlaySession);
  const approvals = value.approvals.map(mapCarPlayApproval);
  const recentNotes = value.recentNotes.map(mapWorkspaceNote);
  const safeActions = value.safeActions.map((item) => {
    if (
      !isRecord(item) ||
      ![
        'pause-all',
        'continue-low-risk-checks',
        'prepare-handover',
        'mark-everything-later',
        'capture-note',
      ].includes(String(item.id)) ||
      typeof item.label !== 'string' ||
      typeof item.enabled !== 'boolean'
    ) {
      throw new Error('The host returned a malformed Drive action.');
    }
    return {
      id: item.id as CarPlayDriveSnapshot['safeActions'][number]['id'],
      label: item.label,
      enabled: item.enabled,
    };
  });
  return {
    generatedAt: value.generatedAt,
    title: 'Anvil Drive',
    attention: {
      pendingApprovals: attention.pendingApprovals as number,
      blockedSessions: attention.blockedSessions as number,
      requiresDesktopReview: attention.requiresDesktopReview as number,
      failedChecks: attention.failedChecks as number,
    },
    sessions,
    approvals,
    recentNotes,
    safeActions,
  };
}

function mapCarPlaySession(value: unknown): CarPlaySessionSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    !['active', 'paused', 'blocked', 'completed'].includes(String(value.status)) ||
    typeof value.summary !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new Error('The host returned a malformed Drive session.');
  }
  return {
    id: value.id,
    title: value.title,
    status: value.status as CarPlaySessionSummary['status'],
    summary: value.summary,
    updatedAt: value.updatedAt,
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.workspaceName === 'string' ? { workspaceName: value.workspaceName } : {}),
    ...(typeof value.repo === 'string' ? { repo: value.repo } : {}),
  };
}

function mapCarPlayApproval(value: unknown): CarPlayApprovalRequest {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.requestKey !== 'string' ||
    (typeof value.requestId !== 'string' && typeof value.requestId !== 'number') ||
    !['command', 'file_change', 'permissions'].includes(String(value.kind)) ||
    typeof value.createdAt !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.summary !== 'string' ||
    typeof value.requestedAction !== 'string' ||
    !['low', 'medium', 'high', 'destructive'].includes(String(value.risk)) ||
    typeof value.requiresFullReview !== 'boolean' ||
    !Array.isArray(value.allowedSurfaces) ||
    !value.allowedSurfaces.every((surface) =>
      ['desktop', 'mobile', 'watch', 'widget', 'carplay', 'siri'].includes(String(surface)),
    ) ||
    typeof value.carPlayApprovable !== 'boolean' ||
    typeof value.markedForLater !== 'boolean'
  ) {
    throw new Error('The host returned a malformed Drive approval.');
  }
  return {
    id: value.id,
    sessionId: value.sessionId,
    requestKey: value.requestKey,
    requestId: value.requestId,
    kind: value.kind as CarPlayApprovalRequest['kind'],
    createdAt: value.createdAt,
    title: value.title,
    summary: value.summary,
    requestedAction: value.requestedAction,
    risk: value.risk as CarPlayApprovalRequest['risk'],
    requiresFullReview: value.requiresFullReview,
    allowedSurfaces: value.allowedSurfaces as CompanionSurface[],
    carPlayApprovable: value.carPlayApprovable,
    markedForLater: value.markedForLater,
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.workspaceName === 'string' ? { workspaceName: value.workspaceName } : {}),
    ...(typeof value.repo === 'string' ? { repo: value.repo } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.command === 'string' ? { command: value.command } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(typeof value.grantRoot === 'string' ? { grantRoot: value.grantRoot } : {}),
    ...(typeof value.blockedReason === 'string' ? { blockedReason: value.blockedReason } : {}),
  };
}

function mapWorkspaceNote(value: unknown): WorkspaceNote {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.body !== 'string' ||
    !['desktop', 'mobile', 'watch', 'widget', 'carplay', 'siri'].includes(String(value.source)) ||
    !['open', 'accepted', 'dismissed'].includes(String(value.status)) ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('The host returned a malformed Drive note.');
  }
  return {
    id: value.id,
    body: value.body,
    source: value.source as WorkspaceNote['source'],
    status: value.status as WorkspaceNote['status'],
    createdAt: value.createdAt,
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.workspaceName === 'string' ? { workspaceName: value.workspaceName } : {}),
    ...(typeof value.repo === 'string' ? { repo: value.repo } : {}),
    ...(typeof value.reviewedAt === 'string' ? { reviewedAt: value.reviewedAt } : {}),
  };
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
