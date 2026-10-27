import type { AgentRunSummary, AgentRunStatus } from '../../shared/types.js';
import { getDb } from '../db/database.js';

interface ChatRunRow {
  id: string;
  thread_id: string;
  session_id: string | null;
  workspace_id: string | null;
  title: string;
  repo_ids_json: string;
  content: string;
  timestamp: string;
  completed_at: string | null;
  evidence_count: number;
  changed_file_count: number;
}

interface AutomationRunRow {
  id: string;
  automation_id: string;
  workspace_id: string;
  name: string;
  repo_ids_json: string;
  status: string;
  assistant_message: string | null;
  error_message: string | null;
  changed_file_count: number;
  started_at: string;
  completed_at: string | null;
  event_count: number;
}

interface CodeReviewRunRow {
  id: string;
  repo_id: string;
  repo_name: string | null;
  status: string;
  summary: string | null;
  scope_type: string;
  started_at: string;
  completed_at: string | null;
  finding_count: number;
}

export function listAgentRuns(workspaceId: string, limit = 60): AgentRunSummary[] {
  const db = getDb();
  const chatRuns = db
    .prepare(
      `SELECT
         m.id,
         m.thread_id,
         m.session_id,
         t.workspace_id,
         t.title,
         t.repo_ids_json,
         m.content,
         m.timestamp,
         (
           SELECT MIN(a.timestamp)
           FROM chat_messages a
           WHERE a.thread_id = m.thread_id
             AND a.role = 'assistant'
             AND a.timestamp > m.timestamp
         ) AS completed_at,
         (
           SELECT COUNT(*)
           FROM chat_messages e
           WHERE e.thread_id = m.thread_id
             AND e.kind = 'event'
             AND e.timestamp >= m.timestamp
             AND e.timestamp <= COALESCE((
               SELECT MIN(a2.timestamp)
               FROM chat_messages a2
               WHERE a2.thread_id = m.thread_id
                 AND a2.role = 'assistant'
                 AND a2.timestamp > m.timestamp
             ), datetime('now'))
         ) AS evidence_count,
         (
           SELECT COUNT(DISTINCT json_extract(e.event_json, '$.filePath'))
           FROM chat_messages e
           WHERE e.thread_id = m.thread_id
             AND e.kind = 'event'
             AND json_extract(e.event_json, '$.type') = 'file_edit'
             AND e.timestamp >= m.timestamp
             AND e.timestamp <= COALESCE((
               SELECT MIN(a3.timestamp)
               FROM chat_messages a3
               WHERE a3.thread_id = m.thread_id
                 AND a3.role = 'assistant'
                 AND a3.timestamp > m.timestamp
             ), datetime('now'))
         ) AS changed_file_count
       FROM chat_messages m
       JOIN chat_threads t ON t.id = m.thread_id
       WHERE m.role = 'user'
         AND t.workspace_id = ?
       ORDER BY m.timestamp DESC
       LIMIT ?`,
    )
    .all(workspaceId, limit) as ChatRunRow[];

  const automationRuns = db
    .prepare(
      `SELECT
         r.id,
         r.automation_id,
         r.workspace_id,
         d.name,
         d.repo_ids_json,
         r.status,
         r.assistant_message,
         r.error_message,
         r.changed_file_count,
         r.started_at,
         r.completed_at,
         COUNT(e.id) AS event_count
       FROM automation_runs r
       JOIN automation_definitions d ON d.id = r.automation_id
       LEFT JOIN automation_run_events e ON e.run_id = r.id
       WHERE r.workspace_id = ?
       GROUP BY r.id
       ORDER BY r.started_at DESC
       LIMIT ?`,
    )
    .all(workspaceId, limit) as AutomationRunRow[];

  const workspaceRepoIds = db
    .prepare('SELECT repo_id FROM workspace_repos WHERE workspace_id = ?')
    .all(workspaceId) as Array<{ repo_id: string }>;
  const repoIds = workspaceRepoIds.map((row) => row.repo_id);
  const codeReviewRuns =
    repoIds.length > 0
      ? (db
          .prepare(
            `SELECT
               cr.id,
               cr.repo_id,
               repos.name AS repo_name,
               cr.status,
               cr.summary,
               cr.scope_type,
               cr.started_at,
               cr.completed_at,
               COUNT(f.id) AS finding_count
             FROM code_reviews cr
             LEFT JOIN repos ON repos.id = cr.repo_id
             LEFT JOIN code_review_findings f ON f.review_id = cr.id
             WHERE cr.repo_id IN (${repoIds.map(() => '?').join(',')})
             GROUP BY cr.id
             ORDER BY cr.started_at DESC
             LIMIT ?`,
          )
          .all(...repoIds, limit) as CodeReviewRunRow[])
      : [];

  return [
    ...chatRuns.map(mapChatRun),
    ...automationRuns.map(mapAutomationRun),
    ...codeReviewRuns.map(mapCodeReviewRun),
  ]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit);
}

function mapChatRun(row: ChatRunRow): AgentRunSummary {
  return {
    id: `chat:${row.id}`,
    source: 'chat',
    title: row.title,
    status: row.completed_at ? 'completed' : 'running',
    workspaceId: row.workspace_id ?? undefined,
    repoIds: parseStringArray(row.repo_ids_json),
    threadId: row.thread_id,
    sessionId: row.session_id ?? undefined,
    startedAt: row.timestamp,
    completedAt: row.completed_at ?? undefined,
    summary: row.content.replace(/\s+/g, ' ').trim().slice(0, 180),
    changedFileCount: Number(row.changed_file_count ?? 0),
    evidenceCount: Number(row.evidence_count ?? 0),
  };
}

function mapAutomationRun(row: AutomationRunRow): AgentRunSummary {
  return {
    id: `automation:${row.id}`,
    source: 'automation',
    title: row.name,
    status: normalizeStatus(row.status),
    workspaceId: row.workspace_id,
    repoIds: parseStringArray(row.repo_ids_json),
    automationId: row.automation_id,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    summary: row.error_message ?? row.assistant_message?.replace(/\s+/g, ' ').trim().slice(0, 180),
    changedFileCount: Number(row.changed_file_count ?? 0),
    evidenceCount: Number(row.event_count ?? 0),
  };
}

function mapCodeReviewRun(row: CodeReviewRunRow): AgentRunSummary {
  return {
    id: `code_review:${row.id}`,
    source: 'code_review',
    title: `${row.repo_name ?? 'Repository'} review`,
    status: normalizeStatus(row.status),
    repoIds: [row.repo_id],
    reviewId: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    summary: row.summary ?? row.scope_type.replace(/_/g, ' '),
    changedFileCount: 0,
    evidenceCount: Number(row.finding_count ?? 0),
  };
}

function normalizeStatus(value: string): AgentRunStatus {
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  return 'running';
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}
