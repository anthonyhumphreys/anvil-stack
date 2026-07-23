import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  notificationSupported: true,
  notifications: [] as Array<{
    options: Record<string, unknown>;
    handlers: Map<string, (...args: unknown[]) => void>;
    show: ReturnType<typeof vi.fn>;
  }>,
  windows: [] as Array<{
    isFocused: ReturnType<typeof vi.fn>;
    isMinimized: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    webContents: { send: ReturnType<typeof vi.fn> };
  }>,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => electron.windows,
  },
  Notification: class MockNotification {
    static isSupported() {
      return electron.notificationSupported;
    }

    private readonly record: (typeof electron.notifications)[number];

    constructor(options: Record<string, unknown>) {
      this.record = { options, handlers: new Map(), show: vi.fn() };
      electron.notifications.push(this.record);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      this.record.handlers.set(event, handler);
      return this;
    }

    show() {
      this.record.show();
    }
  },
}));

vi.mock('../chat-persistence.service.js', () => ({
  getChatThread: () => ({ title: 'Fix the workspace switch' }),
}));

import { notifyChatActivity } from '../notification.service.js';

function createWindow(focused = false) {
  return {
    isFocused: vi.fn(() => focused),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
}

describe('chat activity notifications', () => {
  beforeEach(() => {
    electron.notificationSupported = true;
    electron.notifications.length = 0;
    electron.windows.length = 0;
  });

  it('stays quiet while an Anvil window is focused', () => {
    electron.windows.push(createWindow(true));

    notifyChatActivity({
      kind: 'complete',
      target: { workspaceId: 'workspace-1', threadId: 'thread-1', personaId: 'coder' },
    });

    expect(electron.notifications).toHaveLength(0);
  });

  it('still surfaces blocking requests while another Anvil surface is focused', () => {
    electron.windows.push(createWindow(true));

    notifyChatActivity({
      kind: 'approval',
      target: { workspaceId: 'workspace-1', threadId: 'thread-1', personaId: 'coder' },
    });

    expect(electron.notifications).toHaveLength(1);
    expect(electron.notifications[0].options).toMatchObject({
      title: 'Anvil needs your approval',
    });
  });

  it('shows thread-specific copy while Anvil is in the background', () => {
    electron.windows.push(createWindow(false));

    notifyChatActivity({
      kind: 'input',
      target: { workspaceId: 'workspace-1', threadId: 'thread-1', personaId: 'coder' },
    });

    expect(electron.notifications).toHaveLength(1);
    expect(electron.notifications[0].options).toMatchObject({
      title: 'Anvil needs your input',
      body: 'Fix the workspace switch has a question for you.',
    });
    expect(electron.notifications[0].show).toHaveBeenCalledOnce();
  });

  it.each(['click', 'action'])('%s opens the exact workspace thread', (eventName) => {
    const win = createWindow(false);
    electron.windows.push(win);
    const target = { workspaceId: 'workspace-1', threadId: 'thread-1', personaId: 'coder' };

    notifyChatActivity({ kind: 'approval', target });
    const notification = electron.notifications[0];
    const handler = notification.handlers.get(eventName);
    expect(handler).toBeDefined();
    if (eventName === 'action') handler?.({}, 0);
    else handler?.();

    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith('app-window:navigate-to-chat', target);
  });
});
