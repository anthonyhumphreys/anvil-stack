import { ipcMain } from 'electron';
import { getDiagnosticsSnapshot } from '../services/diagnostics.service.js';

export function registerDiagnosticsHandlers(): void {
  ipcMain.handle('diagnostics:get-snapshot', () => getDiagnosticsSnapshot());
}
