import { ipcMain } from 'electron';
import type { EditableAgentInput } from '../services/editable-agent.service.js';
import {
  deleteEditableAgent,
  listEditableAgents,
  saveEditableAgent,
} from '../services/editable-agent.service.js';

export function registerAgentHandlers(): void {
  ipcMain.handle('agents:list', () => {
    try {
      return listEditableAgents();
    } catch (err) {
      console.error('[Agents IPC] Error listing editable agents:', err);
      throw err;
    }
  });

  ipcMain.handle('agents:save', (_event, input: EditableAgentInput, agentId?: string) => {
    try {
      if (typeof input?.name !== 'string' || input.name.trim().length === 0) {
        throw new Error('Agent name is required.');
      }
      if (typeof input?.promptBody !== 'string' || input.promptBody.trim().length === 0) {
        throw new Error('Agent prompt is required.');
      }
      return saveEditableAgent(input, agentId);
    } catch (err) {
      console.error('[Agents IPC] Error saving editable agent:', err);
      throw err;
    }
  });

  ipcMain.handle('agents:delete', (_event, agentId: string) => {
    try {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw new Error('agentId is required');
      }
      return deleteEditableAgent(agentId);
    } catch (err) {
      console.error('[Agents IPC] Error deleting editable agent:', err);
      throw err;
    }
  });
}
