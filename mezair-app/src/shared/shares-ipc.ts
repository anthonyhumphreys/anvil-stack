// window.mezair.shares — owned by the sharing workstream.
// Spec: docs/plans/inline-artifacts-and-canvas-tools.md §11.

import type { ShareAudience } from '../../cloud/contract/shares.js';
import type { WorkItemReference } from './change-review-types.js';
import type { ShareTicketPreview, ShareTicketReceipt } from './share-ticket.js';
import type { ThreadContinuation } from '../../cloud/contract/thread-pickup.js';
import type { ThreadPickupInput, ThreadPickupPreview } from './thread-pickup-ipc.js';
import type { ChatThread } from './types.js';
export type { ShareAudience, ShareTicketPreview, ShareTicketReceipt };

export type ShareItemType = 'artifact' | 'surface' | 'thread' | 'remote-thread';

export interface ShareContextItem {
  id: string;
  title: string;
  kind: 'artifact' | 'surface' | 'attachment';
}

export interface ShareAccessOptions {
  available: boolean;
  organizations: Array<{ id: string; name: string }>;
  organizationSharing: boolean;
}

export interface ShareTarget {
  itemType: ShareItemType;
  itemId: string;
}

export interface ShareOptionsInput {
  audience?: ShareAudience;
  /** Main-process snapshot reviewed in the preview; required for thread publication. */
  preparedId?: string;
  contextItemIds?: string[];
  includeComments?: boolean;
  includeFullDiff?: boolean;
  expiresInDays?: number;
  /** Redact these secret-scan findings (by id) before upload. */
  redactFindingIds?: string[];
  /**
   * Findings (by id) the user explicitly confirmed are safe to publish
   * unredacted. Publish refuses while any finding is neither redacted nor
   * acknowledged.
   */
  acknowledgeFindingIds?: string[];
  /**
   * Mermaid/diagram artifacts: the diagram pre-rendered to SVG by the
   * renderer, embedded in the static snapshot so recipients see the
   * diagram rather than its source. Sanitised (script-free) in main.
   */
  diagramSvg?: string;
}

/** Media type of a sealed share bundle (spec §11.3). */
export const SHARE_BUNDLE_MEDIA_TYPE = 'application/vnd.mezair.share+json';

/** Backend bounds for `expiresInDays` (share.create). */
export const SHARE_DEFAULT_EXPIRES_DAYS = 30;
export const SHARE_MAX_EXPIRES_DAYS = 365;

/**
 * Share bundle (spec §11.3): sealed and uploaded as
 * `application/vnd.mezair.share+json`. `snapshot` is always static and
 * script-free; `interactive` (sketches, HTML artifacts) carries the full
 * document, which the website runs only behind a trust interstitial in an
 * opaque-origin, network-less sandbox. Snapshot markup may reference
 * `snapshot.images` entries as `mezair-image:<key>` URLs.
 */
export interface MezairShareBundle {
  format: 'mezair-share/v1';
  title: string;
  /** 'artifact:html' | 'artifact:mermaid' | 'surface:review' | … */
  kind: string;
  version: number;
  sharedAt: string;
  digest: string;
  snapshot: {
    html: string;
    css: string;
    images?: Record<string, string>;
    /** Rendered height in CSS px at the freeze width, when measured (sizes the script-free frame). */
    height?: number;
  };
  interactive?: {
    html: string;
    kitVersion?: string;
  };
  payload?: unknown;
  schemaVersion?: number;
  files?: Array<{ name: string; mediaType: string; dataBase64: string }>;
  /** Reviewed, redacted portable conversation. No provider state or inherited permissions. */
  continuation?: ThreadContinuation;
}

export interface ShareSecretFinding {
  id: string;
  label: string;
  /** Masked: never the full secret. */
  excerpt: string;
  /** How many times the value occurs in the shared content. */
  occurrences?: number;
}

export interface SharePreview {
  preparedId?: string;
  contextItems?: ShareContextItem[];
  suggestedTicket?: { id: string; provider: WorkItemReference['provider'] };
  title: string;
  mediaType: string;
  interactive: boolean;
  /** Static rendering the recipient sees first (HTML document for an iframe srcdoc). */
  previewDocument: string;
  byteLength: number;
  secretFindings: ShareSecretFinding[];
  version: number;
  /** Plain-language list of what the share contains (shown in the dialog). */
  includes?: string[];
  /** Include options that apply to this item (comments; full diff for reviews). */
  availableOptions?: { includeComments?: boolean; includeFullDiff?: boolean };
  /** True when the content could not be scanned for secrets (binary files). */
  unscanned?: boolean;
}

export interface ShareRecord {
  audience?: ShareAudience;
  id: string;
  itemType: ShareItemType;
  itemId: string;
  version: number;
  shareId: string;
  title: string;
  mediaType: string;
  interactive: boolean;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  /** Current version of the item, to show "Shared v2 · you're on v4". */
  currentVersion?: number;
}

export interface SharesApi {
  pickupPending(): Promise<boolean>;
  onPickupRequested(callback: () => void): () => void;
  preparePickup(): Promise<ThreadPickupPreview | null>;
  confirmPickup(input: ThreadPickupInput): Promise<ChatThread>;
  cancelPickup(preparedId: string): Promise<void>;
  available(): Promise<boolean>;
  accessOptions(): Promise<ShareAccessOptions>;
  previewTicket(shareRecordId: string, ticket: WorkItemReference): Promise<ShareTicketPreview>;
  attachTicket(shareRecordId: string, ticket: WorkItemReference): Promise<ShareTicketReceipt>;
  preview(target: ShareTarget, options?: ShareOptionsInput): Promise<SharePreview>;
  /** Publishes and copies nothing: returns the URL for the renderer to place on the clipboard. */
  publish(
    target: ShareTarget,
    options?: ShareOptionsInput,
  ): Promise<{ record: ShareRecord; url: string }>;
  /** Re-publishes the current version under the same link (stable URL). */
  update(shareRecordId: string, options?: ShareOptionsInput): Promise<ShareRecord>;
  revoke(shareRecordId: string): Promise<ShareRecord>;
  list(filter?: {
    itemType?: ShareItemType;
    itemId?: string;
    workspaceId?: string;
  }): Promise<ShareRecord[]>;
  copyLink(shareRecordId: string): Promise<boolean>;
}
