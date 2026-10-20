import { previewBuild } from '../../shared/preview-build.js';
import { getWorkspace } from '../services/workspace.service.js';
import { ipcMain, webContents, app, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { getBrowserMcpNames } from '../../shared/app-identity.js';
import {
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
// Legacy global Codex MCP registration
// ---------------------------------------------------------------------------
// Browser tools are now served to every session by the local Anvil MCP
// endpoint (agent-tools/browser-tools.ts). The old global `codex mcp add`
// registration is removed once, and only when it points at this app's script.

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

async function removeLegacyChromeMcpRegistration(): Promise<void> {
  if (previewBuild || process.env.ANVIL_DEV_USER_DATA_PATH?.trim()) return;
  const scriptPath = resolveChromeMcpScriptPath();
  if (!scriptPath) return;
  for (const name of getBrowserMcpNames()) {
    const registration = await getChromeMcpRegistration(name);
    if (
      !registration ||
      !isCurrentBrowserMcpRegistration(registration, process.execPath, scriptPath)
    )
      continue;
    await execFileAsync('codex', ['mcp', 'remove', name], { timeout: 15_000 });
    console.log(`[Browser] Removed legacy global ${name} MCP registration`);
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
  // The local Anvil MCP endpoint serves browser tools to every session.
  ipcMain.handle('browser:register-mcp', () => ({ success: true }));

  void removeLegacyChromeMcpRegistration().catch((err) => {
    console.warn(
      `[Browser] Failed to remove legacy Chrome MCP registration: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

export { cleanupBrowser };
