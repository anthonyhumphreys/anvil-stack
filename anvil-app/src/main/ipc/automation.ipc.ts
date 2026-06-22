import { ipcMain } from 'electron';
import type { AutomationDefinitionInput } from '../../shared/types.js';
import {
  createWorkspaceAutomation,
  deleteWorkspaceAutomation,
  getAutomationById,
  getAutomationDaemonRuntimeStatus,
  getAutomationRunById,
  listRunEventsForRun,
  listRunsForAutomation,
  listWorkspaceAutomations,
  listWorkspaceAutomationTriage,
  reconcileAutomationDaemon,
  runAutomationNow,
  updateWorkspaceAutomation,
} from '../services/automation.service.js';

export function registerAutomationHandlers(): void {
  ipcMain.handle('automations:list', (_event, workspaceId: string) => {
    return listWorkspaceAutomations(workspaceId);
  });

  ipcMain.handle('automations:get', (_event, automationId: string) => {
    return getAutomationById(automationId);
  });

  ipcMain.handle(
    'automations:create',
    (_event, workspaceId: string, input: AutomationDefinitionInput) => {
      return createWorkspaceAutomation(workspaceId, input);
    },
  );

  ipcMain.handle(
    'automations:update',
    (_event, automationId: string, input: AutomationDefinitionInput) => {
      return updateWorkspaceAutomation(automationId, input);
    },
  );

  ipcMain.handle('automations:remove', (_event, automationId: string) => {
    deleteWorkspaceAutomation(automationId);
  });

  ipcMain.handle('automations:run-now', (_event, automationId: string) => {
    return runAutomationNow(automationId);
  });

  ipcMain.handle('automations:list-runs', (_event, automationId: string) => {
    return listRunsForAutomation(automationId);
  });

  ipcMain.handle('automations:triage', (_event, workspaceId: string) => {
    return listWorkspaceAutomationTriage(workspaceId);
  });

  ipcMain.handle('automations:get-run', (_event, runId: string) => {
    return getAutomationRunById(runId);
  });

  ipcMain.handle('automations:list-run-events', (_event, runId: string) => {
    return listRunEventsForRun(runId);
  });

  ipcMain.handle('automations:daemon-status', () => {
    return getAutomationDaemonRuntimeStatus();
  });

  ipcMain.handle('automations:reconcile-daemon', () => {
    return reconcileAutomationDaemon();
  });
}
