import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import type { Brand } from '../../shared/branding.js';
import {
  interruptTurn,
  listActiveCodexSessions,
  listPendingApprovalRequests,
  resolveApproval,
} from './codex-session.service.js';
import {
  getMobileCompanionStatus,
  listMobileQuickActions,
  startMobileWorkflow,
} from './mobile-companion.service.js';
import { onCompanionEvent } from './companion-events.service.js';
import { getSettings } from './settings.service.js';
import { getWorkspace } from './workspace.service.js';
import { initializeAppUpdater } from './app-updater.service.js';

let tray: Tray | null = null;
let unsubscribeCompanionEvents: (() => void) | null = null;
let statusBrand: Pick<Brand, 'appName' | 'id'> = { appName: 'Anvil', id: 'anvil' };

export function initializeStatusBar(brand: Pick<Brand, 'appName' | 'id'>): void {
  if (process.platform !== 'darwin' || tray) return;
  statusBrand = brand;
  initializeAppUpdater();

  const image = nativeImage.createFromPath(getStatusIconPath()).resize({ width: 18, height: 18 });
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(statusBrand.appName);
  tray.on('click', () => void rebuildStatusBarMenu());

  unsubscribeCompanionEvents = onCompanionEvent(() => {
    void rebuildStatusBarMenu();
  });
  void rebuildStatusBarMenu();
}

export function cleanupStatusBar(): void {
  unsubscribeCompanionEvents?.();
  unsubscribeCompanionEvents = null;
  tray?.destroy();
  tray = null;
}

async function rebuildStatusBarMenu(): Promise<void> {
  if (!tray) return;

  const approvals = listPendingApprovalRequests();
  const sessions = listActiveCodexSessions();
  const companion = await getMobileCompanionStatus();
  const activeWorkspace = getActiveWorkspaceName();

  tray.setTitle(approvals.length > 0 ? String(approvals.length) : '');

  const template: MenuItemConstructorOptions[] = [
    {
      label: `Open ${statusBrand.appName}`,
      click: focusDesktop,
    },
    {
      label: activeWorkspace ? `Workspace: ${activeWorkspace}` : 'Workspace: none',
      enabled: false,
    },
    {
      label: companion.enabled
        ? `Companion: ${companion.running ? 'running' : 'enabled'} on ${companion.port}`
        : 'Companion: off',
      enabled: false,
    },
    {
      label: 'Launch Workflow',
      submenu: listMobileQuickActions().map((action) => ({
        label: action.title,
        sublabel: action.subtitle,
        click: () => {
          void startMobileWorkflow({ actionId: action.id }).catch((err) => {
            console.error(`[StatusBar] Failed to launch ${action.id}:`, err);
          });
        },
      })),
    },
    { type: 'separator' },
    ...approvalItems(approvals),
    { type: 'separator' },
    ...sessionItems(sessions),
    { type: 'separator' },
    {
      label: `Quit ${statusBrand.appName}`,
      role: 'quit',
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function approvalItems(
  approvals: ReturnType<typeof listPendingApprovalRequests>,
): MenuItemConstructorOptions[] {
  if (approvals.length === 0) {
    return [{ label: 'No pending approvals', enabled: false }];
  }

  return approvals.flatMap((approval) => {
    const label =
      approval.kind === 'command'
        ? truncate(`Command: ${approval.command ?? 'requested'}`, 70)
        : truncate(`File change: ${approval.grantRoot ?? 'requested'}`, 70);
    return [
      { label, enabled: false },
      {
        label: 'Approve',
        click: () => resolveApproval(approval.sessionId, approval.requestId, 'accept'),
      },
      {
        label: 'Approve Session',
        click: () => resolveApproval(approval.sessionId, approval.requestId, 'acceptForSession'),
      },
      {
        label: 'Decline',
        click: () => resolveApproval(approval.sessionId, approval.requestId, 'decline'),
      },
    ];
  });
}

function sessionItems(
  sessions: ReturnType<typeof listActiveCodexSessions>,
): MenuItemConstructorOptions[] {
  if (sessions.length === 0) {
    return [{ label: 'No active Codex sessions', enabled: false }];
  }

  return sessions.flatMap((session) => [
    {
      label: truncate(`${session.personaId}: ${session.status}`, 70),
      enabled: false,
    },
    {
      label: 'Interrupt Session',
      enabled: session.status === 'busy',
      click: () => interruptTurn(session.id),
    },
  ]);
}

function focusDesktop(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function getActiveWorkspaceName(): string | null {
  const activeWorkspaceId = getSettings().activeWorkspaceId;
  if (!activeWorkspaceId) return null;
  try {
    return getWorkspace(activeWorkspaceId).name;
  } catch {
    return null;
  }
}

function getStatusIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'anvil.png')
    : path.join(process.cwd(), 'resources', 'anvil.iconset', 'icon_32x32.png');
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
