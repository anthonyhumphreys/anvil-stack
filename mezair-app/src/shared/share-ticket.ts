import type { WorkItemReference } from './change-review-types.js';

export interface ShareTicketPreviewMetadata {
  title: string;
  audienceLabel: string;
  sharedAt: string;
}

export interface ShareTicketInput extends ShareTicketPreviewMetadata {
  shareRecordId: string;
  /** Short-lived bearer URL. Used only in the provider request and never persisted or returned. */
  url: string;
}

export interface ShareTicketPreview {
  connectionId: string;
  provider: WorkItemReference['provider'];
  ticketId: string;
  ticketTitle: string;
  commentPreview: string;
}

export interface ShareTicketReceipt {
  id: string;
  shareRecordId: string;
  connectionId: string;
  provider: WorkItemReference['provider'];
  ticketId: string;
  ticketTitle: string;
  status: 'pending' | 'published' | 'uncertain';
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}
