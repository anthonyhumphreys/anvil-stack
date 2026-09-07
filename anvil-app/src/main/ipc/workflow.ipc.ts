import { ipcMain } from 'electron';
import type { WorkflowTemplateInput } from '../../shared/types.js';
import {
  askWorkflowSupervisor,
  pauseWorkflowRun,
  resumeWorkflowRun,
  decideWorkflowNode,
  retryWorkflowNode,
  recoverInterruptedWorkflowRuns,
  cancelWorkflowRun,
  deleteWorkflowTemplate,
  draftWorkflowTemplate,
  getWorkflowRun,
  listWorkflowRuns,
  listWorkflowTemplates,
  saveWorkflowTemplate,
  startWorkflowRun,
} from '../services/workflow.service.js';

export function registerWorkflowHandlers(): void {
  recoverInterruptedWorkflowRuns();
  ipcMain.handle('workflow:pause-run', (_event, id: string) => pauseWorkflowRun(id));
  ipcMain.handle('workflow:resume-run', (_event, id: string) => resumeWorkflowRun(id));
  ipcMain.handle('workflow:retry-node', (_event, id: string, nodeId: string) =>
    retryWorkflowNode(id, nodeId),
  );
  ipcMain.handle(
    'workflow:decide-node',
    (_event, id: string, nodeId: string, approved: boolean, note: string) =>
      decideWorkflowNode(id, nodeId, approved, note),
  );
  ipcMain.handle('workflow:list-templates', () => listWorkflowTemplates());
  ipcMain.handle('workflow:draft-template', (_event, request: string) =>
    draftWorkflowTemplate(request),
  );
  ipcMain.handle('workflow:save-template', (_event, input: WorkflowTemplateInput, id?: string) =>
    saveWorkflowTemplate(input, id),
  );
  ipcMain.handle('workflow:delete-template', (_event, id: string) => deleteWorkflowTemplate(id));
  ipcMain.handle('workflow:list-runs', (_event, workspaceId: string) =>
    listWorkflowRuns(workspaceId),
  );
  ipcMain.handle('workflow:get-run', (_event, id: string) => getWorkflowRun(id));
  ipcMain.handle(
    'workflow:start-run',
    (
      _event,
      input: { templateId: string; workspaceId: string; repoIds: string[]; kickoff: string },
    ) =>
      startWorkflowRun({
        templateId: input.templateId,
        workspaceId: input.workspaceId,
        repoIds: input.repoIds,
        kickoff: input.kickoff,
      }),
  );
  ipcMain.handle('workflow:ask-supervisor', (_event, runId: string, question: string) =>
    askWorkflowSupervisor(runId, question),
  );
  ipcMain.handle('workflow:cancel-run', (_event, runId: string) => cancelWorkflowRun(runId));
}
