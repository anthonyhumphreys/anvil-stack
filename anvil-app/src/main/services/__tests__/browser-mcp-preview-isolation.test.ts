import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appPath: vi.fn(() => '/preview'),
}));
vi.mock('../../../shared/preview-build.js', () => ({ previewBuild: { buildId: 'preview' } }));
vi.mock('electron', () => ({
  app: { on: vi.fn(), getAppPath: state.appPath },
  webContents: {},
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(name, handler),
  },
}));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('../workspace.service.js', () => ({ getWorkspace: vi.fn() }));
vi.mock('../browser.service.js', () => ({
  listTargets: vi.fn(),
  addManualTarget: vi.fn(),
  startBridge: vi.fn(),
  stopBridge: vi.fn(),
  getBridgeStatus: vi.fn(),
  attachDebugger: vi.fn(),
  detachDebugger: vi.fn(),
  setBrowserScope: vi.fn(),
  cleanupBrowser: vi.fn(),
}));

import { registerBrowserHandlers } from '../../ipc/browser.ipc.js';

beforeEach(() => {
  state.handlers.clear();
  vi.clearAllMocks();
});

describe('preview browser MCP isolation', () => {
  it('does not inspect, remove or replace shared Codex registrations at startup', async () => {
    registerBrowserHandlers();
    await Promise.resolve();
    expect(execFile).not.toHaveBeenCalled();
    expect(state.appPath).not.toHaveBeenCalled();
    expect(state.handlers.has('browser:start-bridge')).toBe(true);
  });

  it('rejects explicit MCP registration without launching the shared Codex CLI', async () => {
    registerBrowserHandlers();
    await expect(state.handlers.get('browser:register-mcp')!()).resolves.toEqual({
      success: false,
      error: 'Shared Codex MCP registration is disabled in candidate previews.',
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(state.appPath).not.toHaveBeenCalled();
  });
});
