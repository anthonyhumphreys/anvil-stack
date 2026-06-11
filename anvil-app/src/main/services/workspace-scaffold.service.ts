import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import type {
  WorkspaceScaffoldMaybeCompleteResult,
  WorkspaceScaffoldSession,
} from '../../shared/types.js';
import {
  LEGACY_SCAFFOLD_COMPLETE_MARKER,
  PRIMARY_SCAFFOLD_COMPLETE_MARKER,
} from '../../shared/app-identity.js';
import { getDb } from '../db/database.js';
import { scanForRepos } from './repo-scan.service.js';
import { connectRepoPath } from './repo-connect.service.js';
import { indexRepo } from './repo-index.service.js';
import { addReposToWorkspace } from './workspace.service.js';

interface WorkspaceScaffoldSessionRow {
  id: string;
  workspace_id: string;
  root_path: string;
  persona_id: string;
  status: WorkspaceScaffoldSession['status'];
  completion_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface CompletionPayload {
  repos: Array<{ name: string; path: string }>;
}

export function getWorkspaceScaffoldSession(workspaceId: string): WorkspaceScaffoldSession | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM workspace_scaffold_sessions WHERE workspace_id = ?')
    .get(workspaceId) as WorkspaceScaffoldSessionRow | undefined;
  return row ? mapWorkspaceScaffoldSession(row) : null;
}

export function startWorkspaceScaffoldSession(
  workspaceId: string,
  rootPath: string,
  personaId = 'coder',
): WorkspaceScaffoldSession {
  const normalizedRootPath = rootPath.trim();
  ensureScaffoldRootPath(normalizedRootPath);

  const db = getDb();
  const id = randomUUID();

  db.prepare(
    `INSERT INTO workspace_scaffold_sessions
       (id, workspace_id, root_path, persona_id, status, completion_json, error_message, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 'active', NULL, NULL, datetime('now'), datetime('now'), NULL)
     ON CONFLICT(workspace_id) DO UPDATE SET
       root_path = excluded.root_path,
       persona_id = excluded.persona_id,
       status = 'active',
       completion_json = NULL,
       error_message = NULL,
       updated_at = datetime('now'),
       completed_at = NULL`,
  ).run(id, workspaceId, normalizedRootPath, personaId);

  return getWorkspaceScaffoldSession(workspaceId)!;
}

export function cancelWorkspaceScaffoldSession(workspaceId: string): void {
  updateWorkspaceScaffoldSession(workspaceId, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
  });
}

export function failWorkspaceScaffoldSession(workspaceId: string, errorMessage: string): void {
  updateWorkspaceScaffoldSession(workspaceId, {
    status: 'failed',
    errorMessage,
  });
}

export function maybeCompleteWorkspaceScaffold(
  workspaceId: string,
  assistantMessage: string,
): WorkspaceScaffoldMaybeCompleteResult {
  const session = getWorkspaceScaffoldSession(workspaceId);
  if (!session || session.status !== 'active') {
    return { triggered: false };
  }

  const completion = parseWorkspaceScaffoldCompletion(assistantMessage);
  if (!completion) {
    return { triggered: false };
  }

  updateWorkspaceScaffoldSession(workspaceId, {
    status: 'syncing',
    completion,
    errorMessage: null,
  });

  void syncWorkspaceScaffoldRepos(workspaceId, completion).catch((err) => {
    failWorkspaceScaffoldSession(
      workspaceId,
      err instanceof Error ? err.message : 'Failed to synchronise scaffolded repositories.',
    );
  });

  return { triggered: true };
}

export function parseWorkspaceScaffoldCompletion(
  assistantMessage: string,
): CompletionPayload | null {
  const markerPatterns = [PRIMARY_SCAFFOLD_COMPLETE_MARKER, LEGACY_SCAFFOLD_COMPLETE_MARKER].map(
    (marker) => new RegExp(`\\[\\[${marker}\\]\\]\\s*([\\s\\S]*?)\\s*\\[\\[\\/${marker}\\]\\]`),
  );
  const match = markerPatterns
    .map((pattern) => assistantMessage.match(pattern))
    .find((result): result is RegExpMatchArray => Boolean(result));
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]) as CompletionPayload;
    if (!Array.isArray(parsed.repos)) return null;

    const repos = parsed.repos
      .filter(
        (repo): repo is { name: string; path: string } =>
          typeof repo?.name === 'string' &&
          repo.name.trim().length > 0 &&
          typeof repo?.path === 'string' &&
          repo.path.trim().length > 0,
      )
      .map((repo) => ({ name: repo.name.trim(), path: repo.path.trim() }));

    return repos.length > 0 ? { repos } : null;
  } catch {
    return null;
  }
}

async function syncWorkspaceScaffoldRepos(
  workspaceId: string,
  completion: CompletionPayload,
): Promise<void> {
  const session = getWorkspaceScaffoldSession(workspaceId);
  if (!session) {
    throw new Error(`Scaffold session not found for workspace ${workspaceId}`);
  }

  const candidatePaths = new Set(completion.repos.map((repo) => repo.path));
  for (const discovered of scanForRepos(session.rootPath, 5)) {
    candidatePaths.add(discovered.path);
  }

  const connectedRepoIds: string[] = [];
  const failures: string[] = [];

  for (const repoPath of candidatePaths) {
    try {
      const repo = await connectRepoPath(repoPath);
      connectedRepoIds.push(repo.id);
    } catch (err) {
      failures.push(
        `${repoPath}: ${err instanceof Error ? err.message : 'Failed to connect repository.'}`,
      );
    }
  }

  if (connectedRepoIds.length === 0) {
    throw new Error(
      failures[0] ??
        'No Git repositories were detected in the scaffold root after completion was inferred.',
    );
  }

  addReposToWorkspace(workspaceId, connectedRepoIds);
  updateWorkspaceScaffoldSession(workspaceId, {
    status: 'indexing',
    errorMessage: failures.length > 0 ? failures.join('\n') : null,
  });

  const indexFailures: string[] = [];
  for (const repoId of connectedRepoIds) {
    try {
      await indexRepo(repoId);
    } catch (err) {
      indexFailures.push(
        `${repoId}: ${err instanceof Error ? err.message : 'Failed to index repository.'}`,
      );
    }
  }

  updateWorkspaceScaffoldSession(workspaceId, {
    status: 'completed',
    errorMessage:
      [...failures, ...indexFailures].length > 0
        ? [...failures, ...indexFailures].join('\n')
        : null,
    completedAt: new Date().toISOString(),
  });
}

function updateWorkspaceScaffoldSession(
  workspaceId: string,
  updates: {
    status?: WorkspaceScaffoldSession['status'];
    completion?: CompletionPayload | null;
    errorMessage?: string | null;
    completedAt?: string | null;
  },
): void {
  const db = getDb();
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (updates.status) {
    setClauses.push('status = ?');
    values.push(updates.status);
  }
  if (updates.completion !== undefined) {
    setClauses.push('completion_json = ?');
    values.push(updates.completion ? JSON.stringify(updates.completion) : null);
  }
  if (updates.errorMessage !== undefined) {
    setClauses.push('error_message = ?');
    values.push(updates.errorMessage);
  }
  if (updates.completedAt !== undefined) {
    setClauses.push('completed_at = ?');
    values.push(updates.completedAt);
  }

  values.push(workspaceId);
  db.prepare(
    `UPDATE workspace_scaffold_sessions SET ${setClauses.join(', ')} WHERE workspace_id = ?`,
  ).run(...values);
}

function mapWorkspaceScaffoldSession(row: WorkspaceScaffoldSessionRow): WorkspaceScaffoldSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    rootPath: row.root_path,
    personaId: row.persona_id,
    status: row.status,
    completion: row.completion_json ? safeParseCompletion(row.completion_json) : undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function safeParseCompletion(json: string): CompletionPayload | undefined {
  try {
    return JSON.parse(json) as CompletionPayload;
  } catch {
    return undefined;
  }
}

function ensureScaffoldRootPath(rootPath: string): void {
  if (!rootPath) {
    throw new Error('Choose a scaffold folder before starting workspace setup.');
  }

  if (existsSync(rootPath)) {
    const stats = statSync(rootPath);
    if (!stats.isDirectory()) {
      throw new Error('The scaffold path exists but is not a folder.');
    }

    if (readdirSync(rootPath).length > 0) {
      throw new Error(
        'The scaffold folder already exists and is not empty. Choose a new folder name or an empty folder.',
      );
    }

    return;
  }

  mkdirSync(rootPath, { recursive: true });
}
