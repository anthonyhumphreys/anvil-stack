import { ipcMain } from 'electron';
import type { EmbeddedEditorTarget } from '../../shared/types.js';
import {
  cleanupEmbeddedEditor,
  focusEmbeddedEditorTarget,
  getEmbeddedEditorStatus,
  openEmbeddedEditorExternally,
  startEmbeddedEditor,
  stopEmbeddedEditor,
} from '../services/embedded-editor.service.js';

export function registerEditorHandlers(): void {
  ipcMain.handle('editor:get-status', () => {
    return getEmbeddedEditorStatus();
  });

  ipcMain.handle('editor:start', async (_event, workspaceId: string) => {
    return await startEmbeddedEditor(workspaceId);
  });

  ipcMain.handle('editor:stop', async () => {
    await stopEmbeddedEditor();
  });

  ipcMain.handle(
    'editor:focus-target',
    async (
      _event,
      target: EmbeddedEditorTarget,
      options?: {
        startServer?: boolean;
      },
    ) => {
      return await focusEmbeddedEditorTarget(target, options);
    },
  );

  ipcMain.handle('editor:open-external', async (_event, target: EmbeddedEditorTarget) => {
    await openEmbeddedEditorExternally(target);
  });
}

export { cleanupEmbeddedEditor };
