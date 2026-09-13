import type { WorkItem, WorkItemProvider } from './types.js';

export interface WorkItemReference {
  connectionId: string;
  provider: WorkItemProvider;
  id: string;
}
/** Identity carried from execution to human verification; never a workflow gate decision. */
export interface ReviewOrigin {
  workflowRunId?: string;
  automationRunId?: string;
  executionPath?: string;
  pullRequest?: { id: string; provider: string; headSha: string; number?: number };
}
export interface ReviewEvidenceSource {
  visualisationId: string;
  headSha: string;
  kind: 'chapter' | 'risk';
  id: string;
}
export interface ReviewEvidenceTarget {
  criterionId?: string;
  scenarioVersion?: string;
  runId?: string;
  captureId?: string;
  findingId?: string;
}
export interface ReviewEvidenceLink extends ReviewEvidenceTarget {
  id: string;
  source: ReviewEvidenceSource;
  visualisationVersion: string;
  criteriaVersion: string;
  candidateTree: string;
  createdAt: string;
  provenance: 'human-linked';
  freshness: 'current' | 'stale' | 'unknown';
  freshnessDetail?: string;
}
export interface ReviewNativeEvidence {
  candidateTree: string;
  id: string;
  buildId: string;
  headSha: string;
  platform: 'darwin';
  arch: 'arm64' | 'x64';
  status: 'passed' | 'failed' | 'unsupported' | 'unavailable';
  signing: 'unsigned' | 'signed' | 'unavailable';
  notes: string;
  recordedAt: string;
  reviewer: string;
  provenance: 'human-observed';
}
export interface ReviewSnapshot {
  head: string;
  tree: string;
  capturedAt: string;
}
export type ScenarioStep =
  | { action: 'goto'; value: string }
  | { action: 'click'; locator: string }
  | { action: 'fill'; locator: string; value: string }
  | { action: 'press'; locator: string; value: string }
  | { action: 'visible'; locator: string }
  | { action: 'text'; locator: string; value: string };
export interface ReviewScenario {
  name: string;
  fixtureVersion: string;
  setupCommand?: string;
  resetCommand: string;
  startCommand: string;
  readyPath: string;
  steps: ScenarioStep[];
  viewports: { name: string; width: number; height: number }[];
}
export interface ReviewCriterion {
  id: string;
  text: string;
}
export interface ReviewCriteriaVersion {
  id: string;
  sourceText: string;
  fetchedAt: string;
  items: ReviewCriterion[];
}
export interface ReviewCapture {
  id: string;
  viewport: string;
  image: string;
  trace: string;
  imageDigest: string;
  traceDigest: string;
  outcome: 'passed' | 'failed';
  steps: { action: string; outcome: 'passed' | 'failed'; detail?: string }[];
}
export interface ReviewRun {
  /** Computed when evidence is read; absent while not yet checked. */
  evidenceAvailable?: boolean;
  evidenceDetail?: string;
  id: string;
  candidate: ReviewSnapshot;
  baseTree: string;
  criteriaVersion: string;
  scenarioVersion: string;
  startedAt: string;
  completedAt?: string;
  provenance: 'runner-observed';
  outcome: 'running' | 'passed' | 'failed' | 'inconclusive';
  environment: string;
  base: ReviewCapture[];
  candidateCaptures: ReviewCapture[];
  log: string;
  error?: string;
}
export interface ReviewFinding {
  id: string;
  runId: string;
  captureId: string;
  note: string;
  locator?: string;
  x?: number;
  y?: number;
  repair?: { threadId?: string; workItemRef?: WorkItemReference; at: string; replayRunId?: string };
  history: { state: 'open' | 'ready_for_recheck' | 'accepted'; at: string; runId: string }[];
}
export interface ReviewDecision {
  id: string;
  at: string;
  reviewer: string;
  snapshot: string;
  criteriaVersion: string;
  runId: string;
  outcome: 'accepted' | 'rejected';
  note: string;
  criterionDecisions: { criterionId: string; outcome: 'accepted' | 'not_checked'; note: string }[];
}
export interface ReviewAttentionSession {
  id: string;
  reviewer: string;
  startedAt: string;
  lastObservedAt: string;
  activeMs: number;
  provenance: 'foreground-interaction';
}
export interface ChangeReview {
  attentionSessions?: ReviewAttentionSession[];
  origin?: ReviewOrigin;
  evidenceLinks?: ReviewEvidenceLink[];
  nativeEvidence?: ReviewNativeEvidence[];
  id: string;
  workspaceId: string;
  repoId: string;
  title: string;
  baseRef: string;
  baseCommit: string;
  candidate: ReviewSnapshot;
  workItemRef?: WorkItemReference;
  workItem?: WorkItem;
  criteria: ReviewCriteriaVersion[];
  scenario?: ReviewScenario;
  scenarioVersion?: string;
  runs: ReviewRun[];
  findings: ReviewFinding[];
  decisions: ReviewDecision[];
  createdAt: string;
  updatedAt: string;
  freshness: 'current' | 'stale' | 'unknown';
  freshnessDetail?: string;
  publications?: {
    id: string;
    decisionId: string;
    status: 'pending' | 'published' | 'uncertain';
    at: string;
  }[];
}
export interface ChangeReviewApi {
  recordAttention(id: string, input: { sessionId: string; active: boolean }): Promise<void>;
  list(workspaceId: string): Promise<ChangeReview[]>;
  create(input: {
    workspaceId: string;
    repoId: string;
    baseRef: string;
    workItemRef?: WorkItemReference;
    localCriteria?: string;
    origin?: ReviewOrigin;
  }): Promise<ChangeReview>;
  linkEvidence(
    id: string,
    input: ReviewEvidenceTarget & { source: ReviewEvidenceSource },
  ): Promise<ChangeReview>;
  unlinkEvidence(id: string, linkId: string): Promise<ChangeReview>;
  repairFinding(
    id: string,
    findingId: string,
    input: { threadId?: string; workItemRef?: WorkItemReference },
  ): Promise<ChangeReview>;
  recordNativeEvidence(
    id: string,
    input: Omit<
      ReviewNativeEvidence,
      'id' | 'recordedAt' | 'reviewer' | 'provenance' | 'candidateTree'
    >,
  ): Promise<ChangeReview>;
  get(id: string): Promise<ChangeReview>;
  refresh(id: string): Promise<ChangeReview>;
  configure(id: string, scenario: ReviewScenario): Promise<ChangeReview>;
  run(id: string): Promise<ChangeReview>;
  cancel(id: string): Promise<void>;
  annotate(
    id: string,
    input: {
      runId: string;
      captureId: string;
      note: string;
      locator?: string;
      x?: number;
      y?: number;
    },
  ): Promise<ChangeReview>;
  resolveFinding(
    id: string,
    findingId: string,
    state: 'ready_for_recheck' | 'accepted',
    runId: string,
  ): Promise<ChangeReview>;
  decide(
    id: string,
    input: {
      runId: string;
      outcome: 'accepted' | 'rejected';
      note: string;
      criterionDecisions: ReviewDecision['criterionDecisions'];
    },
  ): Promise<ChangeReview>;
  artifact(id: string, runId: string, captureId: string): Promise<string>;
  openTrace(id: string, runId: string, captureId: string): Promise<void>;
  export(id: string, format: 'markdown' | 'json'): Promise<string>;
  publish(id: string, decisionId: string, redactedText: string): Promise<ChangeReview>;
}

/** Acceptance belongs to the evidence reviewed, not to every future candidate. */
export function isFindingAccepted(review: ChangeReview, finding: ReviewFinding): boolean {
  const decision = finding.history.at(-1);
  if (decision?.state !== 'accepted' || review.freshness !== 'current') return false;
  const run = review.runs.find((run) => run.id === decision.runId);
  return Boolean(
    run &&
    run.candidate.head === review.candidate.head &&
    run.outcome === 'passed' &&
    run.evidenceAvailable !== false &&
    run.candidate.tree === review.candidate.tree &&
    run.criteriaVersion === review.criteria.at(-1)?.id &&
    run.scenarioVersion === review.scenarioVersion,
  );
}
