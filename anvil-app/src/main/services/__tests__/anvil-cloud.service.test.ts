import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, existsSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

import {
  getAnvilCloudWorkbenchSnapshot,
  runAnvilCloudCommand,
} from '../anvil-cloud.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(true);
});

describe('anvil cloud service', () => {
  it('detects the workspace CLI and exposes fixed commands', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, '0.1.0\n', '');
    });

    const snapshot = await getAnvilCloudWorkbenchSnapshot();

    expect(snapshot.status.available).toBe(true);
    expect(snapshot.status.source).toBe('workspace');
    expect(snapshot.commands.map((command) => command.id)).toContain('check');
    expect(snapshot.commands.map((command) => command.id)).toContain('lens');
  });

  it('runs a mapped JSON command without shelling through renderer input', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, '{"ok":true,"diagnostics":[]}\n', '');
    });

    const result = await runAnvilCloudCommand('check', '/tmp/cell');

    expect(result.ok).toBe(true);
    expect(result.parsed).toEqual({ ok: true, diagnostics: [] });
    expect(execFileMock).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['check', '--json']),
      expect.objectContaining({ cwd: '/tmp/cell', timeout: 120_000 }),
      expect.any(Function),
    );
  });

  it('returns stdout and stderr when the CLI fails', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const error = Object.assign(new Error('exit 3'), {
        code: 3,
        stdout: '{"ok":false,"diagnostics":[{"code":"NOPE"}]}\n',
        stderr: 'failed\n',
      });
      callback(error, error.stdout, error.stderr);
    });

    const result = await runAnvilCloudCommand('check', '/tmp/cell');

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('failed\n');
    expect(result.parsed).toEqual({ ok: false, diagnostics: [{ code: 'NOPE' }] });
  });
});
