import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import type {
  DbInsightAnalysis,
  DbInsightArtifact,
  DbInsightArtifactCategory,
  DbInsightEntity,
  DbInsightFileType,
  DbInsightStructure,
  DbInsightTechnology,
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

interface ParsedExportSnapshot extends ParsedSqlSnapshot {
  structure: DbInsightStructure;
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
  let structure: DbInsightStructure | undefined;
  if (row.raw_snapshot_json) {
    try {
      const snapshot = JSON.parse(row.raw_snapshot_json) as Partial<ParsedExportSnapshot>;
      structure = snapshot.structure;
    } catch {
      // Older analyses stored a SQL-only snapshot.
    }
  }
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
    structure,
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

function splitQualifiedName(
  raw: string,
  defaultSchema = 'dbo',
): { schema: string; name: string; qualifiedName: string } {
  const normalized = normalizeQualifiedName(raw);
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length >= 2) {
    const schema = parts[parts.length - 2];
    const name = parts[parts.length - 1];
    return { schema, name, qualifiedName: `${schema}.${name}` };
  }

  const name = parts[0] ?? normalized ?? 'unknown';
  return {
    schema: defaultSchema,
    name,
    qualifiedName: defaultSchema ? `${defaultSchema}.${name}` : name,
  };
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

function findMatchingParen(source: string, openingIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) {
        if (source[index + 1] === quote && quote !== ']') {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '[') {
      quote = ']';
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')' && --depth === 0) {
      return index;
    }
  }
  return -1;
}

function splitTopLevelSqlList(body: string): string[] {
  const segments: string[] = [];
  let segmentStart = 0;
  let depth = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (character === quote) {
        if (body[index + 1] === quote && quote !== ']') index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '[') quote = ']';
    else if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (character === ',' && depth === 0) {
      segments.push(body.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }
  segments.push(body.slice(segmentStart));
  return segments;
}

function extractColumnNames(body: string): string[] {
  const columns: string[] = [];

  for (const rawSegment of splitTopLevelSqlList(body)) {
    const line = rawSegment.trim();
    if (!line) continue;
    if (
      /^(constraint|primary\s+key|foreign\s+key|unique|check|key|index|fulltext|spatial|\))/i.test(
        line,
      )
    )
      continue;
    const match = line.match(/^(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$#]*)/);
    if (!match) continue;
    const column = normalizeQualifiedName(match[1]);
    if (column) columns.push(column);
  }

  return columns;
}

function extractReferencedObjects(block: string, defaultSchema = 'dbo'): string[] {
  const matches = block.matchAll(
    /(?:from|join|update|into|delete\s+from|merge\s+into)\s+([#A-Za-z0-9_\[\]"`.]+)/gi,
  );

  const refs = new Set<string>();
  for (const match of matches) {
    const qualifiedName = splitQualifiedName(match[1], defaultSchema).qualifiedName;
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

export function parseSqlSnapshot(contents: string[], defaultSchema = 'dbo'): ParsedSqlSnapshot {
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
      /create\s+table\s+(?:if\s+not\s+exists\s+)?([#A-Za-z0-9_\[\]"`.]+)\s*\(/gi,
    );
    for (const match of tableMatches) {
      const openingIndex = (match.index ?? 0) + match[0].lastIndexOf('(');
      const closingIndex = findMatchingParen(cleaned, openingIndex);
      if (closingIndex < 0) continue;
      const body = cleaned.slice(openingIndex + 1, closingIndex);
      const { schema, name, qualifiedName } = splitQualifiedName(match[1], defaultSchema);
      const columnNames = extractColumnNames(body);
      const keyColumns = columnNames.filter((column) => /(id|code|key)$/i.test(column)).slice(0, 6);

      for (const ref of body.matchAll(/references\s+([#A-Za-z0-9_\[\]"`.]+)/gi)) {
        relationships.add(
          `${qualifiedName} -> ${splitQualifiedName(ref[1], defaultSchema).qualifiedName}`,
        );
      }

      tables.push({
        schema,
        name,
        qualifiedName,
        columnCount: columnNames.length,
        keyColumns,
        fields: columnNames,
      });
    }

    for (const match of cleaned.matchAll(
      /alter\s+table\s+(?:only\s+)?([#A-Za-z0-9_\[\]"`.]+)[\s\S]*?foreign\s+key\s*\([^)]*\)\s*references\s+([#A-Za-z0-9_\[\]"`.]+)/gi,
    )) {
      relationships.add(
        `${splitQualifiedName(match[1], defaultSchema).qualifiedName} -> ${splitQualifiedName(match[2], defaultSchema).qualifiedName}`,
      );
    }

    const procedureMatches = cleaned.matchAll(
      /create\s+(?:or\s+(?:alter|replace)\s+)?(?:proc|procedure)\s+([#A-Za-z0-9_\[\]"`.]+)([\s\S]*?)(?=\n\s*go\s*(?:\n|$)|\n\s*create\s+(?:or\s+(?:alter|replace)\s+)?(?:proc|procedure|table|view|function)\b|$)/gi,
    );
    for (const match of procedureMatches) {
      const { schema, name, qualifiedName } = splitQualifiedName(match[1], defaultSchema);
      storedProcedures.push({
        schema,
        name,
        qualifiedName,
        purpose: inferProcedurePurpose(name),
        referencedObjects: extractReferencedObjects(match[2], defaultSchema).slice(0, 10),
      });
    }

    for (const match of cleaned.matchAll(
      /create\s+(?:or\s+replace\s+)?view\s+([#A-Za-z0-9_\[\]"`.]+)/gi,
    )) {
      viewNames.add(splitQualifiedName(match[1], defaultSchema).qualifiedName);
    }

    for (const match of cleaned.matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+([#A-Za-z0-9_\[\]"`.]+)/gi,
    )) {
      functionNames.add(splitQualifiedName(match[1], defaultSchema).qualifiedName);
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

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_ANALYSIS_BYTES = 20 * 1024 * 1024;
const MAX_ENTITY_FIELDS = 80;

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseJsonValues(content: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(content);
    return Array.isArray(value) ? value : [value];
  } catch {
    const values: unknown[] = [];
    try {
      for (const line of content.split(/\r?\n/).filter((item) => item.trim())) {
        values.push(JSON.parse(line));
      }
      return values.length ? values : null;
    } catch {
      return null;
    }
  }
}

function detectTechnology(fileName: string, content: string): DbInsightTechnology {
  const trimmed = content.trimStart();
  if (/\.(?:sql|txt)$/i.test(fileName)) {
    if (/\bGO\s*(?:\r?\n|$)|\bUSE\s+\[|\[[A-Za-z_][\w$#]*\]/i.test(content)) return 'sql-server';
    if (
      /\bSERIAL\b|\bJSONB\b|\bCREATE\s+SCHEMA\s+public\b|\bCREATE\s+SEQUENCE\s+public\.|\bALTER\s+TABLE\s+ONLY\b|\bSET\s+default_table_access_method\b|\$\$[\s\S]*\$\$/i.test(
        content,
      )
    )
      return 'postgresql';
    if (/\bAUTO_INCREMENT\b|\bENGINE\s*=\s*\w+|`[\w$]+`/i.test(content)) return 'mysql';
    if (/\bAUTOINCREMENT\b|\bPRAGMA\s+|\bWITHOUT\s+ROWID\b/i.test(content)) return 'sqlite';
    if (/\bCREATE\s+(?:TABLE|VIEW|INDEX|PROCEDURE|FUNCTION)\b/i.test(content)) return 'sql';
    if (/^\s*(?:TYPE|SCAN|HGETALL|LRANGE|SMEMBERS|ZRANGE|GET|SET)\s+/im.test(content))
      return 'redis';
    return 'unknown';
  }

  if (/\.json$/i.test(fileName) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const values = parseJsonValues(content)?.slice(0, 250);
    if (!values) return 'unknown';
    if (values.some(isDynamoItem)) return 'dynamodb';
    if (values.some(isMongoDocumentGroup)) return 'mongodb';
    if (values.some(isRedisDump)) return 'redis';
  }

  if (
    /^\s*TYPE\s+\S+\s*$/im.test(content) &&
    /^(?:string|list|set|zset|hash|stream|none)\s*$/im.test(content)
  ) {
    return 'redis';
  }
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DYNAMO_TYPES = new Set(['S', 'N', 'B', 'BOOL', 'NULL', 'M', 'L', 'SS', 'NS', 'BS']);

function isDynamoAttribute(value: unknown): boolean {
  return (
    isRecord(value) && Object.keys(value).length === 1 && DYNAMO_TYPES.has(Object.keys(value)[0])
  );
}

function isDynamoItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Array.isArray(value.Items) && value.Items.length > 0) return value.Items.some(isDynamoItem);
  const item = isRecord(value.Item) ? value.Item : value;
  const fields = Object.values(item);
  return fields.length > 0 && fields.every(isDynamoAttribute);
}

function getMongoDocument(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if ('_id' in value) return value;
  if (isRecord(value.document) && '_id' in value.document) return value.document;
  return null;
}

function isMongoDocumentGroup(value: unknown): boolean {
  const docs = Array.isArray(value)
    ? value
    : isRecord(value) && isRecord(value.document)
      ? [value.document]
      : [value];
  return docs.length > 0 && docs.some((item) => getMongoDocument(item) !== null);
}

function isRedisDump(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).some(
      (item) => isRecord(item) && typeof item.type === 'string' && 'value' in item,
    )
  );
}

function collectFieldPaths(value: unknown, prefix = '', depth = 0): string[] {
  if (!isRecord(value) || depth >= 3) return prefix ? [prefix] : [];
  const fields: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    fields.push(field);
    if (isRecord(child)) fields.push(...collectFieldPaths(child, field, depth + 1));
  }
  return fields;
}

function cleanCollectionName(fileName: string): string {
  return (
    path.basename(fileName, path.extname(fileName)).replace(/(?:\.export|\.dump)$/i, '') ||
    'documents'
  );
}

function parseJsonDocuments(
  fileName: string,
  content: string,
  technology: 'mongodb' | 'dynamodb',
): DbInsightEntity | null {
  const parsed = parseJsonValues(content);
  if (!parsed) return null;
  if (parsed.length === 1 && isRecord(parsed[0]) && Array.isArray(parsed[0].Items)) {
    parsed.splice(0, 1, ...parsed[0].Items);
  }
  const documents =
    technology === 'mongodb'
      ? parsed.map(getMongoDocument)
      : parsed.map((item) => {
          if (!isRecord(item)) return null;
          const document = isRecord(item.Item) ? item.Item : item;
          return Object.values(document).every(isDynamoAttribute) ? document : null;
        });
  if (!documents.length || documents.some((document) => document === null)) {
    throw new Error(
      `${fileName} contains records that do not all match the detected ${technology} export shape. Remove unrelated or malformed records and try again.`,
    );
  }
  const validDocuments = documents as Record<string, unknown>[];
  const fieldSet = new Set<string>();
  for (const document of validDocuments.slice(0, 500)) {
    const fields = technology === 'dynamodb' ? Object.keys(document) : collectFieldPaths(document);
    fields.forEach((field) => fieldSet.add(field));
  }
  const fields = [...fieldSet].sort().slice(0, MAX_ENTITY_FIELDS);
  return {
    name: cleanCollectionName(fileName),
    kind: technology === 'mongodb' ? 'collection' : 'item-export',
    fieldCount: fieldSet.size,
    fields,
    recordCount: validDocuments.length,
    notes:
      technology === 'mongodb'
        ? 'Fields were collected from up to 500 exported documents. Values were not retained.'
        : 'Fields were collected from up to 500 DynamoDB items. Values were not retained.',
  };
}

function parseRedisDump(content: string): DbInsightEntity[] {
  const observedKeys = new Map<string, { type: string; fieldCount: number }>();
  const parsed = parseJsonValues(content);
  if (parsed?.length === 1 && isRecord(parsed[0])) {
    for (const [key, item] of Object.entries(parsed[0])) {
      if (!isRecord(item) || typeof item.type !== 'string' || !('value' in item)) continue;
      if (item.type.toLowerCase() === 'none') continue;
      observedKeys.set(key, {
        type: item.type.toLowerCase(),
        fieldCount: isRecord(item.value) ? Object.keys(item.value).length : 0,
      });
    }
  } else {
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = 0; index < lines.length - 1; index += 1) {
      const command = lines[index].match(/^TYPE\s+(\S+)$/i);
      const type = lines[index + 1].match(/^(string|list|set|zset|hash|stream|none)$/i)?.[1];
      if (!command || !type || type.toLowerCase() === 'none') continue;
      if (!observedKeys.has(command[1])) {
        observedKeys.set(command[1], { type: type.toLowerCase(), fieldCount: 0 });
      }
    }
  }
  const patterns = new Map<string, { keyCount: number; fieldCount: number; types: Set<string> }>();
  for (const [key, observed] of observedKeys) {
    const separators = [...new Set(key.match(/[:./_-]/g) ?? [])].sort().join('') || 'none';
    const segmentCount = key.split(/[:./_-]/).filter(Boolean).length;
    const name = `key shape (${separators}; ${segmentCount} segment${segmentCount === 1 ? '' : 's'})`;
    const shape = patterns.get(name) ?? { keyCount: 0, fieldCount: 0, types: new Set<string>() };
    shape.keyCount += 1;
    shape.fieldCount = Math.max(shape.fieldCount, observed.fieldCount);
    shape.types.add(observed.type);
    patterns.set(name, shape);
  }
  return [...patterns.entries()]
    .map(([name, data]) => ({
      name,
      kind: 'key-pattern' as const,
      fieldCount: data.fieldCount,
      fields: [],
      keyCount: data.keyCount,
      notes: `Observed Redis data type(s): ${[...data.types].join(', ')}. Key names and values were omitted.`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function parseExportSnapshot(
  files: Array<{ fileName: string; content: string }>,
): ParsedExportSnapshot {
  const detected = files.map((file) => ({
    ...file,
    technology: detectTechnology(file.fileName, file.content),
  }));
  const technologies = [
    ...new Set(detected.map((file) => file.technology).filter((value) => value !== 'unknown')),
  ];
  if (technologies.length === 0) {
    throw new Error(
      'These files do not look like supported SQL, MongoDB, DynamoDB, or Redis exports. Add SQL DDL, MongoDB JSON documents with _id fields, DynamoDB typed JSON items, or Redis TYPE output / structured key exports.',
    );
  }
  const sqlTechnologies = new Set<DbInsightTechnology>([
    'sql-server',
    'postgresql',
    'mysql',
    'sqlite',
    'sql',
  ]);
  const includesSql = technologies.some((technology) => sqlTechnologies.has(technology));
  const includesNonSql = technologies.some((technology) => !sqlTechnologies.has(technology));
  if (includesSql && includesNonSql) {
    throw new Error(
      `These exports appear to mix relational SQL with ${technologies.filter((technology) => !sqlTechnologies.has(technology)).join(', ')}. Analyse one database technology at a time.`,
    );
  }
  const explicitTechnologies = technologies.filter((value) => value !== 'sql');
  if (explicitTechnologies.length > 1) {
    throw new Error(
      `These exports appear to use multiple technologies (${explicitTechnologies.join(', ')}). Analyse one database technology at a time.`,
    );
  }

  const technology = (explicitTechnologies[0] ?? 'sql') as DbInsightTechnology;
  const unknownFiles = detected.filter((file) => file.technology === 'unknown');
  if (unknownFiles.length > 0) {
    throw new Error(
      `Could not identify ${unknownFiles.map((file) => file.fileName).join(', ')} as a supported export. Check the file contents and try again.`,
    );
  }

  const sqlFiles = detected.filter(
    (file) =>
      ['sql-server', 'postgresql', 'mysql', 'sqlite', 'sql'].includes(file.technology) &&
      /\.(?:sql|txt)$/i.test(file.fileName),
  );
  const defaultSchema =
    technology === 'sql-server' ? 'dbo' : technology === 'postgresql' ? 'public' : '';
  const sql = parseSqlSnapshot(
    sqlFiles.map((file) => file.content),
    defaultSchema,
  );
  let entities: DbInsightEntity[] = [];
  let recordCount = 0;
  let keyCount = 0;
  const limitations: string[] = [];
  const evidence = detected.map((file) => `${file.fileName}: detected ${file.technology}`);

  if (['sql-server', 'postgresql', 'mysql', 'sqlite', 'sql'].includes(technology)) {
    entities = sql.tables.map((table) => ({
      name: table.qualifiedName,
      kind: 'table',
      fieldCount: table.columnCount,
      fields: table.fields ?? [],
    }));
    if (
      sql.tableCount === 0 &&
      sql.procedureCount === 0 &&
      sql.viewCount === 0 &&
      sql.functionCount === 0
    )
      throw new Error(
        'The SQL export was recognised, but no table, view, function, or procedure definitions were found. Add SQL DDL and try again.',
      );
    limitations.push(
      'DDL exports describe schema only. They do not include live row counts or runtime execution data.',
    );
  } else if (technology === 'mongodb' || technology === 'dynamodb') {
    entities = detected.flatMap((file) => {
      const entity = parseJsonDocuments(file.fileName, file.content, technology);
      return entity ? [entity] : [];
    });
    if (!entities.length)
      throw new Error(
        `The ${technology} JSON export was recognised, but no document/item structure could be parsed.`,
      );
    recordCount = entities.reduce((count, entity) => count + (entity.recordCount ?? 0), 0);
    limitations.push(
      'Record counts describe documents or items present in these exported files, not the full live database.',
    );
  } else if (technology === 'redis') {
    entities = detected.flatMap((file) => parseRedisDump(file.content));
    if (!entities.length)
      throw new Error(
        'The Redis export was recognised, but no typed keys could be parsed. Include redis-cli TYPE output or a structured key export.',
      );
    keyCount = entities.reduce((count, entity) => count + (entity.keyCount ?? 0), 0);
    limitations.push(
      'Redis key counts cover only keys represented in the export. The export does not establish full keyspace size or runtime memory use.',
    );
  }

  const tableCount = ['sql-server', 'postgresql', 'mysql', 'sqlite', 'sql'].includes(technology)
    ? sql.tableCount
    : 0;
  return {
    ...sql,
    tableCount,
    structure: {
      technology,
      entityCount: entities.length,
      entities: entities.slice(0, 80),
      evidence,
      limitations,
      ...(recordCount ? { recordCount } : {}),
      ...(keyCount ? { keyCount } : {}),
    },
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

export function buildFallbackAnalysis(snapshot: ParsedExportSnapshot): AnalysisPayload {
  const topTables = snapshot.tables.slice(0, 8);
  const topProcedures = snapshot.storedProcedures.slice(0, 8);
  const notableTables =
    topTables.map((table) => table.qualifiedName).join(', ') || 'none identified';
  const notableProcedures =
    topProcedures.map((procedure) => procedure.qualifiedName).join(', ') || 'none identified';

  const structure = snapshot.structure;
  const risks: string[] = [];
  const isSql = ['sql-server', 'postgresql', 'mysql', 'sqlite', 'sql'].includes(
    structure.technology,
  );
  if (isSql && snapshot.relationships.length === 0 && snapshot.tableCount > 1) {
    risks.push(
      'No foreign-key relationships were detected from the exported DDL, so referential links may be implicit or missing.',
    );
  }
  if (isSql && snapshot.procedureCount > 0 && snapshot.tableCount === 0) {
    risks.push(
      'Stored procedures were provided without matching schema definitions, so some references may be unresolved.',
    );
  }
  if (isSql && snapshot.tableCount > 40) {
    risks.push(
      'This appears to be a broad schema export; consider analysing bounded subsets if you need deeper guidance.',
    );
  }
  if (
    structure.technology === 'mongodb' &&
    structure.entities.some((entity) => entity.fieldCount === 0)
  ) {
    risks.push('Some exported documents have no discoverable fields in the bounded sample.');
  }
  if (
    structure.technology === 'redis' &&
    structure.entities.some((entity) => entity.notes?.includes('not included'))
  ) {
    // Redis type output can be incomplete, so avoid implying that key names establish value structure.
    risks.push(
      'Some key patterns have no exported Redis data type, so their value structure is unknown.',
    );
  }

  const entityNames = structure.entities.slice(0, 8).map((entity) => entity.name);
  const summary =
    structure.technology === 'mongodb'
      ? `MongoDB export contains ${structure.entityCount} collection export(s) and ${structure.recordCount ?? 0} document(s). Collections: ${entityNames.join(', ') || 'none identified'}.`
      : structure.technology === 'dynamodb'
        ? `DynamoDB export contains ${structure.entityCount} item export(s) and ${structure.recordCount ?? 0} exported item(s). Sources: ${entityNames.join(', ') || 'none identified'}.`
        : structure.technology === 'redis'
          ? `Redis export contains ${structure.entityCount} key pattern(s) covering ${structure.keyCount ?? 0} observed key(s). Patterns: ${entityNames.join(', ') || 'none identified'}.`
          : `SQL export detected ${snapshot.tableCount} table(s), ${snapshot.procedureCount} stored procedure(s), ${snapshot.viewCount} view(s), and ${snapshot.functionCount} function(s). Key tables: ${notableTables}. Key procedures: ${notableProcedures}.`;

  return {
    summary,
    databaseName: snapshot.databaseName,
    tables: topTables,
    storedProcedures: topProcedures,
    relationships: snapshot.relationships.slice(0, 12),
    risks,
    recommendedQuestions:
      structure.technology === 'mongodb'
        ? [
            'Which collections own the main business entities?',
            'Which fields link documents across collections?',
            'What validation rules or indexes should be checked for these fields?',
          ]
        : structure.technology === 'dynamodb'
          ? [
              'Which attributes form the partition and sort keys?',
              'Which access patterns should the table and secondary indexes support?',
              'Are these exported items representative of the live table shape?',
            ]
          : structure.technology === 'redis'
            ? [
                'Which key patterns are ephemeral versus durable?',
                'What expiration policy applies to each observed key pattern?',
                'Which data types and commands does the application use for these keys?',
              ]
            : [
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

    if (['mongodb', 'dynamodb', 'redis'].includes(detectTechnology(artifact.fileName, content))) {
      const block = `--- ${artifact.fileName} ---\n[Export values and key names omitted. Use the parsed structure in the snapshot.]\n`;
      if (combined.length + block.length > maxChars) break;
      combined += block;
      continue;
    }

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

  const structure = analysis.structure;
  const structureLines = structure
    ? [
        `- Detected technology: ${structure.technology}`,
        `- Exported entities: ${structure.entityCount}${structure.recordCount !== undefined ? `; ${structure.recordCount} exported documents/items` : ''}${structure.keyCount !== undefined ? `; ${structure.keyCount} observed keys` : ''}.`,
        'Export structure:',
        ...structure.entities
          .slice(0, 8)
          .map(
            (entity) =>
              `- ${entity.name} (${entity.kind}; ${entity.fieldCount} fields${entity.recordCount !== undefined ? `; ${entity.recordCount} exported records` : ''}${entity.keyCount !== undefined ? `; ${entity.keyCount} observed keys` : ''})${entity.fields.length ? `: ${entity.fields.join(', ')}` : ''}`,
          ),
        'Evidence and limits:',
        ...structure.evidence.slice(0, 8).map((value) => `- ${value}`),
        ...structure.limitations.slice(0, 4).map((value) => `- Limit: ${value}`),
      ]
    : [
        `- Detected technology: SQL (dialect unknown)`,
        `- Counts: ${analysis.tableCount} table(s), ${analysis.procedureCount} stored procedure(s), ${analysis.viewCount} view(s), ${analysis.functionCount} function(s).`,
        'Key tables:',
        tables,
        'Key stored procedures:',
        procedures,
      ];

  return [
    `Latest DB Insights analysis for this workspace${analysis.databaseName ? ` (${analysis.databaseName})` : ''}:`,
    `- Summary: ${analysis.summary}`,
    ...structureLines,
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
    return 'No DB Insights analysis is available yet. Ask the user to add supported SQL, MongoDB, DynamoDB, or Redis exports in DB Insights and run Analyse.';
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

  const fileSize = statSync(filePath).size;
  if (fileSize > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `${fileName} is ${formatBytes(fileSize)}. DB Insights accepts exports up to 5 MB per file.`,
    );
  }
  const content = readFileSync(filePath, 'utf-8');

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
    throw new Error('Add one or more supported database exports before running DB Insights.');
  }

  const analysisId = randomUUID();
  db.prepare(
    `INSERT INTO db_insight_analyses (id, workspace_id, artifact_ids, status, started_at)
     VALUES (?, ?, ?, 'running', datetime('now'))`,
  ).run(analysisId, workspaceId, JSON.stringify(artifacts.map((artifact) => artifact.id)));

  try {
    const contents = new Map<string, string>();
    let totalBytes = 0;
    for (const artifact of artifacts) {
      const size = statSync(artifact.filePath).size;
      if (size > MAX_ARTIFACT_BYTES) {
        throw new Error(
          `${artifact.fileName} is ${formatBytes(size)}. DB Insights accepts exports up to 5 MB per file.`,
        );
      }
      totalBytes += size;
      if (totalBytes > MAX_ANALYSIS_BYTES) {
        throw new Error(
          'The selected exports total more than 20 MB. Remove some files or add a smaller export set.',
        );
      }
      contents.set(artifact.id, readFileSync(artifact.filePath, 'utf-8'));
    }

    const snapshot = parseExportSnapshot(
      artifacts.map((artifact) => ({
        fileName: artifact.fileName,
        content: contents.get(artifact.id) ?? '',
      })),
    );
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

    const isSql = ['sql-server', 'postgresql', 'mysql', 'sqlite', 'sql'].includes(
      snapshot.structure.technology,
    );
    const nextTables = isSql && parsed.tables.length > 0 ? parsed.tables : fallback.tables;
    const nextProcedures =
      isSql && parsed.storedProcedures.length > 0
        ? parsed.storedProcedures
        : fallback.storedProcedures;
    const nextRelationships =
      isSql && parsed.relationships.length > 0 ? parsed.relationships : fallback.relationships;
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
    title: 'Select database exports',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Database Exports',
        extensions: ['sql', 'txt', 'json'],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (canceled) return [];
  return filePaths;
}
