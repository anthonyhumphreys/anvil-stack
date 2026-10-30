// Point-and-say comments on any surface (§5.4). surface_comments is the single
// store; sendToAgent delivers the comment with its anchor context.
import { randomUUID } from 'node:crypto';
import type {
  SurfaceAnchor,
  SurfaceAnchorType,
  SurfaceComment,
  SurfaceCommentInput,
} from '../../shared/surfaces/types.js';
import { getSurfaceKind } from '../../shared/surfaces/registry.js';
import { getDb } from '../db/database.js';
import { deliverSurfaceFeedback, describeAnchorShort, getSurface } from './core.js';

interface SurfaceCommentRow {
  id: string;
  surface_id: string;
  thread_id: string;
  anchor_json: string;
  body: string;
  status: string;
  created_at: string;
  updated_at: string;
}

const MAX_COMMENT_LENGTH = 10_000;
const MAX_QUOTE_LENGTH = 2_000;
const ANCHOR_TYPES = new Set<SurfaceAnchorType>([
  'surface',
  'diff-range',
  'finding',
  'chapter',
  'node',
  'row',
  'cell',
  'series-point',
  'step',
  'text-selection',
  'region',
]);

export function listSurfaceComments(surfaceId: string): SurfaceComment[] {
  const rows = getDb()
    .prepare('SELECT * FROM surface_comments WHERE surface_id = ? ORDER BY created_at ASC, id ASC')
    .all(surfaceId) as SurfaceCommentRow[];
  return rows.map(mapRow);
}

export function getSurfaceComment(commentId: string): SurfaceComment | null {
  const row = getDb().prepare('SELECT * FROM surface_comments WHERE id = ?').get(commentId) as
    SurfaceCommentRow | undefined;
  return row ? mapRow(row) : null;
}

export async function addSurfaceComment(input: SurfaceCommentInput): Promise<SurfaceComment> {
  const intent = getSurface(input.surfaceId);
  if (!intent) throw new Error(`Surface not found: ${input.surfaceId}`);
  const body = String(input.body ?? '').trim();
  if (!body) throw new Error('Comment body is required.');
  if (body.length > MAX_COMMENT_LENGTH) throw new Error('Comment is too long.');
  const anchor = normaliseAnchor(input.anchor);
  const definition = getSurfaceKind(intent.payload.surfaceKind);
  if (anchor.type !== 'surface' && definition && !definition.anchors.includes(anchor.type)) {
    throw new Error(`${definition.label} surfaces do not support ${anchor.type} comments.`);
  }
  const now = new Date().toISOString();
  const comment: SurfaceComment = {
    id: randomUUID(),
    surfaceId: intent.id,
    anchor,
    body,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO surface_comments
         (id, surface_id, thread_id, anchor_json, body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(
      comment.id,
      comment.surfaceId,
      intent.scope.threadId,
      JSON.stringify(anchor),
      body,
      now,
      now,
    );
  if (input.sendToAgent) {
    await sendSurfaceCommentToAgent(comment).catch((error: unknown) => {
      console.error('[Surfaces] Failed to send comment to the agent:', error);
      return false;
    });
  }
  return comment;
}

export function setSurfaceCommentStatus(
  commentId: string,
  status: SurfaceComment['status'],
): SurfaceComment {
  if (status !== 'open' && status !== 'resolved') throw new Error('Invalid comment status.');
  const result = getDb()
    .prepare('UPDATE surface_comments SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), commentId);
  if (result.changes === 0) throw new Error(`Comment not found: ${commentId}`);
  return getSurfaceComment(commentId) as SurfaceComment;
}

export function deleteSurfaceComment(commentId: string): boolean {
  return getDb().prepare('DELETE FROM surface_comments WHERE id = ?').run(commentId).changes > 0;
}

export function sendSurfaceCommentToAgent(comment: SurfaceComment): Promise<boolean> {
  return deliverSurfaceFeedback(comment.surfaceId, formatCommentFeedback(comment));
}

export function formatCommentFeedback(comment: SurfaceComment): string {
  const { anchor } = comment;
  const where = describeAnchorShort(anchor);
  const lines = [
    `User comment (${comment.id}) on ${anchor.type === 'surface' ? 'the surface' : anchor.type}${
      where ? ` ${where}` : ''
    }:`,
    comment.body,
  ];
  if (anchor.targetId) lines.push(`Target id: ${anchor.targetId}`);
  if (anchor.quote) lines.push(`Quoted: "${anchor.quote}"`);
  if (anchor.rect) {
    const { x, y, width, height } = anchor.rect;
    lines.push(
      `Region (fractions of the surface): x=${round(x)} y=${round(y)} w=${round(width)} h=${round(height)}`,
    );
  }
  return lines.join('\n');
}

function normaliseAnchor(value: unknown): SurfaceAnchor {
  if (typeof value !== 'object' || value === null) return { type: 'surface' };
  const raw = value as Record<string, unknown>;
  const type = ANCHOR_TYPES.has(raw.type as SurfaceAnchorType)
    ? (raw.type as SurfaceAnchorType)
    : null;
  if (!type) throw new Error('Unsupported comment anchor.');
  const anchor: SurfaceAnchor = { type };
  if (typeof raw.targetId === 'string' && raw.targetId.trim()) {
    anchor.targetId = raw.targetId.trim().slice(0, 500);
  }
  if (typeof raw.filePath === 'string' && raw.filePath.trim()) {
    anchor.filePath = raw.filePath.trim().slice(0, 1_000);
  }
  if (isLine(raw.lineStart)) anchor.lineStart = raw.lineStart;
  if (isLine(raw.lineEnd)) anchor.lineEnd = raw.lineEnd;
  if (typeof raw.quote === 'string' && raw.quote.trim()) {
    anchor.quote = raw.quote.slice(0, MAX_QUOTE_LENGTH);
  }
  if (typeof raw.label === 'string' && raw.label.trim())
    anchor.label = raw.label.trim().slice(0, 300);
  if (typeof raw.rect === 'object' && raw.rect !== null) {
    const rect = raw.rect as Record<string, unknown>;
    const parts = [rect.x, rect.y, rect.width, rect.height];
    if (parts.every((part) => typeof part === 'number' && part >= 0 && part <= 1)) {
      anchor.rect = {
        x: rect.x as number,
        y: rect.y as number,
        width: rect.width as number,
        height: rect.height as number,
      };
    }
  }
  return anchor;
}

function mapRow(row: SurfaceCommentRow): SurfaceComment {
  let anchor: SurfaceAnchor = { type: 'surface' };
  try {
    anchor = normaliseAnchor(JSON.parse(row.anchor_json));
  } catch {
    /* fall back to a whole-surface anchor */
  }
  return {
    id: row.id,
    surfaceId: row.surface_id,
    anchor,
    body: row.body,
    status: row.status === 'resolved' ? 'resolved' : 'open',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isLine(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function round(value: number): string {
  return value.toFixed(3);
}
