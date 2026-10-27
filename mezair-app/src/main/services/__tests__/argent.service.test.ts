import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, existsSyncMock, getSimulatorPreviewStatusMock, startSimulatorPreviewMock } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    existsSyncMock: vi.fn(),
    getSimulatorPreviewStatusMock: vi.fn(),
    startSimulatorPreviewMock: vi.fn(),
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

vi.mock('../simulator-preview.service.js', () => ({
  getSimulatorPreviewStatus: getSimulatorPreviewStatusMock,
  startSimulatorPreview: startSimulatorPreviewMock,
}));

import {
  getArgentWorkbenchSnapshot,
  runArgentCommand,
  startArgentSimulatorPreview,
} from '../argent.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(true);
  getSimulatorPreviewStatusMock.mockReturnValue({
    running: true,
    url: 'http://localhost:3200',
  });
  startSimulatorPreviewMock.mockReturnValue({
    running: true,
    url: 'http://localhost:3200',
    cwd: '/workspace/mobile',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('packager-status:running'),
    }),
  );
});

describe('argent service', () => {
  it('detects ready CLI, MCP, device, Metro, and prompt state', async () => {
    execFileMock.mockImplementation((cmd, args, _opts, callback) => {
      if (cmd === 'which' && args[0] === 'argent') {
        callback(null, '/usr/local/bin/argent\n', '');
        return;
      }
      if (cmd === 'argent' && args[0] === '--version') {
        callback(null, '1.2.3\n', '');
        return;
      }
      if (cmd === 'codex' && args.join(' ') === 'mcp list') {
        callback(null, 'argent  @swmansion/argent\n', '');
        return;
      }
      if (cmd === 'xcrun') {
        callback(null, '== Devices ==\n    iPhone 16 Pro (ABC-123) (Booted)\n', '');
        return;
      }
      if (cmd === 'adb') {
        callback(null, 'List of devices attached\nemulator-5554\tdevice\n', '');
        return;
      }
      callback(new Error(`unexpected command ${cmd} ${args.join(' ')}`), '', '');
    });

    const snapshot = await getArgentWorkbenchSnapshot();

    expect(snapshot.cli).toMatchObject({
      installed: true,
      version: '1.2.3',
      path: '/usr/local/bin/argent',
    });
    expect(snapshot.mcp.registered).toBe(true);
    expect(snapshot.mobileProjectExists).toBe(true);
    expect(snapshot.ios.available || snapshot.android.available).toBe(true);
    expect(snapshot.metro.running).toBe(true);
    expect(snapshot.prompts.map((prompt) => prompt.id)).toContain('profile-slowdown');
    expect(snapshot.commands.map((command) => command.id)).toContain('init-mcp');
    expect(snapshot.checks.find((check) => check.id === 'argent-cli')?.level).toBe('pass');
  });

  it('runs the Argent init command from the Expo companion root', async () => {
    execFileMock.mockImplementation((cmd, args, opts, callback) => {
      callback(null, `ran ${cmd} ${args.join(' ')} in ${opts.cwd}\n`, '');
    });

    const result = await runArgentCommand('init-mcp');

    expect(result.ok).toBe(true);
    expect(result.command).toBe('npx @swmansion/argent init');
    expect(result.cwd.endsWith('/mobile')).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      'npx',
      ['@swmansion/argent', 'init'],
      expect.objectContaining({ cwd: expect.stringMatching(/mobile$/), timeout: 180_000 }),
      expect.any(Function),
    );
  });

  it('returns stdout and stderr when an Argent command fails', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const error = Object.assign(new Error('exit 1'), {
        code: 1,
        stdout: 'partial stdout\n',
        stderr: 'bad news\n',
      });
      callback(error, error.stdout, error.stderr);
    });

    const result = await runArgentCommand('flags');

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('partial stdout\n');
    expect(result.stderr).toBe('bad news\n');
  });

  it('starts the simulator preview from the mobile workspace', () => {
    const result = startArgentSimulatorPreview();

    expect(result.running).toBe(true);
    expect(startSimulatorPreviewMock).toHaveBeenCalledWith({
      cwd: expect.stringMatching(/mobile$/),
    });
  });
});
