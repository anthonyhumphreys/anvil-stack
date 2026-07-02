import { ipcMain } from 'electron';
import type { ArgentCommandId } from '../../shared/types.js';
import {
  getArgentWorkbenchSnapshot,
  runArgentCommand,
  startArgentSimulatorPreview,
} from '../services/argent.service.js';

export function registerArgentHandlers(): void {
  ipcMain.handle('argent:get-snapshot', () => getArgentWorkbenchSnapshot());

  ipcMain.handle('argent:run-command', (_event, commandId: ArgentCommandId) =>
    runArgentCommand(commandId),
  );

  ipcMain.handle('argent:start-simulator-preview', () => startArgentSimulatorPreview());
}
