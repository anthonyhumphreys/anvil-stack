// window.anvil.shares — owned by the sharing workstream.
// Spec: docs/plans/inline-artifacts-and-canvas-tools.md §11.

export type ShareItemType = 'artifact' | 'surface';

export interface ShareTarget {
  itemType: ShareItemType;
  itemId: string;
}

export interface ShareOptionsInput {
  includeComments?: boolean;
  includeFullDiff?: boolean;
  expiresInDays?: number;
  /** Redact these secret-scan findings (by id) before upload. */
  redactFindingIds?: string[];
}

export interface ShareSecretFinding {
  id: string;
  label: string;
  excerpt: string;
}

export interface SharePreview {
  title: string;
  mediaType: string;
  interactive: boolean;
  /** Static rendering the recipient sees first (HTML document for an iframe srcdoc). */
  previewDocument: string;
  byteLength: number;
  secretFindings: ShareSecretFinding[];
  version: number;
}

export interface ShareRecord {
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
  available(): Promise<boolean>;
  preview(target: ShareTarget, options?: ShareOptionsInput): Promise<SharePreview>;
  /** Publishes and copies nothing: returns the URL for the renderer to place on the clipboard. */
  publish(
    target: ShareTarget,
    options?: ShareOptionsInput,
  ): Promise<{ record: ShareRecord; url: string }>;
  /** Re-publishes the current version under the same link (stable URL). */
  update(shareRecordId: string, options?: ShareOptionsInput): Promise<ShareRecord>;
  revoke(shareRecordId: string): Promise<ShareRecord>;
  list(filter?: { itemType?: ShareItemType; itemId?: string; workspaceId?: string }): Promise<ShareRecord[]>;
  copyLink(shareRecordId: string): Promise<boolean>;
}
