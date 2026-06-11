import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeCicdPipelines, createCicdPipeline } from '../cicd.service.js';

describe('cicd.service', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'anvil-cicd-'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('discovers GitHub Actions workflows, reusable workflows, gates, and job dependencies', async () => {
    mkdirSync(join(repoPath, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(repoPath, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'on: [push]',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - name: Test',
        '        run: pnpm test',
        '  deploy:',
        '    needs: build',
        '    environment: production',
        '    uses: ./.github/workflows/deploy.yml',
      ].join('\n'),
    );
    writeFileSync(
      join(repoPath, '.github', 'workflows', 'deploy.yml'),
      ['name: Deploy', 'on:', '  workflow_call:', 'jobs:', '  release:', '    runs-on: ubuntu-latest'].join(
        '\n',
      ),
    );

    const analysis = await analyzeCicdPipelines('repo-1', 'demo', repoPath);

    expect(analysis.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        '.github/workflows/ci.yml',
        '.github/workflows/deploy.yml',
      ]),
    );
    expect(analysis.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'workflow', label: 'CI' }),
        expect.objectContaining({ type: 'job', label: 'deploy' }),
        expect.objectContaining({ type: 'gate', label: 'production' }),
      ]),
    );
    expect(analysis.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: '.github/workflows/ci.yml::job:build',
          to: '.github/workflows/ci.yml::job:deploy',
          label: 'needs',
        }),
      ]),
    );
  });

  it('discovers Azure Pipelines entrypoints and local templates', async () => {
    mkdirSync(join(repoPath, 'templates'), { recursive: true });
    writeFileSync(
      join(repoPath, 'azure-pipelines.yml'),
      [
        'trigger:',
        '  - main',
        'stages:',
        '  - stage: Build',
        '    jobs:',
        '      - template: templates/node-job.yml',
        '  - stage: Deploy',
        '    jobs:',
        '      - deployment: production',
        '        environment: prod',
        '        strategy:',
        '          runOnce:',
        '            deploy:',
        '              steps:',
        '                - script: echo ship',
      ].join('\n'),
    );
    writeFileSync(
      join(repoPath, 'templates', 'node-job.yml'),
      ['jobs:', '  - job: build', '    steps:', '      - script: pnpm build'].join('\n'),
    );

    const analysis = await analyzeCicdPipelines('repo-2', 'demo', repoPath);

    expect(analysis.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'azure-pipelines.yml', role: 'entrypoint' }),
        expect.objectContaining({ path: 'templates/node-job.yml', role: 'template' }),
      ]),
    );
    expect(analysis.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'stage', label: 'Build' }),
        expect.objectContaining({ type: 'gate', label: 'prod' }),
      ]),
    );
    expect(analysis.summary.providers).toContain('azure-pipelines');
  });

  it('returns validation findings for malformed YAML and empty workflows', async () => {
    mkdirSync(join(repoPath, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repoPath, '.github', 'workflows', 'broken.yml'), 'name: Broken\njobs:\n  nope: [');

    const analysis = await analyzeCicdPipelines('repo-3', 'demo', repoPath);

    expect(analysis.files[0]).toMatchObject({ valid: false });
    expect(analysis.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error' })]),
    );
  });

  it('creates starter pipeline files without overwriting existing files', () => {
    const created = createCicdPipeline(repoPath, {
      provider: 'github-actions',
      template: 'node-ci',
      name: 'Node CI',
    });

    expect(created.filePath).toBe('.github/workflows/node-ci.yml');
    expect(created.content).toContain('pnpm test');
    expect(existsSync(join(repoPath, created.filePath))).toBe(true);
    expect(() =>
      createCicdPipeline(repoPath, {
        provider: 'github-actions',
        template: 'node-ci',
        name: 'Node CI',
      }),
    ).toThrow('already exists');
  });
});
