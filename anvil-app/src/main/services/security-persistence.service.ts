import { randomUUID } from 'node:crypto';
import type {
  SecurityAudit,
  SecurityAuditStatus,
  SecurityFinding,
  SecurityFindingSeverity,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';

// ---------------------------------------------------------------------------
// Internal row types (snake_case columns from SQLite)
// ---------------------------------------------------------------------------

interface SecurityAuditRow {
  id: string;
  repo_id: string;
  scope: string;
  status: string;
  summary: string | null;
  started_at: string;
  completed_at: string | null;
  model_version: string | null;
}

interface SecurityFindingRow {
  id: string;
  audit_id: string;
  severity: string;
  category: string;
  owasp_ref: string | null;
  cwe_ref: string | null;
  affected_files: string | null;
  description: string;
  remediation: string | null;
  work_item_id: string | null;
  dismissed: number;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapAudit(row: SecurityAuditRow): SecurityAudit {
  return {
    id: row.id,
    repoId: row.repo_id,
    scope: safeParseJson<string[]>(row.scope, []),
    status: row.status as SecurityAuditStatus,
    summary: row.summary ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    modelVersion: row.model_version ?? undefined,
  };
}

function mapFinding(row: SecurityFindingRow): SecurityFinding {
  return {
    id: row.id,
    auditId: row.audit_id,
    severity: row.severity as SecurityFindingSeverity,
    category: row.category,
    owaspRef: row.owasp_ref ?? undefined,
    cweRef: row.cwe_ref ?? undefined,
    affectedFiles: safeParseJson<string[]>(row.affected_files, []),
    description: row.description,
    remediation: row.remediation ?? undefined,
    workItemId: row.work_item_id ?? undefined,
    dismissed: row.dismissed === 1,
  };
}

function safeParseJson<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Audit operations
// ---------------------------------------------------------------------------

export interface CreateAuditInput {
  repoId: string;
  scope: string[];
  modelVersion?: string;
}

/**
 * Create a new security audit and return its ID.
 */
export function createAudit(input: CreateAuditInput): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO security_audits
     (id, repo_id, scope, status, started_at, model_version)
     VALUES (?, ?, ?, 'running', ?, ?)`,
  ).run(id, input.repoId, JSON.stringify(input.scope), now, input.modelVersion ?? null);
  return id;
}

/**
 * Get a security audit by ID, or null if not found.
 */
export function getAudit(id: string): SecurityAudit | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM security_audits WHERE id = ?').get(id) as
    | SecurityAuditRow
    | undefined;
  return row ? mapAudit(row) : null;
}

/**
 * List all security audits for a given repo, ordered by start time descending.
 */
export function listAudits(repoId: string): SecurityAudit[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM security_audits WHERE repo_id = ? ORDER BY started_at DESC`)
    .all(repoId) as SecurityAuditRow[];
  return rows.map(mapAudit);
}

/**
 * Get the currently running audit for a repo, if any.
 * Automatically marks audits running for over 30 minutes as failed.
 */
export function getRunningAudit(repoId: string): SecurityAudit | null {
  const db = getDb();

  // Clean up stale audits that have been running for over 30 minutes
  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  db.prepare(
    `UPDATE security_audits SET status = 'failed', summary = 'Audit timed out', completed_at = ?
     WHERE repo_id = ? AND status = 'running' AND started_at < ?`,
  ).run(new Date().toISOString(), repoId, staleThreshold);

  const row = db
    .prepare(
      `SELECT * FROM security_audits WHERE repo_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .get(repoId) as SecurityAuditRow | undefined;
  return row ? mapAudit(row) : null;
}

/**
 * Update the status (and optionally summary) of a security audit.
 */
export function updateAuditStatus(id: string, status: SecurityAuditStatus, summary?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (summary !== undefined) {
    db.prepare(
      `UPDATE security_audits SET status = ?, summary = ?, completed_at = ? WHERE id = ?`,
    ).run(status, summary, now, id);
  } else {
    db.prepare(`UPDATE security_audits SET status = ?, completed_at = ? WHERE id = ?`).run(
      status,
      now,
      id,
    );
  }
}

// ---------------------------------------------------------------------------
// Finding operations
// ---------------------------------------------------------------------------

export interface CreateFindingInput {
  auditId: string;
  severity: SecurityFindingSeverity;
  category: string;
  owaspRef?: string;
  cweRef?: string;
  affectedFiles: string[];
  description: string;
  remediation?: string;
}

/**
 * Create a security finding and return its ID.
 */
export function createFinding(input: CreateFindingInput): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO security_findings
     (id, audit_id, severity, category, owasp_ref, cwe_ref, affected_files, description, remediation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.auditId,
    input.severity,
    input.category,
    input.owaspRef ?? null,
    input.cweRef ?? null,
    JSON.stringify(input.affectedFiles),
    input.description,
    input.remediation ?? null,
  );
  return id;
}

/**
 * Get all findings for a given audit, ordered by severity.
 */
export function getFindings(auditId: string): SecurityFinding[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM security_findings WHERE audit_id = ?
       ORDER BY CASE severity
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         WHEN 'low' THEN 3
         WHEN 'info' THEN 4
         ELSE 5
       END`,
    )
    .all(auditId) as SecurityFindingRow[];
  return rows.map(mapFinding);
}

/**
 * Get a single finding by ID, or null if not found.
 */
export function getFinding(id: string): SecurityFinding | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM security_findings WHERE id = ?').get(id) as
    | SecurityFindingRow
    | undefined;
  return row ? mapFinding(row) : null;
}

/**
 * Dismiss a security finding.
 */
export function dismissFinding(id: string): void {
  const db = getDb();
  db.prepare('UPDATE security_findings SET dismissed = 1 WHERE id = ?').run(id);
}

/**
 * Link a finding to a work item.
 */
export function linkFindingToWorkItem(findingId: string, workItemId: string): void {
  const db = getDb();
  db.prepare('UPDATE security_findings SET work_item_id = ? WHERE id = ?').run(
    workItemId,
    findingId,
  );
}
