import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  settings: {
    workItemProvider: 'github',
    githubOwner: 'acme',
    githubRepo: 'widgets',
    githubToken: 'token',
  },
  getItem: vi.fn(),
  listItems: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, handler),
  },
}));
vi.mock('../settings.service.js', () => ({ getSettings: () => mocks.settings }));
vi.mock('../workitem-context.service.js', () => ({ getWorkItemSettings: () => mocks.settings }));
vi.mock('../workitem-provider.js', () => ({
  getActiveProvider: () => ({ getItem: mocks.getItem, listItems: mocks.listItems }),
}));
vi.mock('../../db/database.js', () => ({ getDb: vi.fn() }));
vi.mock('../llm.service.js', () => ({ callLlm: vi.fn() }));
vi.mock('../../utils/prompt-templates.js', () => ({ loadPromptTemplate: vi.fn() }));
import { registerWorkItemsHandlers } from '../../ipc/workitems.ipc.js';
registerWorkItemsHandlers();
beforeEach(() => {
  mocks.getItem
    .mockReset()
    .mockResolvedValue({ id: 'https://github.com/acme/widgets/issues/42', title: 'Fix', tags: [] });
  mocks.listItems.mockReset().mockResolvedValue([]);
});
it.each(['42', '#42', 'https://github.com/Acme/Widgets/issues/42'])(
  'normalizes GitHub search %s to scoped canonical identity',
  async (query) => {
    const result = await mocks.handlers.get('workitems:search')!(null, query);
    expect(mocks.getItem).toHaveBeenCalledWith('https://github.com/acme/widgets/issues/42');
    expect(result).toHaveLength(1);
  },
);
it('never directly resolves another repository from the selected connection', async () => {
  await mocks.handlers.get('workitems:search')!(null, 'https://github.com/other/widgets/issues/42');
  expect(mocks.getItem).not.toHaveBeenCalled();
});
