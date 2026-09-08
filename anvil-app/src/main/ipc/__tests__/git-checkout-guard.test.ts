import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  active: vi.fn(),
  create: vi.fn(),
  switchBranch: vi.fn(),
  pr: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
  },
}));
vi.mock('../../services/codex-session.service.js', () => ({
  hasActiveSessionAtPath: mocks.active,
}));
vi.mock('../../db/database.js', () => ({
  getDb: () => ({
    prepare: () => ({ get: () => ({ id: 'repo', name: 'Repo', path: '/checkout' }) }),
  }),
}));
vi.mock('../../services/git.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/git.service.js')>()),
  createBranch: mocks.create,
  switchBranch: mocks.switchBranch,
  createPullRequestFromChanges: mocks.pr,
}));
import { registerGitHandlers } from '../git.ipc.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  registerGitHandlers();
});
describe('branch changes in shared checkouts', () => {
  it.each(['git:create-branch', 'git:switch-branch'])(
    'blocks %s while another session uses the checkout',
    (channel) => {
      mocks.active.mockReturnValue(true);
      expect(() => mocks.handlers.get(channel)!(null, 'repo', 'feature/new')).toThrow(
        'chat session is using',
      );
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.switchBranch).not.toHaveBeenCalled();
    },
  );
  it('allows a branch switch after the checkout is released', () => {
    mocks.active.mockReturnValue(false);
    mocks.handlers.get('git:switch-branch')!(null, 'repo', 'feature/new');
    expect(mocks.switchBranch).toHaveBeenCalledWith('/checkout', 'feature/new');
  });
});
