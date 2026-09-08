import { getWorkspace } from '../services/workspace.service.js';
import { ipcMain, webContents, app, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { getBrowserMcpNames, PRIMARY_BROWSER_MCP_NAME } from '../../shared/app-identity.js';
import {
  buildBrowserMcpAddArgs,
  isCurrentBrowserMcpRegistration,
  parseCodexStdioMcpRegistration,
  type CodexStdioMcpRegistration,
} from '../services/browser-mcp-registration.service.js';
import {
  setBrowserScope,
  listTargets,
  addManualTarget,
  startBridge,
  stopBridge,
  getBridgeStatus,
  attachDebugger,
  detachDebugger,
  cleanupBrowser,
} from '../services/browser.service.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Track embedded webview webContents
// ---------------------------------------------------------------------------

const owners = new Map<number, number>();
let selectedOwner: number | null = null;
let selectedGuestId: number | null = null;
let selectedWorkspace: string | null = null;
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  const host = (contents as WebContents & { hostWebContents?: WebContents }).hostWebContents;
  if (host) owners.set(contents.id, host.id);
  contents.on('destroyed', () => {
    owners.delete(contents.id);
  });
});
function ownedGuest(owner: WebContents, id: number): WebContents {
  const guest = webContents.fromId(id);
  const host = guest && (guest as WebContents & { hostWebContents?: WebContents }).hostWebContents;
  if (
    !guest ||
    guest.isDestroyed() ||
    guest.getType() !== 'webview' ||
    (owners.get(id) ?? host?.id) !== owner.id
  )
    throw new Error('Browser target does not belong to this window');
  return guest;
}

// ---------------------------------------------------------------------------
// Codex MCP registration
// ---------------------------------------------------------------------------

async function getChromeMcpRegistration(name: string): Promise<CodexStdioMcpRegistration | null> {
  try {
    const { stdout } = await execFileAsync('codex', ['mcp', 'get', name, '--json'], {
      timeout: 10_000,
    });
    return parseCodexStdioMcpRegistration(String(stdout));
  } catch {
    return null;
  }
}

function resolveChromeMcpScriptPath(): string | null {
  // In dev: app.getAppPath() → project root. In prod: app.getAppPath() → app.asar
  // The scripts/ dir lives at project root, so try both locations
  const appPath = app.getAppPath();
  const candidates = [
    resolve(appPath, 'scripts/chrome-mcp-server.mjs'),
    resolve(appPath, '..', 'scripts/chrome-mcp-server.mjs'),
    resolve(__dirname, '../../scripts/chrome-mcp-server.mjs'),
  ];
  const scriptPath = candidates.find((p) => existsSync(p)) ?? candidates[0];
  return existsSync(scriptPath) ? scriptPath : null;
}

async function removeChromeMcp(name: string): Promise<void> {
  await execFileAsync('codex', ['mcp', 'remove', name], { timeout: 15_000 });
}

async function registerChromeMcp(): Promise<{ success: boolean; error?: string }> {
  const scriptPath = resolveChromeMcpScriptPath();

  if (!scriptPath) {
    return { success: false, error: 'Anvil Chrome MCP server script not found.' };
  }

  const registrations = new Map<string, CodexStdioMcpRegistration>();
  for (const name of getBrowserMcpNames()) {
    const registration = await getChromeMcpRegistration(name);
    if (registration) registrations.set(name, registration);
  }

  const primaryRegistration = registrations.get(PRIMARY_BROWSER_MCP_NAME);
  if (
    primaryRegistration &&
    isCurrentBrowserMcpRegistration(primaryRegistration, process.execPath, scriptPath)
  ) {
    try {
      for (const name of registrations.keys()) {
        if (name !== PRIMARY_BROWSER_MCP_NAME) await removeChromeMcp(name);
      }
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Browser] Failed to remove legacy MCP registration: ${msg}`);
      return { success: false, error: msg };
    }
  }

  try {
    if (primaryRegistration) await removeChromeMcp(PRIMARY_BROWSER_MCP_NAME);
    await execFileAsync(
      'codex',
      buildBrowserMcpAddArgs(PRIMARY_BROWSER_MCP_NAME, process.execPath, scriptPath),
      { timeout: 15_000 },
    );
    for (const name of registrations.keys()) {
      if (name !== PRIMARY_BROWSER_MCP_NAME) await removeChromeMcp(name);
    }
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

  ipcMain.handle('browser:start-bridge', async (event, id: number, workspaceId: string) => {
    const guest = ownedGuest(event.sender, id);
    const workspace = getWorkspace(workspaceId);
    setBrowserScope({ workspaceId, repoPaths: workspace.repos.map((repo) => repo.path) });
    selectedOwner = event.sender.id;
    selectedWorkspace = workspaceId;
    selectedGuestId = id;
    attachDebugger(guest);
    return { port: await startBridge() };
  });
  ipcMain.handle('browser:stop-bridge', () => {
    stopBridge();
    selectedOwner = null;
    selectedWorkspace = null;
  });
  ipcMain.handle('browser:attach-debugger', (event, id: number, workspaceId: string) => {
    const guest = ownedGuest(event.sender, id);
    if (selectedOwner !== event.sender.id || selectedWorkspace !== workspaceId) detachDebugger();
    selectedOwner = event.sender.id;
    selectedWorkspace = workspaceId;
    selectedGuestId = id;
    setBrowserScope({
      workspaceId,
      repoPaths: getWorkspace(workspaceId).repos.map((repo) => repo.path),
    });
    attachDebugger(guest);
  });
  ipcMain.handle('browser:detach-debugger', (event, id: number) => {
    if (selectedOwner === event.sender.id && selectedGuestId === id) {
      detachDebugger();
      selectedOwner = null;
      selectedWorkspace = null;
    }
  });
  ipcMain.handle('browser:register-mcp', () => registerChromeMcp());

  void repairChromeMcpRegistration().catch((err) => {
    console.warn(
      `[Browser] Failed to check Chrome MCP registration: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function repairChromeMcpRegistration(): Promise<void> {
  const registrations = await Promise.all(
    getBrowserMcpNames().map((name) => getChromeMcpRegistration(name)),
  );
  if (!registrations.some(Boolean)) return;

  const result = await registerChromeMcp();
  if (!result.success) {
    console.warn(`[Browser] Failed to repair Chrome MCP registration: ${result.error}`);
  }
}

export { cleanupBrowser };
