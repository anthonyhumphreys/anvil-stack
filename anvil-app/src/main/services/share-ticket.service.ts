import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/database.js';
import type { WorkItemReference } from '../../shared/change-review-types.js';
import type {
  ShareTicketInput,
  ShareTicketPreview,
  ShareTicketPreviewMetadata,
  ShareTicketReceipt,
} from '../../shared/share-ticket.js';
import type { WorkItem } from '../../shared/types.js';
import { getSettings } from './settings.service.js';
import { getActiveProvider } from './workitem-provider.js';

export type {
  ShareTicketInput,
  ShareTicketPreview,
  ShareTicketPreviewMetadata,
  ShareTicketReceipt,
} from '../../shared/share-ticket.js';

interface ReceiptRow extends Omit<ShareTicketReceipt, 'status'> {
  status: ShareTicketReceipt['status'];
  published_at: string | null;
}

function connectionFingerprint(ref: WorkItemReference): string {
  const connection = getSettings().workItemConnections?.find(
    (entry) => entry.id === ref.connectionId,
  );
  if (!connection || connection.provider !== ref.provider)
    throw new Error(
      'The selected Work Item connection is unavailable or has a different provider.',
    );
  return createHash('sha256').update(JSON.stringify(connection)).digest('hex');
}

function selectedProvider(ref: WorkItemReference) {
  const fingerprint = connectionFingerprint(ref);
  const provider = getActiveProvider(ref.connectionId, true);
  if (!provider) throw new Error('The selected Work Item provider is unavailable.');
  return { provider, fingerprint };
}

function displayDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('The share date is invalid.');
  return new Date(timestamp).toISOString().slice(0, 10);
}

function commentText(metadata: ShareTicketPreviewMetadata): string {
  const title = metadata.title.trim();
  const audience = metadata.audienceLabel.trim();
  if (!title || !audience) throw new Error('Share title and audience are required.');
  return `Anvil thread shared: ${title}\nAudience: ${audience}\nShared: ${displayDate(metadata.sharedAt)}`;
}

function toReceipt(row: ReceiptRow): ShareTicketReceipt {
  return {
    id: row.id,
    shareRecordId: row.shareRecordId,
    connectionId: row.connectionId,
    provider: row.provider,
    ticketId: row.ticketId,
    ticketTitle: row.ticketTitle,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.published_at ? { publishedAt: row.published_at } : {}),
  };
}

function findReceipt(
  ref: WorkItemReference,
  shareRecordId: string,
): ShareTicketReceipt | undefined {
  const row = getDb()
    .prepare(
      `SELECT id, share_record_id AS shareRecordId, connection_id AS connectionId,
        provider, ticket_id AS ticketId, ticket_title AS ticketTitle, status,
        created_at AS createdAt, updated_at AS updatedAt, published_at
       FROM share_ticket_publications
       WHERE share_record_id = ? AND connection_id = ? AND provider = ? AND ticket_id = ?`,
    )
    .get(shareRecordId, ref.connectionId, ref.provider, ref.id) as ReceiptRow | undefined;
  return row ? toReceipt(row) : undefined;
}

async function resolveTarget(
  ref: WorkItemReference,
  provider: NonNullable<ReturnType<typeof getActiveProvider>>,
): Promise<WorkItem> {
  const item = await provider.getItem(ref.id);
  if (item.id !== ref.id || item.provider !== ref.provider)
    throw new Error('The selected Work Item did not match the requested target.');
  return item;
}

/** Resolves the exact selected connection and ticket without needing the bearer share URL. */
export async function previewShareTicket(
  ref: WorkItemReference,
  metadata: ShareTicketPreviewMetadata,
): Promise<ShareTicketPreview> {
  const { provider } = selectedProvider(ref);
  const item = await resolveTarget(ref, provider);
  return {
    connectionId: ref.connectionId,
    provider: ref.provider,
    ticketId: item.id,
    ticketTitle: item.title,
    commentPreview: `${commentText(metadata)}\nLink: [${metadata.title.trim()}]`,
  };
}

/** Explicit user action: persist intent before posting and retain ambiguous outcomes. */
export async function attachShareToTicket(
  ref: WorkItemReference,
  input: ShareTicketInput,
  beforePost?: () => void | Promise<void>,
): Promise<ShareTicketReceipt> {
  if (!input.shareRecordId.trim() || !input.url.trim())
    throw new Error('The share record and link are required.');
  let shareUrl: URL;
  try {
    shareUrl = new URL(input.url);
  } catch {
    throw new Error('The share link is invalid.');
  }
  if (shareUrl.protocol !== 'https:' || shareUrl.username || shareUrl.password)
    throw new Error('The share link is invalid.');
  const comment = commentText(input);
  const selected = selectedProvider(ref);
  const target = await resolveTarget(ref, selected.provider);
  if (!selected.provider.publishLink)
    throw new Error('This Work Item provider cannot publish links.');
  const prior = findReceipt(ref, input.shareRecordId);
  if (prior?.status === 'published') return prior;
  if (prior)
    throw new Error(
      'A prior ticket publication is pending or uncertain. Check the ticket before taking further action.',
    );

  const id = randomUUID();
  const timestamp = new Date().toISOString();
  try {
    getDb()
      .prepare(
        `INSERT INTO share_ticket_publications
          (id, share_record_id, connection_id, provider, ticket_id, ticket_title,
           status, created_at, updated_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
      )
      .run(
        id,
        input.shareRecordId,
        ref.connectionId,
        ref.provider,
        ref.id,
        target.title,
        timestamp,
        timestamp,
      );
  } catch {
    // Includes a concurrent duplicate attempt. Keep database details out of the caller surface.
    const duplicate = findReceipt(ref, input.shareRecordId);
    if (duplicate?.status === 'published') return duplicate;
    throw new Error('A ticket publication already exists or could not be recorded.');
  }

  let guardRejected = false;
  const runPrePostGuard = async () => {
    try {
      if (connectionFingerprint(ref) !== selected.fingerprint)
        throw new Error('The Work Item connection changed.');
      await beforePost?.();
      if (connectionFingerprint(ref) !== selected.fingerprint)
        throw new Error('The Work Item connection changed.');
    } catch {
      guardRejected = true;
      throw new Error(
        'The share or Work Item connection changed before publication. Preview again.',
      );
    }
  };
  try {
    await selected.provider.publishLink!(
      ref.id,
      {
        text: comment,
        label: input.title.trim(),
        url: shareUrl.toString(),
      },
      runPrePostGuard,
    );
    const publishedAt = new Date().toISOString();
    getDb()
      .prepare(
        `UPDATE share_ticket_publications SET status = 'published', updated_at = ?, published_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(publishedAt, publishedAt, id);
  } catch {
    if (guardRejected) {
      getDb()
        .prepare("DELETE FROM share_ticket_publications WHERE id = ? AND status = 'pending'")
        .run(id);
      throw new Error(
        'The share or Work Item connection changed before publication. Preview again.',
      );
    }
    const uncertainAt = new Date().toISOString();
    getDb()
      .prepare(
        `UPDATE share_ticket_publications SET status = 'uncertain', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(uncertainAt, id);
    throw new Error('Ticket publication outcome is uncertain. Check the ticket before retrying.');
  }
  const receipt = findReceipt(ref, input.shareRecordId);
  if (!receipt) throw new Error('Ticket publication was recorded but its receipt is unavailable.');
  return receipt;
}

export function getShareTicketReceipt(
  ref: WorkItemReference,
  shareRecordId: string,
): ShareTicketReceipt | undefined {
  return findReceipt(ref, shareRecordId);
}
