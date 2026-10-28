import { ipcMain } from 'electron';
import { listAgentRuns } from '../services/agent-run.service.js';

export function registerAgentRunHandlers(): void {
  ipcMain.handle('agent-runs:list', (_event, workspaceId: string, limit?: number) => {
    return listAgentRuns(workspaceId, limit);
  });
}
