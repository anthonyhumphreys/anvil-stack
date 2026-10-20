import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, settings, provider, llm, db } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  settings: {
    current: {
      docsProvider: 'linear',
      activeWorkspaceId: 'workspace-a',
      activeWorkItemConnectionId: 'linear-a',
      linearApiKey: 'linear-key-a',
    },
  },
  provider: {
    listProjects: vi.fn(),
    listPages: vi.fn(),
    listChildren: vi.fn(),
    getPageContent: vi.fn(),
    checkStaleness: vi.fn(),
    createPage: vi.fn(),
    updatePage: vi.fn(),
  },
  llm: { call: vi.fn() },
  db: {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() =>
        sql.includes('SELECT name FROM repos')
          ? { name: 'Anvil' }
          : { overview: 'Overview', mermaid_diagram: '' },
      ),
      all: vi.fn(() => []),
    })),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
}));
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../../services/docs-provider.js', () => ({ getActiveDocsProvider: () => provider }));
vi.mock('../../services/llm.service.js', () => ({ callLlm: llm.call }));
vi.mock('../../services/settings.service.js', () => ({ getSettings: () => settings.current }));

import { registerDocsHandlers } from '../docs.ipc.js';

describe('docs IPC request scope', () => {
  beforeEach(() => {
    handlers.clear();
    settings.current = {
      docsProvider: 'linear',
      activeWorkspaceId: 'workspace-a',
      activeWorkItemConnectionId: 'linear-a',
      linearApiKey: 'linear-key-a',
    };
    provider.createPage.mockReset();
    provider.createPage.mockResolvedValue('https://linear.app/document/new');
    llm.call.mockReset();
    db.prepare.mockClear();
    registerDocsHandlers();
  });

  it('discards generated content if the active Linear account changes before publication', async () => {
    let release!: (content: string) => void;
    let started!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    llm.call.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
          started();
        }),
    );

    const context = {
      provider: 'linear' as const,
      workspaceId: 'workspace-a',
      connectionId: 'linear-a',
    };
    const create = handlers.get('docs:create')!;
    const pending = create(null, 'project-a', 'Guide', 'repo-a', context) as Promise<string>;
    await generationStarted;

    settings.current = {
      docsProvider: 'linear',
      activeWorkspaceId: 'workspace-a',
      activeWorkItemConnectionId: 'linear-b',
      linearApiKey: 'linear-key-b',
    };
    release('# Generated for account A');

    await expect(pending).rejects.toThrow('Active Linear connection changed');
    expect(provider.createPage).not.toHaveBeenCalled();
  });

  it('rejects a stale workspace before starting a request', async () => {
    const context = {
      provider: 'linear' as const,
      workspaceId: 'workspace-old',
      connectionId: 'linear-a',
    };
    await expect(
      (handlers.get('docs:list-projects')!)(null, context),
    ).rejects.toThrow('Active workspace changed');
    expect(provider.listProjects).not.toHaveBeenCalled();
  });
});
