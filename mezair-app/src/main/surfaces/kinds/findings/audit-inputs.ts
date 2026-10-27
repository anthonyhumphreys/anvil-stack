// Loads the indexed repo summary a security audit needs, mirroring the
// security IPC handler so the audit can run in-process without UI.
import type { RepoSummary } from '../../../../shared/types.js';
import { getDb } from '../../../db/database.js';

export interface SecurityAuditInputs {
  summary: RepoSummary;
  languages: Array<{ language: string; percentage: number }>;
}

function safeParseJson<T>(json: unknown, fallback: T): T {
  if (typeof json !== 'string' || !json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** Null when the repo has not been indexed (no summary to audit against). */
export function loadSecurityAuditInputs(repoId: string): SecurityAuditInputs | null {
  const db = getDb();
  const summaryRow = db.prepare('SELECT * FROM repo_summaries WHERE repo_id = ?').get(repoId) as
    Record<string, unknown> | undefined;
  if (!summaryRow) return null;
  const moduleRows = db
    .prepare('SELECT * FROM module_summaries WHERE repo_id = ?')
    .all(repoId) as Array<Record<string, unknown>>;
  const summary: RepoSummary = {
    repoId,
    overview: String(summaryRow.overview ?? ''),
    modules: moduleRows.map((row) => ({
      path: String(row.path),
      purpose: String(row.purpose ?? ''),
      fileCount: Number(row.file_count ?? 0),
      keyFiles: safeParseJson<string[]>(row.key_files, []),
      dependencies: safeParseJson<string[]>(row.dependencies, []),
    })),
    patterns: safeParseJson<string[]>(summaryRow.patterns, []),
    frameworks: safeParseJson<string[]>(summaryRow.frameworks, []),
    entryPoints: safeParseJson<string[]>(summaryRow.entry_points, []),
    configFiles: safeParseJson<string[]>(summaryRow.config_files, []),
    mermaidDiagram: String(summaryRow.mermaid_diagram ?? ''),
  };
  return {
    summary,
    languages: safeParseJson<Array<{ language: string; percentage: number }>>(
      summaryRow.language_breakdown,
      [],
    ),
  };
}
