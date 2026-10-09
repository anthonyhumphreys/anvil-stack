import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
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
      [
        'name: Deploy',
        'on:',
        '  workflow_call:',
        'jobs:',
        '  release:',
        '    runs-on: ubuntu-latest',
      ].join('\n'),
    );

    const analysis = await analyzeCicdPipelines('repo-1', 'demo', repoPath);

    expect(analysis.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['.github/workflows/ci.yml', '.github/workflows/deploy.yml']),
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
    writeFileSync(
      join(repoPath, '.github', 'workflows', 'broken.yml'),
      'name: Broken\njobs:\n  nope: [',
    );

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
    expect(created.content).toContain('actions/checkout@v4');
    expect(created.content).not.toContain('pnpm test');
    expect(existsSync(join(repoPath, created.filePath))).toBe(true);
    expect(() =>
      createCicdPipeline(repoPath, {
        provider: 'github-actions',
        template: 'node-ci',
        name: 'Node CI',
      }),
    ).toThrow('already exists');
  });

  it('detects the declared package manager, framework, scripts, and workspace with matching commands', async () => {
    mkdirSync(join(repoPath, 'packages', 'web'), { recursive: true });
    writeFileSync(join(repoPath, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFileSync(join(repoPath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@10.4.0',
        workspaces: ['packages/*'],
        scripts: { test: 'vitest run', build: 'vite build' },
        devDependencies: { vite: '^6.0.0' },
      }),
    );
    writeFileSync(
      join(repoPath, 'packages', 'web', 'package.json'),
      JSON.stringify({
        name: 'web',
        scripts: { lint: 'eslint .' },
      }),
    );

    const analysis = await analyzeCicdPipelines('repo-node', 'web', repoPath);

    expect(analysis.stack).toMatchObject({
      language: 'node',
      framework: 'Vite',
      packageManager: 'pnpm',
      workspace: true,
      scripts: ['test', 'build'],
    });
    expect(analysis.recommendations[0]).toMatchObject({ template: 'node-ci', recommended: true });
    expect(analysis.recommendations[0].commands).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm -r --if-present run lint',
      'pnpm run test',
      'pnpm run build',
    ]);
    const created = createCicdPipeline(repoPath, {
      provider: 'github-actions',
      template: 'node-ci',
      name: 'Web CI',
    });
    expect(created.content).toContain('pnpm/action-setup@v4');
    expect(created.content).toContain('pnpm run test');
    expect(created.content).toContain('pnpm run build');
    expect(created.content).toContain('pnpm -r --if-present run lint');
  });

  it.each([
    {
      manager: 'npm',
      lock: 'package-lock.json',
      expectedInstall: 'npm ci',
      expectedAction: 'cache: npm',
    },
    {
      manager: 'yarn',
      lock: 'yarn.lock',
      expectedInstall: 'yarn install --frozen-lockfile',
      expectedAction: 'corepack enable',
    },
    {
      manager: 'bun',
      lock: 'bun.lock',
      expectedInstall: 'bun install --frozen-lockfile',
      expectedAction: 'oven-sh/setup-bun@v2',
    },
  ])(
    'generates $manager commands from its lockfile and package scripts',
    async ({ manager, lock, expectedInstall, expectedAction }) => {
      writeFileSync(
        join(repoPath, 'package.json'),
        JSON.stringify({
          packageManager: `${manager}@${manager === 'npm' ? '10.0.0' : '1.2.3'}`,
          scripts: { lint: 'eslint .', test: 'vitest run' },
        }),
      );
      writeFileSync(join(repoPath, lock), 'lock data');

      const analysis = await analyzeCicdPipelines(`repo-${manager}`, manager, repoPath);
      expect(analysis.stack.packageManager).toBe(manager);
      expect(analysis.recommendations[0].commands).toEqual([
        expectedInstall,
        `${manager} run lint`,
        `${manager} run test`,
      ]);
      const pipeline = createCicdPipeline(repoPath, {
        provider: 'github-actions',
        template: 'node-ci',
        name: `${manager} CI`,
      });
      expect(pipeline.content).toContain(expectedAction);
      expect(pipeline.content).toContain(expectedInstall);
    },
  );

  it('detects projects without scripts and unknown repositories without inventing commands', async () => {
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({ name: 'bare-app', scripts: {} }),
    );
    const node = await analyzeCicdPipelines('repo-bare', 'bare-app', repoPath);
    expect(node.stack.packageManager).toBe('npm');
    expect(node.stack.scripts).toEqual([]);
    expect(node.recommendations[0].commands).toEqual(['npm install']);
    expect(
      createCicdPipeline(repoPath, {
        provider: 'github-actions',
        template: 'node-ci',
        name: 'Bare app',
      }).content,
    ).toContain('npm install');

    rmSync(join(repoPath, 'package.json'));
    const unknown = await analyzeCicdPipelines('repo-empty', 'empty', repoPath);
    expect(unknown.stack.language).toBe('unknown');
    expect(unknown.recommendations[0].template).toBe('generic-ci');
    expect(unknown.recommendations[0].commands).toEqual([
      'No build, test, or lint command detected',
    ]);
  });

  it('detects Python projects and only emits pytest when repository evidence supports it', async () => {
    writeFileSync(
      join(repoPath, 'pyproject.toml'),
      '[project]\nname = "api"\ndependencies = ["fastapi"]',
    );
    mkdirSync(join(repoPath, 'tests'), { recursive: true });
    writeFileSync(join(repoPath, 'pytest.ini'), '[pytest]\ntestpaths = tests');
    const analysis = await analyzeCicdPipelines('repo-python', 'api', repoPath);
    expect(analysis.stack).toMatchObject({ language: 'python', framework: 'fastapi' });
    expect(analysis.recommendations[0].commands).toEqual(['python -m pip install .']);
    writeFileSync(join(repoPath, 'requirements.txt'), 'fastapi==0.115.0');
    writeFileSync(
      join(repoPath, 'pyproject.toml'),
      '[project]\nname = "api"\ndependencies = ["fastapi"]\n[project.optional-dependencies]\ntest = ["pytest>=8"]',
    );
    const withTests = await analyzeCicdPipelines('repo-python', 'api', repoPath);
    expect(withTests.recommendations[0].commands).toContain("python -m pip install '.[test]'");
    expect(withTests.recommendations[0].commands).toContain('python -m pytest');
  });

  it('detects nested .NET projects and passes the project path to test commands', async () => {
    mkdirSync(join(repoPath, 'src', 'service'), { recursive: true });
    const projectFile = `${'VeryLongProjectName'.repeat(7)}: API.csproj`;
    writeFileSync(
      join(repoPath, 'src', 'service', projectFile),
      '<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>',
    );
    const analysis = await analyzeCicdPipelines('repo-dotnet', 'service', repoPath);
    expect(analysis.stack.language).toBe('dotnet');
    expect(analysis.recommendations[0].commands).toContain(
      `dotnet test '${`src/service/${projectFile}`.replace(/'/g, `'\\''`)}' --configuration Release`,
    );
    expect(analysis.stack.sdkVersion).toBe('9.x');
    const workflow = createCicdPipeline(repoPath, {
      provider: 'github-actions',
      template: 'dotnet-ci',
      name: '.NET CI',
    });
    expect(workflow.content).toContain(
      `dotnet test '${`src/service/${projectFile}`.replace(/'/g, `'\\''`)}' --configuration Release`,
    );
    expect(parseDocument(workflow.content).errors).toHaveLength(0);
    expect(workflow.content).toContain(projectFile);
  });

  it('quotes workflow names and rejects traversal, symlink paths, and unsupported templates', () => {
    const injected = createCicdPipeline(repoPath, {
      provider: 'github-actions',
      template: 'generic-ci',
      name: 'build: [danger]\non: push',
    });
    expect(injected.content).toContain('name: "build: [danger] on: push"');
    expect(parseDocument(injected.content).errors).toHaveLength(0);
    expect(() =>
      createCicdPipeline(repoPath, {
        provider: 'github-actions',
        template: 'generic-ci',
        name: 'escape',
        filePath: '../outside.yml',
      }),
    ).toThrow('relative .yml');
    mkdirSync(join(repoPath, 'linked'), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'anvil-cicd-outside-'));
    try {
      symlinkSync(outside, join(repoPath, 'linked', 'escape'));
      expect(() =>
        createCicdPipeline(repoPath, {
          provider: 'github-actions',
          template: 'generic-ci',
          name: 'escape',
          filePath: 'linked/escape/pipeline.yml',
        }),
      ).toThrow('symbolic link');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(() =>
      createCicdPipeline(repoPath, {
        provider: 'github-actions',
        template: 'evil' as 'generic-ci',
        name: 'unsupported',
      }),
    ).toThrow('supported pipeline');
  });

  it('keeps an untrusted package-manager version inside a YAML scalar', () => {
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@10.4.0\njobs:\n  injected: true',
        scripts: { test: 'vitest' },
      }),
    );
    const pipeline = createCicdPipeline(repoPath, {
      provider: 'github-actions',
      template: 'node-ci',
      name: 'Safe Node CI',
    });
    const document = parseDocument(pipeline.content);
    expect(document.errors).toHaveLength(0);
    expect(pipeline.content).toContain('version: "10"');
    expect(document.toJS()).not.toHaveProperty('injected');
  });

  it('rejects a template that conflicts with the detected stack', () => {
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'web' }));
    expect(() =>
      createCicdPipeline(repoPath, {
        provider: 'github-actions',
        template: 'python-ci',
        name: 'Python CI',
      }),
    ).toThrow('supported pipeline');
  });

  it('targets only Yarn Classic workspaces that define the selected script', async () => {
    mkdirSync(join(repoPath, 'packages', 'with-lint'), { recursive: true });
    mkdirSync(join(repoPath, 'packages', 'without-lint'), { recursive: true });
    writeFileSync(join(repoPath, 'yarn.lock'), '# yarn lockfile v1');
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'], packageManager: 'yarn@1.22.22' }),
    );
    writeFileSync(
      join(repoPath, 'packages', 'with-lint', 'package.json'),
      JSON.stringify({ name: 'with-lint', scripts: { lint: 'eslint .' } }),
    );
    writeFileSync(
      join(repoPath, 'packages', 'without-lint', 'package.json'),
      JSON.stringify({ name: 'without-lint', scripts: { test: 'jest' } }),
    );
    const analysis = await analyzeCicdPipelines('repo-yarn', 'yarn', repoPath);
    expect(analysis.recommendations[0].commands).toContain("yarn workspace 'with-lint' run lint");
    expect(analysis.recommendations[0].commands).not.toContain('yarn workspaces run lint');
  });
});
