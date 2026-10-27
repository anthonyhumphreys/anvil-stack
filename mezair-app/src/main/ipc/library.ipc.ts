// Owned by the sidebar/Library workstream: implements window.mezair.library.
import { ipcMain } from 'electron';
import type { LibraryItemKind, LibraryListFilter } from '../../shared/library-ipc.js';
import { listLibraryItems } from '../services/library.service.js';

const LIBRARY_KINDS: readonly LibraryItemKind[] = [
  'artifact',
  'surface',
  'adr',
  'diagram',
  'compliance',
  'doc',
];

/** Validate the renderer's filter at the trust boundary; unknown fields are dropped. */
export function parseLibraryFilter(value: unknown): LibraryListFilter {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Library filter must be an object.');
  }
  const input = value as Record<string, unknown>;
  const filter: LibraryListFilter = {};
  if (input.kind !== undefined) {
    if (typeof input.kind !== 'string' || !LIBRARY_KINDS.includes(input.kind as LibraryItemKind)) {
      throw new Error(`Unknown library kind: ${String(input.kind)}`);
    }
    filter.kind = input.kind as LibraryItemKind;
  }
  if (input.repoId !== undefined) {
    if (typeof input.repoId !== 'string') throw new Error('Library repoId must be a string.');
    if (input.repoId) filter.repoId = input.repoId;
  }
  if (input.query !== undefined) {
    if (typeof input.query !== 'string') throw new Error('Library query must be a string.');
    const query = input.query.trim().slice(0, 200);
    if (query) filter.query = query;
  }
  if (input.sharedOnly !== undefined) {
    if (typeof input.sharedOnly !== 'boolean') {
      throw new Error('Library sharedOnly must be a boolean.');
    }
    if (input.sharedOnly) filter.sharedOnly = true;
  }
  return filter;
}

export function registerLibraryHandlers(): void {
  ipcMain.handle('library:list', async (_event, workspaceId: unknown, filter: unknown) => {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
      throw new Error('A workspace id is required to list the Library.');
    }
    return listLibraryItems(workspaceId, parseLibraryFilter(filter));
  });
}
