import { ipcMain } from 'electron';
import { getCodexUsageSnapshot } from '../services/codex-usage.service.js';

export function registerCodexUsageHandlers(): void {
  ipcMain.handle('codex-usage:snapshot', async () => getCodexUsageSnapshot());
}
