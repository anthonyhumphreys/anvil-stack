import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../settings.service.js', () => ({ getSettings: () => ({}) }));
import { executeMeshCommand } from '../mesh-command.service';

const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

describe('Mesh command execution', () => {
  it('records full-access exit status and stops a timed-out process', async () => {
    expect(
      await executeMeshCommand({
        argv: ['sh', '-c', 'echo full-access; exit 3'],
        cwd: '/tmp',
        env,
        mode: 'full-access',
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ exitCode: 3, timedOut: false, log: 'full-access\n' });
    expect(
      await executeMeshCommand({
        argv: ['sh', '-c', 'sleep 10'],
        cwd: '/tmp',
        env,
        mode: 'full-access',
        timeoutMs: 30,
      }),
    ).toMatchObject({ exitCode: null, timedOut: true });
  });

  // Run against the installed Codex binary locally; CI does not install it.
  it.runIf(process.env.ANVIL_RUN_SANDBOX_TESTS === '1')(
    'enforces workspace and read-only boundaries without a model turn',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-command-')));
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-outside-')));
      try {
        const local = join(root, 'allowed');
        const forbidden = join(outside, 'denied');
        const execute = (mode: 'workspace-auto' | 'read-only', path: string) =>
          executeMeshCommand({
            argv: ['sh', '-c', `printf sandbox > '${path}'`],
            cwd: root,
            env,
            mode,
            timeoutMs: 5_000,
          });
        expect((await execute('workspace-auto', local)).exitCode).toBe(0);
        expect(existsSync(local)).toBe(true);
        expect((await execute('workspace-auto', forbidden)).exitCode).not.toBe(0);
        expect(existsSync(forbidden)).toBe(false);
        const readOnly = join(root, 'read-only-denied');
        expect((await execute('read-only', readOnly)).exitCode).not.toBe(0);
        expect(existsSync(readOnly)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});
