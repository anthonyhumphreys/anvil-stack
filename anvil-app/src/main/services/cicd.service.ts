import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { globby } from 'globby';
import { parseDocument, isMap, isSeq, isScalar, type Document, type ParsedNode } from 'yaml';
import type {
  CicdFlowEdge,
  CicdFlowNode,
  CicdCreatePipelineInput,
  CicdCreatePipelineResult,
  CicdPipelineAnalysis,
  CicdPipelineFile,
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

  return {
    repoId,
    repoName,
    generatedAt: new Date().toISOString(),
    files: Array.from(parsedFiles.values()).map(({ doc: _doc, data: _data, ...file }) => file),
    nodes,
    edges,
    findings,
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
  const filePath = normalizePipelinePath(
    input.filePath?.trim() || defaultPipelinePath(input.provider, input.template),
  );
  if (!isSafeRelativePath(filePath) || !YAML_EXT_RE.test(filePath)) {
    throw new Error('Pipeline path must be a relative .yml or .yaml file inside the repository.');
  }

  const absolutePath = join(repoPath, filePath);
  if (existsSync(absolutePath)) {
    throw new Error(`Pipeline file already exists: ${filePath}`);
  }

  const content = renderPipelineTemplate(input);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
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
    findings.push(makeFinding('error', file, 'This workflow does not define any jobs.', workflowId));
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
        uses ? `Reusable workflow: ${uses}` : stringValue(job?.['runs-on']) ?? 'Runner not set',
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
      findings.push(makeFinding('warning', file, `Job "${jobKey}" has no runner or reusable workflow.`, jobNodeId));
    }

    if (environment) {
      const gateNodeId = nodeId(file.path, `gate:${jobKey}:${environment}`);
      nodes.push(
        makeNode('github-actions', 'gate', file.path, environment, 'Environment protection', 2, gateNodeId),
      );
      edges.push({ from: gateNodeId, to: jobNodeId, label: 'approves' });
    }

    const steps = asArray(job?.steps);
    steps.slice(0, 8).forEach((stepRaw, index) => {
      const step = asRecord(stepRaw);
      const label = stringValue(step?.name) ?? stringValue(step?.uses) ?? stringValue(step?.run) ?? `Step ${index + 1}`;
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
    findings.push(makeFinding('warning', file, 'This pipeline has no CI, PR, or scheduled trigger.', pipelineId));
  }

  const stages = asArray(root?.stages);
  const jobs = asArray(root?.jobs);
  const steps = asArray(root?.steps);

  if (stages.length === 0 && jobs.length === 0 && steps.length === 0) {
    findings.push(makeFinding('error', file, 'This pipeline does not define stages, jobs, or steps.', pipelineId));
    return;
  }

  if (stages.length > 0) {
    stages.forEach((rawStage, index) => {
      const stage = asRecord(rawStage);
      const label = stringValue(stage?.stage) ?? stringValue(stage?.template) ?? `Stage ${index + 1}`;
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
          (isDeployment ? `Environment: ${environmentName(job?.environment) ?? 'not set'}` : undefined),
        depth,
        jobNodeId,
      ),
    );
    edges.push({ from: parentNodeId, to: jobNodeId, label: job?.dependsOn ? 'dependsOn' : undefined });

    const environment = environmentName(job?.environment);
    if (isDeployment && environment) {
      const gateNodeId = nodeId(file.path, `gate:${label}:${environment}`);
      nodes.push(makeNode('azure-pipelines', 'gate', file.path, environment, 'Deployment environment', depth + 1, gateNodeId));
      edges.push({ from: gateNodeId, to: jobNodeId, label: 'approves' });
    }

    if (!isTemplate && !job?.pool && !job?.uses && !job?.strategy) {
      findings.push(makeFinding('info', file, `Job "${label}" does not set a pool; it may rely on a default.`, jobNodeId));
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

function renderPipelineTemplate(input: CicdCreatePipelineInput): string {
  if (input.provider === 'github-actions') {
    if (input.template === 'gated-release') {
      return [
        `name: ${input.name || 'Gated Release'}`,
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
        '        run: echo "build"',
        '',
        '  security:',
        '    needs: build',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Security scan',
        '        run: echo "scan"',
        '',
        '  production:',
        '    needs: security',
        '    runs-on: ubuntu-latest',
        '    environment: production',
        '    steps:',
        '      - name: Deploy',
        '        run: echo "deploy"',
        '',
      ].join('\n');
    }

    return [
      `name: ${input.name || 'Node CI'}`,
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
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: 22',
      '          cache: pnpm',
      '      - uses: pnpm/action-setup@v4',
      '        with:',
      '          version: 10',
      '      - run: pnpm install --frozen-lockfile',
      '      - run: pnpm lint',
      '      - run: pnpm test',
      '      - run: pnpm build',
      '',
    ].join('\n');
  }

  return [
    `name: ${input.name || 'Azure CI'}`,
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
    "              version: '8.x'",
    '          - script: dotnet restore',
    '            displayName: Restore',
    '          - script: dotnet test --configuration Release',
    '            displayName: Test',
    '          - script: dotnet publish --configuration Release --output $(Build.ArtifactStagingDirectory)',
    '            displayName: Publish',
    '          - publish: $(Build.ArtifactStagingDirectory)',
    '            artifact: drop',
    '',
  ].join('\n');
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
  return !pathValue.startsWith('..') && !pathValue.startsWith('/') && !pathValue.includes('\0');
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
