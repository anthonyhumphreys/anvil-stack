import { fixPath } from './utils/fix-path.js';
fixPath();

import { app, BrowserWindow, ipcMain, session } from 'electron';
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { initDatabase } from './db/database.js';
import { registerSettingsHandlers } from './ipc/settings.ipc.js';
import { registerCodexRegistryHandlers } from './ipc/codex-registry.ipc.js';
import { registerCodexUsageHandlers } from './ipc/codex-usage.ipc.js';
import { registerAnvilCloudHandlers } from './ipc/anvil-cloud.ipc.js';
import { registerDiagnosticsHandlers } from './ipc/diagnostics.ipc.js';
import { registerMobileCompanionHandlers } from './ipc/mobile-companion.ipc.js';
import { registerRepoHandlers, handleStaleIndexingRepos } from './ipc/repo.ipc.js';
import { ensureRepobaseMcp } from './services/repobase.service.js';
import { registerChatHandlers, cleanupChatSessions } from './ipc/chat.ipc.js';
import { registerOnboardHandlers } from './ipc/onboard.ipc.js';
import { registerWorkItemsHandlers } from './ipc/workitems.ipc.js';
import { registerDocsHandlers } from './ipc/docs.ipc.js';
import { registerBaHandlers, cleanupBaSessions, handleOrphanedBaSessions } from './ipc/ba.ipc.js';
import { registerSecurityHandlers } from './ipc/security.ipc.js';
import { registerPentestHandlers, cleanupPentest } from './ipc/pentest.ipc.js';
import { registerCodeReviewHandlers } from './ipc/codereview.ipc.js';
import { registerDiagramFileHandlers, cleanupDiagramServices } from './ipc/diagram-file.ipc.js';
import { registerWorkspaceHandlers } from './ipc/workspace.ipc.js';
import { registerWorkspaceNotesHandlers } from './ipc/workspace-notes.ipc.js';
import { registerWorkspaceScaffoldHandlers } from './ipc/workspace-scaffold.ipc.js';
import { registerLaunchHandlers } from './ipc/launch.ipc.js';
import { parseBrandFromArgs, getBrand } from '../shared/branding.js';
import { registerTerminalHandlers, cleanupTerminals } from './ipc/terminal.ipc.js';
import { registerGovernanceHandlers } from './ipc/governance.ipc.js';
import { registerDbInsightsHandlers } from './ipc/db-insights.ipc.js';
import { registerAutomationHandlers } from './ipc/automation.ipc.js';
import { registerWorkflowHandlers } from './ipc/workflow.ipc.js';
import { registerAgentRunHandlers } from './ipc/agent-run.ipc.js';
import { registerDesignHandlers } from './ipc/design.ipc.js';
import { registerAdrHandlers } from './ipc/adr.ipc.js';
import { registerBrowserHandlers, cleanupBrowser } from './ipc/browser.ipc.js';
import { registerSimulatorPreviewHandlers } from './ipc/simulator-preview.ipc.js';
import { registerArgentHandlers } from './ipc/argent.ipc.js';
import { registerEditorHandlers, cleanupEmbeddedEditor } from './ipc/editor.ipc.js';
import { registerGitHandlers } from './ipc/git.ipc.js';
import { registerCicdHandlers } from './ipc/cicd.ipc.js';
import { registerComplianceHandlers } from './ipc/compliance.ipc.js';
import { registerLifecycleHandlers } from './ipc/lifecycle.ipc.js';
import { registerDependencyHandlers } from './ipc/dependencies.ipc.js';
import { registerRunHandlers, cleanupRunProcesses } from './ipc/run.ipc.js';
import { registerVoiceHandlers } from './ipc/voice.ipc.js';
import {
  clearPendingLaunchIntent,
  deliverPendingLaunchIntent,
  extractLaunchUrlFromArgv,
  parseOpenInAnvilUrl,
  queueLaunchIntent,
} from './services/launch-intent.service.js';
import {
  initializeAutomationRuntime,
  shutdownAutomationRuntime,
} from './services/automation.service.js';
import { isAutomationDaemonMode } from './services/automation-daemon.service.js';
import { LEGACY_PROTOCOL, PRIMARY_PROTOCOL } from '../shared/app-identity.js';
import { getLegacyUserDataPaths, getPrimaryUserDataPath } from './utils/app-paths.js';
import {
  stopMobileCompanionServer,
  syncMobileCompanionServer,
} from './services/mobile-companion.service.js';
import { cleanupStatusBar, initializeStatusBar } from './services/statusbar.service.js';
import { cleanupSimulatorPreview } from './services/simulator-preview.service.js';
import { initializeAppUpdater } from './services/app-updater.service.js';

const brandId = parseBrandFromArgs(process.argv);
const brand = getBrand(brandId);
const isolatedDevProfileActive = Boolean(
  process.env.ELECTRON_RENDERER_URL && process.env.ANVIL_DEV_USER_DATA_PATH?.trim(),
);

function getAppIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'anvil.png')
    : path.join(process.cwd(), 'resources', 'anvil.png');
}

function configureUserDataPath(): void {
  const isolatedDevPath = process.env.ANVIL_DEV_USER_DATA_PATH?.trim();
  if (process.env.ELECTRON_RENDERER_URL && isolatedDevPath) {
    app.setPath('userData', path.resolve(isolatedDevPath));
    return;
  }

  const targetPath = getPrimaryUserDataPath();
  if (!existsSync(targetPath)) {
    const legacyPath = getLegacyUserDataPaths().find((candidate) => existsSync(candidate));
    if (legacyPath) {
      cpSync(legacyPath, targetPath, { recursive: true });
    }
  }
  app.setPath('userData', targetPath);
}

app.setName(isolatedDevProfileActive ? `${brand.appName} UI Lab` : brand.appName);
configureUserDataPath();

let mainWindow: BrowserWindow | null = null;
let rendererCspRegistered = false;
const daemonMode = isAutomationDaemonMode();
if (daemonMode && process.platform === 'linux') {
  app.commandLine.appendSwitch('headless');
  app.commandLine.appendSwitch('disable-gpu');
}
const gotSingleInstanceLock = daemonMode ? true : app.requestSingleInstanceLock();

function getWindowChromeState(targetWindow = mainWindow): { isFullScreen: boolean } {
  return {
    isFullScreen: targetWindow?.isFullScreen() ?? false,
  };
}

function sendWindowChromeState(targetWindow: BrowserWindow): void {
  if (targetWindow.isDestroyed()) return;
  targetWindow.webContents.send(
    'app-window:chrome-state-changed',
    getWindowChromeState(targetWindow),
  );
}

function handleIncomingLaunchUrl(rawUrl: string): void {
  try {
    const intent = parseOpenInAnvilUrl(rawUrl);
    if (!intent) return;
    queueLaunchIntent(intent);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      deliverPendingLaunchIntent(mainWindow);
    }
  } catch (err) {
    console.error('[Launch] Failed to parse incoming Anvil URL:', err);
    clearPendingLaunchIntent();
  }
}

const initialLaunchUrl = extractLaunchUrlFromArgv(process.argv);
if (initialLaunchUrl) {
  handleIncomingLaunchUrl(initialLaunchUrl);
}

function isAnvilRendererDocument(url: string): boolean {
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      const rendererOrigin = new URL(process.env.ELECTRON_RENDERER_URL).origin;
      return url.startsWith(`${rendererOrigin}/`);
    } catch {
      return false;
    }
  }

  return url.endsWith('/renderer/index.html') || url.endsWith('\\renderer\\index.html');
}

function getWindowHash(route: string, workspaceId?: string, toolWindow = false): string {
  const routeUrl = new URL(route, 'https://anvil.local');
  const params = routeUrl.searchParams;
  if (workspaceId) params.set('workspaceId', workspaceId);
  if (toolWindow) params.set('toolWindow', '1');
  const query = params.toString();
  return `${routeUrl.pathname}${query ? `?${query}` : ''}`;
}

function createWindow(
  options: { workspaceId?: string; route?: string; toolWindow?: boolean } = {},
): BrowserWindow {
  const isToolWindow = options.toolWindow === true;
  const createdWindow = new BrowserWindow({
    width: isToolWindow ? 1200 : 1400,
    height: isToolWindow ? 820 : 900,
    minWidth: isToolWindow ? 720 : 1024,
    minHeight: isToolWindow ? 520 : 700,
    title: app.getName(),
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    backgroundColor: '#0b1020',
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  if (!mainWindow) {
    mainWindow = createdWindow;
  }

  createdWindow.on('enter-full-screen', () => sendWindowChromeState(createdWindow));
  createdWindow.on('leave-full-screen', () => sendWindowChromeState(createdWindow));

  // Content Security Policy — relaxed in dev for Vite HMR
  if (!rendererCspRegistered) {
    rendererCspRegistered = true;
    const isDev = !!process.env.ELECTRON_RENDERER_URL;
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType !== 'mainFrame' || !isAnvilRendererDocument(details.url)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const csp = isDev
        ? "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data:; " +
          "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*; " +
          'frame-src https://embed.diagrams.net http://127.0.0.1:* http://localhost:*; ' +
          "worker-src 'self' blob:"
        : "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data:; " +
          "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*; " +
          'frame-src https://embed.diagrams.net http://127.0.0.1:* http://localhost:*';

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      });
    });
  }

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    if (options.workspaceId || options.route) {
      rendererUrl.hash = getWindowHash(
        options.route ?? '/repos',
        options.workspaceId,
        options.toolWindow,
      );
    }
    createdWindow.loadURL(rendererUrl.toString());
  } else {
    const loadOptions =
      options.workspaceId || options.route
        ? {
            hash: getWindowHash(options.route ?? '/repos', options.workspaceId, options.toolWindow),
          }
        : undefined;
    createdWindow.loadFile(path.join(__dirname, '../renderer/index.html'), loadOptions);
  }

  createdWindow.webContents.on('did-finish-load', () => {
    if (createdWindow === mainWindow) {
      deliverPendingLaunchIntent(createdWindow);
    }
    sendWindowChromeState(createdWindow);
  });

  createdWindow.on('closed', () => {
    if (mainWindow === createdWindow) {
      mainWindow = BrowserWindow.getAllWindows().find((win) => win !== createdWindow) ?? null;
    }
  });

  return createdWindow;
}

if (!gotSingleInstanceLock) {
  const userDataPath = app.getPath('userData');
  const devHint = process.env.ELECTRON_RENDERER_URL
    ? ` Quit the running ${brand.appName} instance before running pnpm dev.`
    : '';
  console.error(
    `[Startup] Another ${brand.appName} instance is already running for ${userDataPath}.${devHint}`,
  );
  app.quit();
} else {
  if (!daemonMode) {
    app.on('second-instance', (_event, argv) => {
      const launchUrl = extractLaunchUrlFromArgv(argv);
      if (launchUrl) handleIncomingLaunchUrl(launchUrl);

      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });

    app.on('open-url', (event, rawUrl) => {
      event.preventDefault();
      handleIncomingLaunchUrl(rawUrl);
    });
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId(brand.appId);
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(getAppIconPath());
  }
  initDatabase(brand.defaultTheme);
  initializeAutomationRuntime();

  if (daemonMode) {
    app.dock?.hide();
    return;
  }

  initializeStatusBar(brand);
  initializeAppUpdater();

  registerSettingsHandlers();
  registerMobileCompanionHandlers();
  registerCodexRegistryHandlers();
  registerCodexUsageHandlers();
  registerAnvilCloudHandlers();
  registerDiagnosticsHandlers();
  registerRepoHandlers();
  registerChatHandlers();
  registerOnboardHandlers();
  registerWorkItemsHandlers();
  registerDocsHandlers();
  registerBaHandlers();
  registerSecurityHandlers();
  registerPentestHandlers();
  registerCodeReviewHandlers();
  registerDiagramFileHandlers();
  registerWorkspaceHandlers({
    openWorkspaceWindow: (workspaceId) => {
      const win = createWindow({ workspaceId });
      win.show();
      win.focus();
    },
  });
  registerWorkspaceNotesHandlers();
  registerWorkspaceScaffoldHandlers();
  registerLaunchHandlers();
  registerTerminalHandlers();
  registerGovernanceHandlers();
  registerDbInsightsHandlers();
  registerAutomationHandlers();
  registerWorkflowHandlers();
  registerAgentRunHandlers();
  registerDesignHandlers();
  registerAdrHandlers();
  registerBrowserHandlers();
  registerSimulatorPreviewHandlers();
  registerArgentHandlers();
  registerEditorHandlers();
  registerGitHandlers();
  registerCicdHandlers();
  registerComplianceHandlers();
  registerLifecycleHandlers();
  registerRunHandlers();
  registerDependencyHandlers();
  registerVoiceHandlers(mainWindow!);
  void syncMobileCompanionServer().catch((err) => {
    console.error('[Mobile Companion] Failed to start server:', err);
  });
  handleOrphanedBaSessions();
  handleStaleIndexingRepos();

  // Register Repobase MCP with Codex (background, non-blocking)
  ensureRepobaseMcp().catch(() => {});
  app.setAsDefaultProtocolClient(PRIMARY_PROTOCOL);
  app.setAsDefaultProtocolClient(LEGACY_PROTOCOL);

  ipcMain.handle('brand:get', () => brand);
  ipcMain.handle('app-window:get-version', () => app.getVersion());
  ipcMain.handle('app-window:open-tool-window', (_event, route: string, workspaceId?: string) => {
    if (!route.startsWith('/') || route.startsWith('//')) {
      throw new Error('Tool routes must be internal application paths');
    }
    const win = createWindow({ route, workspaceId, toolWindow: true });
    win.show();
    win.focus();
  });
  ipcMain.handle('app-window:get-chrome-state', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return getWindowChromeState(win ?? mainWindow);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  shutdownAutomationRuntime();
  cleanupChatSessions();
  cleanupBaSessions();
  cleanupDiagramServices();
  cleanupTerminals();
  cleanupBrowser();
  cleanupSimulatorPreview();
  void stopMobileCompanionServer();
  void cleanupEmbeddedEditor();
  cleanupPentest();
  cleanupRunProcesses();
  cleanupStatusBar();
});
