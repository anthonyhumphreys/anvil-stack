import { randomUUID } from 'node:crypto';
import type {
  ChatArtifactAnnotation,
  ChatArtifactAnnotationInput,
  ChatArtifactAnnotationPatch,
  ChatArtifactAnnotationStatus,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';

const MAX_ANNOTATION_BODY_LENGTH = 20_000;
const MAX_ANNOTATION_QUOTE_LENGTH = 5_000;

interface ChatArtifactAnnotationRow {
  id: string;
  artifact_id: string;
  body: string;
  quote: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapAnnotationRow(row: ChatArtifactAnnotationRow): ChatArtifactAnnotation {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    body: row.body,
    quote: row.quote ?? undefined,
    status: parseStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStatus(value: string): ChatArtifactAnnotationStatus {
  return value === 'resolved' ? 'resolved' : 'open';
}

function normaliseBody(value: string): string {
  const body = value.trim();
  if (!body) throw new Error('Annotation text is required.');
  if (body.length > MAX_ANNOTATION_BODY_LENGTH) {
    throw new Error(`Annotation text cannot exceed ${MAX_ANNOTATION_BODY_LENGTH} characters.`);
  }
  return body;
}

function normaliseQuote(value: string | null | undefined): string | null {
  const quote = value?.trim() ?? '';
  if (!quote) return null;
  if (quote.length > MAX_ANNOTATION_QUOTE_LENGTH) {
    throw new Error(`Annotation quote cannot exceed ${MAX_ANNOTATION_QUOTE_LENGTH} characters.`);
  }
  return quote;
}

function requireAnnotation(id: string): ChatArtifactAnnotationRow {
  const row = getDb().prepare('SELECT * FROM chat_artifact_annotations WHERE id = ?').get(id) as
    | ChatArtifactAnnotationRow
    | undefined;
  if (!row) throw new Error(`Artifact annotation ${id} was not found.`);
  return row;
}

export function listChatArtifactAnnotations(artifactId: string): ChatArtifactAnnotation[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_artifact_annotations
       WHERE artifact_id = ?
       ORDER BY status ASC, updated_at DESC`,
    )
    .all(artifactId) as ChatArtifactAnnotationRow[];
  return rows.map(mapAnnotationRow);
}

export function createChatArtifactAnnotation(
  input: ChatArtifactAnnotationInput,
): ChatArtifactAnnotation {
  const db = getDb();
  const artifact = db.prepare('SELECT id FROM chat_artifacts WHERE id = ?').get(input.artifactId);
  if (!artifact) throw new Error(`Artifact ${input.artifactId} was not found.`);

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO chat_artifact_annotations
       (id, artifact_id, body, quote, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?)`,
  ).run(id, input.artifactId, normaliseBody(input.body), normaliseQuote(input.quote), now, now);
  return mapAnnotationRow(requireAnnotation(id));
}

export function updateChatArtifactAnnotation(
  id: string,
  patch: ChatArtifactAnnotationPatch,
): ChatArtifactAnnotation {
  const current = requireAnnotation(id);
  const body = patch.body === undefined ? current.body : normaliseBody(patch.body);
  const quote = patch.quote === undefined ? current.quote : normaliseQuote(patch.quote);
  const status =
    patch.status === undefined ? parseStatus(current.status) : parseStatus(patch.status);
  const now = new Date().toISOString();

  getDb()
    .prepare(
      `UPDATE chat_artifact_annotations
       SET body = ?, quote = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(body, quote, status, now, id);
  return mapAnnotationRow(requireAnnotation(id));
}

export function deleteChatArtifactAnnotation(id: string): boolean {
  return getDb().prepare('DELETE FROM chat_artifact_annotations WHERE id = ?').run(id).changes > 0;
}
