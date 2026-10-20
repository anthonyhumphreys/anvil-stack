// Implements window.anvil.shares (channel names fixed in src/preload/shares.ts).
// Validates renderer input, delegates to share.service, and registers the
// approval-gated `share_item` agent tool.

import { ipcMain } from 'electron';
import type {
  ShareItemType,
  ShareOptionsInput,
  SharePreview,
  ShareRecord,
  ShareTarget,
} from '../../shared/shares-ipc.js';
import { registerAgentToolProvider } from '../agent-tools/dispatch.js';
import {
  copyShareLink,
  isSharingAvailable,
  listShares,
  migrateLegacySharedUrls,
  previewShare,
  publishShare,
  revokeShare,
  sharesAgentToolProvider,
  updateShare,
} from '../services/share.service.js';

const MAX_ID_LENGTH = 200;
const MAX_FINDING_IDS = 500;
/** Pre-rendered diagram SVG ceiling (the bundle builder re-checks). */
const MAX_DIAGRAM_SVG_CHARS = 2 * 1024 * 1024;

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isItemType(value: unknown): value is ShareItemType {
  return value === 'artifact' || value === 'surface';
}

function parseTarget(value: unknown): ShareTarget {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  if (!isItemType(record['itemType']) || !isId(record['itemId'])) {
    throw new Error('Invalid share target.');
  }
  return { itemType: record['itemType'], itemId: record['itemId'] };
}

function parseIdList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_FINDING_IDS || !value.every(isId)) {
    throw new Error('Invalid finding ids.');
  }
  return value as string[];
}

function parseOptions(value: unknown): ShareOptionsInput {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object') throw new Error('Invalid share options.');
  const record = value as Record<string, unknown>;
  const options: ShareOptionsInput = {};
  if (record['includeComments'] !== undefined) {
    options.includeComments = record['includeComments'] === true;
  }
  if (record['includeFullDiff'] !== undefined) {
    options.includeFullDiff = record['includeFullDiff'] === true;
  }
  if (record['expiresInDays'] !== undefined) {
    const days = record['expiresInDays'];
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) {
      throw new Error('Invalid expiry.');
    }
    options.expiresInDays = days;
  }
  const redact = parseIdList(record['redactFindingIds']);
  if (redact) options.redactFindingIds = redact;
  const acknowledge = parseIdList(record['acknowledgeFindingIds']);
  if (acknowledge) options.acknowledgeFindingIds = acknowledge;
  if (record['diagramSvg'] !== undefined) {
    const svg = record['diagramSvg'];
    if (typeof svg !== 'string' || svg.length > MAX_DIAGRAM_SVG_CHARS) {
      throw new Error('Invalid diagram image.');
    }
    options.diagramSvg = svg;
  }
  return options;
}

function parseListFilter(value: unknown): {
  itemType?: ShareItemType;
  itemId?: string;
  workspaceId?: string;
} {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object') throw new Error('Invalid share filter.');
  const record = value as Record<string, unknown>;
  return {
    ...(isItemType(record['itemType']) ? { itemType: record['itemType'] } : {}),
    ...(isId(record['itemId']) ? { itemId: record['itemId'] } : {}),
    ...(isId(record['workspaceId']) ? { workspaceId: record['workspaceId'] } : {}),
  };
}

function requireRecordId(value: unknown): string {
  if (!isId(value)) throw new Error('Invalid share id.');
  return value;
}

let toolRegistered = false;

export function registerSharesHandlers(): void {
  ipcMain.handle('shares:available', (): boolean => isSharingAvailable());

  ipcMain.handle(
    'shares:preview',
    (_event, target: unknown, options: unknown): Promise<SharePreview> =>
      previewShare(parseTarget(target), parseOptions(options)),
  );

  ipcMain.handle(
    'shares:publish',
    (_event, target: unknown, options: unknown): Promise<{ record: ShareRecord; url: string }> =>
      publishShare(parseTarget(target), parseOptions(options)),
  );

  ipcMain.handle(
    'shares:update',
    (_event, shareRecordId: unknown, options: unknown): Promise<ShareRecord> =>
      updateShare(requireRecordId(shareRecordId), parseOptions(options)),
  );

  ipcMain.handle('shares:revoke', (_event, shareRecordId: unknown): Promise<ShareRecord> =>
    revokeShare(requireRecordId(shareRecordId)),
  );

  ipcMain.handle('shares:list', (_event, filter: unknown): Promise<ShareRecord[]> =>
    listShares(parseListFilter(filter)),
  );

  ipcMain.handle('shares:copy-link', (_event, shareRecordId: unknown): Promise<boolean> =>
    copyShareLink(requireRecordId(shareRecordId)),
  );

  if (!toolRegistered) {
    toolRegistered = true;
    registerAgentToolProvider(sharesAgentToolProvider);
    // Move pre-`shares` link URLs out of SQLite into credential storage.
    setTimeout(() => {
      void migrateLegacySharedUrls().catch(() => undefined);
    }, 0);
  }
}
