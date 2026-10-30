import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DependencyRecord } from '../../../../shared/types.js';
import {
  classifyLicense,
  dependenciesSurfaceKind,
  digestDependencies,
  topRiskPackages,
  type DependenciesSurfaceData,
} from '../../../../shared/surfaces/kinds/dependencies.js';
import { validateJsonSchema } from '../../validate.js';
import { fakeCoreState, getSurface, resetFakeCore, testContext, textOf } from './data-fake-core.js';

const mocks = vi.hoisted(() => ({
  records: [] as DependencyRecord[],
  auditStdout: '',
  auditError: null as Error | null,
  provider: null as null | { createItem: (input: { title: string }) => Promise<{ id: string }> },
}));

vi.mock('../../core.js', async () => await import('./data-fake-core.js'));
vi.mock('../../../db/database.js', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (id: string) =>
        id === 'repo-1' ? { id, name: 'web-app', path: '/work/web-app' } : undefined,
    }),
  }),
}));
vi.mock('../../../services/dependencies.service.js', () => ({
  listDependencies: async () => mocks.records,
  runDependencyAudit: async (_path: string, manager: string) => {
    if (mocks.auditError) throw mocks.auditError;
    return { manager, command: 'x', exitCode: 1, stdout: mocks.auditStdout, stderr: '', ok: true };
  },
  auditLicenses: async () => ({
    generatedAt: '2026-01-02T00:00:00Z',
    total: mocks.records.length,
    unknown: 1,
    packages: mocks.records.map((record) => ({
      ...record,
      license: record.name === 'gpl-lib' ? 'GPL-3.0' : record.name === 'react' ? 'MIT' : 'UNKNOWN',
    })),
  }),
  exportSbom: async () =>
    JSON.stringify({ bomFormat: 'CycloneDX', components: [{ name: 'react' }, { name: 'lodash' }] }),
}));
vi.mock('../../../services/workitem-provider.js', () => ({
  getActiveProvider: () => mocks.provider,
}));
const keptArtifacts = vi.hoisted(() => [] as Array<{ title: string; content: string; storage?: string }>);
vi.mock('../../../services/chat-artifact.service.js', () => ({
  upsertChatArtifact: (input: { title: string; content: string; storage?: string }) => {
    keptArtifacts.push(input);
    return { ...input, id: 'artifact-sbom', version: 1, kind: 'data', relativePath: 'sbom.json' };
  },
}));
vi.mock('../artifact.js', () => ({ publishArtifactSurface: vi.fn() }));

const { dependenciesSurfaceHandler } = await import('../dependencies.js');
const { parseAuditOutput } = await import('../dependencies/audit-parse.js');
const { dependenciesSnapshot } = await import('../dependencies/snapshot.js');
const { resetKeyedSurfacesForTests } = await import('../data/keyed-surfaces.js');

const provider = dependenciesSurfaceHandler.toolProvider!;

const NPM_V2 = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: {
      name: 'lodash',
      severity: 'high',
      isDirect: true,
      via: [
        {
          source: 1065,
          name: 'lodash',
          title: 'Prototype Pollution',
          url: 'https://github.com/advisories/GHSA-p6mc',
          severity: 'high',
        },
      ],
      fixAvailable: { name: 'lodash', version: '4.17.21', isSemVerMajor: false },
    },
    'minimist-wrapper': {
      name: 'minimist-wrapper',
      severity: 'moderate',
      isDirect: false,
      via: ['minimist'],
      fixAvailable: true,
    },
  },
});

const PNPM_V1 = JSON.stringify({
  advisories: {
    '1065': {
      id: 1065,
      module_name: 'lodash',
      severity: 'critical',
      title: 'Prototype Pollution',
      patched_versions: '>=4.17.21',
      github_advisory_id: 'GHSA-p6mc',
      findings: [{ version: '4.17.20', paths: ['.>lodash'] }],
    },
  },
  metadata: {},
});

const YARN_BERRY = [
  JSON.stringify({
    value: 'lodash',
    children: {
      ID: 1065,
      Issue: 'Prototype Pollution',
      Severity: 'high',
      'Tree Versions': ['4.17.20'],
    },
  }),
].join('\n');

const NUGET = `Project 'App' has the following vulnerable packages
   [net6.0]:
   Top-level Package      Requested   Resolved   Severity   Advisory URL
   > System.Text.Json     6.0.0       6.0.0      High       https://github.com/advisories/GHSA-hh2w

   Transitive Package     Resolved   Severity   Advisory URL
   > System.Net.Http      4.3.0      High       https://github.com/advisories/GHSA-7jgj
`;

beforeEach(() => {
  resetFakeCore();
  resetKeyedSurfacesForTests();
  mocks.records = [
    { name: 'react', version: '^18.2.0', manager: 'pnpm', license: 'UNKNOWN' },
    { name: 'lodash', version: '4.17.20', manager: 'pnpm' },
    { name: 'gpl-lib', version: '1.0.0', manager: 'pnpm' },
    { name: 'Newtonsoft.Json', version: '13.0.1', manager: 'nuget', license: 'UNKNOWN' },
  ];
  mocks.auditStdout = NPM_V2;
  mocks.auditError = null;
  mocks.provider = null;
});

describe('licence policy', () => {
  it('classifies permissive, copyleft, dual and unknown licences', () => {
    expect(classifyLicense('MIT')).toBe('allowed');
    expect(classifyLicense('LGPL-2.1')).toBe('allowed');
    expect(classifyLicense('GPL-3.0-only')).toBe('restricted');
    expect(classifyLicense('AGPL-3.0')).toBe('restricted');
    expect(classifyLicense('(MIT OR GPL-3.0)')).toBe('allowed');
    expect(classifyLicense('UNKNOWN')).toBe('unknown');
    expect(classifyLicense(undefined)).toBe('unknown');
  });
});

describe('audit parsing', () => {
  it('parses npm v2 audits including indirect-only packages', () => {
    const parsed = parseAuditOutput('npm', NPM_V2);
    const lodash = parsed.packages.find((pkg) => pkg.name === 'lodash')!;
    expect(lodash.vulnerabilities[0]).toMatchObject({ severity: 'high', fixedIn: '4.17.21' });
    const wrapper = parsed.packages.find((pkg) => pkg.name === 'minimist-wrapper')!;
    expect(wrapper.vulnerabilities[0]).toMatchObject({
      severity: 'medium',
      title: 'Depends on vulnerable minimist',
    });
    expect(wrapper.direct).toBe(false);
  });

  it('parses pnpm/npm v1 advisories, yarn berry NDJSON and dotnet tables', () => {
    expect(parseAuditOutput('pnpm', PNPM_V1).packages[0]).toMatchObject({
      name: 'lodash',
      version: '4.17.20',
      vulnerabilities: [{ id: 'GHSA-p6mc', severity: 'critical', fixedIn: '>=4.17.21' }],
    });
    expect(parseAuditOutput('yarn', YARN_BERRY).packages[0]).toMatchObject({
      name: 'lodash',
      version: '4.17.20',
    });
    const nuget = parseAuditOutput('nuget', NUGET).packages;
    expect(nuget.map((pkg) => [pkg.name, pkg.direct])).toEqual([
      ['System.Net.Http', false],
      ['System.Text.Json', true],
    ]);
  });

  it('flags unparsable output and pip caveats', () => {
    expect(parseAuditOutput('npm', 'not json').unparsed).toBe(true);
    expect(parseAuditOutput('python', '').note).toContain('outdated');
  });
});

describe('dependencies tools', () => {
  it('deps_list publishes one keyed surface; audit and licences patch it in place', async () => {
    const ctx = testContext();
    const listed = await provider.call(ctx, 'deps_list', { repoId: 'repo-1' });
    const surfaceId = listed?.structuredContent?.surfaceId as string;
    expect(getSurface(surfaceId)!.payload.key).toBe('deps:repo-1');
    expect(textOf(listed)).toContain('4 packages');
    expect(textOf(listed)).toContain('not run (call deps_audit)');

    const audited = await provider.call(ctx, 'deps_audit', { repoId: 'repo-1', manager: 'npm' });
    expect(audited?.structuredContent?.surfaceId).toBe(surfaceId);
    let data = getSurface(surfaceId)!.payload.data as DependenciesSurfaceData;
    expect(data.packages.find((pkg) => pkg.name === 'lodash')?.vulnerabilities).toHaveLength(1);
    // Transitive package added from the audit with the repo's JS manager.
    expect(data.packages.find((pkg) => pkg.name === 'minimist-wrapper')).toMatchObject({
      manager: 'pnpm',
      direct: false,
    });
    expect(data.summary.audits[0]).toMatchObject({
      manager: 'npm',
      ok: true,
      vulnerabilityCount: 2,
    });

    await provider.call(ctx, 'deps_licenses', { repoId: 'repo-1' });
    data = getSurface(surfaceId)!.payload.data as DependenciesSurfaceData;
    expect(data.packages.find((pkg) => pkg.name === 'gpl-lib')?.licenseStatus).toBe('restricted');
    expect(data.packages.find((pkg) => pkg.name === 'react')?.license).toBe('MIT');
    expect(data.summary.licensesCheckedAt).toBe('2026-01-02T00:00:00Z');
    // Audit overlay survives the licence pass and a re-list.
    await provider.call(ctx, 'deps_list', { repoId: 'repo-1' });
    data = getSurface(surfaceId)!.payload.data as DependenciesSurfaceData;
    expect(data.packages.find((pkg) => pkg.name === 'lodash')?.vulnerabilities).toHaveLength(1);
    expect(data.packages.find((pkg) => pkg.name === 'minimist-wrapper')).toBeDefined();
    expect(validateJsonSchema(dependenciesSurfaceKind.schema, data)).toEqual([]);
    const digest = digestDependencies(data);
    expect(digest).toContain('pnpm:lodash@4.17.20');
    expect(digest).toContain('1 restricted');
  });

  it('deps_audit publishes when no surface exists and records failures honestly', async () => {
    mocks.auditError = new Error('pnpm: command not found');
    const result = await provider.call(testContext(), 'deps_audit', {
      repoId: 'repo-1',
      manager: 'pnpm',
    });
    expect(textOf(result)).toContain('pnpm audit failed: pnpm: command not found');
    const data = getSurface(result?.structuredContent?.surfaceId as string)!.payload
      .data as DependenciesSurfaceData;
    expect(data.summary.audits[0]).toMatchObject({ manager: 'pnpm', ok: false });
  });

  it('enforces repo scope and argument validation', async () => {
    await expect(provider.call(testContext(), 'deps_list', { repoId: 'repo-9' })).rejects.toThrow(
      /outside/,
    );
    await expect(
      provider.call(testContext(), 'deps_audit', { repoId: 'repo-1', manager: 'cargo' }),
    ).rejects.toThrow(/Invalid arguments/);
  });

  it('deps_sbom keeps the SBOM as a session artifact and returns only a digest', async () => {
    const result = await provider.call(testContext(), 'deps_sbom', {
      repoId: 'repo-1',
      format: 'cyclonedx-json',
    });
    const text = textOf(result);
    expect(text).toContain('2 components');
    expect(result?.structuredContent?.artifactId).toBe('artifact-sbom');
    expect(keptArtifacts.at(-1)?.storage).toBe('session');
    expect(keptArtifacts.at(-1)?.content).toContain('CycloneDX');
    expect(text).not.toContain('"bomFormat"');
  });
});

describe('dependencies actions', () => {
  async function auditedSurface() {
    const ctx = testContext();
    await provider.call(ctx, 'deps_list', { repoId: 'repo-1' });
    const result = await provider.call(ctx, 'deps_audit', { repoId: 'repo-1', manager: 'npm' });
    return getSurface(result?.structuredContent?.surfaceId as string)!;
  }

  it('ask_upgrade sends package and advisory context to the agent', async () => {
    const intent = await auditedSurface();
    const result = await dependenciesSurfaceHandler.executeAction!(
      { intent },
      { surfaceId: intent.id, action: 'ask_upgrade', targetIds: ['pnpm:lodash'] },
    );
    expect(result.ok).toBe(true);
    expect(fakeCoreState.delivered[0].message).toContain('pnpm:lodash@4.17.20');
    expect(fakeCoreState.delivered[0].message).toContain('fixed in 4.17.21');
  });

  it('create_work_items errors honestly without a provider and patches ids with one', async () => {
    const intent = await auditedSurface();
    const denied = await dependenciesSurfaceHandler.executeAction!(
      { intent },
      { surfaceId: intent.id, action: 'create_work_items', targetIds: ['pnpm:lodash'] },
    );
    expect(denied.ok).toBe(false);
    mocks.provider = { createItem: async () => ({ id: 'LIN-7' }) };
    const created = await dependenciesSurfaceHandler.executeAction!(
      { intent: getSurface(intent.id)! },
      { surfaceId: intent.id, action: 'create_work_items', targetIds: ['pnpm:lodash'] },
    );
    expect(created.ok).toBe(true);
    const data = getSurface(intent.id)!.payload.data as DependenciesSurfaceData;
    expect(data.packages.find((pkg) => pkg.name === 'lodash')?.workItemId).toBe('LIN-7');
  });

  it('snapshot is script-free and lists top risks', async () => {
    const intent = await auditedSurface();
    const data = intent.payload.data as DependenciesSurfaceData;
    expect(topRiskPackages(data.packages, 3)[0].name).toBe('lodash');
    const snapshot = dependenciesSnapshot(
      {
        ...data,
        packages: [
          ...data.packages,
          { name: '<script>x</script>', version: '1', manager: 'npm', direct: true },
        ],
      },
      'Deps',
    );
    expect(snapshot.html).not.toMatch(/<script/i);
    expect(snapshot.html).toContain('Top risks');
  });
});
