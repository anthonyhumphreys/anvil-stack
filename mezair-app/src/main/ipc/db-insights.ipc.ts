import { ipcMain } from 'electron';
import {
  addArtifact,
  getLatestAnalysis,
  listArtifacts,
  removeArtifact,
  runAnalysis,
  selectDbInsightFiles,
} from '../services/db-insights.service.js';

export function registerDbInsightsHandlers(): void {
  ipcMain.handle('db-insights:list-artifacts', (_event, workspaceId: string) => {
    return listArtifacts(workspaceId);
  });

  ipcMain.handle('db-insights:add-artifact', (_event, workspaceId: string, filePath: string) => {
    return addArtifact(workspaceId, filePath);
  });

  ipcMain.handle('db-insights:remove-artifact', (_event, id: string) => {
    return removeArtifact(id);
  });

  ipcMain.handle('db-insights:select-files', async () => {
    return selectDbInsightFiles();
  });

  ipcMain.handle('db-insights:analyze', async (_event, workspaceId: string) => {
    return runAnalysis(workspaceId);
  });

  ipcMain.handle('db-insights:get-latest-analysis', (_event, workspaceId: string) => {
    return getLatestAnalysis(workspaceId, { includeRunning: true });
  });
}
