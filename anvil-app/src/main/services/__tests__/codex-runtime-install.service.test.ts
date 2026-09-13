import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ archiveVersion: '0.154.0', extracted: 0, executable: 'codex' }));
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('Use isolated runtime root');
    },
  },
}));
vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    void (async () => {
      if (file === 'tar') {
        state.extracted++;
        const destination = args[args.indexOf('-C') + 1];
        await mkdir(join(destination, 'bin'), { recursive: true });
        await writeFile(join(destination, 'bin', state.executable), state.archiveVersion);
        await writeFile(join(destination, 'bin', 'companion'), 'retained companion');
        return '';
      }
      if (args[0] === '--version') return `codex-cli ${await readFile(file, 'utf8')}`;
      throw new Error('No system installation');
    })().then(
      (stdout) => callback(null, stdout, ''),
      (error) => callback(error, '', ''),
    );
  },
}));

import {
  getCodexRuntimeStatus,
  getCodexRuntimeTarget,
  getManagedCodexExecutablePath,
  installCodexRuntime,
  resolveCodexRuntime,
} from '../codex-runtime.service.js';

const fixture = Buffer.from('verified fixture archive');
let root: string;
const target = getCodexRuntimeTarget()!;
const originalDigest = target.sha256;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'anvil-runtime-test-'));
  vi.stubEnv('ANVIL_CODEX_RUNTIME_DIR', root);
  state.archiveVersion = '0.154.0';
  state.extracted = 0;
  state.executable = target.executable;
  // The fixture replaces the release archive, while exercising the real hashing and disk writes.
  target.sha256 = createHash('sha256').update(fixture).digest('hex');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(fixture)),
  );
});

afterEach(async () => {
  target.sha256 = originalDigest;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function existing(version = '0.154.0') {
  await mkdir(join(root, '0.154.0', 'bin'), { recursive: true });
  await writeFile(getManagedCodexExecutablePath(root), version);
  await writeFile(join(root, '0.154.0', 'previous-marker'), 'old installation');
}

describe('managed Codex installation', () => {
  it('installs once for concurrent requests and keeps the packaged companion files', async () => {
    const [first, second] = await Promise.all([installCodexRuntime(), installCodexRuntime()]);
    expect(first).toMatchObject({ ready: true, version: '0.154.0', source: 'managed' });
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, '0.154.0', 'bin', 'companion'), 'utf8')).toBe(
      'retained companion',
    );
    expect(await readdir(root)).toEqual(['0.154.0']);
    await expect(resolveCodexRuntime()).resolves.toBe(getManagedCodexExecutablePath(root));
  });

  it('rejects checksum mismatch before extracting or replacing a working installation', async () => {
    await existing();
    vi.mocked(fetch).mockResolvedValue(new Response('corrupt archive'));
    await expect(installCodexRuntime()).resolves.toMatchObject({
      ready: true,
      error: expect.stringContaining('checksum'),
    });
    expect(state.extracted).toBe(0);
    expect(await readFile(join(root, '0.154.0', 'previous-marker'), 'utf8')).toBe(
      'old installation',
    );
    expect(await readdir(root)).toEqual(['0.154.0']);
  });

  it('restores the previous installation if the new executable has the wrong version', async () => {
    await existing();
    state.archiveVersion = '0.151.0';
    await expect(installCodexRuntime()).resolves.toMatchObject({
      ready: true,
      version: '0.154.0',
      error: expect.stringContaining('exactly version'),
    });
    expect(await readFile(join(root, '0.154.0', 'previous-marker'), 'utf8')).toBe(
      'old installation',
    );
    expect(await readdir(root)).toEqual(['0.154.0']);
  });

  it('does not silently install while checking or resolving a missing engine', async () => {
    await expect(getCodexRuntimeStatus()).resolves.toMatchObject({
      installed: false,
      ready: false,
    });
    await expect(resolveCodexRuntime()).rejects.toThrow('Anvil Settings');
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('reports a failed download and cleans up staging without touching the prior version', async () => {
    await existing();
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await expect(installCodexRuntime()).resolves.toMatchObject({ ready: true, error: 'offline' });
    expect(await readdir(root)).toEqual(['0.154.0']);
    expect(state.extracted).toBe(0);
  });
});
