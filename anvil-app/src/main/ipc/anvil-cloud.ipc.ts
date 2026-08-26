import { shell, ipcMain } from 'electron';
import type {
  AnvilCloudCommandId,
  AnvilCloudExecutionConnectionInput,
  AnvilCloudExecutionStartInput,
} from '../../shared/types.js';
import {
  getAnvilCloudWorkbenchSnapshot,
  runAnvilCloudCommand,
} from '../services/anvil-cloud.service.js';
import {
  clearAnvilCloudExecutionConnection,
  collectAnvilCloudExecution,
  getAnvilCloudExecution,
  getAnvilCloudExecutionConnection,
  listAnvilCloudExecutions,
  readAnvilCloudExecutionEvents,
  resolveAnvilCloudExecutionApproval,
  saveAnvilCloudExecutionConnection,
  startAnvilCloudExecution,
  steerAnvilCloudExecution,
  terminateAnvilCloudExecution,
  testAnvilCloudExecutionConnection,
} from '../services/anvil-cloud-execution.service.js';

export function registerAnvilCloudHandlers(): void {
  ipcMain.handle('anvil-cloud:snapshot', async () => getAnvilCloudWorkbenchSnapshot());

  ipcMain.handle('anvil-cloud:run', async (_event, commandId: AnvilCloudCommandId, cwd: string) => {
    return runAnvilCloudCommand(commandId, cwd);
  });

  ipcMain.handle('anvil-cloud:open-lens', async (_event, cwd: string) => {
    const result = await runAnvilCloudCommand('lens', cwd);
    const url = readLensUrl(result.parsed);

    if (!result.ok || !url) {
      return {
        success: false,
        result,
        error: result.error ?? 'Anvil Lens is not available. Start Anvil Local first.',
      };
    }

    await shell.openExternal(url);
    return { success: true, url, result };
  });

  ipcMain.handle('anvil-cloud:execution-connection', () => getAnvilCloudExecutionConnection());
  ipcMain.handle(
    'anvil-cloud:save-execution-connection',
    (_event, input: AnvilCloudExecutionConnectionInput) => saveAnvilCloudExecutionConnection(input),
  );
  ipcMain.handle('anvil-cloud:clear-execution-connection', () =>
    clearAnvilCloudExecutionConnection(),
  );
  ipcMain.handle('anvil-cloud:test-execution-connection', () =>
    testAnvilCloudExecutionConnection(),
  );
  ipcMain.handle('anvil-cloud:executions-list', () => listAnvilCloudExecutions());
  ipcMain.handle('anvil-cloud:execution-get', (_event, executionId: string) =>
    getAnvilCloudExecution(executionId),
  );
  ipcMain.handle('anvil-cloud:execution-start', (_event, input: AnvilCloudExecutionStartInput) =>
    startAnvilCloudExecution(input),
  );
  ipcMain.handle('anvil-cloud:execution-events', (_event, executionId: string, cursor?: string) =>
    readAnvilCloudExecutionEvents(executionId, cursor),
  );
  ipcMain.handle(
    'anvil-cloud:execution-approval',
    (
      _event,
      input: {
        executionId: string;
        requestId: string;
        decision: 'approved' | 'rejected';
        reason?: string;
      },
    ) => resolveAnvilCloudExecutionApproval(input),
  );
  ipcMain.handle('anvil-cloud:execution-steer', (_event, executionId: string, message: string) =>
    steerAnvilCloudExecution(executionId, message),
  );
  ipcMain.handle('anvil-cloud:execution-collect', (_event, executionId: string) =>
    collectAnvilCloudExecution(executionId),
  );
  ipcMain.handle('anvil-cloud:execution-terminate', (_event, executionId: string) =>
    terminateAnvilCloudExecution(executionId),
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
