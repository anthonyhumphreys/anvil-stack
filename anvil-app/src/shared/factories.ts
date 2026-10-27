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
export interface FactorySaveInput {
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
