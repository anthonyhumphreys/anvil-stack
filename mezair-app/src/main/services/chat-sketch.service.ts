// Throwaway agent-authored visuals (§8.10): thread-scoped, unversioned, never
// synced or listed in the Library. Keep promotes a sketch to an HTML artifact.
import { randomUUID } from 'node:crypto';
import type { ChatArtifact } from '../../shared/types.js';
import type { ChatSketch } from '../../shared/surfaces/types.js';
import { getDb } from '../db/database.js';
import { getChatArtifact, upsertChatArtifact } from './chat-artifact.service.js';

interface ChatSketchRow {
  id: string;
  thread_id: string;
  source_message_id: string | null;
  title: string;
  html: string;
  height: number | null;
  kept_artifact_id: string | null;
  created_at: string;
  updated_at: string;
}

export const MAX_SKETCH_HTML_BYTES = 1_500_000;
const MAX_SKETCH_TITLE_LENGTH = 200;
const MAX_SKETCH_HEIGHT = 20_000;

export interface ChatSketchInput {
  threadId: string;
  title: string;
  html: string;
  height?: number;
  sourceMessageId?: string;
}

export function createChatSketch(input: ChatSketchInput): ChatSketch {
  const html = assertSketchHtml(input.html);
  const now = new Date().toISOString();
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO chat_sketches
         (id, thread_id, source_message_id, title, html, height, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.threadId,
      input.sourceMessageId ?? null,
      normaliseSketchTitle(input.title),
      html,
      normaliseHeight(input.height) ?? null,
      now,
      now,
    );
  return requireChatSketch(id);
}

export function getChatSketch(id: string): ChatSketch | null {
  const row = getDb().prepare('SELECT * FROM chat_sketches WHERE id = ?').get(id) as
    ChatSketchRow | undefined;
  return row ? mapRow(row) : null;
}

export function listChatSketches(threadId: string): ChatSketch[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_sketches WHERE thread_id = ? ORDER BY created_at ASC')
    .all(threadId) as ChatSketchRow[];
  return rows.map(mapRow);
}

export function updateChatSketch(
  id: string,
  changes: { html?: string; title?: string; height?: number | null },
): ChatSketch {
  const current = requireChatSketch(id);
  const html = changes.html !== undefined ? assertSketchHtml(changes.html) : current.html;
  const title = changes.title !== undefined ? normaliseSketchTitle(changes.title) : current.title;
  const height =
    changes.height === null
      ? null
      : changes.height !== undefined
        ? (normaliseHeight(changes.height) ?? null)
        : (current.height ?? null);
  getDb()
    .prepare(
      'UPDATE chat_sketches SET html = ?, title = ?, height = ?, updated_at = ? WHERE id = ?',
    )
    .run(html, title, height, new Date().toISOString(), id);
  return requireChatSketch(id);
}

export function deleteChatSketch(id: string): boolean {
  return getDb().prepare('DELETE FROM chat_sketches WHERE id = ?').run(id).changes > 0;
}

/**
 * Promotes a sketch to an HTML artifact (v1, or a new version when kept again).
 * Repository storage needs a repo; otherwise it stays in the session.
 */
export function keepChatSketch(
  id: string,
  options: { title?: string; path?: string; repoId?: string | null } = {},
): ChatArtifact {
  const sketch = requireChatSketch(id);
  const title = options.title?.trim() ? normaliseSketchTitle(options.title) : sketch.title;
  const previous = sketch.keptArtifactId ? getChatArtifact(sketch.keptArtifactId) : null;
  const repoId = previous
    ? (previous.repoId ?? null)
    : (options.repoId ?? threadRepoId(sketch.threadId));
  const artifact = upsertChatArtifact({
    threadId: sketch.threadId,
    repoId,
    sourceMessageId: sketch.sourceMessageId,
    title,
    kind: 'html',
    storage: previous?.storage ?? (repoId ? 'repository' : 'session'),
    relativePath:
      previous?.relativePath ??
      (options.path?.trim() || `sketches/${slugify(title)}-${sketch.id.slice(0, 8)}.html`),
    content: sketch.html,
    status: 'draft',
    visibility: 'local',
    source: 'assistant',
  });
  getDb()
    .prepare('UPDATE chat_sketches SET kept_artifact_id = ?, updated_at = ? WHERE id = ?')
    .run(artifact.id, new Date().toISOString(), id);
  return artifact;
}

export function threadRepoId(threadId: string): string | null {
  const row = getDb()
    .prepare('SELECT active_repo_id, repo_ids_json FROM chat_threads WHERE id = ?')
    .get(threadId) as { active_repo_id: string | null; repo_ids_json: string | null } | undefined;
  if (!row) return null;
  if (row.active_repo_id) return row.active_repo_id;
  try {
    const ids = JSON.parse(row.repo_ids_json ?? '[]') as unknown;
    return Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : null;
  } catch {
    return null;
  }
}

function requireChatSketch(id: string): ChatSketch {
  const sketch = getChatSketch(id);
  if (!sketch) throw new Error(`Sketch not found: ${id}`);
  return sketch;
}

function assertSketchHtml(html: unknown): string {
  if (typeof html !== 'string' || !html.trim()) throw new Error('Sketch HTML is required.');
  if (Buffer.byteLength(html, 'utf8') > MAX_SKETCH_HTML_BYTES) {
    throw new Error('Sketch HTML is too large (1.5 MB maximum). Use an artifact instead.');
  }
  return html;
}

function normaliseSketchTitle(title: string): string {
  const trimmed = String(title ?? '').trim();
  return (trimmed || 'Sketch').slice(0, MAX_SKETCH_TITLE_LENGTH);
}

function normaliseHeight(height: number | undefined): number | undefined {
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return undefined;
  return Math.min(Math.round(height), MAX_SKETCH_HEIGHT);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'sketch'
  );
}

function mapRow(row: ChatSketchRow): ChatSketch {
  return {
    id: row.id,
    threadId: row.thread_id,
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    title: row.title,
    html: row.html,
    ...(row.height ? { height: row.height } : {}),
    ...(row.kept_artifact_id ? { keptArtifactId: row.kept_artifact_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
