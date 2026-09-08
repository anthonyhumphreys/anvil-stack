import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  guests: new Map<number, unknown>(),
  attach: vi.fn(),
  detach: vi.fn(),
  scope: vi.fn(),
  start: vi.fn(async () => 1234),
}));
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  webContents: { fromId: (id: number) => state.guests.get(id) },
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(name, fn),
  },
}));
vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    (args.at(-1) as (error: Error) => void)(new Error('not configured'));
  }),
}));
vi.mock('../workspace.service.js', () => ({
  getWorkspace: () => ({ repos: [{ path: '/repo' }] }),
}));
vi.mock('../browser.service.js', () => ({
  listTargets: vi.fn(),
  addManualTarget: vi.fn(),
  startBridge: state.start,
  stopBridge: vi.fn(),
  getBridgeStatus: vi.fn(),
  attachDebugger: state.attach,
  detachDebugger: state.detach,
  setBrowserScope: state.scope,
  cleanupBrowser: vi.fn(),
}));
import { registerBrowserHandlers } from '../../ipc/browser.ipc.js';
const sender = { id: 10 };
const guest = (host: number) => ({
  isDestroyed: () => false,
  getType: () => 'webview',
  hostWebContents: { id: host },
});
beforeEach(() => {
  state.handlers.clear();
  state.guests.clear();
  vi.clearAllMocks();
  registerBrowserHandlers();
  state.guests.set(1, guest(10));
  state.guests.set(2, guest(20));
});
describe('browser selection lifecycle', () => {
  it('reattaches an already-loaded page when starting the bridge', async () => {
    await state.handlers.get('browser:start-bridge')!({ sender }, 1, 'ws');
    expect(state.attach).toHaveBeenCalledWith(state.guests.get(1));
    expect(state.scope).toHaveBeenCalledWith({ workspaceId: 'ws', repoPaths: ['/repo'] });
  });
  it('rejects a page owned by another window before changing attachment', () => {
    expect(() => state.handlers.get('browser:attach-debugger')!({ sender }, 2, 'ws')).toThrow(
      'does not belong',
    );
    expect(state.attach).not.toHaveBeenCalled();
  });
  it('does not let an unmounting panel detach another panel in the same window', () => {
    state.guests.set(3, guest(10));
    state.handlers.get('browser:attach-debugger')!({ sender }, 3, 'ws');
    state.detach.mockClear();
    state.handlers.get('browser:detach-debugger')!({ sender }, 1);
    expect(state.detach).not.toHaveBeenCalled();
    state.handlers.get('browser:detach-debugger')!({ sender }, 3);
    expect(state.detach).toHaveBeenCalledTimes(1);
  });
});
