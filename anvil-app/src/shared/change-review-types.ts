import type { WorkItem, WorkItemProvider } from './types.js';

export interface WorkItemReference {
  connectionId: string;
  provider: WorkItemProvider;
  id: string;
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
export interface ChangeReview {
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
  list(workspaceId: string): Promise<ChangeReview[]>;
  create(input: {
    workspaceId: string;
    repoId: string;
    baseRef: string;
    workItemRef?: WorkItemReference;
    localCriteria?: string;
  }): Promise<ChangeReview>;
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
