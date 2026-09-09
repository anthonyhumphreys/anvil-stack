import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

async function builderArguments(args: string[]) {
  process.argv = [process.execPath, 'scripts/dist.mjs', '--brand=anvil', ...args];
  vi.stubEnv('ANVIL_PACKAGE_MANAGER', 'pnpm');
  const script = '../../../../scripts/dist.mjs';
  await import(script);
  const call = vi
    .mocked(spawnSync)
    .mock.calls.find(
      (call) =>
        Array.isArray(call[1]) && call[1].some((arg) => arg.endsWith('electron-builder/cli.js')),
    );
  expect(call).toBeDefined();
  return call![1] as string[];
}

describe('distribution config overrides', () => {
  it('preserves normal Anvil branding', async () => {
    const args = await builderArguments(['--mac', 'dmg', '--publish', 'never']);
    expect(args.filter((arg) => arg.startsWith('-c.productName='))).toEqual([
      '-c.productName=Anvil',
    ]);
    expect(args.filter((arg) => arg.startsWith('-c.appId='))).toEqual([
      '-c.appId=dev.anthonyhumphreys.anvil',
    ]);
  });

  it('passes a single scalar name and app ID for candidate previews', async () => {
    const args = await builderArguments([
      '--mac',
      'dmg',
      'zip',
      '--arm64',
      '--publish',
      'never',
      '-c.productName=Anvil Preview PR 87 abcdef12',
      '-c.appId=dev.anvil.preview.pr87',
    ]);
    expect(args.filter((arg) => arg.startsWith('-c.productName='))).toEqual([
      '-c.productName=Anvil Preview PR 87 abcdef12',
    ]);
    expect(args.filter((arg) => arg.startsWith('-c.appId='))).toEqual([
      '-c.appId=dev.anvil.preview.pr87',
    ]);
    expect(args).toContain('-c.copyright=AnthonyHumphreys.dev');
  });

  it('also avoids default duplication for separate config values', async () => {
    const args = await builderArguments(['--mac', 'zip', '-c.productName', 'Anvil Preview']);
    expect(args).not.toContain('-c.productName=Anvil');
    expect(args).toContain('-c.productName');
    expect(args).toContain('Anvil Preview');
  });
});
