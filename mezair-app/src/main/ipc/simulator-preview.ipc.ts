import { ipcMain } from 'electron';
import type { SimulatorPreviewStartOptions } from '../../shared/types.js';
import {
  getSimulatorPreviewStatus,
  startSimulatorPreview,
  stopSimulatorPreview,
} from '../services/simulator-preview.service.js';

export function registerSimulatorPreviewHandlers(): void {
  ipcMain.handle('simulator-preview:get-status', () => {
    return getSimulatorPreviewStatus();
  });

  ipcMain.handle('simulator-preview:start', (_event, options?: SimulatorPreviewStartOptions) => {
    return startSimulatorPreview(options);
  });

  ipcMain.handle('simulator-preview:stop', () => {
    stopSimulatorPreview();
  });
}
