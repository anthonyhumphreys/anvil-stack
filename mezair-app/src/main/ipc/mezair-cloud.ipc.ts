import { shell, ipcMain } from 'electron';
import type {
  MezairCloudCommandId,
  MezairCloudExecutionConnectionInput,
  MezairCloudExecutionStartInput,
} from '../../shared/types.js';
import {
  getMezairCloudWorkbenchSnapshot,
  runMezairCloudCommand,
} from '../services/mezair-cloud.service.js';
import {
  clearMezairCloudExecutionConnection,
  collectMezairCloudExecution,
  getMezairCloudExecution,
  getMezairCloudExecutionConnection,
  listMezairCloudExecutions,
  readMezairCloudExecutionEvents,
  resolveMezairCloudExecutionApproval,
  saveMezairCloudExecutionConnection,
  startMezairCloudExecution,
  steerMezairCloudExecution,
  terminateMezairCloudExecution,
  testMezairCloudExecutionConnection,
} from '../services/mezair-cloud-execution.service.js';

export function registerMezairCloudHandlers(): void {
  ipcMain.handle('mezair-cloud:snapshot', async () => getMezairCloudWorkbenchSnapshot());

  ipcMain.handle('mezair-cloud:run', async (_event, commandId: MezairCloudCommandId, cwd: string) => {
    return runMezairCloudCommand(commandId, cwd);
  });

  ipcMain.handle('mezair-cloud:open-lens', async (_event, cwd: string) => {
    const result = await runMezairCloudCommand('lens', cwd);
    const url = readLensUrl(result.parsed);

    if (!result.ok || !url) {
      return {
        success: false,
        result,
        error: result.error ?? 'Mezair Lens is not available. Start Mezair Local first.',
      };
    }

    await shell.openExternal(url);
    return { success: true, url, result };
  });

  ipcMain.handle('mezair-cloud:execution-connection', () => getMezairCloudExecutionConnection());
  ipcMain.handle(
    'mezair-cloud:save-execution-connection',
    (_event, input: MezairCloudExecutionConnectionInput) => saveMezairCloudExecutionConnection(input),
  );
  ipcMain.handle('mezair-cloud:clear-execution-connection', () =>
    clearMezairCloudExecutionConnection(),
  );
  ipcMain.handle('mezair-cloud:test-execution-connection', () =>
    testMezairCloudExecutionConnection(),
  );
  ipcMain.handle('mezair-cloud:executions-list', () => listMezairCloudExecutions());
  ipcMain.handle('mezair-cloud:execution-get', (_event, executionId: string) =>
    getMezairCloudExecution(executionId),
  );
  ipcMain.handle('mezair-cloud:execution-start', (_event, input: MezairCloudExecutionStartInput) =>
    startMezairCloudExecution(input),
  );
  ipcMain.handle('mezair-cloud:execution-events', (_event, executionId: string, cursor?: string) =>
    readMezairCloudExecutionEvents(executionId, cursor),
  );
  ipcMain.handle(
    'mezair-cloud:execution-approval',
    (
      _event,
      input: {
        executionId: string;
        requestId: string;
        decision: 'approved' | 'rejected';
        reason?: string;
      },
    ) => resolveMezairCloudExecutionApproval(input),
  );
  ipcMain.handle('mezair-cloud:execution-steer', (_event, executionId: string, message: string) =>
    steerMezairCloudExecution(executionId, message),
  );
  ipcMain.handle('mezair-cloud:execution-collect', (_event, executionId: string) =>
    collectMezairCloudExecution(executionId),
  );
  ipcMain.handle('mezair-cloud:execution-terminate', (_event, executionId: string) =>
    terminateMezairCloudExecution(executionId),
  );
}

function readLensUrl(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const payload = parsed as { url?: unknown; result?: { url?: unknown } };
  const rawUrl = typeof payload.url === 'string' ? payload.url : payload.result?.url;
  if (typeof rawUrl !== 'string') return null;

  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
