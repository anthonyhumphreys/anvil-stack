// Data portability (sync/1): `data.export.*`, `data.import.*`,
// `data.operationStatus`. Per the integration contract these ops move
// versioned portable entities between accounts — conflicts are preserved
// (never silently overwritten), and no live leases migrate with data.

/** Portable document format; unknown versions reject at preview. */
export const DATA_EXPORT_FORMAT_VERSION = 1;

/** One entity in a portable document — the sync `ScannedEntity` shape. */
export interface ExportedEntity {
  entityType: string;
  entityId: string;
  revision: number;
  schemaVersion: number;
  payload: unknown;
}

export interface DataExportBeginParams {
  /** Per-page byte cap for `data.export.page` (clamped server-side). */
  maxBytes?: number;
}

export interface DataExportBeginResult {
  operationId: string;
  epoch: string;
  /** Change-journal watermark the snapshot was opened at. */
  watermarkStart: number;
}

export interface DataExportPageParams {
  operationId: string;
  /**
   * Client-side resume position: `null`/absent for the first page, otherwise
   * the previous page's `nextCursor` — mirrors `sync.scan.page`, so a lost
   * response retries from the client's last consumed position.
   */
  cursor?: string | null;
  /** Per-page byte cap (clamped server-side). */
  maxBytes?: number;
}

export interface DataExportPageResult {
  operationId: string;
  formatVersion: number;
  epoch: string;
  entities: ExportedEntity[];
  nextCursor: string | null;
  done: boolean;
}

export type ImportOutcome = 'create' | 'identical' | 'conflict' | 'invalid';

export interface ImportPreviewEntry {
  entityType: string;
  entityId: string;
  outcome: ImportOutcome;
  /** Populated for 'conflict'/'invalid' — never for clean creates. */
  reason?: string;
}

export interface DataImportPreviewParams {
  formatVersion: number;
  entities: ExportedEntity[];
}

export interface DataImportPreviewResult {
  /** Staged operation — pass to `data.import.commit` to apply. */
  operationId: string;
  summary: {
    creates: number;
    identical: number;
    conflicts: number;
    invalid: number;
  };
  /**
   * Per-entity decisions, capped at `DATA_IMPORT_PREVIEW_ENTRY_CAP`
   * (`truncated` when exceeded). The full plan is durably staged on the
   * operation — commit applies it regardless of response truncation.
   */
  entries: ImportPreviewEntry[];
  truncated: boolean;
}

export interface DataImportCommitParams {
  operationId: string;
}

export interface DataImportCommitResult {
  operationId: string;
  applied: number;
  conflicts: number;
  skipped: number;
}

export interface DataOperationStatusParams {
  operationId: string;
}

export type DataOperationState =
  | 'open'       // export in progress, pages remain
  | 'done'       // export fully consumed
  | 'previewed'  // import plan staged, awaiting commit
  | 'committed'  // import applied
  | 'failed';    // terminal failure (detail carries the reason)

export interface DataOperationStatusResult {
  operationId: string;
  kind: 'export' | 'import';
  state: DataOperationState;
  createdAt: string;
  finishedAt?: string;
  detail?: Record<string, unknown>;
}
