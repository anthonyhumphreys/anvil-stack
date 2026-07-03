import { networkInterfaces } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
}));

vi.mock('node:os', () => ({
  networkInterfaces: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../db/database.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../settings.service.js', () => ({
  getSettings: () => ({}),
}));

vi.mock('../workspace.service.js', () => ({
  getWorkspace: vi.fn(),
  listWorkspaces: vi.fn(() => []),
}));

vi.mock('../companion-events.service.js', () => ({
  emitCompanionEvent: vi.fn(),
  onCompanionEvent: vi.fn(() => () => undefined),
}));

vi.mock('../codex-session.service.js', () => ({
  getCodexSession: vi.fn(),
  interruptTurn: vi.fn(),
  listActiveCodexSessions: vi.fn(() => []),
  listPendingApprovalRequests: vi.fn(() => []),
  resolveApproval: vi.fn(),
  sendMessage: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock('../chat-persistence.service.js', () => ({
  createChatSession: vi.fn(),
  createChatThread: vi.fn(),
  deleteChatThread: vi.fn(),
  getChatThread: vi.fn(),
  loadChatHistory: vi.fn(() => []),
  saveChatEntry: vi.fn(),
}));

import { getMobileCompanionStatus } from '../mobile-companion.service.js';

const mockedNetworkInterfaces = vi.mocked(networkInterfaces);

function mockCompanionSettings(): void {
  getDbMock.mockReturnValue({
    prepare: vi.fn((sql: string) => ({
      run: vi.fn(),
      get: vi.fn(() => {
        if (sql.includes('COUNT(*)')) return { count: 0 };
        return {
          enabled: 1,
          host: '0.0.0.0',
          port: 47631,
          instance_id: 'instance-1',
        };
      }),
      all: vi.fn(() => []),
    })),
  });
}

describe('mobile companion advertised base URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanionSettings();
  });

  it('prefers a LAN address over Tailscale when both are available', async () => {
    mockedNetworkInterfaces.mockReturnValue({
      en0: [
        {
          address: '192.168.1.148',
          family: 'IPv4',
          internal: false,
          netmask: '255.255.255.0',
          mac: '00:00:00:00:00:00',
          cidr: '192.168.1.148/24',
        },
      ],
      utun10: [
        {
          address: '100.73.163.103',
          family: 'IPv4',
          internal: false,
          netmask: '255.255.255.255',
          mac: '00:00:00:00:00:00',
          cidr: '100.73.163.103/32',
        },
      ],
    });

    await expect(getMobileCompanionStatus()).resolves.toMatchObject({
      baseUrl: 'http://192.168.1.148:47631',
    });
  });
});
