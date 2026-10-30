import { ipcMain } from 'electron';
import {
  clearPendingLaunchIntent,
  getPendingLaunchIntent,
} from '../services/launch-intent.service.js';

export function registerLaunchHandlers(): void {
  ipcMain.handle('launch:get-pending-intent', () => getPendingLaunchIntent());
  ipcMain.handle('launch:clear-pending-intent', () => {
    clearPendingLaunchIntent();
  });
}
