import { ipcMain } from 'electron';
import type { WorkspaceNoteCreateInput } from '../../shared/types.js';
import {
  createWorkspaceNote,
  listWorkspaceNotes,
  updateWorkspaceNoteStatus,
} from '../services/workspace-notes.service.js';

export function registerWorkspaceNotesHandlers(): void {
  ipcMain.handle(
    'workspace-notes:list',
    (_event, workspaceId?: string, includeReviewed?: boolean) =>
      listWorkspaceNotes(workspaceId, includeReviewed),
  );
  ipcMain.handle('workspace-notes:create', (_event, input: WorkspaceNoteCreateInput) =>
    createWorkspaceNote({ ...input, source: input.source ?? 'desktop' }),
  );
  ipcMain.handle('workspace-notes:accept', (_event, noteId: string) => {
    updateWorkspaceNoteStatus(noteId, 'accepted');
  });
  ipcMain.handle('workspace-notes:dismiss', (_event, noteId: string) => {
    updateWorkspaceNoteStatus(noteId, 'dismissed');
  });
}
