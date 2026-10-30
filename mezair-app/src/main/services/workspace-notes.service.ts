import { randomUUID } from 'node:crypto';
import type { WorkspaceNote, WorkspaceNoteCreateInput } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { emitCompanionEvent } from './companion-events.service.js';
import { getWorkspace } from './workspace.service.js';

interface WorkspaceNoteRow {
  id: string;
  workspace_id: string | null;
  repo: string | null;
  body: string;
  source: WorkspaceNote['source'];
  status: WorkspaceNote['status'];
  created_at: string;
  reviewed_at: string | null;
}

export function listWorkspaceNotes(workspaceId?: string, includeReviewed = false): WorkspaceNote[] {
  const filters: string[] = [];
  const params: unknown[] = [];

  if (workspaceId) {
    filters.push('workspace_id = ?');
    params.push(workspaceId);
  }

  if (!includeReviewed) {
    filters.push("status = 'open'");
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(
      `SELECT *
       FROM workspace_notes
       ${where}
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    .all(...params) as WorkspaceNoteRow[];

  return rows.map(mapWorkspaceNote);
}

export function createWorkspaceNote(input: WorkspaceNoteCreateInput): WorkspaceNote {
  const body = input.body.trim();
  if (!body) throw new Error('Workspace note body is required.');

  const now = new Date().toISOString();
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO workspace_notes
       (id, workspace_id, repo, body, source, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(id, input.workspaceId ?? null, input.repo ?? null, body, input.source, now);

  emitCompanionEvent('notes');
  return {
    id,
    workspaceId: input.workspaceId,
    workspaceName: workspaceName(input.workspaceId),
    repo: input.repo,
    body,
    source: input.source,
    status: 'open',
    createdAt: now,
  };
}

export function updateWorkspaceNoteStatus(
  noteId: string,
  status: Extract<WorkspaceNote['status'], 'accepted' | 'dismissed'>,
): void {
  getDb()
    .prepare(
      `UPDATE workspace_notes
       SET status = ?, reviewed_at = ?
       WHERE id = ?`,
    )
    .run(status, new Date().toISOString(), noteId);
  emitCompanionEvent('notes');
}

function mapWorkspaceNote(row: WorkspaceNoteRow): WorkspaceNote {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceName: workspaceName(row.workspace_id ?? undefined),
    repo: row.repo ?? undefined,
    body: row.body,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? undefined,
  };
}

function workspaceName(workspaceId: string | undefined): string | undefined {
  if (!workspaceId) return undefined;
  try {
    return getWorkspace(workspaceId).name;
  } catch {
    return undefined;
  }
}
