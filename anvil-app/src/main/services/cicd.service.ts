import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { globby, globbySync } from 'globby';
import { parseDocument, isMap, isSeq, isScalar, type Document, type ParsedNode } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import type {
  CicdFlowEdge,
  CicdFlowNode,
  CicdCreatePipelineInput,
  CicdCreatePipelineResult,
  CicdPipelineAnalysis,
  CicdPipelineFile,
  CicdPipelineRecommendation,
  CicdStackProfile,
  CicdProvider,
  CicdValidationFinding,
} from '../../shared/types.js';

type YamlValue = unknown;

interface ParsedPipelineFile extends CicdPipelineFile {
  doc: Document.Parsed | null;
  data: YamlValue;
}

const GITHUB_WORKFLOW_GLOBS = ['.github/workflows/*.{yml,yaml}'];
const AZURE_ENTRYPOINT_GLOBS = [
  'azure-pipelines.{yml,yaml}',
  'azure-pipelines/*.{yml,yaml}',
  '.azure-pipelines/*.{yml,yaml}',
];
const YAML_EXT_RE = /\.ya?ml$/i;

export async function analyzeCicdPipelines(
  repoId: string,
  repoName: string,
  repoPath: string,
): Promise<CicdPipelineAnalysis> {
  const entrypointPaths = await discoverEntrypoints(repoPath);
  const parsedFiles = new Map<string, ParsedPipelineFile>();

  for (const filePath of entrypointPaths) {
    collectPipelineFile(repoPath, filePath, 'entrypoint', parsedFiles);
  }

  const nodes: CicdFlowNode[] = [];
  const edges: CicdFlowEdge[] = [];
  const findings: CicdValidationFinding[] = [];

  for (const file of parsedFiles.values()) {
    if (!file.valid) {
      findings.push({
        id: findingId(file.path, 'parse-error'),
        severity: 'error',
        provider: file.provider,
        filePath: file.path,
        message: file.error ?? 'Pipeline YAML could not be parsed.',
      });
      continue;
    }

    if (file.provider === 'github-actions') {
      analyseGitHubWorkflow(file, nodes, edges, findings);
      collectGitHubReferences(repoPath, file, parsedFiles);
    } else {
      analyseAzurePipeline(file, nodes, edges, findings);
      collectAzureTemplateReferences(repoPath, file, parsedFiles);
    }
  }

  for (const file of parsedFiles.values()) {
    if (file.role !== 'entrypoint' && !nodes.some((node) => node.filePath === file.path)) {
      const node = makeNode(file.provider, 'template', file.path, file.name, file.role, 1);
      nodes.push(node);
    }
  }

  const providers = Array.from(new Set([...parsedFiles.values()].map((file) => file.provider)));
  const stack = detectRepositoryStack(repoPath);
  const recommendations = recommendPipelines(stack, providers);

  return {
    repoId,
    repoName,
    generatedAt: new Date().toISOString(),
    files: Array.from(parsedFiles.values()).map(({ doc: _doc, data: _data, ...file }) => file),
    nodes,
    edges,
    findings,
    stack,
    recommendations,
    summary: {
      providers,
      workflowCount: nodes.filter((node) => node.type === 'workflow').length,
      stageCount: nodes.filter((node) => node.type === 'stage').length,
      jobCount: nodes.filter((node) => node.type === 'job').length,
      stepCount: nodes.filter((node) => node.type === 'step').length,
      gateCount: nodes.filter((node) => node.type === 'gate').length,
      templateCount: nodes.filter((node) => node.type === 'template').length,
    },
  };
}

export function createCicdPipeline(
  repoPath: string,
  input: CicdCreatePipelineInput,
): CicdCreatePipelineResult {
  if (
    !input ||
    !isSupportedProvider(input.provider) ||
    !isSupportedTemplate(input.template) ||
    typeof input.name !== 'string' ||
    (input.provider === 'azure-pipelines' && input.template !== 'dotnet-azure') ||
    !isCompatibleTemplate(input.template, detectRepositoryStack(repoPath).language)
  ) {
    throw new Error('Choose a supported pipeline provider and template.');
  }
  const filePath = normalizePipelinePath(
    input.filePath?.trim() || defaultPipelinePath(input.provider, input.template),
  );
  if (!isSafeRelativePath(filePath) || !YAML_EXT_RE.test(filePath)) {
    throw new Error('Pipeline path must be a relative .yml or .yaml file inside the repository.');
  }

  const absolutePath = join(repoPath, filePath);
  assertNoSymlinkedParent(repoPath, filePath);
  if (existsSync(absolutePath)) {
    throw new Error(`Pipeline file already exists: ${filePath}`);
  }

  const content = renderPipelineTemplate(input, detectRepositoryStack(repoPath));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, { encoding: 'utf8', flag: 'wx' });
  return { filePath, content };
}

async function discoverEntrypoints(repoPath: string): Promise<string[]> {
  const matches = await globby([...GITHUB_WORKFLOW_GLOBS, ...AZURE_ENTRYPOINT_GLOBS], {
    cwd: repoPath,
    onlyFiles: true,
    gitignore: true,
    absolute: false,
  });
  return Array.from(new Set(matches.map(normalizePipelinePath))).sort();
}

function collectPipelineFile(
  repoPath: string,
  filePath: string,
  role: CicdPipelineFile['role'],
  files: Map<string, ParsedPipelineFile>,
): ParsedPipelineFile | null {
  const normalized = normalizePipelinePath(filePath);
  if (files.has(normalized)) return files.get(normalized)!;
  if (!isSafeRelativePath(normalized)) return null;

  const absolutePath = join(repoPath, normalized);
  if (!existsSync(absolutePath)) return null;

  const provider = detectProvider(normalized);
  const content = readFileSync(absolutePath, 'utf8');
  let doc: Document.Parsed | null = null;
  let data: YamlValue = null;
  let error: string | undefined;

  try {
    doc = parseDocument(content, { prettyErrors: true });
    data = doc.toJS();
    if (doc.errors.length > 0) {
      error = doc.errors.map((yamlError) => yamlError.message).join('; ');
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const file: ParsedPipelineFile = {
    path: normalized,
    provider,
    role,
    name: pipelineDisplayName(normalized, data),
    valid: !error,
    error,
    content,
    doc,
    data,
  };
  files.set(normalized, file);
  return file;
}

function analyseGitHubWorkflow(
  file: ParsedPipelineFile,
  nodes: CicdFlowNode[],
  edges: CicdFlowEdge[],
  findings: CicdValidationFinding[],
): void {
  const root = asRecord(file.data);
  const workflowId = nodeId(file.path, 'workflow');
  const workflowNode = makeNode(
    'github-actions',
    'workflow',
    file.path,
    stringValue(root?.name) ?? file.name,
    triggerSubtitle(root?.on),
    0,
  );
  nodes.push(workflowNode);

  if (!root?.on) {
    findings.push(makeFinding('warning', file, 'This workflow has no trigger. It may never run.'));
  }

  const jobs = asRecord(root?.jobs);
  if (!jobs || Object.keys(jobs).length === 0) {
    findings.push(
      makeFinding('error', file, 'This workflow does not define any jobs.', workflowId),
    );
    return;
  }

  if (!root?.permissions) {
    findings.push(
      makeFinding(
        'info',
        file,
        'No top-level permissions block is set. GitHub will use repository defaults.',
        workflowId,
      ),
    );
  }

  for (const [jobKey, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    const jobNodeId = nodeId(file.path, `job:${jobKey}`);
    const uses = stringValue(job?.uses);
    const environment = environmentName(job?.environment);
    const needs = needsList(job?.needs);
    nodes.push(
      makeNode(
        'github-actions',
        'job',
        file.path,
        stringValue(job?.name) ?? jobKey,
        uses ? `Reusable workflow: ${uses}` : (stringValue(job?.['runs-on']) ?? 'Runner not set'),
        1,
        jobNodeId,
        needs.length === 0 && !job?.['runs-on'] && !uses ? 'warning' : 'configured',
        { key: jobKey },
      ),
    );

    if (needs.length === 0) {
      edges.push({ from: workflowId, to: jobNodeId, label: 'starts' });
    } else {
      for (const need of needs) {
        edges.push({ from: nodeId(file.path, `job:${need}`), to: jobNodeId, label: 'needs' });
      }
    }

    if (!job?.['runs-on'] && !uses) {
      findings.push(
        makeFinding(
          'warning',
          file,
          `Job "${jobKey}" has no runner or reusable workflow.`,
          jobNodeId,
        ),
      );
    }

    if (environment) {
      const gateNodeId = nodeId(file.path, `gate:${jobKey}:${environment}`);
      nodes.push(
        makeNode(
          'github-actions',
          'gate',
          file.path,
          environment,
          'Environment protection',
          2,
          gateNodeId,
        ),
      );
      edges.push({ from: gateNodeId, to: jobNodeId, label: 'approves' });
    }

    const steps = asArray(job?.steps);
    steps.slice(0, 8).forEach((stepRaw, index) => {
      const step = asRecord(stepRaw);
      const label =
        stringValue(step?.name) ??
        stringValue(step?.uses) ??
        stringValue(step?.run) ??
        `Step ${index + 1}`;
      const stepNodeId = nodeId(file.path, `job:${jobKey}:step:${index}`);
      nodes.push(
        makeNode(
          'github-actions',
          'step',
          file.path,
          trimLabel(label),
          stringValue(step?.uses) ? `uses ${step?.uses}` : 'run',
          2,
          stepNodeId,
        ),
      );
      edges.push({ from: jobNodeId, to: stepNodeId });
    });
  }
}

function analyseAzurePipeline(
  file: ParsedPipelineFile,
  nodes: CicdFlowNode[],
  edges: CicdFlowEdge[],
  findings: CicdValidationFinding[],
): void {
  const root = asRecord(file.data);
  const pipelineId = nodeId(file.path, 'pipeline');
  nodes.push(
    makeNode(
      'azure-pipelines',
      'workflow',
      file.path,
      file.name,
      azureTriggerSubtitle(root),
      0,
      pipelineId,
    ),
  );

  if (!root?.trigger && !root?.pr && !root?.schedules) {
    findings.push(
      makeFinding(
        'warning',
        file,
        'This pipeline has no CI, PR, or scheduled trigger.',
        pipelineId,
      ),
    );
  }

  const stages = asArray(root?.stages);
  const jobs = asArray(root?.jobs);
  const steps = asArray(root?.steps);

  if (stages.length === 0 && jobs.length === 0 && steps.length === 0) {
    findings.push(
      makeFinding(
        'error',
        file,
        'This pipeline does not define stages, jobs, or steps.',
        pipelineId,
      ),
    );
    return;
  }

  if (stages.length > 0) {
    stages.forEach((rawStage, index) => {
      const stage = asRecord(rawStage);
      const label =
        stringValue(stage?.stage) ?? stringValue(stage?.template) ?? `Stage ${index + 1}`;
      const stageNodeId = nodeId(file.path, `stage:${label}:${index}`);
      const isTemplate = !!stage?.template;
      nodes.push(
        makeNode(
          'azure-pipelines',
          isTemplate ? 'template' : 'stage',
          file.path,
          label,
          stringValue(stage?.displayName) ?? (isTemplate ? 'Template stage' : undefined),
          1,
          stageNodeId,
        ),
      );
      edges.push({ from: pipelineId, to: stageNodeId });
      appendAzureJobs(file, stageNodeId, asArray(stage?.jobs), nodes, edges, findings, 2);
    });
  } else if (jobs.length > 0) {
    appendAzureJobs(file, pipelineId, jobs, nodes, edges, findings, 1);
  } else {
    appendAzureSteps(file, pipelineId, steps, nodes, edges, 1);
  }
}

function appendAzureJobs(
  file: ParsedPipelineFile,
  parentNodeId: string,
  jobs: unknown[],
  nodes: CicdFlowNode[],
  edges: CicdFlowEdge[],
  findings: CicdValidationFinding[],
  depth: number,
): void {
  jobs.forEach((rawJob, index) => {
    const job = asRecord(rawJob);
    const label =
      stringValue(job?.job) ??
      stringValue(job?.deployment) ??
      stringValue(job?.template) ??
      `Job ${index + 1}`;
    const isDeployment = !!job?.deployment;
    const isTemplate = !!job?.template;
    const jobNodeId = nodeId(file.path, `job:${label}:${index}`);
    nodes.push(
      makeNode(
        'azure-pipelines',
        isTemplate ? 'template' : 'job',
        file.path,
        label,
        stringValue(job?.displayName) ??
          (isDeployment
            ? `Environment: ${environmentName(job?.environment) ?? 'not set'}`
            : undefined),
        depth,
        jobNodeId,
      ),
    );
    edges.push({
      from: parentNodeId,
      to: jobNodeId,
      label: job?.dependsOn ? 'dependsOn' : undefined,
    });

    const environment = environmentName(job?.environment);
    if (isDeployment && environment) {
      const gateNodeId = nodeId(file.path, `gate:${label}:${environment}`);
      nodes.push(
        makeNode(
          'azure-pipelines',
          'gate',
          file.path,
          environment,
          'Deployment environment',
          depth + 1,
          gateNodeId,
        ),
      );
      edges.push({ from: gateNodeId, to: jobNodeId, label: 'approves' });
    }

    if (!isTemplate && !job?.pool && !job?.uses && !job?.strategy) {
      findings.push(
        makeFinding(
          'info',
          file,
          `Job "${label}" does not set a pool; it may rely on a default.`,
          jobNodeId,
        ),
      );
    }

    appendAzureSteps(file, jobNodeId, asArray(job?.steps), nodes, edges, depth + 1);
  });
}

function appendAzureSteps(
  file: ParsedPipelineFile,
  parentNodeId: string,
  steps: unknown[],
  nodes: CicdFlowNode[],
  edges: CicdFlowEdge[],
  depth: number,
): void {
  steps.slice(0, 10).forEach((rawStep, index) => {
    const step = asRecord(rawStep);
    const label =
      stringValue(step?.displayName) ??
      stringValue(step?.task) ??
      stringValue(step?.script) ??
      stringValue(step?.bash) ??
      stringValue(step?.powershell) ??
      stringValue(step?.template) ??
      `Step ${index + 1}`;
    const stepNodeId = nodeId(file.path, `step:${parentNodeId}:${index}`);
    nodes.push(
      makeNode(
        'azure-pipelines',
        step?.template ? 'template' : 'step',
        file.path,
        trimLabel(label),
        step?.template ? 'Template step' : step?.task ? 'Task' : 'Script',
        depth,
        stepNodeId,
      ),
    );
    edges.push({ from: parentNodeId, to: stepNodeId });
  });
}

function collectGitHubReferences(
  repoPath: string,
  file: ParsedPipelineFile,
  files: Map<string, ParsedPipelineFile>,
): void {
  const jobs = asRecord(asRecord(file.data)?.jobs);
  if (!jobs) return;

  for (const rawJob of Object.values(jobs)) {
    const uses = stringValue(asRecord(rawJob)?.uses);
    if (!uses?.startsWith('./')) continue;
    collectPipelineFile(repoPath, normalizePipelinePath(uses), 'reusable-workflow', files);
  }
}

function collectAzureTemplateReferences(
  repoPath: string,
  file: ParsedPipelineFile,
  files: Map<string, ParsedPipelineFile>,
): void {
  if (!file.doc?.contents) return;
  for (const template of findTemplateValues(file.doc.contents)) {
    const templatePath = normalizePipelinePath(join(dirname(file.path), template));
    const collected = collectPipelineFile(repoPath, templatePath, 'template', files);
    if (collected?.valid && collected.doc?.contents) {
      for (const nestedTemplate of findTemplateValues(collected.doc.contents)) {
        collectPipelineFile(
          repoPath,
          normalizePipelinePath(join(dirname(collected.path), nestedTemplate)),
          'template',
          files,
        );
      }
    }
  }
}

function findTemplateValues(node: ParsedNode): string[] {
  const values: string[] = [];
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : '';
      if (key === 'template' && isScalar(pair.value) && typeof pair.value.value === 'string') {
        values.push(pair.value.value);
      }
      if (pair.value && typeof pair.value === 'object') {
        values.push(...findTemplateValues(pair.value as ParsedNode));
      }
    }
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      if (item && typeof item === 'object') values.push(...findTemplateValues(item as ParsedNode));
    }
  }
  return values.filter((value) => YAML_EXT_RE.test(value) && !value.includes('@'));
}

function detectProvider(filePath: string): CicdProvider {
  return filePath.startsWith('.github/workflows/') ? 'github-actions' : 'azure-pipelines';
}

function defaultPipelinePath(
  provider: CicdProvider,
  template: CicdCreatePipelineInput['template'],
): string {
  if (provider === 'github-actions') {
    return `.github/workflows/${template}.yml`;
  }
  return template === 'dotnet-azure' ? 'azure-pipelines.yml' : `azure-pipelines/${template}.yml`;
}

function renderPipelineTemplate(input: CicdCreatePipelineInput, stack: CicdStackProfile): string {
  const displayName = yamlScalar(
    (input.name.trim() || titleForTemplate(input.template)).slice(0, 120),
  );
  if (input.provider === 'github-actions') {
    if (input.template === 'gated-release') {
      return [
        `name: ${displayName}`,
        '',
        'on:',
        '  push:',
        '    branches: [main]',
        '  workflow_dispatch:',
        '',
        'permissions:',
        '  contents: read',
        '',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - name: Build',
        '        run: echo "Add your build command"',
        '',
        '  security:',
        '    needs: build',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Security scan',
        '        run: echo "Add your security scan"',
        '',
        '  production:',
        '    needs: security',
        '    runs-on: ubuntu-latest',
        '    environment: production',
        '    # Configure required reviewers in the GitHub environment settings to pause for approval.',
        '    steps:',
        '      - name: Deploy',
        '        run: echo "Add your deployment command"',
        '',
      ].join('\n');
    }

    return renderGithubWorkflow(input.template, displayName, stack);
  }

  return [
    `name: ${displayName}`,
    '',
    'trigger:',
    '  - main',
    '',
    'pr:',
    '  - main',
    '',
    'pool:',
    '  vmImage: ubuntu-latest',
    '',
    'stages:',
    '  - stage: Build',
    '    displayName: Build and test',
    '    jobs:',
    '      - job: build',
    '        steps:',
    '          - checkout: self',
    '          - task: UseDotNet@2',
    '            inputs:',
    "              packageType: 'sdk'",
    `              version: ${yamlScalar(stack.sdkVersion ?? '8.x')}`,
    `          - script: ${yamlScalar(`dotnet restore${stack.projectFile ? ` ${shellQuote(stack.projectFile)}` : ''}`)}`,
    '            displayName: Restore',
    `          - script: ${yamlScalar(`dotnet test${stack.projectFile ? ` ${shellQuote(stack.projectFile)}` : ''} --configuration Release`)}`,
    '            displayName: Test',
    '',
  ].join('\n');
}

function renderGithubWorkflow(
  template: CicdCreatePipelineInput['template'],
  name: string,
  stack: CicdStackProfile,
): string {
  const lines = [
    `name: ${name}`,
    '',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main]',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
  ];
  const setup = githubSetupSteps(stack);
  if (setup.length) lines.push(...setup);
  const commands = commandsForStack(stack, template);
  for (const command of commands) lines.push(`      - run: ${yamlScalar(command)}`);
  lines.push('');
  return lines.join('\n');
}

function githubSetupSteps(stack: CicdStackProfile): string[] {
  if (stack.language === 'node') {
    if (!stack.packageManager)
      return [
        '      - uses: actions/setup-node@v4',
        '        with:',
        "          node-version: '22'",
      ];
    const pm = stack.packageManager;
    if (pm === 'pnpm') {
      const steps = [
        '      - uses: pnpm/action-setup@v4',
        '        with:',
        `          version: ${yamlScalar(stack.packageManagerVersion ?? '10')}`,
        '      - uses: actions/setup-node@v4',
        '        with:',
        "          node-version: '22'",
      ];
      if (stack.evidence.some((item) => item.includes('pnpm-lock.yaml')))
        steps.push('          cache: pnpm');
      return steps;
    }
    if (pm === 'bun')
      return [
        '      - uses: oven-sh/setup-bun@v2',
        '      - uses: actions/setup-node@v4',
        '        with:',
        "          node-version: '22'",
      ];
    if (pm === 'yarn') {
      const steps = [
        '      - uses: actions/setup-node@v4',
        '        with:',
        "          node-version: '22'",
      ];
      if (stack.evidence.some((item) => item.includes('yarn.lock')))
        steps.push('          cache: yarn');
      steps.push('      - run: corepack enable');
      return steps;
    }
    const steps = [
      '      - uses: actions/setup-node@v4',
      '        with:',
      "          node-version: '22'",
    ];
    if (existsLockfileForManager(stack, 'npm')) steps.push('          cache: npm');
    return steps;
  }
  if (stack.language === 'python') {
    return [
      '      - uses: actions/setup-python@v5',
      '        with:',
      "          python-version: '3.x'",
    ];
  }
  if (stack.language === 'go')
    return [
      '      - uses: actions/setup-go@v5',
      '        with:',
      "          go-version-file: 'go.mod'",
    ];
  if (stack.language === 'rust') return ['      - uses: dtolnay/rust-toolchain@stable'];
  if (stack.language === 'dotnet') {
    return [
      '      - uses: actions/setup-dotnet@v4',
      '        with:',
      `          dotnet-version: ${yamlScalar(stack.sdkVersion ?? '8.x')}`,
    ];
  }
  return [];
}

function commandsForStack(
  stack: CicdStackProfile,
  template: CicdCreatePipelineInput['template'],
): string[] {
  if (template === 'generic-ci') return [];
  if (stack.language === 'node') {
    const commands: string[] = [];
    const manager = stack.packageManager;
    if (manager) {
      const install =
        manager === 'npm'
          ? existsLockfileForManager(stack, 'npm')
            ? 'npm ci'
            : 'npm install'
          : manager === 'pnpm'
            ? stack.evidence.some((item) => item.includes('pnpm-lock.yaml'))
              ? 'pnpm install --frozen-lockfile'
              : 'pnpm install'
            : manager === 'yarn'
              ? stack.evidence.some((item) => item.includes('yarn.lock (Yarn Berry)'))
                ? 'yarn install --immutable'
                : stack.evidence.some((item) => item.includes('yarn.lock'))
                  ? 'yarn install --frozen-lockfile'
                  : 'yarn install'
              : stack.evidence.some((item) => item.includes('bun.lock'))
                ? 'bun install --frozen-lockfile'
                : 'bun install';
      commands.push(install);
    }
    for (const script of ['lint', 'typecheck', 'test', 'build']) {
      if (stack.scripts.includes(script)) commands.push(`${manager ?? 'npm'} run ${script}`);
      else if (stack.workspaceScripts?.includes(script)) {
        const yarnBerry = stack.evidence.some((item) => item.includes('yarn.lock (Yarn Berry)'));
        commands.push(
          ...workspaceRunCommands(manager, script, yarnBerry, stack.workspaceScriptTargets ?? []),
        );
      }
    }
    return commands;
  }
  if (stack.language === 'python') {
    const commands: string[] = [];
    if (stack.evidence.includes('Pipfile')) {
      commands.push('python -m pip install pipenv');
      commands.push(
        stack.evidence.includes('Pipfile.lock') ? 'pipenv sync --dev' : 'pipenv install --dev',
      );
      if (stack.evidence.includes('pytest installed')) commands.push('pipenv run pytest');
      return commands;
    }
    if (stack.evidence.includes('requirements.txt'))
      commands.push('python -m pip install -r requirements.txt');
    else if (stack.evidence.includes('pyproject installable project'))
      commands.push(
        stack.evidence.some((item) => item.startsWith('pytest extra:'))
          ? `python -m pip install '.[${stack.evidence.find((item) => item.startsWith('pytest extra:'))?.slice('pytest extra:'.length)}]'`
          : 'python -m pip install .',
      );
    else if (stack.evidence.includes('setup.py')) commands.push('python -m pip install .');
    const pytestExtra = stack.evidence.find((item) => item.startsWith('install pytest extra:'));
    if (pytestExtra) {
      commands.push(
        `python -m pip install '.[${pytestExtra.slice('install pytest extra:'.length)}]'`,
      );
    }
    if (stack.evidence.includes('pytest installed')) commands.push('python -m pytest');
    return commands;
  }
  if (stack.language === 'go') return ['go test ./...'];
  if (stack.language === 'rust') {
    return [stack.evidence.includes('Cargo.lock') ? 'cargo test --locked' : 'cargo test'];
  }
  if (stack.language === 'dotnet') {
    return [
      `dotnet test${stack.projectFile ? ` ${shellQuote(stack.projectFile)}` : ''} --configuration Release`,
    ];
  }
  return [];
}

function detectRepositoryStack(repoPath: string): CicdStackProfile {
  const evidence: string[] = [];
  const manifestPath = join(repoPath, 'package.json');
  let packageJson: Record<string, unknown> | null = null;
  if (existsSync(manifestPath)) {
    try {
      packageJson = asRecord(JSON.parse(readFileSync(manifestPath, 'utf8')));
      evidence.push('package.json');
    } catch {
      evidence.push('package.json (unreadable)');
    }
  }
  const files = (names: string[]) => names.filter((name) => existsSync(join(repoPath, name)));
  const scriptsRecord = asRecord(packageJson?.scripts) ?? {};
  const scripts = Object.keys(scriptsRecord).filter((script) => /^[\w:-]+$/.test(script));
  if (scripts.length) evidence.push(`scripts: ${scripts.join(', ')}`);
  const dependencyNames = Object.keys({
    ...asRecord(packageJson?.dependencies),
    ...asRecord(packageJson?.devDependencies),
  });
  const framework = detectNodeFramework(dependencyNames);
  if (framework) evidence.push(`framework dependency: ${framework}`);
  const manager = detectPackageManager(repoPath, packageJson);
  if (manager.evidence) evidence.push(manager.evidence);
  const workspace =
    Array.isArray(packageJson?.workspaces) ||
    typeof packageJson?.workspaces === 'object' ||
    existsSync(join(repoPath, 'pnpm-workspace.yaml'));
  if (workspace) evidence.push('workspace configuration');
  if (packageJson) {
    const workspaceTargets = workspace ? readWorkspaceScripts(repoPath, packageJson, scripts) : [];
    const workspaceScripts = Array.from(
      new Set(workspaceTargets.flatMap((target) => target.scripts)),
    ).sort();
    if (workspaceScripts.length) evidence.push(`workspace scripts: ${workspaceScripts.join(', ')}`);
    return {
      language: 'node',
      framework,
      packageManager: manager.manager,
      packageManagerVersion: manager.version,
      workspace,
      scripts,
      workspaceScripts,
      workspaceScriptTargets: workspaceTargets,
      evidence,
    };
  }
  const pythonFiles = files(['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py']);
  if (pythonFiles.length) {
    evidence.push(...pythonFiles);
    const pyproject = pythonFiles.includes('pyproject.toml')
      ? readFileSync(join(repoPath, 'pyproject.toml'), 'utf8')
      : '';
    const requirements = pythonFiles.includes('requirements.txt')
      ? readFileSync(join(repoPath, 'requirements.txt'), 'utf8')
      : '';
    const pipfile = pythonFiles.includes('Pipfile')
      ? readFileSync(join(repoPath, 'Pipfile'), 'utf8')
      : '';
    let pyprojectToml: Record<string, unknown> = {};
    let pipfileToml: Record<string, unknown> = {};
    try {
      if (pyproject) pyprojectToml = asRecord(parseToml(pyproject)) ?? {};
      if (pipfile) pipfileToml = asRecord(parseToml(pipfile)) ?? {};
    } catch {
      // Invalid TOML remains visible as evidence but does not enable guessed commands.
    }
    if (existsSync(join(repoPath, 'Pipfile.lock'))) evidence.push('Pipfile.lock');
    const project = asRecord(pyprojectToml.project);
    const projectDependencies = Array.isArray(project?.dependencies)
      ? project.dependencies.filter((item): item is string => typeof item === 'string')
      : [];
    const testExtras = asRecord(project?.['optional-dependencies']);
    const pytestExtra = Object.entries(testExtras ?? {}).find(
      ([name, values]) =>
        /^(test|tests|testing|dev)$/.test(name) &&
        Array.isArray(values) &&
        values.some((item) => typeof item === 'string' && /^pytest(?:$|[<=>~!\s]|\[)/i.test(item)),
    );
    const pipfilePackages = {
      ...asRecord(pipfileToml.packages),
      ...asRecord(pipfileToml['dev-packages']),
    };
    const requirementNames = requirements.split(/\r?\n/).map((line) => line.split('#')[0].trim());
    const pipfileHasPytest = Object.keys(pipfilePackages).some((item) => /^pytest$/i.test(item));
    const requirementsHavePytest = requirementNames.some((item) =>
      /^pytest(?:$|[<=>~!\s]|\[)/i.test(item),
    );
    const projectHasPytest = projectDependencies.some((item) =>
      /^pytest(?:$|[<=>~!\s]|\[)/i.test(item),
    );
    if (pythonFiles.includes('Pipfile')) {
      if (pipfileHasPytest) evidence.push('pytest installed');
    } else if (pythonFiles.includes('requirements.txt')) {
      if (requirementsHavePytest || pytestExtra) evidence.push('pytest installed');
      if (pytestExtra) {
        evidence.push(`install pytest extra:${pytestExtra[0]}`);
      }
    } else if (project || asRecord(pyprojectToml['build-system'])) {
      if (projectHasPytest) evidence.push('pytest installed');
      if (pytestExtra) {
        evidence.push(`pytest extra:${pytestExtra[0]}`);
        evidence.push('pytest installed');
      }
    }
    if (project || asRecord(pyprojectToml['build-system']))
      evidence.push('pyproject installable project');
    const pythonText = `${projectDependencies.join('\n')}\n${requirements}\n${pipfile}`;
    const pythonFramework = ['django', 'fastapi', 'flask'].find((name) =>
      pythonText.toLowerCase().includes(name),
    );
    if (pythonFramework) evidence.push(`framework dependency: ${pythonFramework}`);
    return {
      language: 'python',
      framework: pythonFramework,
      packageManager: 'pip',
      workspace: false,
      scripts: [],
      evidence,
    };
  }
  if (existsSync(join(repoPath, 'go.mod')))
    return {
      language: 'go',
      packageManager: 'go',
      workspace: false,
      scripts: [],
      evidence: ['go.mod'],
    };
  if (existsSync(join(repoPath, 'Cargo.toml')))
    return {
      language: 'rust',
      packageManager: 'cargo',
      workspace: false,
      scripts: [],
      evidence: ['Cargo.toml'],
    };
  const dotnetFiles = globbySync(['**/*.{sln,csproj}'], {
    cwd: repoPath,
    onlyFiles: true,
    gitignore: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/dist/**'],
  });
  const hasDotnetProject = dotnetFiles.length > 0;
  if (hasDotnetProject) {
    evidence.push(...dotnetFiles);
    if (existsSync(join(repoPath, 'global.json'))) evidence.push('global.json');
    const projectFile = dotnetFiles.find((file) => file.endsWith('.sln')) ?? dotnetFiles[0];
    let sdkVersion: string | undefined;
    const globalJsonPath = join(repoPath, 'global.json');
    if (existsSync(globalJsonPath)) {
      try {
        const globalJson = asRecord(JSON.parse(readFileSync(globalJsonPath, 'utf8')));
        const version = asRecord(globalJson?.sdk)?.version;
        if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
          sdkVersion = version;
        }
      } catch {
        // Ignore malformed SDK pins and infer the SDK from the project target.
      }
    }
    if (!sdkVersion && projectFile.endsWith('.csproj')) {
      try {
        const project = readFileSync(join(repoPath, projectFile), 'utf8');
        const targetFramework = project.match(/<TargetFrameworks?>\s*([^<]+)</i)?.[1];
        const targetMajor = targetFramework?.match(/net(\d+)\./i)?.[1];
        if (targetMajor) sdkVersion = `${targetMajor}.x`;
      } catch {
        // Keep the default SDK version when a project file cannot be read.
      }
    }
    if (sdkVersion) evidence.push(`.NET SDK ${sdkVersion}`);
    return {
      language: 'dotnet',
      packageManager: 'dotnet',
      projectFile,
      sdkVersion,
      workspace: false,
      scripts: [],
      evidence,
    };
  }
  return { language: 'unknown', workspace: false, scripts: [], evidence };
}

function detectPackageManager(
  repoPath: string,
  packageJson: Record<string, unknown> | null,
): { manager?: CicdStackProfile['packageManager']; version?: string; evidence?: string } {
  const declared =
    typeof packageJson?.packageManager === 'string' ? packageJson.packageManager.split('@')[0] : '';
  const candidates = ['pnpm', 'yarn', 'bun', 'npm'] as const;
  if (candidates.includes(declared as (typeof candidates)[number])) {
    const lock = (
      {
        pnpm: 'pnpm-lock.yaml',
        yarn: 'yarn.lock',
        bun: 'bun.lock',
        npm: 'package-lock.json',
      } as const
    )[declared as (typeof candidates)[number]];
    const lockEvidence = existsSync(join(repoPath, lock)) ? `; ${lock}` : '';
    const yarnMajor =
      declared === 'yarn' && String(packageJson?.packageManager).match(/^yarn@(\d+)/)?.[1];
    const yarnVersionEvidence =
      yarnMajor && Number(yarnMajor) >= 2 && lockEvidence ? '; yarn.lock (Yarn Berry)' : '';
    const packageManager = String(packageJson?.packageManager);
    const candidateVersion = packageManager.split('@').slice(1).join('@').split('+')[0];
    const version = /^\d+(?:\.\d+){0,2}(?:-[A-Za-z0-9.-]+)?$/.test(candidateVersion)
      ? candidateVersion
      : undefined;
    const safePackageManagerEvidence = packageManager.replace(/[\r\n\0]/g, ' ').slice(0, 100);
    return {
      manager: declared as (typeof candidates)[number],
      version,
      evidence: `packageManager: ${safePackageManagerEvidence}${lockEvidence}${yarnVersionEvidence}`,
    };
  }
  const lockfiles = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ] as const;
  for (const [file, name] of lockfiles) {
    if (existsSync(join(repoPath, file))) {
      const yarnMajor =
        name === 'yarn' && String(packageJson?.packageManager ?? '').match(/^yarn@(\d+)/)?.[1];
      const yarnMetadata =
        name === 'yarn' && readFileSync(join(repoPath, file), 'utf8').includes('__metadata:');
      const detail =
        name === 'yarn' && ((yarnMajor && Number(yarnMajor) >= 2) || yarnMetadata)
          ? 'yarn.lock (Yarn Berry)'
          : file;
      return { manager: name, evidence: detail };
    }
  }
  if (packageJson)
    return { manager: 'npm', evidence: 'package.json (npm default; no lockfile found)' };
  return {};
}

function detectNodeFramework(dependencies: string[]): string | undefined {
  const names = new Set(dependencies);
  const framework = [
    ['next', 'Next.js'],
    ['vite', 'Vite'],
    ['@angular/core', 'Angular'],
    ['nuxt', 'Nuxt'],
    ['react-scripts', 'Create React App'],
    ['astro', 'Astro'],
    ['svelte', 'Svelte'],
    ['@nestjs/core', 'NestJS'],
    ['express', 'Express'],
  ] as const;
  return framework.find(([dependency]) => names.has(dependency))?.[1];
}

function readWorkspaceScripts(
  repoPath: string,
  packageJson: Record<string, unknown>,
  rootScripts: string[],
): Array<{ name: string; scripts: string[] }> {
  const rawWorkspaces = packageJson.workspaces;
  const patterns = Array.isArray(rawWorkspaces)
    ? rawWorkspaces.filter((item): item is string => typeof item === 'string')
    : Array.isArray(asRecord(rawWorkspaces)?.packages)
      ? (asRecord(rawWorkspaces)?.packages as unknown[]).filter(
          (item): item is string => typeof item === 'string',
        )
      : [];
  if (existsSync(join(repoPath, 'pnpm-workspace.yaml'))) {
    try {
      const parsed = parseDocument(
        readFileSync(join(repoPath, 'pnpm-workspace.yaml'), 'utf8'),
      ).toJS();
      const pnpmPatterns = asRecord(parsed)?.packages;
      if (Array.isArray(pnpmPatterns))
        patterns.push(...pnpmPatterns.filter((item): item is string => typeof item === 'string'));
    } catch {
      // A malformed workspace file must not stop CI recommendations.
    }
  }
  const packageGlobs = patterns.map((pattern) => `${pattern.replace(/\/$/, '')}/package.json`);
  if (!packageGlobs.length) return [];
  const manifests = globbySync(packageGlobs, {
    cwd: repoPath,
    onlyFiles: true,
    gitignore: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/dist/**', '**/vendor/**'],
  });
  const targets: Array<{ name: string; scripts: string[] }> = [];
  for (const manifest of manifests) {
    try {
      const child = asRecord(JSON.parse(readFileSync(join(repoPath, manifest), 'utf8')));
      const scripts = Object.keys(asRecord(child?.scripts) ?? {}).filter(
        (name) => /^[\w:-]+$/.test(name) && !rootScripts.includes(name),
      );
      if (!scripts.length) continue;
      const name =
        typeof child?.name === 'string' ? child.name : manifest.replace(/\/package\.json$/, '');
      targets.push({ name, scripts });
    } catch {
      // Ignore malformed package manifests and keep usable recommendations.
    }
  }
  return targets;
}

function workspaceRunCommands(
  manager: CicdStackProfile['packageManager'],
  script: string,
  yarnBerry: boolean,
  targets: Array<{ name: string; scripts: string[] }>,
): string[] {
  if (manager === 'pnpm') return [`pnpm -r --if-present run ${script}`];
  if (manager === 'npm') return [`npm run ${script} --workspaces --if-present`];
  if (manager === 'yarn') {
    if (yarnBerry) return [`yarn workspaces foreach --all run ${script}`];
    return targets
      .filter((target) => target.scripts.includes(script))
      .map((target) => `yarn workspace ${shellQuote(target.name)} run ${script}`);
  }
  if (manager === 'bun') {
    return targets
      .filter((target) => target.scripts.includes(script))
      .map((target) => `bun run --filter ${shellQuote(target.name)} ${script}`);
  }
  return [`npm run ${script} --workspaces --if-present`];
}

function recommendPipelines(
  stack: CicdStackProfile,
  providers: CicdProvider[],
): CicdPipelineRecommendation[] {
  const template =
    stack.language === 'node'
      ? 'node-ci'
      : stack.language === 'python'
        ? 'python-ci'
        : stack.language === 'go'
          ? 'go-ci'
          : stack.language === 'rust'
            ? 'rust-ci'
            : stack.language === 'dotnet'
              ? 'dotnet-ci'
              : 'generic-ci';
  const commands = commandsForStack(stack, template);
  const existingProvider = providers.includes('github-actions')
    ? 'github-actions'
    : providers.includes('azure-pipelines') && template.startsWith('dotnet')
      ? 'azure-pipelines'
      : 'github-actions';
  const primaryTemplate =
    existingProvider === 'azure-pipelines' && template === 'dotnet-ci' ? 'dotnet-azure' : template;
  const evidence = stack.evidence.length
    ? stack.evidence.slice(0, 6)
    : ['No supported language or package manifest found'];
  const recommendation: CicdPipelineRecommendation = {
    rank: 1,
    template: primaryTemplate,
    provider: existingProvider,
    title: titleForTemplate(primaryTemplate),
    reason:
      stack.language === 'unknown'
        ? 'No supported stack markers were found. This starter contains a safe placeholder only.'
        : `Matches the detected ${stack.framework ? `${stack.framework} ` : ''}${stack.language} stack${stack.scripts.length || stack.workspaceScripts?.length ? ` and uses available scripts` : ''}.`,
    evidence,
    commands:
      primaryTemplate === 'dotnet-azure'
        ? [
            `dotnet restore${stack.projectFile ? ` ${shellQuote(stack.projectFile)}` : ''}`,
            `dotnet test${stack.projectFile ? ` ${shellQuote(stack.projectFile)}` : ''} --configuration Release`,
          ]
        : commands.length
          ? commands
          : ['No build, test, or lint command detected'],
    recommended: true,
  };
  const items = [recommendation];
  if (stack.language === 'dotnet' && existingProvider === 'github-actions') {
    items.push({
      ...recommendation,
      rank: 2,
      template: 'dotnet-azure',
      provider: 'azure-pipelines',
      title: '.NET Azure Pipeline',
      reason: 'Azure Pipelines is another fit for this .NET repository.',
      commands: [
        `dotnet restore${stack.projectFile ? ` ${shellQuote(stack.projectFile)}` : ''}`,
        `dotnet test${stack.projectFile ? ` ${shellQuote(stack.projectFile)}` : ''} --configuration Release`,
      ],
      recommended: false,
    });
  }
  if (stack.language !== 'unknown' && !providers.length) {
    items.push({
      ...recommendation,
      rank: items.length + 1,
      template: 'gated-release',
      provider: 'github-actions',
      title: 'Gated Release',
      reason:
        'Adds a production environment hook. Configure required reviewers in GitHub environment settings to pause for approval.',
      commands: ['Build and security commands are placeholders', 'Deploy step is a placeholder'],
      recommended: false,
    });
  }
  return items;
}

function titleForTemplate(template: CicdCreatePipelineInput['template']): string {
  return {
    'node-ci': 'Node CI',
    'python-ci': 'Python CI',
    'go-ci': 'Go CI',
    'rust-ci': 'Rust CI',
    'dotnet-ci': '.NET CI',
    'dotnet-azure': '.NET Azure Pipeline',
    'gated-release': 'Gated Release',
    'generic-ci': 'Generic CI',
  }[template];
}

function yamlScalar(value: string): string {
  return JSON.stringify(value.replace(/[\r\n\0]/g, ' '));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function existsLockfileForManager(stack: CicdStackProfile, manager: string): boolean {
  return stack.evidence.some(
    (item) =>
      manager === 'npm' &&
      (item.includes('package-lock.json') || item.includes('npm-shrinkwrap.json')),
  );
}

function isSupportedProvider(provider: string): provider is CicdProvider {
  return provider === 'github-actions' || provider === 'azure-pipelines';
}

function isSupportedTemplate(template: string): template is CicdCreatePipelineInput['template'] {
  return [
    'node-ci',
    'python-ci',
    'go-ci',
    'rust-ci',
    'dotnet-ci',
    'dotnet-azure',
    'gated-release',
    'generic-ci',
  ].includes(template);
}

function isCompatibleTemplate(
  template: CicdCreatePipelineInput['template'],
  language: CicdStackProfile['language'],
): boolean {
  if (language === 'unknown' || template === 'generic-ci' || template === 'gated-release')
    return true;
  const expectedLanguage: Partial<
    Record<CicdCreatePipelineInput['template'], CicdStackProfile['language']>
  > = {
    'node-ci': 'node',
    'python-ci': 'python',
    'go-ci': 'go',
    'rust-ci': 'rust',
    'dotnet-ci': 'dotnet',
    'dotnet-azure': 'dotnet',
  };
  return expectedLanguage[template] === language;
}

function assertNoSymlinkedParent(repoPath: string, filePath: string): void {
  let current = repoPath;
  for (const part of dirname(filePath).split('/').filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error('Pipeline path cannot pass through a symbolic link.');
    }
  }
}

function pipelineDisplayName(filePath: string, data: unknown): string {
  return stringValue(asRecord(data)?.name) ?? filePath.split('/').pop() ?? filePath;
}

function triggerSubtitle(trigger: unknown): string {
  if (typeof trigger === 'string') return trigger;
  if (Array.isArray(trigger)) return trigger.join(', ');
  const keys = Object.keys(asRecord(trigger) ?? {});
  return keys.length ? keys.join(', ') : 'manual';
}

function azureTriggerSubtitle(root: Record<string, unknown> | null): string {
  const triggers = [];
  if (root?.trigger) triggers.push('CI');
  if (root?.pr) triggers.push('PR');
  if (root?.schedules) triggers.push('schedule');
  return triggers.length ? triggers.join(' + ') : 'manual';
}

function environmentName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return stringValue(asRecord(value)?.name);
}

function needsList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function makeNode(
  provider: CicdProvider,
  type: CicdFlowNode['type'],
  filePath: string,
  label: string,
  subtitle: string | undefined,
  depth: number,
  id = nodeId(filePath, `${type}:${label}`),
  status: CicdFlowNode['status'] = 'configured',
  metadata?: CicdFlowNode['metadata'],
): CicdFlowNode {
  return { id, type, provider, filePath, label, subtitle, depth, status, metadata };
}

function makeFinding(
  severity: CicdValidationFinding['severity'],
  file: ParsedPipelineFile,
  message: string,
  nodeIdValue?: string,
): CicdValidationFinding {
  return {
    id: findingId(file.path, `${severity}:${message}`),
    severity,
    provider: file.provider,
    filePath: file.path,
    message,
    nodeId: nodeIdValue,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function trimLabel(value: string): string {
  return value.replace(/\s+/g, ' ').slice(0, 80);
}

function normalizePipelinePath(pathValue: string): string {
  return normalize(pathValue).split(sep).join('/');
}

function isSafeRelativePath(pathValue: string): boolean {
  return (
    !pathValue.startsWith('..') &&
    !pathValue.startsWith('/') &&
    !/^[a-zA-Z]:/.test(pathValue) &&
    !pathValue.includes('\\') &&
    !pathValue.includes('\0')
  );
}

function nodeId(filePath: string, key: string): string {
  return `${filePath}::${key}`;
}

function findingId(filePath: string, key: string): string {
  return `${filePath}::${key}`.replace(/[^a-zA-Z0-9:_./-]/g, '-');
}

export function relativePipelinePath(repoPath: string, absolutePath: string): string {
  return normalizePipelinePath(relative(repoPath, absolutePath));
}
