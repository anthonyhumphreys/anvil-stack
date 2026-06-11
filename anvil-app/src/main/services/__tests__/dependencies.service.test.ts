import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import {
  auditLicenses,
  exportSbom,
  listDependencies,
  runDependencyAudit,
} from '../dependencies.service.js';

describe('dependencies.service', () => {
  let repoPath: string;

  beforeEach(() => {
    spawnMock.mockReset();
    repoPath = mkdtempSync(join(tmpdir(), 'anvil-deps-'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('lists JavaScript dependencies with manager, license, and version-based deprecation data', async () => {
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({
        dependencies: {
          'core-js': '^2.6.12',
          request: '^2.88.2',
        },
      }),
    );
    writeFileSync(join(repoPath, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    mkdirSync(join(repoPath, 'node_modules', 'core-js'), { recursive: true });
    writeFileSync(join(repoPath, 'node_modules', 'core-js', 'package.json'), '{"license":"MIT"}');

    const dependencies = await listDependencies(repoPath);

    expect(dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'core-js',
          manager: 'pnpm',
          deprecated: true,
          license: 'MIT',
          alternative: 'core-js v3',
        }),
        expect.objectContaining({
          name: 'request',
          deprecated: true,
          alternative: 'node-fetch or axios',
        }),
      ]),
    );
  });

  it('returns an empty dependency list for malformed package.json instead of throwing', async () => {
    writeFileSync(join(repoPath, 'package.json'), '{ nope');

    await expect(listDependencies(repoPath)).resolves.toEqual([]);
  });

  it('lists NuGet and Python dependencies when no package.json exists', async () => {
    writeFileSync(
      join(repoPath, 'App.csproj'),
      '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup></Project>',
    );
    writeFileSync(join(repoPath, 'requirements.txt'), 'flask==3.0.0\n# comment\npytest>=8\n');

    const dependencies = await listDependencies(repoPath);

    expect(dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Newtonsoft.Json', version: '13.0.3', manager: 'nuget' }),
        expect.objectContaining({ name: 'flask', version: '3.0.0', manager: 'python' }),
        expect.objectContaining({ name: 'pytest', version: '8', manager: 'python' }),
      ]),
    );
  });

  it('treats npm audit exit code 1 as successful audit output', async () => {
    mockSpawnClose({ stdout: '{"vulnerabilities":1}', code: 1 });

    const result = await runDependencyAudit(repoPath, 'npm');

    expect(result).toMatchObject({
      manager: 'npm',
      exitCode: 1,
      stdout: '{"vulnerabilities":1}',
      ok: true,
    });
  });

  it('rejects spawn failures and invalid managers', async () => {
    mockSpawnError(new Error('ENOENT'));

    await expect(runDependencyAudit(repoPath, 'pnpm')).rejects.toThrow('Failed to run pnpm');
    await expect(runDependencyAudit(repoPath, 'bogus' as never)).rejects.toThrow(
      'Unsupported dependency manager',
    );
  });

  it('generates license audits and SBOM exports', async () => {
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({
        dependencies: {
          react: '^19.0.0',
        },
      }),
    );

    const licenseAudit = await auditLicenses(repoPath);
    const cyclonedx = await exportSbom(repoPath, 'cyclonedx-json');
    const csv = await exportSbom(repoPath, 'csv');

    expect(licenseAudit).toMatchObject({ total: 1, unknown: 1 });
    expect(JSON.parse(cyclonedx)).toMatchObject({ bomFormat: 'CycloneDX' });
    expect(csv).toContain('manager,name,version,license,deprecated,alternative');
    expect(csv).toContain('"react"');
  });
});

function mockSpawnClose({
  stdout = '',
  stderr = '',
  code = 0,
}: {
  stdout?: string;
  stderr?: string;
  code?: number;
}) {
  spawnMock.mockReturnValueOnce(fakeProcess({ stdout, stderr, code }));
}

function mockSpawnError(error: Error) {
  spawnMock.mockReturnValueOnce(fakeProcess({ error }));
}

function fakeProcess({
  stdout = '',
  stderr = '',
  code,
  error,
}: {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: Error;
}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    if (error) proc.emit('error', error);
    else proc.emit('close', code);
  });
  return proc;
}
