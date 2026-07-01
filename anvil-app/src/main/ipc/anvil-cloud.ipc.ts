import { shell, ipcMain } from 'electron';
import type { AnvilCloudCommandId } from '../../shared/types.js';
import {
  getAnvilCloudWorkbenchSnapshot,
  runAnvilCloudCommand,
} from '../services/anvil-cloud.service.js';

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
