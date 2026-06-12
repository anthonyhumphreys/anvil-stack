import { ipcMain, BrowserWindow, app, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { getBrowserMcpNames, PRIMARY_BROWSER_MCP_NAME } from '../../shared/app-identity.js';
import {
  listTargets,
  addManualTarget,
  startBridge,
  stopBridge,
  getBridgeStatus,
  attachDebugger,
  detachDebugger,
  setConnectedUrl,
  cleanupBrowser,
} from '../services/browser.service.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Track embedded webview webContents
// ---------------------------------------------------------------------------

let webviewContentsId: number | null = null;

function findWebviewContents(): WebContents | null {
  if (webviewContentsId !== null) {
    const wc = BrowserWindow.getAllWindows()
      .flatMap((w) => [w.webContents])
      .find((c) => c.id === webviewContentsId);
    if (wc && !wc.isDestroyed()) return wc;
    webviewContentsId = null;
  }
  return null;
}

// Listen for webview creation to grab its webContents
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') {
    webviewContentsId = contents.id;
    console.log(`[Browser] Webview webContents created (id=${contents.id})`);

    contents.on('destroyed', () => {
      if (webviewContentsId === contents.id) {
        webviewContentsId = null;
        detachDebugger();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Codex MCP registration
// ---------------------------------------------------------------------------

async function isChromeMcpRegistered(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('codex', ['mcp', 'list'], { timeout: 10_000 });
    return getBrowserMcpNames().some((name) => stdout.includes(name));
  } catch {
    return false;
  }
}

async function registerChromeMcp(): Promise<{ success: boolean; error?: string }> {
  // In dev: app.getAppPath() → project root. In prod: app.getAppPath() → app.asar
  // The scripts/ dir lives at project root, so try both locations
  const appPath = app.getAppPath();
  const candidates = [
    resolve(appPath, 'scripts/chrome-mcp-server.mjs'),
    resolve(appPath, '..', 'scripts/chrome-mcp-server.mjs'),
    resolve(__dirname, '../../scripts/chrome-mcp-server.mjs'),
  ];
  const scriptPath = candidates.find((p) => existsSync(p)) ?? candidates[0];

  if (!existsSync(scriptPath)) {
    return { success: false, error: `MCP server script not found at ${scriptPath}` };
  }

  if (await isChromeMcpRegistered()) {
    return { success: true };
  }

  try {
    await execFileAsync(
      'codex',
      ['mcp', 'add', PRIMARY_BROWSER_MCP_NAME, '--', process.execPath, scriptPath],
      { timeout: 15_000 },
    );
    console.log(`[Browser] Registered ${PRIMARY_BROWSER_MCP_NAME} MCP with Codex CLI`);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Browser] Failed to register MCP: ${msg}`);
    return { success: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerBrowserHandlers(): void {
  ipcMain.handle('browser:list-targets', () => listTargets());

  ipcMain.handle('browser:add-target', (_event, url: string) => {
    try {
      return addManualTarget(url);
    } catch (err) {
      throw new Error(`Invalid URL: ${err instanceof Error ? err.message : err}`);
    }
  });

  ipcMain.handle('browser:get-bridge-status', () => getBridgeStatus());

  ipcMain.handle('browser:start-bridge', async () => {
    const port = await startBridge();

    // Attach debugger to webview if available
    const wc = findWebviewContents();
    if (wc) {
      attachDebugger(wc);
    }

    return { port };
  });

  ipcMain.handle('browser:stop-bridge', () => {
    stopBridge();
  });

  ipcMain.handle('browser:attach-debugger', () => {
    const wc = findWebviewContents();
    if (!wc) return; // webview not registered yet — will attach when bridge starts
    attachDebugger(wc);
  });

  ipcMain.handle('browser:set-url', (_event, url: string) => {
    setConnectedUrl(url);
  });

  ipcMain.handle('browser:register-mcp', () => registerChromeMcp());

  ipcMain.handle(
    'browser:cdp-command',
    async (_event, method: string, params?: Record<string, unknown>) => {
      const wc = findWebviewContents();
      if (!wc) throw new Error('No embedded browser webview found');

      try {
        wc.debugger.attach('1.3');
      } catch {
        /* already attached */
      }

      return wc.debugger.sendCommand(method, params);
    },
  );
}

export { cleanupBrowser };
