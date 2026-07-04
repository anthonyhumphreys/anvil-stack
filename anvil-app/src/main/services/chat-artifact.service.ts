import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatArtifact, ChatArtifactInput, ChatArtifactKind } from '../../shared/types.js';
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
  created_at: string;
  updated_at: string;
}

const ARTIFACT_ROOT = '.anvil/artifacts';

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseArtifactKind(value: string): ChatArtifactKind {
  if (
    value === 'markdown' ||
    value === 'code' ||
    value === 'html' ||
    value === 'diagram' ||
    value === 'data' ||
    value === 'text'
  ) {
    return value;
  }
  return 'text';
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
    case 'html':
      return 'html';
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
  writeFileSync(targetPath, content, 'utf8');
  return targetPath;
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
  const filePath = writeRepoArtifact(input.repoId, relativePath, input.content);
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
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, relative_path) DO UPDATE SET
       repo_id = excluded.repo_id,
       source_message_id = excluded.source_message_id,
       title = excluded.title,
       kind = excluded.kind,
       file_path = excluded.file_path,
       content = excluded.content,
       version = excluded.version,
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
    existing?.created_at ?? now,
    now,
  );

  const row = db.prepare('SELECT * FROM chat_artifacts WHERE id = ?').get(id) as ChatArtifactRow;
  return mapArtifactRow(row);
}
