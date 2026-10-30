import { ipcMain } from 'electron';
import {
  listBoards,
  createBoard,
  updateBoard,
  deleteBoard,
  listDocuments,
  addDocument,
  updateDocument,
  removeDocument,
  selectGovernanceFiles,
} from '../services/governance.service.js';

export function registerGovernanceHandlers(): void {
  // -- Boards ----------------------------------------------------------------

  ipcMain.handle('governance:list-boards', (_event, workspaceId: string) => {
    try {
      return listBoards(workspaceId);
    } catch (err) {
      console.error('[Governance IPC] Error listing boards:', err);
      throw err;
    }
  });

  ipcMain.handle(
    'governance:create-board',
    (_event, workspaceId: string, name: string, description?: string) => {
      try {
        return createBoard(workspaceId, name, description);
      } catch (err) {
        console.error('[Governance IPC] Error creating board:', err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    'governance:update-board',
    (_event, id: string, opts: { name?: string; description?: string }) => {
      try {
        return updateBoard(id, opts);
      } catch (err) {
        console.error('[Governance IPC] Error updating board:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('governance:delete-board', (_event, id: string) => {
    try {
      return deleteBoard(id);
    } catch (err) {
      console.error('[Governance IPC] Error deleting board:', err);
      throw err;
    }
  });

  // -- Documents -------------------------------------------------------------

  ipcMain.handle('governance:list-documents', (_event, workspaceId: string, boardId?: string) => {
    try {
      return listDocuments(workspaceId, boardId);
    } catch (err) {
      console.error('[Governance IPC] Error listing documents:', err);
      throw err;
    }
  });

  ipcMain.handle(
    'governance:add-document',
    (_event, workspaceId: string, filePath: string, boardId?: string, description?: string) => {
      try {
        return addDocument(workspaceId, filePath, boardId, description);
      } catch (err) {
        console.error('[Governance IPC] Error adding document:', err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    'governance:update-document',
    (_event, id: string, opts: { boardId?: string | null; description?: string }) => {
      try {
        return updateDocument(id, opts);
      } catch (err) {
        console.error('[Governance IPC] Error updating document:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('governance:remove-document', (_event, id: string) => {
    try {
      return removeDocument(id);
    } catch (err) {
      console.error('[Governance IPC] Error removing document:', err);
      throw err;
    }
  });

  // -- File picker -----------------------------------------------------------

  ipcMain.handle('governance:select-files', async () => {
    try {
      return await selectGovernanceFiles();
    } catch (err) {
      console.error('[Governance IPC] Error selecting files:', err);
      throw err;
    }
  });
}
