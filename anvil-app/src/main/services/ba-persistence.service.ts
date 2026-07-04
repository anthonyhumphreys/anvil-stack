import { randomUUID } from 'node:crypto';
import type {
  BaSession,
  BaFinding,
  BaFindingType,
  BaFindingStatus,
  BaMessage,
  BaRepoLink,
  WorkItem,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';

// ---------------------------------------------------------------------------
// Internal row types (snake_case columns from SQLite)
// ---------------------------------------------------------------------------

interface BaSessionRow {
  id: string;
  work_item_id: string;
  repo_id: string;
  spike_branch: string;
  origin_branch: string;
  worktree_path: string | null;
  stash_ref: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
}

interface BaFindingRow {
  id: string;
  work_item_id: string;
  repo_id: string;
  session_id: string | null;
  type: string;
  content: string;
  status: string;
  source_message_id: string | null;
  follow_up_work_item_id: string | null;
  follow_up_work_item_provider: string | null;
  follow_up_work_item_title: string | null;
  follow_up_work_item_url: string | null;
  created_at: string;
  updated_at: string;
}

interface BaMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  event_type: string | null;
  created_at: string;
}

interface BaRepoLinkRow {
  work_item_id: string;
  repo_id: string;
  linked_at: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapSession(row: BaSessionRow): BaSession {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    repoId: row.repo_id,
    spikeBranch: row.spike_branch,
    originBranch: row.origin_branch,
    worktreePath: row.worktree_path ?? undefined,
    stashRef: row.stash_ref ?? undefined,
    status: row.status as BaSession['status'],
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
  };
}

function mapFinding(row: BaFindingRow): BaFinding {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    repoId: row.repo_id,
    sessionId: row.session_id ?? undefined,
    type: row.type as BaFindingType,
    content: row.content,
    status: row.status as BaFindingStatus,
    sourceMessageId: row.source_message_id ?? undefined,
    followUpWorkItemId: row.follow_up_work_item_id ?? undefined,
    followUpWorkItemProvider:
      (row.follow_up_work_item_provider as BaFinding['followUpWorkItemProvider']) ?? undefined,
    followUpWorkItemTitle: row.follow_up_work_item_title ?? undefined,
    followUpWorkItemUrl: row.follow_up_work_item_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: BaMessageRow): BaMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as BaMessage['role'],
    content: row.content,
    eventType: row.event_type ?? undefined,
    createdAt: row.created_at,
  };
}

function mapRepoLink(row: BaRepoLinkRow): BaRepoLink {
  return {
    workItemId: row.work_item_id,
    repoId: row.repo_id,
    linkedAt: row.linked_at,
  };
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

export interface CreateBaSessionInput {
  workItemId: string;
  repoId: string;
  spikeBranch: string;
  originBranch: string;
  worktreePath?: string;
  stashRef?: string;
}

/**
 * Create a new BA session and return its ID.
 */
export function createBaSession(input: CreateBaSessionInput): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ba_sessions
     (id, work_item_id, repo_id, spike_branch, origin_branch, worktree_path, stash_ref, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    id,
    input.workItemId,
    input.repoId,
    input.spikeBranch,
    input.originBranch,
    input.worktreePath ?? null,
    input.stashRef ?? null,
    now,
  );
  return id;
}

/**
 * Get a BA session by ID, or null if not found.
 */
export function getBaSession(id: string): BaSession | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ba_sessions WHERE id = ?').get(id) as
    | BaSessionRow
    | undefined;
  return row ? mapSession(row) : null;
}

/**
 * Get the active (non-ended) BA session for a work item, or null.
 */
export function getActiveBaSession(workItemId: string): BaSession | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM ba_sessions
       WHERE work_item_id = ? AND status = 'active'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(workItemId) as BaSessionRow | undefined;
  return row ? mapSession(row) : null;
}

/**
 * Mark a BA session as completed with an ended_at timestamp.
 */
export function endBaSession(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE ba_sessions SET status = 'completed', ended_at = ? WHERE id = ?`).run(now, id);
}

/**
 * Get all sessions with status 'orphaned'.
 */
export function getOrphanedSessions(): BaSession[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM ba_sessions WHERE status = 'orphaned'`)
    .all() as BaSessionRow[];
  return rows.map(mapSession);
}

/**
 * Mark a session as orphaned (e.g. app crashed while it was active).
 */
export function markSessionOrphaned(id: string): void {
  const db = getDb();
  db.prepare(`UPDATE ba_sessions SET status = 'orphaned' WHERE id = ?`).run(id);
}

/**
 * List all BA sessions for a given work item.
 */
export function listBaSessions(workItemId: string): BaSession[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM ba_sessions WHERE work_item_id = ? ORDER BY started_at ASC`)
    .all(workItemId) as BaSessionRow[];
  return rows.map(mapSession);
}

// ---------------------------------------------------------------------------
// Finding operations
// ---------------------------------------------------------------------------

export interface CreateBaFindingInput {
  workItemId: string;
  repoId: string;
  sessionId?: string;
  type: BaFindingType;
  content: string;
  sourceMessageId?: string;
}

/**
 * Create a BA finding. If a finding with the same workItemId + type + content
 * already exists, the existing finding is returned instead (deduplication).
 */
export function createBaFinding(input: CreateBaFindingInput): BaFinding {
  const db = getDb();

  // Deduplication: check for existing finding with same workItemId + type + content
  const existing = db
    .prepare(
      `SELECT * FROM ba_findings
       WHERE work_item_id = ? AND type = ? AND content = ?
       LIMIT 1`,
    )
    .get(input.workItemId, input.type, input.content) as BaFindingRow | undefined;

  if (existing) {
    return mapFinding(existing);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ba_findings
     (id, work_item_id, repo_id, session_id, type, content, status, source_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
  ).run(
    id,
    input.workItemId,
    input.repoId,
    input.sessionId ?? null,
    input.type,
    input.content,
    input.sourceMessageId ?? null,
    now,
    now,
  );

  return mapFinding(db.prepare('SELECT * FROM ba_findings WHERE id = ?').get(id) as BaFindingRow);
}

/**
 * Get a BA finding by ID, or null if not found.
 */
export function getBaFinding(id: string): BaFinding | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ba_findings WHERE id = ?').get(id) as
    | BaFindingRow
    | undefined;
  return row ? mapFinding(row) : null;
}

/**
 * List all BA findings for a given work item.
 */
export function listBaFindings(workItemId: string): BaFinding[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM ba_findings WHERE work_item_id = ? ORDER BY created_at ASC`)
    .all(workItemId) as BaFindingRow[];
  return rows.map(mapFinding);
}

export interface UpdateBaFindingInput {
  status?: BaFindingStatus;
  content?: string;
}

/**
 * Update mutable fields on a BA finding (status and/or content).
 */
export function updateBaFinding(id: string, updates: UpdateBaFindingInput): void {
  const db = getDb();
  const now = new Date().toISOString();

  const setClauses: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    values.push(updates.status);
  }
  if (updates.content !== undefined) {
    setClauses.push('content = ?');
    values.push(updates.content);
  }

  values.push(id);
  db.prepare(`UPDATE ba_findings SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Delete a BA finding by ID.
 */
export function deleteBaFinding(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM ba_findings WHERE id = ?').run(id);
}

export function linkBaFindingToWorkItem(
  findingId: string,
  workItem: Pick<WorkItem, 'id' | 'provider' | 'title' | 'url'>,
): BaFinding {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE ba_findings
     SET follow_up_work_item_id = ?,
         follow_up_work_item_provider = ?,
         follow_up_work_item_title = ?,
         follow_up_work_item_url = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(workItem.id, workItem.provider, workItem.title, workItem.url ?? null, now, findingId);

  return mapFinding(
    db.prepare('SELECT * FROM ba_findings WHERE id = ?').get(findingId) as BaFindingRow,
  );
}

// ---------------------------------------------------------------------------
// Message operations
// ---------------------------------------------------------------------------

export interface SaveBaMessageInput {
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  eventType?: string;
}

/**
 * Persist a single BA message.
 */
export function saveBaMessage(input: SaveBaMessageInput): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ba_messages (id, session_id, role, content, event_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.sessionId, input.role, input.content, input.eventType ?? null, now);
  return id;
}

/**
 * Load all messages for a given BA session, ordered by creation time.
 */
export function loadBaMessages(sessionId: string): BaMessage[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM ba_messages WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as BaMessageRow[];
  return rows.map(mapMessage);
}

// ---------------------------------------------------------------------------
// Repo link operations
// ---------------------------------------------------------------------------

/**
 * Set (or overwrite) the repo link for a work item.
 */
export function setBaRepoLink(workItemId: string, repoId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO ba_repo_links (work_item_id, repo_id, linked_at)
     VALUES (?, ?, ?)`,
  ).run(workItemId, repoId, now);
}

/**
 * Get the repo link for a work item, or null if none exists.
 */
export function getBaRepoLink(workItemId: string): BaRepoLink | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ba_repo_links WHERE work_item_id = ?').get(workItemId) as
    | BaRepoLinkRow
    | undefined;
  return row ? mapRepoLink(row) : null;
}
