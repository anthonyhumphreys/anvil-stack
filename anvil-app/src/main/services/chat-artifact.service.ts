import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ChatArtifact,
  ChatArtifactFile,
  ChatArtifactInput,
  ChatArtifactKind,
  ReasoningEffort,
} from '../../shared/types.js';
import { normaliseReasoningEffort } from '../../shared/codex-models.js';
import { getDb } from '../db/database.js';

interface ChatArtifactRow {
  id: string;
  thread_id: string;
  repo_id: string | null;
  source_message_id: string | null;
  title: string;
  kind: string;
  relative_path: string;
  file_path: string | null;
  content: string;
  version: number;
  status: string | null;
  visibility: string | null;
  source: string | null;
  model: string | null;
  reasoning_effort: string | null;
  created_at: string;
  updated_at: string;
}

const ARTIFACT_ROOT = '.anvil/artifacts';
const MAX_PREVIEW_FILE_BYTES = 50 * 1024 * 1024;

function mapArtifactRow(row: ChatArtifactRow): ChatArtifact {
  return {
    id: row.id,
    threadId: row.thread_id,
    repoId: row.repo_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    title: row.title,
    kind: parseArtifactKind(row.kind),
    relativePath: row.relative_path,
    filePath: row.file_path ?? undefined,
    content: row.content,
    version: Number(row.version ?? 1),
    status: parseArtifactStatus(row.status),
    visibility: parseArtifactVisibility(row.visibility),
    source: parseArtifactSource(row.source),
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort
      ? normaliseReasoningEffort(row.reasoning_effort)
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseArtifactKind(value: string): ChatArtifactKind {
  if (
    value === 'markdown' ||
    value === 'mermaid' ||
    value === 'code' ||
    value === 'html' ||
    value === 'docx' ||
    value === 'pptx' ||
    value === 'pdf' ||
    value === 'csv' ||
    value === 'xlsx' ||
    value === 'diagram' ||
    value === 'data' ||
    value === 'text'
  ) {
    return value;
  }
  return 'text';
}

function parseArtifactStatus(value: string | null | undefined): ChatArtifact['status'] {
  if (
    value === 'draft' ||
    value === 'reviewed' ||
    value === 'approved' ||
    value === 'superseded' ||
    value === 'archived'
  ) {
    return value;
  }
  return 'draft';
}

function parseArtifactVisibility(value: string | null | undefined): ChatArtifact['visibility'] {
  if (value === 'local' || value === 'shareable' || value === 'public-ready') return value;
  return 'local';
}

function parseArtifactSource(value: string | null | undefined): ChatArtifact['source'] {
  if (value === 'assistant' || value === 'user' || value === 'imported') return value;
  return 'assistant';
}

function getRepoPath(repoId: string | null | undefined): string | null {
  if (!repoId) return null;
  const row = getDb().prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
    | { path: string }
    | undefined;
  return row?.path ?? null;
}

function normaliseArtifactPath(relativePath: string, kind: ChatArtifactKind): string {
  const fallbackExtension = extensionForKind(kind);
  const cleaned = relativePath.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\0/g, '');
  const candidate = cleaned || `artifact.${fallbackExtension}`;
  const normalised = normalize(candidate).replace(/\\/g, '/');

  if (normalised === '.' || normalised.startsWith('../') || normalised.includes('/../')) {
    return `artifact.${fallbackExtension}`;
  }

  return normalised.includes('.') ? normalised : `${normalised}.${fallbackExtension}`;
}

function extensionForKind(kind: ChatArtifactKind): string {
  switch (kind) {
    case 'markdown':
      return 'md';
    case 'mermaid':
      return 'mmd';
    case 'html':
      return 'html';
    case 'docx':
      return 'docx';
    case 'pptx':
      return 'pptx';
    case 'pdf':
      return 'pdf';
    case 'csv':
      return 'csv';
    case 'xlsx':
      return 'xlsx';
    case 'diagram':
      return 'mmd';
    case 'data':
      return 'json';
    case 'code':
      return 'txt';
    case 'text':
      return 'txt';
  }
}

function writeRepoArtifact(
  repoId: string | null | undefined,
  relativePath: string,
  content: string,
  encoding: ChatArtifactInput['contentEncoding'] = 'utf8',
) {
  const repoPath = getRepoPath(repoId);
  if (!repoPath) return null;

  const targetPath = join(repoPath, ARTIFACT_ROOT, relativePath);
  const rootPath = join(repoPath, ARTIFACT_ROOT);
  const targetRelative = relative(rootPath, targetPath);
  if (targetRelative.startsWith('..') || targetRelative.split(sep).includes('..')) {
    throw new Error('Artifact path escapes the repository artifact directory');
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  assertRealPathWithinRoot(rootPath, dirname(targetPath));
  if (existsSync(targetPath)) assertRealPathWithinRoot(rootPath, targetPath);
  if (encoding === 'file') {
    if (!existsSync(targetPath)) {
      throw new Error(`Referenced artifact file does not exist: ${relativePath}`);
    }
    return targetPath;
  }

  if (encoding === 'base64') {
    const payload = content.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    writeFileSync(targetPath, Buffer.from(payload, 'base64'));
    return targetPath;
  }

  writeFileSync(targetPath, content, 'utf8');
  return targetPath;
}

function assertRealPathWithinRoot(rootPath: string, candidatePath: string): void {
  const rootRealPath = realpathSync(rootPath);
  const candidateRealPath = realpathSync(candidatePath);
  const candidateRelative = relative(rootRealPath, candidateRealPath);
  if (candidateRelative.startsWith('..') || candidateRelative.split(sep).includes('..')) {
    throw new Error('Artifact path resolves outside the repository artifact directory');
  }
}

function mimeTypeForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.pdf':
      return 'application/pdf';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.csv':
      return 'text/csv';
    default:
      return 'application/octet-stream';
  }
}

export function readChatArtifactFile(id: string): ChatArtifactFile {
  const row = getDb()
    .prepare('SELECT repo_id, relative_path, file_path FROM chat_artifacts WHERE id = ?')
    .get(id) as
    | { repo_id: string | null; relative_path: string; file_path: string | null }
    | undefined;

  if (!row?.file_path || !row.repo_id) throw new Error('Artifact has no persisted file');

  const repoPath = getRepoPath(row.repo_id);
  if (!repoPath) throw new Error('Artifact repository is no longer connected');

  const rootPath = join(repoPath, ARTIFACT_ROOT);
  const fileRelative = relative(rootPath, row.file_path);
  if (fileRelative.startsWith('..') || fileRelative.split(sep).includes('..')) {
    throw new Error('Artifact file is outside the repository artifact directory');
  }
  if (!existsSync(row.file_path)) throw new Error('Artifact file no longer exists');
  assertRealPathWithinRoot(rootPath, row.file_path);

  const size = statSync(row.file_path).size;
  if (size > MAX_PREVIEW_FILE_BYTES) {
    throw new Error('Artifact is too large to preview (50 MB maximum)');
  }

  return {
    name: basename(row.file_path),
    mimeType: mimeTypeForPath(row.file_path),
    size,
    dataBase64: readFileSync(row.file_path).toString('base64'),
  };
}

export function listChatArtifacts(threadId: string): ChatArtifact[] {
  const rows = getDb()
    .prepare(
      `SELECT
         id,
         thread_id,
         repo_id,
         source_message_id,
         title,
         kind,
         relative_path,
         file_path,
         content,
         version,
         status,
         visibility,
         source,
         model,
         reasoning_effort,
         created_at,
         updated_at
       FROM chat_artifacts
       WHERE thread_id = ?
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(threadId) as ChatArtifactRow[];

  return rows.map(mapArtifactRow);
}

export function upsertChatArtifact(input: ChatArtifactInput): ChatArtifact {
  const db = getDb();
  const relativePath = normaliseArtifactPath(input.relativePath, input.kind);
  const now = new Date().toISOString();
  const filePath = writeRepoArtifact(
    input.repoId,
    relativePath,
    input.content,
    input.contentEncoding,
  );
  const status = parseArtifactStatus(input.status);
  const visibility = parseArtifactVisibility(input.visibility);
  const source = parseArtifactSource(input.source);
  const reasoningEffort: ReasoningEffort | undefined = input.reasoningEffort
    ? normaliseReasoningEffort(input.reasoningEffort)
    : undefined;
  const existing = db
    .prepare(
      'SELECT id, version, created_at FROM chat_artifacts WHERE thread_id = ? AND relative_path = ?',
    )
    .get(input.threadId, relativePath) as
    | { id: string; version: number; created_at: string }
    | undefined;

  const id = existing?.id ?? randomUUID();
  const version = existing ? Number(existing.version ?? 1) + 1 : 1;

  db.prepare(
    `INSERT INTO chat_artifacts (
       id,
       thread_id,
       repo_id,
       source_message_id,
       title,
       kind,
       relative_path,
       file_path,
       content,
       version,
       status,
       visibility,
       source,
       model,
       reasoning_effort,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, relative_path) DO UPDATE SET
       repo_id = excluded.repo_id,
       source_message_id = excluded.source_message_id,
       title = excluded.title,
       kind = excluded.kind,
       file_path = excluded.file_path,
       content = excluded.content,
       version = excluded.version,
       status = excluded.status,
       visibility = excluded.visibility,
       source = excluded.source,
       model = excluded.model,
       reasoning_effort = excluded.reasoning_effort,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    input.threadId,
    input.repoId ?? null,
    input.sourceMessageId ?? null,
    input.title.trim() || relativePath,
    input.kind,
    relativePath,
    filePath,
    input.content,
    version,
    status,
    visibility,
    source,
    input.model?.trim() || null,
    reasoningEffort ?? null,
    existing?.created_at ?? now,
    now,
  );

  db.prepare(
    `INSERT INTO chat_artifact_revisions (
       id,
       artifact_id,
       version,
       source_message_id,
       title,
       kind,
       relative_path,
       file_path,
       content,
       status,
       visibility,
       source,
       model,
       reasoning_effort,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artifact_id, version) DO NOTHING`,
  ).run(
    randomUUID(),
    id,
    version,
    input.sourceMessageId ?? null,
    input.title.trim() || relativePath,
    input.kind,
    relativePath,
    filePath,
    input.content,
    status,
    visibility,
    source,
    input.model?.trim() || null,
    reasoningEffort ?? null,
    now,
  );

  const row = db.prepare('SELECT * FROM chat_artifacts WHERE id = ?').get(id) as ChatArtifactRow;
  return mapArtifactRow(row);
}
