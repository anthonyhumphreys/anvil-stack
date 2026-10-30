import type { WorkflowTemplate } from './types.js';

export type FactoryRole = 'viewer' | 'operator' | 'owner';
export interface FactoryOrganizationOption {
  id: string;
  role: string;
}
export interface FactoryOrganizationMember {
  userId: string;
  role: string;
}
export interface FactoryDirectoryPolicy {
  organizationId: string;
  visibility: 'organization' | 'team' | 'restricted';
  teamId?: string;
  members: Array<{ userId: string; role: FactoryRole }>;
}
export interface FactoryDirectoryItem {
  id: string;
  revision: number;
  policy: FactoryDirectoryPolicy;
  role: FactoryRole;
  organizationAdmin: boolean;
  executionOwner: boolean;
  ownerId: string;
  accessPending: boolean;
  accessRequired?: boolean;
  updatedAt: number;
}
export type FactoryAction =
  'read' | 'read-source' | 'operate' | 'edit' | 'activate' | 'merge' | 'execute' | 'cancel';
export type FactoryAccess =
  | { kind: 'private' }
  | {
      kind: 'organization';
      organizationId: string;
      visibility: 'organization' | 'team' | 'restricted';
      teamId?: string;
      members: Array<{ userId: string; role: FactoryRole }>;
    };
export interface FactoryDefinitionInput {
  name: string;
  workspaceId: string;
  repoId: string;
  github: { host: string; owner: string; repo: string; label: string; baseBranch: string };
  workflowTemplateId: string;
  criteria: string[];
  checks: string[];
  postMergeChecks: string[];
  limits: {
    repairRounds: number;
    maxRunMinutes: number;
    maxCommands: number;
    maxConcurrentRuns: number;
  };
  publication: { enabled: boolean; draft: boolean };
  merge: {
    mode: 'human-approved' | 'auto-merge';
    method: 'squash' | 'merge' | 'rebase';
    requiredChecks: string[];
    requireApproval: boolean;
  };
  access: FactoryAccess;
}
export interface FactoryActor {
  id: string;
  accountScope: string;
}
export interface FactoryPreview {
  definition: FactoryDefinitionInput;
  confirmation: string;
  summary: string[];
}
export interface FactoryDefinition {
  id: string;
  workspaceId: string;
  revision: number;
  activeRevision?: number;
  commandPending?: boolean;
  effectiveRole?: FactoryRole;
  accessPending?: boolean;
  sourceAccess?: boolean;
  organizationAdmin?: boolean;
  remote?: boolean;
  executionOwner?: boolean;
  registryVersion?: number;
  lastControlRequestId?: string;
  status: 'draft' | 'active' | 'paused' | 'inactive';
  ownerId: string;
  accountScope: string;
  definition: FactoryDefinitionInput;
  workflow: WorkflowTemplate;
  confirmation: string;
  activatedAt?: string;
  createdAt: string;
  updatedAt: string;
  /** Present on permission-filtered remote metadata; protected fields must not be trusted/exposed. */
  redacted?: boolean;
}
export interface FactoryIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  state: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
}
export type FactoryRunStage =
  | 'received'
  | 'implementing'
  | 'validating'
  | 'publishing'
  | 'waiting-checks'
  | 'repairing'
  | 'awaiting-merge-approval'
  | 'merging'
  | 'verifying-merge'
  | 'completed'
  | 'blocked'
  | 'paused'
  | 'cancelled'
  | 'taken-over'
  | 'cancelling';
export interface FactoryCheckout {
  path: string;
  branch: string;
  baseSha: string;
}
export interface FactoryEvidence {
  headSha: string;
  treeSha: string;
  criteria: Array<{ criterion: string; status: 'passed' | 'failed' | 'blocked'; evidence: string }>;
  commands: Array<{ command: string; exitCode: number | null; output: string; timedOut?: boolean }>;
  passed: boolean;
  checkedAt: string;
}
export interface FactoryPullRequest {
  number: number;
  url: string;
  headSha: string;
  branch: string;
  baseBranch: string;
  draft: boolean;
}
export interface FactoryPrObservation {
  headSha: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  checks: Array<{ name: string; status: 'pending' | 'passed' | 'failed'; headSha: string }>;
  review: 'approved' | 'changes-requested' | 'pending' | 'not-required';
  feedback: Array<{ id: string; body: string; headSha: string; url?: string }>;
  mergeCommitSha?: string;
  mergeQueued?: boolean;
  mergeAutoEnabled?: boolean;
  observedAt: string;
}
export interface FactoryMergeReceipt {
  providerRequestId?: string;
  requestedHeadSha: string;
  state: 'requested' | 'queued' | 'merged';
  mergeCommitSha?: string;
}
export interface FactoryReceipt {
  id: string;
  runId: string;
  key: string;
  kind: 'checkout' | 'workflow' | 'verify' | 'publish' | 'merge' | 'cancel-merge' | 'post-merge';
  status: 'intent' | 'succeeded' | 'uncertain' | 'failed';
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface FactoryRun {
  id: string;
  factoryId: string;
  revision: number;
  workspaceId: string;
  snapshot: FactoryDefinition;
  issue: FactoryIssue;
  stage: FactoryRunStage;
  pendingControl?: 'pause' | 'cancel' | 'takeover';
  pendingControlId?: string;
  workerCommandBaseline?: number;
  resumeStage?: FactoryRunStage;
  version: number;
  repairRounds: number;
  commandsUsed: number;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  nextPollAt?: string;
  checkout?: FactoryCheckout;
  workflowRunId?: string;
  workerThreadId?: string;
  evidence?: FactoryEvidence;
  pullRequest?: FactoryPullRequest;
  observation?: FactoryPrObservation;
  mergeApprovalHead?: string;
  mergeReceipt?: FactoryMergeReceipt;
  postMergeEvidence?: FactoryEvidence;
  lastFeedbackIds?: string[];
  error?: string;
  takeoverThreadId?: string;
  takeoverRequestId?: string;
  lastControlRequestId?: string;
  receipts: FactoryReceipt[];
  commandPending?: boolean;
  effectiveRole?: FactoryRole;
  accessPending?: boolean;
  sourceAccess?: boolean;
  organizationAdmin?: boolean;
  remote?: boolean;
  executionOwner?: boolean;
}
export interface FactoryPreviewOptions {
  /**
   * Pin the current saved template instead of retaining the existing revision's graph.
   * Only the designated executor can re-pin; existing runs keep their own snapshot.
   */
  repinWorkflow?: boolean;
}
export interface FactorySaveInput extends FactoryPreviewOptions {
  definition: FactoryDefinitionInput;
  id?: string;
  expectedRevision?: number;
  confirmation: string;
}
export interface FactoryActivateInput {
  factoryId: string;
  revision: number;
  confirmation: string;
}
export interface FactoryControlInput {
  factoryId: string;
  action: 'pause' | 'resume' | 'deactivate';
  requestId?: string;
}
export interface FactoryRunControlInput {
  runId: string;
  action: 'pause' | 'resume' | 'cancel' | 'retry' | 'approve-merge' | 'takeover';
  expectedHeadSha?: string;
  requestId?: string;
  takeoverContext?: { workspaceId: string; repoId?: string; personaId: string };
}

/** Desktop/provider boundary: all writes have a durable, stable intent key. */
export interface FactoryProvider {
  listIssues(factory: FactoryDefinition, since?: string): Promise<FactoryIssue[]>;
  readIssue(factory: FactoryDefinition, number: number): Promise<FactoryIssue>;
  prepareCheckout(
    factory: FactoryDefinition,
    run: FactoryRun,
    intentKey: string,
    guard?: () => Promise<void>,
  ): Promise<FactoryCheckout>;
  verifyCheckout(
    factory: FactoryDefinition,
    run: FactoryRun,
    intentKey: string,
    guard?: () => Promise<void>,
  ): Promise<FactoryEvidence>;
  publishPullRequest(
    factory: FactoryDefinition,
    run: FactoryRun,
    intentKey: string,
    guard?: () => Promise<void>,
  ): Promise<FactoryPullRequest>;
  readPullRequest(factory: FactoryDefinition, run: FactoryRun): Promise<FactoryPrObservation>;
  requestMerge(
    factory: FactoryDefinition,
    run: FactoryRun,
    intentKey: string,
    guard?: () => Promise<void>,
  ): Promise<FactoryMergeReceipt>;
  cancelMerge(
    factory: FactoryDefinition,
    run: FactoryRun,
    intentKey: string,
    guard?: () => Promise<void>,
  ): Promise<void>;
  verifyMerged(
    factory: FactoryDefinition,
    run: FactoryRun,
    intentKey: string,
    guard?: () => Promise<void>,
  ): Promise<FactoryEvidence>;
}
export const FACTORY_TERMINAL_STAGES: FactoryRunStage[] = ['completed', 'cancelled', 'taken-over'];

/**
 * Isolated worker constraints for a factory graph, in the order the controller enforces them.
 * Empty when the graph can run in a factory. The first issue is the activation error.
 */
export function factoryWorkflowIssues(
  workflow: Pick<WorkflowTemplate, 'nodes' | 'orchestration'>,
): string[] {
  const issues = new Set<string>();
  if (!workflow.nodes.length || workflow.nodes.length > 32)
    issues.add('Choose a bounded saved workflow.');
  for (const node of workflow.nodes) {
    if (node.target && node.target.kind !== 'local')
      issues.add('Factory workers must run in the isolated local execution checkout.');
    if (node.kind !== 'human' && !['codex'].includes(node.provider ?? 'codex'))
      issues.add(
        'Factory workers require a Codex app-server provider with enforced sandbox isolation.',
      );
    if (node.requiresValidation)
      issues.add(
        'Factory acceptance checks run independently in the controller; remove inline privileged validation from the worker graph.',
      );
  }
  for (const profile of workflow.orchestration?.profiles ?? [])
    if (
      (profile.target && profile.target.kind !== 'local') ||
      !['codex'].includes(profile.provider)
    )
      issues.add('Factory specialist profiles must use isolated local Codex app-server execution.');
  return [...issues];
}

function behaviouralGraph(workflow: Pick<WorkflowTemplate, 'nodes' | 'edges' | 'orchestration'>) {
  // Canvas positions and labels do not change what a worker does.
  return JSON.stringify({
    nodes: [...workflow.nodes]
      .map(({ position: _position, ...node }) => node)
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...workflow.edges].map(({ source, target }) => `${source}>${target}`).sort(),
    orchestration: workflow.orchestration ?? null,
  });
}

/** Compares a factory's pinned graph with the saved template it was pinned from. */
export function factoryWorkflowDrift(
  pinned: WorkflowTemplate,
  template: WorkflowTemplate | null | undefined,
): 'current' | 'changed' | 'missing' {
  if (!template) return 'missing';
  return behaviouralGraph(pinned) === behaviouralGraph(template) ? 'current' : 'changed';
}

const FACTORY_WORKER_THREAD_PREFIX = 'factory-worker-';
/** The chat thread that owns a factory run's delegated workflow; also its provenance key. */
export function factoryWorkerThreadId(runId: string): string {
  return `${FACTORY_WORKER_THREAD_PREFIX}${runId}`;
}
export function factoryRunIdFromWorkerThread(threadId: string | undefined): string | null {
  return threadId?.startsWith(FACTORY_WORKER_THREAD_PREFIX)
    ? threadId.slice(FACTORY_WORKER_THREAD_PREFIX.length) || null
    : null;
}
