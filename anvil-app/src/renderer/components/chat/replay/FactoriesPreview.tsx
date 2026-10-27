import type {
  FactoryDefinition,
  FactoryDefinitionInput,
  FactoryDirectoryItem,
  FactoryEvidence,
  FactoryPreview,
  FactoryReceipt,
  FactoryRun,
  FactoryRunStage,
} from '../../../../shared/factories';
import { factoryWorkerThreadId } from '../../../../shared/factories';
import type {
  Persona,
  PublicWorkflowRun,
  RepoInfo,
  WorkflowNode,
  WorkflowTemplate,
  WorkspaceWithRepos,
} from '../../../../shared/types';
import { WorkspaceProvider } from '../../../contexts/WorkspaceContext';
import { FactoriesView } from '../../factories/FactoriesView';
import { WorkflowsView } from '../../workflows/WorkflowsView';

/*
 * Synthetic factory backend for visual verification in the standalone replay.
 * Nothing here reaches GitHub, Codex or the automation daemon; every response is
 * fabricated in memory and labelled as such where it surfaces as copy.
 */

const minute = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * minute).toISOString();
const ahead = (minutes: number) => new Date(Date.now() + minutes * minute).toISOString();
const sha = (seed: string) =>
  Array.from({ length: 40 }, (_, index) =>
    ((seed.charCodeAt(index % seed.length) * (index + 7)) % 16).toString(16),
  ).join('');

const repos: RepoInfo[] = [
  {
    id: 'repo-storefront',
    name: 'storefront',
    path: '/Users/demo/code/storefront',
    remoteUrl: 'git@github.com:acme/storefront.git',
    defaultBranch: 'main',
    languages: [],
    status: 'indexed',
    fileCount: 1840,
    branchCount: 12,
  },
  {
    id: 'repo-docs',
    name: 'docs',
    path: '/Users/demo/code/docs',
    remoteUrl: 'https://github.com/acme/docs.git',
    defaultBranch: 'main',
    languages: [],
    status: 'indexed',
    fileCount: 320,
    branchCount: 3,
  },
];

const workspace: WorkspaceWithRepos = {
  id: 'ws-acme',
  name: 'Acme storefront',
  syncSelected: false,
  createdAt: ago(60 * 24 * 30),
  updatedAt: ago(60),
  repos,
};

const personas = [
  { id: 'architect', name: 'Architect' },
  { id: 'coder', name: 'Coder' },
  { id: 'reviewer', name: 'Reviewer' },
].map(
  (persona) =>
    ({
      ...persona,
      icon: 'bot',
      colour: '#5ec8ff',
      description: '',
      systemPromptTemplate: '',
      capabilities: { canWriteFiles: true, canRunCommands: true, canReadFiles: true },
    }) satisfies Persona,
);

function node(
  id: string,
  name: string,
  personaId: string,
  x: number,
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    name,
    prompt: `${name} the issue.`,
    personaId,
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    executionStrategy: 'focused',
    position: { x, y: 0 },
    ...extra,
  };
}

let templates: WorkflowTemplate[] = [
  {
    id: 'tpl-plan-build-review',
    name: 'Plan, implement, review',
    description: 'Planner clarifies scope, implementer writes the change, reviewer checks it.',
    nodes: [
      node('plan', 'Plan', 'architect', 0, { reasoningEffort: 'xhigh' }),
      node('build', 'Implement', 'coder', 330),
      node('review', 'Review', 'reviewer', 660, { model: 'gpt-5.6-sol-mini' }),
    ],
    edges: [
      { id: 'e1', source: 'plan', target: 'build' },
      { id: 'e2', source: 'build', target: 'review' },
    ],
    createdAt: ago(60 * 24 * 12),
    updatedAt: ago(60 * 5),
  },
  {
    id: 'tpl-single',
    name: 'Single implementer',
    description: 'One focused Codex worker.',
    nodes: [node('solo', 'Implement', 'coder', 0)],
    edges: [],
    createdAt: ago(60 * 24 * 20),
    updatedAt: ago(60 * 24 * 20),
  },
  {
    id: 'tpl-cloud',
    name: 'Cloud swarm',
    description: 'Parallel workers in provisioned sandboxes.',
    nodes: [
      node('fan', 'Fan out', 'coder', 0, {
        target: { kind: 'provisioned-environment', provider: 'vercel-sandbox', ttlSeconds: 900 },
      } as Partial<WorkflowNode>),
    ],
    edges: [],
    createdAt: ago(60 * 24 * 3),
    updatedAt: ago(60 * 24 * 3),
  },
  {
    id: 'tpl-cursor',
    name: 'Cursor pair',
    description: 'Cursor agent drafts, Codex reviews.',
    nodes: [
      node('draft', 'Draft', 'coder', 0, { provider: 'cursor', model: 'auto' }),
      node('check', 'Check', 'reviewer', 330),
    ],
    edges: [{ id: 'e1', source: 'draft', target: 'check' }],
    createdAt: ago(60 * 24 * 2),
    updatedAt: ago(60 * 24 * 2),
  },
];

const baseDefinition = (
  overrides: Partial<FactoryDefinitionInput> = {},
): FactoryDefinitionInput => ({
  name: 'Ready issues to reviewed PR',
  workspaceId: workspace.id,
  repoId: 'repo-storefront',
  github: {
    host: 'github.com',
    owner: 'acme',
    repo: 'storefront',
    label: 'ready-for-agent',
    baseBranch: 'main',
  },
  workflowTemplateId: 'tpl-plan-build-review',
  criteria: [
    'Unit tests cover the reported behaviour and pass.',
    'Type checks pass with no new suppressions.',
    'Lint passes on changed files.',
  ],
  checks: ['pnpm test --run', 'pnpm typecheck', 'pnpm lint'],
  postMergeChecks: ['pnpm test --run'],
  limits: { repairRounds: 2, maxRunMinutes: 90, maxCommands: 40, maxConcurrentRuns: 3 },
  publication: { enabled: true, draft: true },
  merge: {
    mode: 'human-approved',
    method: 'squash',
    requiredChecks: ['ci / test', 'ci / build'],
    requireApproval: true,
  },
  access: { kind: 'private' },
  ...overrides,
});

const pinned = (templateId: string, at: string): WorkflowTemplate => {
  const template = templates.find((item) => item.id === templateId)!;
  return { ...structuredClone(template), updatedAt: at };
};

// The template's review step moved to a smaller model after this copy was pinned.
const pinnedBeforeEdit = (): WorkflowTemplate => {
  const copy = pinned('tpl-plan-build-review', ago(60 * 24 * 2));
  copy.nodes = copy.nodes.map((item) =>
    item.id === 'review' ? { ...item, model: 'gpt-5.6-sol' } : item,
  );
  return copy;
};

// Pinned from a saved workflow that has since been deleted.
const orphanedPin = (): WorkflowTemplate => ({
  id: 'tpl-deleted',
  name: 'Dependency updater',
  description: 'Bump, run the suite, summarise breaking changes.',
  nodes: [
    node('bump', 'Bump dependencies', 'coder', 0),
    node('notes', 'Summarise changes', 'reviewer', 330, { model: 'gpt-5.6-sol-mini' }),
  ],
  edges: [{ id: 'e1', source: 'bump', target: 'notes' }],
  createdAt: ago(60 * 24 * 60),
  updatedAt: ago(60 * 24 * 60),
});

let factories: FactoryDefinition[] = [
  {
    id: 'factory-ready',
    workspaceId: workspace.id,
    revision: 3,
    activeRevision: 3,
    status: 'active',
    ownerId: 'local:demo',
    accountScope: 'local:demo',
    definition: baseDefinition(),
    workflow: pinnedBeforeEdit(),
    confirmation: sha('ready-3'),
    activatedAt: ago(60 * 24 * 6),
    createdAt: ago(60 * 24 * 9),
    updatedAt: ago(60 * 24 * 2),
    effectiveRole: 'owner',
    sourceAccess: true,
    executionOwner: true,
    remote: false,
  },
  {
    id: 'factory-docs',
    workspaceId: workspace.id,
    revision: 5,
    activeRevision: 5,
    status: 'paused',
    ownerId: 'user:sam',
    accountScope: 'org:acme',
    definition: baseDefinition({
      name: 'Docs typo sweeper',
      repoId: 'repo-docs',
      github: {
        host: 'github.com',
        owner: 'acme',
        repo: 'docs',
        label: 'docs:typo',
        baseBranch: 'main',
      },
      workflowTemplateId: 'tpl-single',
      criteria: ['The docs site builds.'],
      checks: ['pnpm build'],
      postMergeChecks: ['pnpm build'],
      limits: { repairRounds: 1, maxRunMinutes: 30, maxCommands: 12, maxConcurrentRuns: 4 },
      merge: {
        mode: 'auto-merge',
        method: 'squash',
        requiredChecks: ['docs / build'],
        requireApproval: false,
      },
      access: {
        kind: 'organization',
        organizationId: 'acme',
        visibility: 'team',
        teamId: 'docs-maintainers',
        members: [
          { userId: 'sam@acme.dev', role: 'owner' },
          { userId: 'riley@acme.dev', role: 'operator' },
        ],
      },
    }),
    workflow: pinned('tpl-single', ago(60 * 24 * 20)),
    confirmation: sha('docs-5'),
    activatedAt: ago(60 * 24 * 40),
    createdAt: ago(60 * 24 * 41),
    updatedAt: ago(60 * 26),
    effectiveRole: 'operator',
    sourceAccess: true,
    organizationAdmin: false,
    executionOwner: false,
    remote: true,
  },
  {
    id: 'factory-security',
    workspaceId: workspace.id,
    revision: 1,
    status: 'draft',
    ownerId: 'local:demo',
    accountScope: 'local:demo',
    definition: baseDefinition({
      name: 'Dependency bumps',
      github: {
        host: 'github.com',
        owner: 'acme',
        repo: 'storefront',
        label: 'deps',
        baseBranch: 'main',
      },
      workflowTemplateId: 'tpl-deleted',
      criteria: ['The full test suite passes.'],
      checks: ['pnpm test --run'],
      limits: { repairRounds: 1, maxRunMinutes: 45, maxCommands: 20, maxConcurrentRuns: 1 },
    }),
    workflow: orphanedPin(),
    confirmation: sha('deps-1'),
    createdAt: ago(60 * 3),
    updatedAt: ago(60 * 3),
    effectiveRole: 'owner',
    sourceAccess: true,
    executionOwner: true,
    remote: false,
  },
];

function evidence(head: string, outcomes: Array<'passed' | 'failed'>, at: string): FactoryEvidence {
  const definition = factories[0].definition;
  return {
    headSha: head,
    treeSha: sha(`${head}-tree`),
    passed: outcomes.every((outcome) => outcome === 'passed'),
    checkedAt: at,
    criteria: outcomes.map((status, index) => ({
      criterion: definition.criteria[index],
      status,
      evidence:
        status === 'passed'
          ? `${definition.checks[index]} exited 0`
          : `${definition.checks[index]} exited 1 — 1 failed, 214 passed`,
    })),
    commands: outcomes.map((status, index) => ({
      command: definition.checks[index],
      exitCode: status === 'passed' ? 0 : 1,
      output:
        status === 'passed'
          ? 'Synthetic output: all checks passed.'
          : 'FAIL src/order/OrderSummary.test.tsx\n  ✕ renders discounted total (14 ms)\n\n  Expected: "$42.00"\n  Received: "$44.10"\n\nTests: 1 failed, 214 passed',
    })),
  };
}

function receipt(
  runId: string,
  kind: FactoryReceipt['kind'],
  status: FactoryReceipt['status'],
  at: string,
  error?: string,
): FactoryReceipt {
  return {
    id: `${runId}-${kind}-${at}`,
    runId,
    key: `${runId}:${kind}`,
    kind,
    status,
    createdAt: at,
    updatedAt: at,
    ...(error ? { error } : {}),
  };
}

interface RunSeed {
  id: string;
  number: number;
  title: string;
  stage: FactoryRunStage;
  startedMinutesAgo: number;
  updatedMinutesAgo: number;
  commandsUsed: number;
  repairRounds?: number;
  resumeStage?: FactoryRunStage;
  error?: string;
  pr?: boolean;
  checks?: Array<{ name: string; status: 'pending' | 'passed' | 'failed' }>;
  review?: 'approved' | 'changes-requested' | 'pending' | 'not-required';
  evidence?: Array<'passed' | 'failed'>;
  postMerge?: boolean;
  receipts: Array<[FactoryReceipt['kind'], FactoryReceipt['status'], number, string?]>;
  takeover?: boolean;
  body?: string;
}

function makeRun(seed: RunSeed, factory = factories[0]): FactoryRun {
  const head = sha(`head-${seed.id}`);
  const run: FactoryRun = {
    id: seed.id,
    factoryId: factory.id,
    revision: factory.revision,
    workspaceId: workspace.id,
    snapshot: factory,
    issue: {
      number: seed.number,
      title: seed.title,
      body:
        seed.body ??
        `Steps to reproduce\n\n1. Open the storefront.\n2. Follow the flow described in the title.\n\nAcceptance criteria\n- The behaviour matches the title.\n- Tests cover the regression.`,
      url: `https://github.com/acme/storefront/issues/${seed.number}`,
      labels: ['ready-for-agent'],
      state: 'open',
      createdAt: ago(seed.startedMinutesAgo + 30),
      updatedAt: ago(seed.updatedMinutesAgo),
    },
    stage: seed.stage,
    version: 4,
    repairRounds: seed.repairRounds ?? 0,
    commandsUsed: seed.commandsUsed,
    createdAt: ago(seed.startedMinutesAgo),
    updatedAt: ago(seed.updatedMinutesAgo),
    deadlineAt: ahead(factory.definition.limits.maxRunMinutes - seed.startedMinutesAgo),
    checkout: {
      path: `/tmp/anvil-factory/${seed.id}`,
      branch: `factory/issue-${seed.number}`,
      baseSha: sha('base'),
    },
    workflowRunId: `wf-${seed.id}`,
    workerThreadId: factoryWorkerThreadId(seed.id),
    receipts: seed.receipts.map(([kind, status, minutes, error]) =>
      receipt(seed.id, kind, status, ago(minutes), error),
    ),
    effectiveRole: 'owner',
    sourceAccess: true,
    executionOwner: true,
    remote: false,
    ...(seed.resumeStage ? { resumeStage: seed.resumeStage } : {}),
    ...(seed.error ? { error: seed.error } : {}),
  };
  if (seed.evidence) run.evidence = evidence(head, seed.evidence, ago(seed.updatedMinutesAgo + 2));
  if (seed.pr) {
    run.pullRequest = {
      number: 1200 + seed.number - 400,
      url: `https://github.com/acme/storefront/pull/${1200 + seed.number - 400}`,
      headSha: head,
      branch: `factory/issue-${seed.number}`,
      baseBranch: 'main',
      draft: seed.stage !== 'completed',
    };
    run.observation = {
      headSha: head,
      state: seed.stage === 'completed' ? 'merged' : 'open',
      draft: seed.stage !== 'completed',
      checks: (seed.checks ?? []).map((check) => ({ ...check, headSha: head })),
      review: seed.review ?? 'pending',
      feedback: [],
      observedAt: ago(Math.max(0, seed.updatedMinutesAgo - 1)),
      ...(seed.stage === 'completed' ? { mergeCommitSha: sha(`merge-${seed.id}`) } : {}),
    };
  }
  if (seed.postMerge) {
    run.postMergeEvidence = {
      ...evidence(sha(`merge-${seed.id}`), ['passed'], ago(seed.updatedMinutesAgo)),
      criteria: [
        {
          criterion: 'Post-merge check',
          status: 'passed',
          evidence: 'pnpm test --run exited 0 on the merge commit',
        },
      ],
    };
  }
  if (seed.takeover) run.takeoverThreadId = 'factory-takeover-demo';
  return run;
}

let runs: FactoryRun[] = [
  makeRun({
    id: 'run-482',
    number: 482,
    title: 'Checkout keeps the stale cart total after a coupon is removed',
    stage: 'implementing',
    startedMinutesAgo: 14,
    updatedMinutesAgo: 0,
    commandsUsed: 11,
    receipts: [
      ['checkout', 'succeeded', 13],
      ['workflow', 'intent', 12],
    ],
  }),
  makeRun({
    id: 'run-475',
    number: 475,
    title: 'Retry webhook delivery with exponential backoff',
    stage: 'awaiting-merge-approval',
    startedMinutesAgo: 71,
    updatedMinutesAgo: 3,
    commandsUsed: 24,
    pr: true,
    checks: [
      { name: 'ci / test', status: 'passed' },
      { name: 'ci / build', status: 'passed' },
      { name: 'ci / e2e', status: 'passed' },
    ],
    review: 'approved',
    evidence: ['passed', 'passed', 'passed'],
    receipts: [
      ['checkout', 'succeeded', 70],
      ['workflow', 'succeeded', 41],
      ['verify', 'succeeded', 38],
      ['publish', 'succeeded', 36],
    ],
  }),
  makeRun({
    id: 'run-479',
    number: 479,
    title: 'Search input loses focus after filters update',
    stage: 'waiting-checks',
    startedMinutesAgo: 38,
    updatedMinutesAgo: 1,
    commandsUsed: 19,
    pr: true,
    checks: [
      { name: 'ci / test', status: 'passed' },
      { name: 'ci / build', status: 'pending' },
      { name: 'ci / e2e', status: 'pending' },
    ],
    review: 'pending',
    evidence: ['passed', 'passed', 'passed'],
    receipts: [
      ['checkout', 'succeeded', 37],
      ['workflow', 'succeeded', 16],
      ['verify', 'succeeded', 9],
      ['publish', 'succeeded', 7],
    ],
  }),
  makeRun({
    id: 'run-468',
    number: 468,
    title: 'Address form drops the apartment line on autofill',
    stage: 'repairing',
    startedMinutesAgo: 52,
    updatedMinutesAgo: 0,
    commandsUsed: 27,
    repairRounds: 1,
    pr: true,
    checks: [
      { name: 'ci / test', status: 'failed' },
      { name: 'ci / build', status: 'passed' },
    ],
    review: 'changes-requested',
    evidence: ['passed', 'passed', 'passed'],
    receipts: [
      ['checkout', 'succeeded', 51],
      ['workflow', 'succeeded', 30],
      ['verify', 'succeeded', 27],
      ['publish', 'succeeded', 25],
      ['checkout', 'succeeded', 6],
      ['workflow', 'intent', 5],
    ],
  }),
  makeRun({
    id: 'run-471',
    number: 471,
    title: 'Flaky snapshot in the OrderSummary test',
    stage: 'blocked',
    resumeStage: 'validating',
    startedMinutesAgo: 96,
    updatedMinutesAgo: 22,
    commandsUsed: 33,
    repairRounds: 2,
    evidence: ['failed', 'passed', 'passed'],
    error: 'Acceptance checks failed and repair budget is exhausted.',
    receipts: [
      ['checkout', 'succeeded', 95],
      ['workflow', 'succeeded', 70],
      ['verify', 'failed', 66, 'pnpm test --run exited 1'],
      ['workflow', 'succeeded', 48],
      ['verify', 'failed', 44, 'pnpm test --run exited 1'],
      ['workflow', 'succeeded', 27],
      ['verify', 'failed', 22, 'pnpm test --run exited 1'],
    ],
  }),
  makeRun({
    id: 'run-466',
    number: 466,
    title: 'Gift card balance rounds half-cents incorrectly',
    stage: 'merging',
    startedMinutesAgo: 120,
    updatedMinutesAgo: 2,
    commandsUsed: 21,
    pr: true,
    checks: [
      { name: 'ci / test', status: 'passed' },
      { name: 'ci / build', status: 'passed' },
    ],
    review: 'approved',
    evidence: ['passed', 'passed', 'passed'],
    receipts: [
      ['checkout', 'succeeded', 118],
      ['workflow', 'succeeded', 90],
      ['verify', 'succeeded', 86],
      ['publish', 'succeeded', 84],
      ['merge', 'uncertain', 2, 'GitHub accepted the merge request; outcome not yet observed.'],
    ],
  }),
  makeRun({
    id: 'run-460',
    number: 460,
    title: 'Dark theme contrast in price badges',
    stage: 'completed',
    startedMinutesAgo: 60 * 26,
    updatedMinutesAgo: 60 * 24,
    commandsUsed: 18,
    pr: true,
    checks: [
      { name: 'ci / test', status: 'passed' },
      { name: 'ci / build', status: 'passed' },
    ],
    review: 'approved',
    evidence: ['passed', 'passed', 'passed'],
    postMerge: true,
    receipts: [
      ['checkout', 'succeeded', 60 * 26],
      ['workflow', 'succeeded', 60 * 25.5],
      ['verify', 'succeeded', 60 * 25.4],
      ['publish', 'succeeded', 60 * 25.3],
      ['merge', 'succeeded', 60 * 24.2],
      ['post-merge', 'succeeded', 60 * 24],
    ],
  }),
  makeRun({
    id: 'run-452',
    number: 452,
    title: 'Migrate image CDN URLs to the v2 signer',
    stage: 'taken-over',
    startedMinutesAgo: 60 * 50,
    updatedMinutesAgo: 60 * 47,
    commandsUsed: 30,
    repairRounds: 1,
    takeover: true,
    receipts: [
      ['checkout', 'succeeded', 60 * 50],
      ['workflow', 'succeeded', 60 * 49],
    ],
  }),
  makeRun({
    id: 'run-455',
    number: 455,
    title: 'Rename “Wishlist” to “Saved items”',
    stage: 'cancelled',
    startedMinutesAgo: 60 * 70,
    updatedMinutesAgo: 60 * 69,
    commandsUsed: 4,
    receipts: [['checkout', 'succeeded', 60 * 70]],
  }),
];

const docsRuns: FactoryRun[] = [
  makeRun(
    {
      id: 'run-docs-31',
      number: 31,
      title: 'Typo in the webhooks quickstart',
      stage: 'paused',
      resumeStage: 'waiting-checks',
      startedMinutesAgo: 60 * 27,
      updatedMinutesAgo: 60 * 26,
      commandsUsed: 6,
      pr: true,
      checks: [{ name: 'docs / build', status: 'passed' }],
      review: 'not-required',
      evidence: ['passed'],
      receipts: [
        ['checkout', 'succeeded', 60 * 27],
        ['publish', 'succeeded', 60 * 26.5],
      ],
    },
    factories[1],
  ),
];

const workerRuns = (): Record<string, PublicWorkflowRun> => {
  const template = factories[0].workflow;
  const make = (id: string, states: Array<'completed' | 'running' | 'waiting'>) =>
    ({
      id,
      templateId: template.id,
      templateName: template.name,
      workspaceId: workspace.id,
      repoIds: ['repo-storefront'],
      nodes: template.nodes,
      edges: template.edges,
      kickoff: 'Synthetic factory worker',
      chatOrigin: {
        threadId: factoryWorkerThreadId(id.replace(/^wf-/, '')),
        requestId: 'synthetic',
      },
      status: 'running',
      supervisorThreadId: 'supervisor-demo',
      nodeRuns: template.nodes.map((item, index) => ({
        nodeId: item.id,
        status: states[index] ?? 'waiting',
        ...(states[index] === 'completed'
          ? { startedAt: ago(12 - index * 4), completedAt: ago(9 - index * 4) }
          : states[index] === 'running'
            ? { startedAt: ago(4) }
            : {}),
      })),
      createdAt: ago(12),
    }) as PublicWorkflowRun;
  return {
    'wf-run-482': make('wf-run-482', ['completed', 'running', 'waiting']),
    'wf-run-468': make('wf-run-468', ['completed', 'completed', 'running']),
  };
};

const directory: FactoryDirectoryItem[] = [
  {
    id: 'factory-remote-pending',
    revision: 2,
    policy: { organizationId: 'acme', visibility: 'restricted', members: [] },
    role: 'viewer',
    organizationAdmin: false,
    executionOwner: false,
    ownerId: 'user:ana',
    accessPending: true,
    updatedAt: Date.now() - 60 * minute,
  },
];

function summarize(definition: FactoryDefinitionInput, workflow: WorkflowTemplate): string[] {
  return [
    `${definition.github.host}/${definition.github.owner}/${definition.github.repo}: new issues labelled ${definition.github.label}; base ${definition.github.baseBranch}`,
    `Pinned graph ${workflow.name}; ${workflow.nodes.length} steps; models ${[...new Set(workflow.nodes.map((n) => n.model))].join(', ')}`,
    'Each ordered criterion is bound to the verification command at the same index; subjective acceptance requires human review.',
    `${definition.criteria.length} acceptance checks; ${definition.postMergeChecks.length} post-merge checks; ${definition.limits.maxCommands} observed shell commands; ${definition.limits.maxRunMinutes} wall-clock minutes; ${definition.limits.repairRounds} repair rounds.`,
    definition.publication.enabled
      ? 'Standing authority to publish verified task branches and pull requests.'
      : 'Publication disabled; runs cannot publish.',
    definition.merge.mode === 'auto-merge'
      ? 'Standing automatic merge authority when exact-head acceptance, required checks and human review conditions pass.'
      : 'An authorised person must approve the current verified head before each merge.',
    `Visibility: ${definition.access.kind === 'private' ? 'private' : definition.access.visibility}. Existing run history follows current visibility and source permissions.`,
    'Activation applies to future issues. Existing runs retain their graph and original grants; pauses, revoked access and reductions in merge authority apply immediately.',
  ];
}

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function resolveWorkflow(
  definition: FactoryDefinitionInput,
  factoryId?: string,
  options?: { repinWorkflow?: boolean },
): WorkflowTemplate {
  const existing = factories.find((item) => item.id === factoryId);
  if (
    existing &&
    !options?.repinWorkflow &&
    existing.definition.workflowTemplateId === definition.workflowTemplateId
  )
    return existing.workflow;
  const template = templates.find((item) => item.id === definition.workflowTemplateId);
  if (!template) throw new Error('Choose an existing saved workflow.');
  if (template.nodes.some((item) => item.target && item.target.kind !== 'local'))
    throw new Error('Factory workers must run in the isolated local execution checkout.');
  if (
    template.nodes.some((item) => item.kind !== 'human' && (item.provider ?? 'codex') !== 'codex')
  )
    throw new Error(
      'Factory workers require a Codex app-server provider with enforced sandbox isolation.',
    );
  return structuredClone(template);
}

function validate(definition: FactoryDefinitionInput): void {
  if (!definition.repoId) throw new Error('Invalid repository id.');
  if (!definition.workflowTemplateId) throw new Error('Invalid workflow template.');
  if (
    definition.criteria.length === 0 ||
    definition.criteria.length !== definition.checks.length ||
    new Set(definition.criteria).size !== definition.criteria.length
  )
    throw new Error(
      'Each unique acceptance criterion needs one reviewed verification command in the same order.',
    );
  if (!definition.postMergeChecks.length) throw new Error('Invalid post-merge checks.');
  if (
    definition.limits.maxCommands <
    definition.checks.length + definition.postMergeChecks.length + 1
  )
    throw new Error(
      'Command budget must leave room for implementation, acceptance and post-merge checks.',
    );
}

/** Called only by the standalone development replay entry, never by Electron. */
export function installFactoriesPreviewBridge(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.has('factories-empty')) {
    factories = [];
    runs = [];
  }
  const bridge = window.anvil as unknown as Record<string, unknown>;
  bridge.workspace = {
    list: async () => [{ ...workspace, repoCount: repos.length }],
    get: async () => structuredClone(workspace),
    activityFeed: async () => [],
  };
  bridge.settings = {
    get: async () => ({
      activeWorkspaceId: workspace.id,
      llmProvider: 'codex',
      enabledLlmProviders: ['codex'],
      openaiModel: 'gpt-5.6-sol',
    }),
    update: async () => undefined,
    getCodexStatus: async () => null,
    getCursorStatus: async () => null,
    getDevinStatus: async () => null,
    getLlmGatewayStatus: async () => null,
  };
  bridge.chat = {
    ...(bridge.chat as object),
    getPersonas: async () => personas,
  };
  bridge.workflow = {
    listTemplates: async () => structuredClone(templates),
    listRuns: async () => Object.values(workerRuns()),
    deleteTemplate: async (id: string) => {
      templates = templates.filter((item) => item.id !== id);
    },
    getRun: async (id: string) => workerRuns()[id] ?? null,
    saveTemplate: async (input: Omit<WorkflowTemplate, 'id' | 'createdAt' | 'updatedAt'>) => {
      await delay(250);
      const now = new Date().toISOString();
      const saved: WorkflowTemplate = {
        ...structuredClone(input),
        description: input.description ?? '',
        id: `tpl-${Math.random().toString(16).slice(2, 8)}`,
        createdAt: now,
        updatedAt: now,
      };
      templates = [saved, ...templates];
      return saved;
    },
  };
  const preview = async (
    definition: FactoryDefinitionInput,
    factoryId?: string,
    options?: { repinWorkflow?: boolean },
  ): Promise<FactoryPreview> => {
    await delay(320);
    validate(definition);
    const workflow = resolveWorkflow(definition, factoryId, options);
    return {
      definition: structuredClone(definition),
      confirmation: sha(JSON.stringify(definition) + workflow.updatedAt),
      summary: summarize(definition, workflow),
    };
  };
  bridge.factories = {
    draft: async (request: string) => {
      await delay(900);
      const auto = /auto-?merge|automatically/i.test(request);
      return baseDefinition({
        name: auto ? 'Ready issues to merged PR' : 'Ready issues to reviewed PR',
        merge: {
          mode: auto ? 'auto-merge' : 'human-approved',
          method: 'squash',
          requiredChecks: ['ci / test', 'ci / build'],
          requireApproval: true,
        },
      });
    },
    preview,
    save: async (input: {
      definition: FactoryDefinitionInput;
      id?: string;
      expectedRevision?: number;
      confirmation: string;
      repinWorkflow?: boolean;
    }) => {
      const reviewed = await preview(input.definition, input.id, input);
      if (reviewed.confirmation !== input.confirmation)
        throw new Error('Factory configuration changed since review. Preview it again.');
      const current = factories.find((item) => item.id === input.id);
      const now = new Date().toISOString();
      const workflow = resolveWorkflow(input.definition, input.id, input);
      const saved: FactoryDefinition = current
        ? {
            ...current,
            revision: current.revision + 1,
            definition: structuredClone(input.definition),
            workflow,
            confirmation: input.confirmation,
            updatedAt: now,
          }
        : {
            id: `factory-${Math.random().toString(16).slice(2, 8)}`,
            workspaceId: workspace.id,
            revision: 1,
            status: 'draft',
            ownerId: 'local:demo',
            accountScope: 'local:demo',
            definition: structuredClone(input.definition),
            workflow,
            confirmation: input.confirmation,
            createdAt: now,
            updatedAt: now,
            effectiveRole: 'owner',
            sourceAccess: true,
            executionOwner: true,
            remote: false,
          };
      factories = [saved, ...factories.filter((item) => item.id !== saved.id)];
      return structuredClone(saved);
    },
    activate: async (input: { factoryId: string }) => {
      await delay(500);
      const factory = factories.find((item) => item.id === input.factoryId)!;
      const next = {
        ...factory,
        status: 'active' as const,
        activeRevision: factory.revision,
        activatedAt: new Date().toISOString(),
      };
      factories = factories.map((item) => (item.id === next.id ? next : item));
      return structuredClone(next);
    },
    list: async () => structuredClone(factories),
    get: async (id: string) => structuredClone(factories.find((item) => item.id === id) ?? null),
    listRuns: async (factoryId: string) =>
      structuredClone(
        factoryId === 'factory-ready' ? runs : factoryId === 'factory-docs' ? docsRuns : [],
      ),
    getRun: async (id: string) =>
      structuredClone([...runs, ...docsRuns].find((item) => item.id === id) ?? null),
    control: async (input: { factoryId: string; action: 'pause' | 'resume' | 'deactivate' }) => {
      await delay(250);
      const factory = factories.find((item) => item.id === input.factoryId)!;
      const status =
        input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : 'inactive';
      const next = { ...factory, status } as FactoryDefinition;
      factories = factories.map((item) => (item.id === next.id ? next : item));
      return structuredClone(next);
    },
    controlRun: async (input: { runId: string; action: string }) => {
      await delay(300);
      const run = runs.find((item) => item.id === input.runId)!;
      const stage: FactoryRunStage =
        input.action === 'approve-merge'
          ? 'merging'
          : input.action === 'pause'
            ? 'paused'
            : input.action === 'resume' || input.action === 'retry'
              ? (run.resumeStage ?? 'implementing')
              : input.action === 'cancel'
                ? 'cancelled'
                : input.action === 'takeover'
                  ? 'taken-over'
                  : run.stage;
      const next: FactoryRun = {
        ...run,
        stage,
        updatedAt: new Date().toISOString(),
        ...(input.action === 'pause' ? { resumeStage: run.stage } : {}),
        ...(input.action === 'retry' ? { error: undefined } : {}),
        ...(input.action === 'approve-merge'
          ? { mergeApprovalHead: run.observation?.headSha }
          : {}),
        ...(input.action === 'takeover' ? { takeoverThreadId: 'factory-takeover-demo' } : {}),
      };
      runs = runs.map((item) => (item.id === next.id ? next : item));
      return structuredClone(next);
    },
    listOrganizations: async () => [{ id: 'acme', role: 'admin' }],
    listOrganizationMembers: async () => [
      { userId: 'sam@acme.dev', role: 'admin' },
      { userId: 'riley@acme.dev', role: 'member' },
      { userId: 'jo@acme.dev', role: 'member' },
    ],
    validateOrganizationTeam: async () => true,
    registerOrganizationKey: async () => 'enrolled',
    directory: async () => structuredClone(directory),
  };
}

/** `?factories&workflows` shows the Workflows side of the relationship with the same data. */
export function FactoriesPreview() {
  const workflows = new URLSearchParams(window.location.search).has('workflows');
  return (
    <div className="h-screen bg-bg-primary text-text-primary">
      <WorkspaceProvider>{workflows ? <WorkflowsView /> : <FactoriesView />}</WorkspaceProvider>
    </div>
  );
}
