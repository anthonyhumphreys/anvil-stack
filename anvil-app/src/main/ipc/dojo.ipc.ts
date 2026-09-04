import { ipcMain } from 'electron';
import type { DojoConfigInput } from '../../shared/types.js';
import {
  getDojoConfig,
  getDojoReport,
  listDojoReports,
  runDojoReview,
  updateDojoConfig,
} from '../services/dojo.service.js';
import { reconcileAutomationDaemon } from '../services/automation.service.js';

export function registerDojoHandlers(): void {
  ipcMain.handle('dojo:get-config', (_event, workspaceId: string) => {
    return getDojoConfig(workspaceId);
  });

  ipcMain.handle('dojo:update-config', (_event, workspaceId: string, input: DojoConfigInput) => {
    const config = updateDojoConfig(workspaceId, input);
    setImmediate(() => reconcileAutomationDaemon());
    return config;
  });

  ipcMain.handle('dojo:list-reports', (_event, workspaceId: string) => {
    return listDojoReports(workspaceId);
  });

  ipcMain.handle('dojo:get-report', (_event, reportId: string) => {
    return getDojoReport(reportId);
  });

  ipcMain.handle('dojo:run-now', (_event, workspaceId: string) => {
    return runDojoReview(workspaceId);
  });
}
