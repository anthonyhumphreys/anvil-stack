import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import type {
  DbInsightAnalysis,
  DbInsightArtifact,
  DbInsightArtifactCategory,
  DbInsightFileType,
  DbInsightStoredProcedure,
  DbInsightTable,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { callLlm } from './llm.service.js';
import { loadPromptTemplate } from '../utils/prompt-templates.js';

interface DbInsightArtifactRow {
  id: string;
  workspace_id: string;
  file_path: string;
  file_name: string;
  file_type: string;
  category: string;
  file_size: number;
  added_at: string;
  updated_at: string;
}

interface DbInsightAnalysisRow {
  id: string;
  workspace_id: string;
  artifact_ids: string;
  status: string;
  summary: string | null;
  database_name: string | null;
  table_count: number;
  procedure_count: number;
  view_count: number;
  function_count: number;
  tables_json: string;
  procedures_json: string;
  relationships_json: string;
  risks_json: string;
  recommended_questions_json: string;
  raw_snapshot_json: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ParsedSqlSnapshot {
  databaseName?: string;
  tableCount: number;
  procedureCount: number;
  viewCount: number;
  functionCount: number;
  tables: DbInsightTable[];
  storedProcedures: DbInsightStoredProcedure[];
  relationships: string[];
}

interface AnalysisPayload {
  summary: string;
  databaseName?: string;
  tables: DbInsightTable[];
  storedProcedures: DbInsightStoredProcedure[];
  relationships: string[];
  risks: string[];
  recommendedQuestions: string[];
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapArtifact(row: DbInsightArtifactRow): DbInsightArtifact {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    filePath: row.file_path,
    fileName: row.file_name,
    fileType: row.file_type as DbInsightFileType,
    category: row.category as DbInsightArtifactCategory,
    fileSize: row.file_size,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

function mapAnalysis(row: DbInsightAnalysisRow): DbInsightAnalysis {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    artifactIds: parseJsonArray<string>(row.artifact_ids),
    status: row.status as DbInsightAnalysis['status'],
    summary: row.summary ?? '',
    databaseName: row.database_name ?? undefined,
    tableCount: row.table_count,
    procedureCount: row.procedure_count,
    viewCount: row.view_count,
    functionCount: row.function_count,
    tables: parseJsonArray<DbInsightTable>(row.tables_json),
    storedProcedures: parseJsonArray<DbInsightStoredProcedure>(row.procedures_json),
    relationships: parseJsonArray<string>(row.relationships_json),
    risks: parseJsonArray<string>(row.risks_json),
    recommendedQuestions: parseJsonArray<string>(row.recommended_questions_json),
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function inferFileType(filePath: string): DbInsightFileType {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.sql':
      return 'sql';
    case '.txt':
      return 'txt';
    case '.json':
      return 'json';
    default:
      return 'other';
  }
}

function normalizeQualifiedName(raw: string): string {
  return raw
    .replace(/[\[\]"`]/g, '')
    .replace(/\s+/g, '')
    .replace(/^\.+|\.+$/g, '');
}

function splitQualifiedName(raw: string): { schema: string; name: string; qualifiedName: string } {
  const normalized = normalizeQualifiedName(raw);
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length >= 2) {
    const schema = parts[parts.length - 2];
    const name = parts[parts.length - 1];
    return { schema, name, qualifiedName: `${schema}.${name}` };
  }

  const name = parts[0] ?? normalized ?? 'unknown';
  return { schema: 'dbo', name, qualifiedName: `dbo.${name}` };
}

function uniqueByQualifiedName<T extends { qualifiedName: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.qualifiedName)) return false;
    seen.add(item.qualifiedName);
    return true;
  });
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
}

function extractColumnNames(body: string): string[] {
  const lines = body.split('\n');
  const columns: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/,$/, '');
    if (!line) continue;
    if (/^(constraint|primary\s+key|foreign\s+key|unique|check|\))/i.test(line)) continue;
    const match = line.match(/^(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$#]*)/);
    if (!match) continue;
    const column = normalizeQualifiedName(match[1]);
    if (column) columns.push(column);
  }

  return columns;
}

function extractReferencedObjects(block: string): string[] {
  const matches = block.matchAll(
    /(?:from|join|update|into|delete\s+from|merge\s+into)\s+([#A-Za-z0-9_\[\]"`.]+)/gi,
  );

  const refs = new Set<string>();
  for (const match of matches) {
    const qualifiedName = splitQualifiedName(match[1]).qualifiedName;
    if (!qualifiedName.includes('#')) refs.add(qualifiedName);
  }

  return [...refs].sort();
}

function inferProcedurePurpose(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith('uspget') || lower.startsWith('get') || lower.includes('lookup')) {
    return 'Reads and returns data for consumers.';
  }
  if (lower.startsWith('usplist') || lower.startsWith('list') || lower.includes('search')) {
    return 'Lists or searches records.';
  }
  if (lower.startsWith('uspinsert') || lower.startsWith('insert') || lower.startsWith('create')) {
    return 'Creates new records.';
  }
  if (lower.startsWith('uspupdate') || lower.startsWith('update')) {
    return 'Updates existing records.';
  }
  if (lower.startsWith('uspdelete') || lower.startsWith('delete') || lower.startsWith('remove')) {
    return 'Deletes or deactivates records.';
  }
  if (lower.includes('sync') || lower.includes('import')) {
    return 'Synchronises or imports data.';
  }
  if (lower.includes('report')) {
    return 'Builds reporting or export output.';
  }

  return 'Encapsulates database-side business logic.';
}

export function parseSqlSnapshot(contents: string[]): ParsedSqlSnapshot {
  const tables: DbInsightTable[] = [];
  const storedProcedures: DbInsightStoredProcedure[] = [];
  const relationships = new Set<string>();
  const viewNames = new Set<string>();
  const functionNames = new Set<string>();
  let databaseName: string | undefined;

  for (const content of contents) {
    const cleaned = stripSqlComments(content);

    if (!databaseName) {
      const databaseMatch = cleaned.match(/\buse\s+\[?([A-Za-z0-9_]+)\]?/i);
      if (databaseMatch) databaseName = databaseMatch[1];
    }

    const tableMatches = cleaned.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?([#A-Za-z0-9_\[\]"`.]+)\s*\(([\s\S]*?)\)\s*(?=go\b|create\b|$)/gi,
    );
    for (const match of tableMatches) {
      const { schema, name, qualifiedName } = splitQualifiedName(match[1]);
      const columnNames = extractColumnNames(match[2]);
      const keyColumns = columnNames.filter((column) => /(id|code|key)$/i.test(column)).slice(0, 6);

      for (const ref of match[2].matchAll(/references\s+([#A-Za-z0-9_\[\]"`.]+)/gi)) {
        relationships.add(`${qualifiedName} -> ${splitQualifiedName(ref[1]).qualifiedName}`);
      }

      tables.push({
        schema,
        name,
        qualifiedName,
        columnCount: columnNames.length,
        keyColumns,
      });
    }

    const procedureMatches = cleaned.matchAll(
      /create\s+(?:or\s+alter\s+)?(?:proc|procedure)\s+([#A-Za-z0-9_\[\]"`.]+)([\s\S]*?)(?=\n\s*go\s*(?:\n|$)|\n\s*create\s+(?:or\s+alter\s+)?(?:proc|procedure|table|view|function)\b|$)/gi,
    );
    for (const match of procedureMatches) {
      const { schema, name, qualifiedName } = splitQualifiedName(match[1]);
      storedProcedures.push({
        schema,
        name,
        qualifiedName,
        purpose: inferProcedurePurpose(name),
        referencedObjects: extractReferencedObjects(match[2]).slice(0, 10),
      });
    }

    for (const match of cleaned.matchAll(/create\s+view\s+([#A-Za-z0-9_\[\]"`.]+)/gi)) {
      viewNames.add(splitQualifiedName(match[1]).qualifiedName);
    }

    for (const match of cleaned.matchAll(/create\s+function\s+([#A-Za-z0-9_\[\]"`.]+)/gi)) {
      functionNames.add(splitQualifiedName(match[1]).qualifiedName);
    }
  }

  const dedupedTables = uniqueByQualifiedName(tables).sort((a, b) =>
    a.qualifiedName.localeCompare(b.qualifiedName),
  );
  const dedupedProcedures = uniqueByQualifiedName(storedProcedures).sort((a, b) =>
    a.qualifiedName.localeCompare(b.qualifiedName),
  );

  return {
    databaseName,
    tableCount: dedupedTables.length,
    procedureCount: dedupedProcedures.length,
    viewCount: viewNames.size,
    functionCount: functionNames.size,
    tables: dedupedTables,
    storedProcedures: dedupedProcedures,
    relationships: [...relationships].sort(),
  };
}

export function inferArtifactCategory(
  fileName: string,
  content: string,
): DbInsightArtifactCategory {
  const lowerName = fileName.toLowerCase();
  const cleaned = stripSqlComments(content).toLowerCase();
  const hasTables = /create\s+table/.test(cleaned);
  const hasProcedures = /create\s+(?:or\s+alter\s+)?(?:proc|procedure)/.test(cleaned);

  if (hasTables && hasProcedures) return 'mixed';
  if (hasTables) return 'schema';
  if (hasProcedures) return 'stored-procedure';
  if (lowerName.includes('schema')) return 'schema';
  if (lowerName.includes('proc')) return 'stored-procedure';
  return 'other';
}

function buildFallbackAnalysis(snapshot: ParsedSqlSnapshot): AnalysisPayload {
  const topTables = snapshot.tables.slice(0, 8);
  const topProcedures = snapshot.storedProcedures.slice(0, 8);
  const notableTables =
    topTables.map((table) => table.qualifiedName).join(', ') || 'none identified';
  const notableProcedures =
    topProcedures.map((procedure) => procedure.qualifiedName).join(', ') || 'none identified';

  const risks: string[] = [];
  if (snapshot.tableCount === 0) {
    risks.push('No table definitions were detected in the uploaded exports.');
  }
  if (snapshot.procedureCount === 0) {
    risks.push('No stored procedures were detected in the uploaded exports.');
  }
  if (snapshot.relationships.length === 0 && snapshot.tableCount > 1) {
    risks.push(
      'No foreign-key relationships were detected from the exported DDL, so referential links may be implicit or missing.',
    );
  }
  if (snapshot.procedureCount > 0 && snapshot.tableCount === 0) {
    risks.push(
      'Stored procedures were provided without matching schema definitions, so some references may be unresolved.',
    );
  }
  if (snapshot.tableCount > 40) {
    risks.push(
      'This appears to be a broad schema export; consider analysing bounded subsets if you need deeper guidance.',
    );
  }

  return {
    summary:
      `DB Insights found ${snapshot.tableCount} table(s), ${snapshot.procedureCount} stored procedure(s), ` +
      `${snapshot.viewCount} view(s), and ${snapshot.functionCount} function(s). ` +
      `Key tables: ${notableTables}. Key procedures: ${notableProcedures}.`,
    databaseName: snapshot.databaseName,
    tables: topTables,
    storedProcedures: topProcedures,
    relationships: snapshot.relationships.slice(0, 12),
    risks,
    recommendedQuestions: [
      'Which tables are the system of record for the main business entities?',
      'Which stored procedures read versus mutate data?',
      'Where are the highest-impact dependencies if a table shape changes?',
      'Which procedures should be reviewed first for performance or maintainability?',
    ],
  };
}

function parseAnalysisResponse(text: string): AnalysisPayload | null {
  const candidates: string[] = [];
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) candidates.push(fenceMatch[1]);

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as Record<string, unknown>;
      return {
        summary: String(parsed.executiveSummary ?? ''),
        databaseName:
          typeof parsed.databaseName === 'string' && parsed.databaseName.trim().length > 0
            ? parsed.databaseName
            : undefined,
        tables: Array.isArray(parsed.tables)
          ? parsed.tables.map((item) => {
              const value = item as Record<string, unknown>;
              return {
                schema: String(value.schema ?? 'dbo'),
                name: String(value.name ?? 'unknown'),
                qualifiedName: String(
                  value.qualifiedName ??
                    `${String(value.schema ?? 'dbo')}.${String(value.name ?? 'unknown')}`,
                ),
                columnCount: Number(value.columnCount ?? 0),
                keyColumns: Array.isArray(value.keyColumns) ? value.keyColumns.map(String) : [],
                notes: value.notes ? String(value.notes) : undefined,
              };
            })
          : [],
        storedProcedures: Array.isArray(parsed.storedProcedures)
          ? parsed.storedProcedures.map((item) => {
              const value = item as Record<string, unknown>;
              return {
                schema: String(value.schema ?? 'dbo'),
                name: String(value.name ?? 'unknown'),
                qualifiedName: String(
                  value.qualifiedName ??
                    `${String(value.schema ?? 'dbo')}.${String(value.name ?? 'unknown')}`,
                ),
                purpose: value.purpose ? String(value.purpose) : undefined,
                referencedObjects: Array.isArray(value.referencedObjects)
                  ? value.referencedObjects.map(String)
                  : [],
              };
            })
          : [],
        relationships: Array.isArray(parsed.relationships) ? parsed.relationships.map(String) : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
        recommendedQuestions: Array.isArray(parsed.recommendedQuestions)
          ? parsed.recommendedQuestions.map(String)
          : [],
      };
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function buildArtifactList(artifacts: DbInsightArtifact[]): string {
  return artifacts
    .map(
      (artifact) =>
        `- ${artifact.fileName} (${artifact.category}, ${artifact.fileType}): ${artifact.filePath}`,
    )
    .join('\n');
}

function buildSourceContext(
  artifacts: DbInsightArtifact[],
  contents: Map<string, string>,
  maxChars = 60_000,
): string {
  let combined = '';

  for (const artifact of artifacts) {
    const content = contents.get(artifact.id) ?? '';
    if (!content) continue;

    const cleaned = stripSqlComments(content).trim();
    const excerpt = cleaned.length > 18_000 ? `${cleaned.slice(0, 18_000)}\n...` : cleaned;
    const block = `--- ${artifact.fileName} ---\n${excerpt}\n`;

    if (combined.length + block.length > maxChars) break;
    combined += block;
  }

  return combined;
}

function commonParentDir(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const directories = paths.map((value) => path.dirname(value));
  const splitPaths = directories.map((value) => value.split(path.sep).filter(Boolean));
  const commonParts: string[] = [];

  for (let index = 0; index < splitPaths[0].length; index += 1) {
    const segment = splitPaths[0][index];
    if (splitPaths.every((parts) => parts[index] === segment)) {
      commonParts.push(segment);
      continue;
    }
    break;
  }

  if (commonParts.length === 0) return directories[0];

  const prefix = directories[0].startsWith(path.sep) ? path.sep : '';
  return `${prefix}${commonParts.join(path.sep)}`;
}

function getWorkspaceName(workspaceId: string): string {
  const row = getDb().prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId) as
    | { name: string }
    | undefined;
  return row?.name ?? 'Workspace';
}

function buildPersonaSummary(analysis: DbInsightAnalysis, artifacts: DbInsightArtifact[]): string {
  const artifactSummary =
    artifacts.length > 0
      ? artifacts
          .slice(0, 6)
          .map((artifact) => `- ${artifact.fileName}: ${artifact.filePath}`)
          .join('\n')
      : 'No DB export files are attached to this workspace.';

  const tables =
    analysis.tables.length > 0
      ? analysis.tables
          .slice(0, 8)
          .map((table) => `- ${table.qualifiedName} (${table.columnCount} columns)`)
          .join('\n')
      : 'No tables detected.';

  const procedures =
    analysis.storedProcedures.length > 0
      ? analysis.storedProcedures
          .slice(0, 8)
          .map((procedure) => `- ${procedure.qualifiedName}`)
          .join('\n')
      : 'No stored procedures detected.';

  const relationships =
    analysis.relationships.length > 0
      ? analysis.relationships
          .slice(0, 8)
          .map((value) => `- ${value}`)
          .join('\n')
      : 'No explicit relationships were detected.';

  const risks =
    analysis.risks.length > 0
      ? analysis.risks
          .slice(0, 6)
          .map((value) => `- ${value}`)
          .join('\n')
      : 'No major structural risks were highlighted.';

  return [
    `Latest DB Insights analysis for this workspace${analysis.databaseName ? ` (${analysis.databaseName})` : ''}:`,
    `- Summary: ${analysis.summary}`,
    `- Counts: ${analysis.tableCount} table(s), ${analysis.procedureCount} stored procedure(s), ${analysis.viewCount} view(s), ${analysis.functionCount} function(s).`,
    'Key tables:',
    tables,
    'Key stored procedures:',
    procedures,
    'Relationships:',
    relationships,
    'Risks:',
    risks,
    'Source exports:',
    artifactSummary,
  ].join('\n');
}

export function getDbInsightsPersonaSummary(workspaceId?: string): string {
  if (!workspaceId) {
    return 'No DB Insights workspace context is active yet.';
  }

  const analysis = getLatestAnalysis(workspaceId);
  if (!analysis) {
    return 'No DB Insights analysis is available yet. Ask the user to import SSMS schema/stored procedure exports in DB Insights and run Analyse.';
  }

  const artifacts = listArtifacts(workspaceId);
  return buildPersonaSummary(analysis, artifacts);
}

export function listArtifacts(workspaceId: string): DbInsightArtifact[] {
  const rows = getDb()
    .prepare('SELECT * FROM db_insight_artifacts WHERE workspace_id = ? ORDER BY file_name ASC')
    .all(workspaceId) as DbInsightArtifactRow[];
  return rows.map(mapArtifact);
}

export function addArtifact(workspaceId: string, filePath: string): DbInsightArtifact {
  const db = getDb();
  const id = randomUUID();
  const fileName = path.basename(filePath);
  const fileType = inferFileType(filePath);

  let content = '';
  let fileSize = 0;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    // Best effort only. Analysis will surface unreadable files later if needed.
  }

  try {
    fileSize = statSync(filePath).size;
  } catch {
    // Ignore inaccessible file size.
  }

  const category = inferArtifactCategory(fileName, content);
  db.prepare(
    `INSERT INTO db_insight_artifacts (id, workspace_id, file_path, file_name, file_type, category, file_size, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(id, workspaceId, filePath, fileName, fileType, category, fileSize);
  db.prepare('DELETE FROM db_insight_analyses WHERE workspace_id = ?').run(workspaceId);

  const row = db
    .prepare('SELECT * FROM db_insight_artifacts WHERE id = ?')
    .get(id) as DbInsightArtifactRow;

  return mapArtifact(row);
}

export function removeArtifact(id: string): void {
  const db = getDb();
  const row = db.prepare('SELECT workspace_id FROM db_insight_artifacts WHERE id = ?').get(id) as
    | { workspace_id: string }
    | undefined;

  db.prepare('DELETE FROM db_insight_artifacts WHERE id = ?').run(id);
  if (row?.workspace_id) {
    db.prepare('DELETE FROM db_insight_analyses WHERE workspace_id = ?').run(row.workspace_id);
  }
}

export function getLatestAnalysis(
  workspaceId: string,
  options?: { includeRunning?: boolean },
): DbInsightAnalysis | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM db_insight_analyses
       WHERE workspace_id = ?
         AND (? = 1 OR status = 'completed')
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(workspaceId, options?.includeRunning ? 1 : 0) as DbInsightAnalysisRow | undefined;

  return row ? mapAnalysis(row) : null;
}

export async function runAnalysis(workspaceId: string): Promise<DbInsightAnalysis> {
  const db = getDb();
  const artifacts = listArtifacts(workspaceId);
  if (artifacts.length === 0) {
    throw new Error('Add one or more exported SQL files before running DB Insights.');
  }

  const analysisId = randomUUID();
  db.prepare(
    `INSERT INTO db_insight_analyses (id, workspace_id, artifact_ids, status, started_at)
     VALUES (?, ?, ?, 'running', datetime('now'))`,
  ).run(analysisId, workspaceId, JSON.stringify(artifacts.map((artifact) => artifact.id)));

  try {
    const contents = new Map<string, string>();
    for (const artifact of artifacts) {
      contents.set(artifact.id, readFileSync(artifact.filePath, 'utf-8'));
    }

    const snapshot = parseSqlSnapshot([...contents.values()]);
    const fallback = buildFallbackAnalysis(snapshot);
    const prompt = loadPromptTemplate('db-insights-analysis.md', {
      artifactList: buildArtifactList(artifacts),
      schemaSnapshot: JSON.stringify(snapshot, null, 2),
      sourceContext: buildSourceContext(artifacts, contents),
      workspaceName: getWorkspaceName(workspaceId),
    });

    let parsed = fallback;
    try {
      const response = await callLlm(prompt, 8192, 0.2, 2, {
        cwd: commonParentDir(artifacts.map((artifact) => artifact.filePath)),
        taskClass: 'long-context',
      });
      parsed = parseAnalysisResponse(response) ?? fallback;
    } catch (err) {
      console.warn('[DB Insights] Falling back to heuristic analysis:', err);
    }

    const nextTables = parsed.tables.length > 0 ? parsed.tables : fallback.tables;
    const nextProcedures =
      parsed.storedProcedures.length > 0 ? parsed.storedProcedures : fallback.storedProcedures;
    const nextRelationships =
      parsed.relationships.length > 0 ? parsed.relationships : fallback.relationships;
    const nextRisks = parsed.risks.length > 0 ? parsed.risks : fallback.risks;
    const nextQuestions =
      parsed.recommendedQuestions.length > 0
        ? parsed.recommendedQuestions
        : fallback.recommendedQuestions;

    db.prepare(
      `UPDATE db_insight_analyses SET
        status = 'completed',
        summary = ?,
        database_name = ?,
        table_count = ?,
        procedure_count = ?,
        view_count = ?,
        function_count = ?,
        tables_json = ?,
        procedures_json = ?,
        relationships_json = ?,
        risks_json = ?,
        recommended_questions_json = ?,
        raw_snapshot_json = ?,
        completed_at = datetime('now')
      WHERE id = ?`,
    ).run(
      parsed.summary || fallback.summary,
      parsed.databaseName ?? fallback.databaseName ?? null,
      snapshot.tableCount,
      snapshot.procedureCount,
      snapshot.viewCount,
      snapshot.functionCount,
      JSON.stringify(nextTables.slice(0, 12)),
      JSON.stringify(nextProcedures.slice(0, 12)),
      JSON.stringify(nextRelationships.slice(0, 16)),
      JSON.stringify(nextRisks.slice(0, 12)),
      JSON.stringify(nextQuestions.slice(0, 8)),
      JSON.stringify(snapshot),
      analysisId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'DB Insights analysis failed';
    db.prepare(
      `UPDATE db_insight_analyses
       SET status = 'failed',
           summary = ?,
           completed_at = datetime('now')
       WHERE id = ?`,
    ).run(message, analysisId);
    throw err;
  }

  const row = db
    .prepare('SELECT * FROM db_insight_analyses WHERE id = ?')
    .get(analysisId) as DbInsightAnalysisRow;

  return mapAnalysis(row);
}

export async function selectDbInsightFiles(): Promise<string[]> {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(focusedWindow!, {
    title: 'Select SQL schema or stored procedure exports',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'SQL Exports',
        extensions: ['sql', 'txt', 'json'],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (canceled) return [];
  return filePaths;
}
