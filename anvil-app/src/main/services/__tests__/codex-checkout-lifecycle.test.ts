import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ validate: vi.fn(), spawn: vi.fn() }));
vi.mock('../thread-checkout.service.js', () => ({ validateThreadCheckouts: mocks.validate }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/anvil' },
  BrowserWindow: { getAllWindows: () => [] },
}));
import { hasActiveThreadSession, startSession } from '../codex-session.service.js';

describe('thread session startup', () => {
  it('rejects a second start while checkout validation is pending, and releases the guard on failure', async () => {
    let rejectValidation!: (reason: Error) => void;
    mocks.validate.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectValidation = reject;
        }),
    );
    const first = startSession(['/checkout'], ['repo'], 'coder', { threadId: 'thread' });
    expect(hasActiveThreadSession('thread')).toBe(true);
    await expect(
      startSession(['/checkout'], ['repo'], 'coder', { threadId: 'thread' }),
    ).rejects.toThrow('already has an active session');
    const failure = expect(first).rejects.toThrow('Checkout missing');
    rejectValidation(new Error('Checkout missing'));
    await failure;
    expect(hasActiveThreadSession('thread')).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
