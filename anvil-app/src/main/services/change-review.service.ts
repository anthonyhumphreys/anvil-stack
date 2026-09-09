import {
  deriveDeliveryMetrics,
  formatDeliveryMetricsMarkdown,
} from '../../shared/delivery-metrics.js';
import { isFindingAccepted } from '../../shared/change-review-types.js';
import { app, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type {
  ChangeReview,
  ReviewScenario,
  ReviewRun,
  ReviewCriteriaVersion,
  ChangeReviewApi,
  ReviewCapture,
  ReviewEvidenceLink,
} from '../../shared/change-review-types.js';
import { extractAcceptanceCriteria } from '../../shared/workitem-intent.js';
import { getDb } from '../db/database.js';
import { mergePersistedReviewAttention } from './change-review-attention.service.js';
import { getWorkspace } from './workspace.service.js';
import { getActiveProvider } from './workitem-provider.js';
import { captureReviewSnapshot, reviewGit } from './review-snapshot.service.js';
import { digest, reviewArtifactRoot, runReviewSide } from './change-review-runner.service.js';

const active = new Map<string, AbortController>();
const publishing = new Set<string>();
export function cleanupChangeReviews(): void {
  for (const controller of active.values()) controller.abort();
}
function now(): string {
  return new Date().toISOString();
}
function read(id: string): ChangeReview {
  const row = getDb().prepare('SELECT record_json FROM change_reviews WHERE id = ?').get(id) as
    | { record_json: string }
    | undefined;
  if (!row) throw new Error('Review not found.');
  return JSON.parse(row.record_json) as ChangeReview;
}
function repoPath(review: Pick<ChangeReview, 'workspaceId' | 'repoId' | 'origin'>): string {
  const repo = getWorkspace(review.workspaceId).repos.find((repo) => repo.id === review.repoId);
  if (!repo) throw new Error('The review repository is no longer linked to this workspace.');
  const origin = review.origin;
  if (!origin) return repo.path;
  let retainedPath: string | undefined;
  if (origin.workflowRunId) {
    const row = getDb()
      .prepare('SELECT workspace_id, graph_json FROM workflow_runs WHERE id = ?')
      .get(origin.workflowRunId) as { workspace_id: string; graph_json: string } | undefined;
    if (!row || row.workspace_id !== review.workspaceId)
      throw new Error('Workflow candidate is unavailable in this workspace.');
    const graph = JSON.parse(row.graph_json) as {
      executionPaths?: { id: string; path: string }[];
      sourceAutomationRunId?: string;
    };
    retainedPath = graph.executionPaths?.find((item) => item.id === review.repoId)?.path;
    if (origin.automationRunId && graph.sourceAutomationRunId !== origin.automationRunId)
      throw new Error('Workflow and automation identities do not match.');
    if (!retainedPath)
      throw new Error('Workflow has no retained execution worktree for this repository.');
  }
  if (origin.automationRunId) {
    const row = getDb()
      .prepare('SELECT workspace_id, worktrees_json FROM automation_runs WHERE id = ?')
      .get(origin.automationRunId) as { workspace_id: string; worktrees_json: string } | undefined;
    if (!row || row.workspace_id !== review.workspaceId)
      throw new Error('Automation candidate is unavailable in this workspace.');
    const tree = (
      JSON.parse(row.worktrees_json) as { repoId: string; path?: string; kept: boolean }[]
    ).find((item) => item.repoId === review.repoId);
    if (!tree?.kept || !tree.path)
      throw new Error('Automation candidate worktree was not retained.');
    if (retainedPath && realpathSync(retainedPath) !== realpathSync(tree.path))
      throw new Error('Execution identities refer to different worktrees.');
    retainedPath = tree.path;
  }
  if (origin.executionPath && !retainedPath)
    throw new Error('An execution path requires a persisted workflow or automation run.');
  if (!retainedPath) return repo.path;
  const canonical = realpathSync(retainedPath);
  if (origin.executionPath && realpathSync(origin.executionPath) !== canonical)
    throw new Error('Execution path does not match the retained candidate.');
  const common = (path: string) =>
    realpathSync(resolve(path, reviewGit(path, ['rev-parse', '--git-common-dir'])));
  if (common(canonical) !== common(repo.path))
    throw new Error('Retained worktree belongs to a different Git repository.');
  return canonical;
}
function save(review: ChangeReview): ChangeReview {
  mergePersistedReviewAttention(review);
  review.updatedAt = now();
  getDb()
    .prepare(
      'INSERT INTO change_reviews VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at',
    )
    .run(review.id, review.workspaceId, review.repoId, JSON.stringify(review), review.updatedAt);
  return review;
}
/** Public mutation responses must reflect the current source, not persisted freshness. */
function saveResponse(review: ChangeReview): ChangeReview {
  save(review);
  return getChangeReview(review.id);
}
function editable(id: string): ChangeReview {
  if (active.has(id) || publishing.has(id))
    throw new Error('Wait for the current run to finish or cancel it first.');
  return read(id);
}
export function criteriaVersion(text: string): ReviewCriteriaVersion {
  const items = text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]\s*(?:\[[ xX]\]\s*)?|\d+[.)]\s*)/, '').trim())
    .filter(Boolean);
  return {
    id: digest(text),
    sourceText: text,
    fetchedAt: now(),
    items: items.map((text, index) => ({ id: digest(`${index}:${text}`).slice(0, 16), text })),
  };
}
export function validateScenario(value: ReviewScenario): ReviewScenario {
  if (!value || typeof value !== 'object') throw new Error('Provide a scenario configuration.');
  for (const key of [
    'name',
    'fixtureVersion',
    'resetCommand',
    'startCommand',
    'readyPath',
  ] as const) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 8000)
      throw new Error(`Scenario ${key} is required.`);
  }
  if (!value.readyPath.startsWith('/') || value.readyPath.startsWith('//'))
    throw new Error('Ready path must be a local path.');
  if (
    value.setupCommand !== undefined &&
    (typeof value.setupCommand !== 'string' || value.setupCommand.length > 8000)
  )
    throw new Error('Invalid setup command.');
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > 100)
    throw new Error('Configure between 1 and 100 steps.');
  for (const step of value.steps) {
    if (!step || !['goto', 'click', 'fill', 'press', 'visible', 'text'].includes(step.action))
      throw new Error('Unsupported scenario action.');
    if (step.action !== 'goto' && (typeof step.locator !== 'string' || !step.locator.trim()))
      throw new Error('Each interaction needs a locator.');
    if (
      ['goto', 'fill', 'press', 'text'].includes(step.action) &&
      typeof (step as { value?: string }).value !== 'string'
    )
      throw new Error('This action needs a value.');
    if (step.action === 'goto' && (!step.value.startsWith('/') || step.value.startsWith('//')))
      throw new Error('Navigation must use a local path.');
  }
  if (!Array.isArray(value.viewports) || !value.viewports.length || value.viewports.length > 4)
    throw new Error('Configure 1 to 4 viewports.');
  const names = new Set<string>();
  for (const viewport of value.viewports) {
    if (
      !viewport ||
      typeof viewport.name !== 'string' ||
      !viewport.name.trim() ||
      names.has(viewport.name)
    )
      throw new Error('Viewport names must be unique.');
    names.add(viewport.name);
    if (
      ![viewport.width, viewport.height].every((n) => Number.isInteger(n) && n >= 240 && n <= 2560)
    )
      throw new Error('Viewport dimensions must be between 240 and 2560.');
  }
  return structuredClone(value);
}
export async function createChangeReview(
  input: Parameters<ChangeReviewApi['create']>[0],
): Promise<ChangeReview> {
  const path = repoPath(input);
  let workItemRef = input.workItemRef;
  if (input.origin?.workflowRunId) {
    const row = getDb()
      .prepare('SELECT graph_json FROM workflow_runs WHERE id = ?')
      .get(input.origin.workflowRunId) as { graph_json: string };
    const persistedRef = (
      JSON.parse(row.graph_json) as { workItemRef?: ChangeReview['workItemRef'] }
    ).workItemRef;
    if (persistedRef) {
      if (
        workItemRef &&
        (workItemRef.id !== persistedRef.id ||
          workItemRef.provider !== persistedRef.provider ||
          workItemRef.connectionId !== persistedRef.connectionId)
      )
        throw new Error('Work Item identity does not match the workflow run.');
      workItemRef = persistedRef;
    }
  }

  if (!input.baseRef?.trim() || input.baseRef.startsWith('-'))
    throw new Error('Choose a base Git reference.');
  const baseCommit = reviewGit(path, ['rev-parse', '--verify', `${input.baseRef}^{commit}`]);
  const item = workItemRef
    ? await getActiveProvider(workItemRef.connectionId, true)?.getItem(workItemRef.id)
    : undefined;
  if (workItemRef && (!item || item.provider !== workItemRef.provider))
    throw new Error('Work Item provider does not match the linked connection.');
  const candidate = captureReviewSnapshot(path);
  if (input.origin?.pullRequest && input.origin.pullRequest.headSha !== candidate.head)
    throw new Error('The local candidate does not match the pull request head.');
  return saveResponse({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    title: item?.title ?? 'Local change review',
    baseRef: input.baseRef,
    baseCommit,
    candidate,
    origin: input.origin
      ? {
          ...structuredClone(input.origin),
          ...(input.origin.workflowRunId || input.origin.automationRunId
            ? { executionPath: path }
            : {}),
        }
      : undefined,
    workItemRef,
    workItem: item,
    criteria: [
      criteriaVersion(item ? extractAcceptanceCriteria(item) : (input.localCriteria?.trim() ?? '')),
    ],
    runs: [],
    findings: [],
    decisions: [],
    createdAt: now(),
    updatedAt: now(),
    freshness: 'current',
  });
}
export function listChangeReviews(workspaceId: string): ChangeReview[] {
  return (
    getDb()
      .prepare(
        'SELECT record_json FROM change_reviews WHERE workspace_id = ? ORDER BY updated_at DESC',
      )
      .all(workspaceId) as { record_json: string }[]
  ).map((row) => getChangeReview((JSON.parse(row.record_json) as ChangeReview).id));
}
/** Remote observations outrank local checkout identity; scope them to one repository and PR. */
function latestObservedPrHead(
  review: Pick<ChangeReview, 'repoId' | 'workspaceId'>,
  pullRequest: { id: string; provider: string; number?: number },
): string | undefined {
  const provider = pullRequest.provider === 'azure-devops' ? 'ado' : pullRequest.provider;
  const latestVisualisation = getDb()
    .prepare(
      'SELECT head_sha, created_at FROM pull_request_visualisations WHERE repo_id = ? AND provider = ? AND pull_request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
    .get(review.repoId, provider, pullRequest.id) as
    | { head_sha: string; created_at: string }
    | undefined;
  const number = pullRequest.number ?? Number(pullRequest.id);
  const observations = getDb()
    .prepare(
      "SELECT payload_json, observed_at FROM watchtower_events WHERE event_type LIKE 'pull_request.%' ORDER BY observed_at DESC, rowid DESC",
    )
    .all() as { payload_json: string; observed_at: string }[];
  for (const observation of observations) {
    let event: { workspaceId?: string; repoIds?: string[]; metadata?: Record<string, unknown> };
    try {
      event = JSON.parse(observation.payload_json);
    } catch {
      continue;
    }
    const metadata = event.metadata;
    const observedProvider = metadata?.provider === 'azure-devops' ? 'ado' : metadata?.provider;
    if (
      event.workspaceId !== review.workspaceId ||
      !event.repoIds?.includes(review.repoId) ||
      metadata?.repoId !== review.repoId ||
      observedProvider !== provider ||
      !Number.isSafeInteger(number) ||
      metadata?.pullRequestNumber !== number ||
      typeof metadata.headSha !== 'string' ||
      !metadata.headSha
    )
      continue;
    // occurredAt may be absent, historical, or supplied by the provider; use queue observation time.
    if (
      !latestVisualisation ||
      Date.parse(observation.observed_at) > (Date.parse(latestVisualisation.created_at) || 0)
    )
      return metadata.headSha;
    break;
  }
  return latestVisualisation?.head_sha;
}
export function getChangeReview(id: string): ChangeReview {
  const review = read(id);
  for (const run of review.runs)
    if (run.outcome === 'running' && !active.has(id)) {
      run.outcome = 'inconclusive';
      run.error = 'Anvil stopped before the run completed.';
      run.completedAt = now();
      save(review);
    }
  try {
    const snapshot = captureReviewSnapshot(repoPath(review));
    review.freshness =
      snapshot.tree === review.candidate.tree &&
      snapshot.head === review.candidate.head &&
      (!review.origin?.pullRequest || review.origin.pullRequest.headSha === snapshot.head)
        ? review.freshness === 'unknown'
          ? 'unknown'
          : 'current'
        : 'stale';
    if (review.freshness === 'stale')
      review.freshnessDetail = 'Source changed since this candidate was captured.';
  } catch (error) {
    review.freshness = 'unknown';
    review.freshnessDetail = String(error);
  }
  updateEvidenceAvailability(review);
  if (review.origin?.pullRequest) {
    const knownHead = latestObservedPrHead(review, review.origin.pullRequest);
    if (knownHead && knownHead !== review.candidate.head) {
      review.freshness = 'stale';
      review.freshnessDetail =
        'A newer pull request head was observed. Review the current candidate.';
    }
  }
  for (const link of review.evidenceLinks ?? []) updateLinkFreshness(review, link);
  return review;
}
export async function refreshChangeReview(id: string): Promise<ChangeReview> {
  const review = editable(id);
  const originalRecord = JSON.stringify(review);
  const snapshot = captureReviewSnapshot(repoPath(review));
  if (review.workItemRef) {
    try {
      const item = await getActiveProvider(review.workItemRef.connectionId, true)?.getItem(
        review.workItemRef.id,
      );
      if (!item || item.provider !== review.workItemRef.provider)
        throw new Error('Linked Work Item unavailable.');
      review.workItem = item;
      const criteria = criteriaVersion(extractAcceptanceCriteria(item));
      if (criteria.id !== review.criteria.at(-1)?.id) review.criteria.push(criteria);
      else review.criteria[review.criteria.length - 1].fetchedAt = criteria.fetchedAt;
    } catch (error) {
      if (active.has(id) || publishing.has(id) || JSON.stringify(read(id)) !== originalRecord)
        throw new Error('The review changed while refreshing. Refresh again.');
      review.freshness = 'unknown';
      review.freshnessDetail = `Could not refresh Work Item criteria: ${String(error)}`;
      save(review);
      throw new Error(review.freshnessDetail);
    }
  }
  if (active.has(id) || publishing.has(id) || JSON.stringify(read(id)) !== originalRecord)
    throw new Error('The review changed while refreshing. Refresh again.');
  if (review.origin?.pullRequest && review.origin.pullRequest.headSha !== snapshot.head)
    throw new Error('Pull request head changed. Create a review for the new candidate.');
  if (review.origin?.pullRequest) {
    const knownHead = latestObservedPrHead(review, review.origin.pullRequest);
    if (knownHead && knownHead !== snapshot.head)
      throw new Error('A newer pull request head was observed. Review the current candidate.');
  }
  review.candidate = snapshot;
  review.freshness = 'current';
  delete review.freshnessDetail;
  return saveResponse(review);
}
export function configureChangeReview(id: string, scenario: ReviewScenario): ChangeReview {
  const review = editable(id);
  review.scenario = validateScenario(scenario);
  review.scenarioVersion = digest(JSON.stringify(review.scenario));
  return saveResponse(review);
}
export async function runChangeReview(id: string): Promise<ChangeReview> {
  let review = editable(id);
  review = await refreshChangeReview(id);
  if (active.has(id) || publishing.has(id)) throw new Error('A review run is already active.');
  if (!review.scenario || !review.scenarioVersion)
    throw new Error('Save a scenario before running.');
  const controller = new AbortController();
  active.set(id, controller);
  const run: ReviewRun = {
    id: randomUUID(),
    candidate: review.candidate,
    baseTree: reviewGit(repoPath(review), ['rev-parse', `${review.baseCommit}^{tree}`]),
    criteriaVersion: review.criteria.at(-1)!.id,
    scenarioVersion: review.scenarioVersion,
    startedAt: now(),
    provenance: 'runner-observed',
    outcome: 'running',
    environment: `${process.platform}/${process.arch}; Node ${process.versions.node}; Anvil ${app.getVersion()}; fixture ${review.scenario.fixtureVersion}`,
    base: [],
    candidateCaptures: [],
    log: '',
  };
  review.runs.push(run);
  save(review);
  const timer = setTimeout(() => controller.abort(), 15 * 60_000);
  timer.unref();
  void (async () => {
    const log = (text: string) => {
      run.log = (run.log + text).slice(-120_000);
      save(review);
    };
    try {
      const path = repoPath(review);
      const runDir = join(reviewArtifactRoot(), review.id, run.id);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const input = {
        repoPath: path,
        commit: review.baseCommit,
        scenario: review.scenario!,
        runDir,
        signal: controller.signal,
        log,
      };
      run.base = await runReviewSide({ ...input, side: 'base' });
      save(review);
      run.candidateCaptures = await runReviewSide({
        ...input,
        snapshot: review.candidate,
        side: 'candidate',
      });
      run.outcome = run.candidateCaptures.every((capture) => capture.outcome === 'passed')
        ? 'passed'
        : 'failed';
      if (captureReviewSnapshot(path).tree !== run.candidate.tree) {
        review.freshness = 'stale';
        review.freshnessDetail = 'Source changed during verification.';
      }
    } catch (error) {
      run.outcome = 'inconclusive';
      run.error = controller.signal.aborted ? 'Run cancelled or timed out.' : String(error);
    } finally {
      clearTimeout(timer);
      run.completedAt = now();
      save(review);
      active.delete(id);
    }
  })();
  return getChangeReview(id);
}
export function cancelChangeReview(id: string): void {
  active.get(id)?.abort();
}
function currentRun(review: ChangeReview, runId: string): ReviewRun {
  const run = review.runs.find((run) => run.id === runId);
  if (
    !run ||
    run.candidate.head !== review.candidate.head ||
    run.candidate.tree !== review.candidate.tree ||
    run.criteriaVersion !== review.criteria.at(-1)?.id ||
    run.scenarioVersion !== review.scenarioVersion
  )
    throw new Error('This evidence is stale. Replay the current candidate and criteria.');
  return run;
}
export function annotateChangeReview(
  id: string,
  input: Parameters<ChangeReviewApi['annotate']>[1],
): ChangeReview {
  const review = editable(id);
  if (!input.note?.trim() || input.note.length > 8000)
    throw new Error('Add a note of up to 8000 characters.');
  const run = review.runs.find((run) => run.id === input.runId);
  if (!run?.candidateCaptures.some((c) => c.id === input.captureId))
    throw new Error('Choose a candidate capture.');
  if ([input.x, input.y].some((n) => n !== undefined && (!Number.isFinite(n) || n < 0 || n > 1)))
    throw new Error('Invalid capture coordinates.');
  review.findings.push({
    ...input,
    note: input.note.trim(),
    id: randomUUID(),
    history: [{ state: 'open', at: now(), runId: input.runId }],
  });
  return saveResponse(review);
}
export function resolveReviewFinding(
  id: string,
  findingId: string,
  state: 'ready_for_recheck' | 'accepted',
  runId: string,
): ChangeReview {
  const review = editable(id);
  const finding = review.findings.find((f) => f.id === findingId);
  if (!finding || !['ready_for_recheck', 'accepted'].includes(state))
    throw new Error('Invalid finding update.');
  if (state === 'accepted') {
    const run = currentRun(getChangeReview(id), runId);
    if (
      getChangeReview(id).freshness !== 'current' ||
      run.outcome !== 'passed' ||
      run.id === finding.runId ||
      run.startedAt <= finding.history[0].at
    )
      throw new Error('A subsequent passing replay is required before accepting this finding.');
    for (const capture of [...run.base, ...run.candidateCaptures]) {
      verifiedArtifact(review, run, capture, 'image');
      verifiedArtifact(review, run, capture, 'trace');
    }
    if (!run.candidateCaptures.length) throw new Error('Replay capture evidence is missing.');
    if (finding.repair) finding.repair.replayRunId = runId;
  }
  finding.history.push({ state, at: now(), runId });
  return saveResponse(review);
}
export async function decideChangeReview(
  id: string,
  input: Parameters<ChangeReviewApi['decide']>[1],
): Promise<ChangeReview> {
  const review = await refreshChangeReview(id);
  if (captureReviewSnapshot(repoPath(review)).tree !== review.candidate.tree)
    throw new Error('Source changed during criteria refresh. Replay the candidate.');
  const run = currentRun(review, input.runId);
  if (!['accepted', 'rejected'].includes(input.outcome)) throw new Error('Invalid decision.');
  const criteria = review.criteria.at(-1)!.items;
  if (
    !Array.isArray(input.criterionDecisions) ||
    input.criterionDecisions.length !== criteria.length ||
    new Set(input.criterionDecisions.map((c) => c.criterionId)).size !== criteria.length ||
    criteria.some(
      (c) =>
        !input.criterionDecisions.some(
          (d) => d.criterionId === c.id && ['accepted', 'not_checked'].includes(d.outcome),
        ),
    )
  )
    throw new Error('Record a decision for every criterion.');
  if (input.outcome === 'accepted') {
    if (run.outcome !== 'passed' || !run.candidateCaptures.length)
      throw new Error('A passing candidate run is required for acceptance.');
    if (input.criterionDecisions.some((c) => c.outcome !== 'accepted'))
      throw new Error('Some criteria remain unchecked.');
    for (const capture of [...run.base, ...run.candidateCaptures]) {
      verifiedArtifact(review, run, capture, 'image');
      verifiedArtifact(review, run, capture, 'trace');
    }
    updateEvidenceAvailability(review);
    if (review.findings.some((f) => !isFindingAccepted(review, f)))
      throw new Error('Resolve open findings before acceptance.');
  }
  if (!input.note?.trim())
    throw new Error('Record the basis for this decision, including any manual checks.');
  review.decisions.push({
    ...input,
    id: randomUUID(),
    at: now(),
    reviewer: userInfo().username,
    snapshot: review.candidate.tree,
    criteriaVersion: review.criteria.at(-1)!.id,
  });
  return saveResponse(review);
}
function updateEvidenceAvailability(review: ChangeReview): void {
  for (const run of review.runs) {
    delete run.evidenceAvailable;
    delete run.evidenceDetail;
    if (!run.completedAt || run.outcome === 'running') {
      run.evidenceDetail = 'Capture availability has not been checked for this unfinished run.';
      continue;
    }
    try {
      if (!run.candidateCaptures.length) throw new Error('Candidate capture evidence is missing.');
      for (const capture of [...run.base, ...run.candidateCaptures]) {
        verifiedArtifact(review, run, capture, 'image');
        verifiedArtifact(review, run, capture, 'trace');
      }
      run.evidenceAvailable = true;
    } catch (error) {
      run.evidenceAvailable = false;
      run.evidenceDetail = String(error);
    }
  }
}
function verifiedArtifact(
  review: ChangeReview,
  run: ReviewRun,
  capture: ReviewCapture,
  kind: 'image' | 'trace',
): string {
  const root = realpathSync(join(reviewArtifactRoot(), review.id, run.id));
  const path = realpathSync(resolve(root, capture[kind]));
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact is outside its run.');
  if (digest(readFileSync(path)) !== capture[kind === 'image' ? 'imageDigest' : 'traceDigest'])
    throw new Error('Artifact changed since capture. Replay the scenario.');
  return path;
}
function captureFor(
  id: string,
  runId: string,
  captureId: string,
): { review: ChangeReview; run: ReviewRun; capture: ReviewCapture } {
  const review = read(id);
  const run = review.runs.find((r) => r.id === runId);
  const capture = run && [...run.base, ...run.candidateCaptures].find((c) => c.id === captureId);
  if (!run || !capture) throw new Error('Capture not found.');
  return { review, run, capture };
}
export function getReviewImage(id: string, runId: string, captureId: string): string {
  const { review, run, capture } = captureFor(id, runId, captureId);
  return `data:image/png;base64,${readFileSync(verifiedArtifact(review, run, capture, 'image')).toString('base64')}`;
}
export async function openReviewTrace(id: string, runId: string, captureId: string): Promise<void> {
  const { review, run, capture } = captureFor(id, runId, captureId);
  shell.showItemInFolder(verifiedArtifact(review, run, capture, 'trace'));
}
export function exportChangeReview(id: string, format: 'markdown' | 'json'): string {
  const review = getChangeReview(id);
  // Exports omit raw logs, command configuration, local paths, images and traces by default.
  const pack = {
    schemaVersion: 1,
    deliveryMetrics: deriveDeliveryMetrics(review),
    id: review.id,
    title: review.title,
    workItem: review.workItemRef,
    origin: review.origin ? { ...review.origin, executionPath: undefined } : undefined,
    evidenceLinks: review.evidenceLinks ?? [],
    nativeEvidence: review.nativeEvidence ?? [],
    base: review.baseCommit,
    candidate: review.candidate,
    freshness: review.freshness,
    criteria: review.criteria,
    runs: review.runs.map(({ log: _log, ...run }) => ({
      ...run,
      base: run.base.map(({ image: _image, trace: _trace, ...c }) => c),
      candidateCaptures: run.candidateCaptures.map(({ image: _image, trace: _trace, ...c }) => c),
    })),
    findings: review.findings.map((finding) => ({
      ...finding,
      acceptanceCurrent: isFindingAccepted(review, finding),
    })),
    decisions: review.decisions,
  };
  return format === 'json'
    ? JSON.stringify(pack, null, 2)
    : [
        `# ${review.title}`,
        `Candidate: ${review.candidate.tree}`,
        `Base: ${review.baseCommit}`,
        `Freshness: ${review.freshness}`,
        '## Acceptance criteria',
        ...review.criteria.at(-1)!.items.map((c) => `- ${c.text}`),
        '## Verification',
        ...review.runs.map(
          (r) =>
            `- ${r.startedAt}: ${r.outcome}, runner-observed, candidate ${r.candidate.tree}, run ${r.id}`,
        ),
        '## Findings',
        ...review.findings.map(
          (f) =>
            `- ${f.history.at(-1)?.state === 'accepted' && !isFindingAccepted(review, f) ? 'stale acceptance' : f.history.at(-1)?.state}: ${f.note}`,
        ),
        '## Human decisions',
        ...review.decisions.map((d) => `- ${d.at}: ${d.outcome} for ${d.snapshot}. ${d.note}`),
        formatDeliveryMetricsMarkdown(deriveDeliveryMetrics(review)),
        '## Scope',
        'Configured scenario assertions and captures only. Ignored files and external services are not part of the source snapshot. Visual, keyboard and accessibility judgement require explicit human review. Raw logs, command configuration and binary artifacts are omitted. Review this text for sensitive content before sharing.',
      ].join('\n\n');
}

export async function publishChangeReview(
  id: string,
  decisionId: string,
  redactedText: string,
): Promise<ChangeReview> {
  const review = editable(id);
  if (!review.workItemRef || !review.decisions.some((d) => d.id === decisionId))
    throw new Error('Link a Work Item and record a decision before publishing.');
  if (!redactedText.trim() || redactedText.length > 30_000)
    throw new Error('Publish between 1 and 30000 characters.');
  review.publications ??= [];
  const previous = review.publications.find((p) => p.decisionId === decisionId);
  if (previous) {
    if (previous.status === 'published') return getChangeReview(id);
    throw new Error(
      'Publication may already have reached the provider. Check the Work Item; Anvil will not send a duplicate.',
    );
  }
  const provider = getActiveProvider(review.workItemRef.connectionId, true);
  if (!provider?.publishReview)
    throw new Error('This provider does not support publishing. Copy the evidence instead.');
  const publication = {
    id: randomUUID(),
    decisionId,
    status: 'pending' as 'pending' | 'published' | 'uncertain',
    at: now(),
  };
  review.publications.push(publication);
  save(review);
  publishing.add(id);
  try {
    await provider.publishReview(
      review.workItemRef.id,
      `${redactedText}\n\nAnvil review ${review.id}; decision ${decisionId}; publication ${publication.id}`,
    );
    const latest = read(id);
    latest.publications!.find((p) => p.id === publication.id)!.status = 'published';
    return saveResponse(latest);
  } catch (error) {
    const latest = read(id);
    latest.publications!.find((p) => p.id === publication.id)!.status = 'uncertain';
    save(latest);
    throw new Error(
      `Publication was not confirmed. Your local decision is saved. Check the Work Item before sharing again. ${String(error)}`,
    );
  } finally {
    publishing.delete(id);
  }
}

function visualisationSource(review: ChangeReview, source: ReviewEvidenceLink['source']): string {
  const row = getDb()
    .prepare(
      'SELECT repo_id, provider, pull_request_id, head_sha, status, data_json FROM pull_request_visualisations WHERE id = ?',
    )
    .get(source.visualisationId) as
    | {
        repo_id: string;
        provider: string;
        pull_request_id: string;
        head_sha: string;
        status: string;
        data_json: string;
      }
    | undefined;
  if (
    !row ||
    row.repo_id !== review.repoId ||
    row.head_sha !== source.headSha ||
    row.status !== 'ready'
  )
    throw new Error('PR visualisation is unavailable or has changed.');
  const latestHead = latestObservedPrHead(review, {
    id: row.pull_request_id,
    provider: row.provider,
  });
  if (latestHead && latestHead !== source.headSha)
    throw new Error('A newer pull request head is known. Review the current candidate.');
  const data = JSON.parse(row.data_json) as {
    chapters?: { id: string }[];
    risks?: { id: string }[];
  };
  const items =
    source.kind === 'chapter' ? data.chapters : source.kind === 'risk' ? data.risks : [];
  if (!items?.some((item) => item.id === source.id))
    throw new Error('Visualisation chapter or risk no longer exists.');
  if (source.headSha !== review.candidate.head)
    throw new Error('Visualisation and candidate heads differ.');
  if (
    review.origin?.pullRequest &&
    (row.pull_request_id !== review.origin.pullRequest.id ||
      row.provider !== review.origin.pullRequest.provider)
  )
    throw new Error('Visualisation belongs to a different pull request.');
  return digest(row.data_json);
}
function updateLinkFreshness(review: ChangeReview, link: ReviewEvidenceLink): void {
  try {
    if (visualisationSource(review, link.source) !== link.visualisationVersion)
      throw new Error('Visualisation changed since this mapping was recorded.');
    if (
      review.freshness !== 'current' ||
      link.candidateTree !== review.candidate.tree ||
      link.criteriaVersion !== review.criteria.at(-1)?.id ||
      (link.scenarioVersion && link.scenarioVersion !== review.scenarioVersion)
    )
      throw new Error(
        'Candidate, criteria or scenario changed. Replay and relink current evidence.',
      );
    if (
      link.criterionId &&
      !review.criteria.at(-1)?.items.some((item) => item.id === link.criterionId)
    )
      throw new Error('Criterion no longer exists.');
    if (link.findingId && !review.findings.some((item) => item.id === link.findingId))
      throw new Error('Finding no longer exists.');
    if (link.runId) {
      const run = currentRun(review, link.runId);
      if (!run.completedAt || run.outcome === 'running')
        throw new Error('Evidence run has not completed.');
      const captures = link.captureId
        ? run.candidateCaptures.filter((capture) => capture.id === link.captureId)
        : [...run.base, ...run.candidateCaptures];
      if (!captures.length) throw new Error('Capture evidence is missing.');
      for (const capture of captures) {
        verifiedArtifact(review, run, capture, 'image');
        verifiedArtifact(review, run, capture, 'trace');
      }
    }
    link.freshness = 'current';
    delete link.freshnessDetail;
  } catch (error) {
    link.freshness = review.freshness === 'unknown' ? 'unknown' : 'stale';
    link.freshnessDetail = String(error);
  }
}
export function linkReviewEvidence(
  id: string,
  input: Parameters<ChangeReviewApi['linkEvidence']>[1],
): ChangeReview {
  const review = editable(id);
  if (!input?.source) throw new Error('Choose a visualisation chapter or risk.');
  visualisationSource(review, input.source);
  if (!input.criterionId && !input.scenarioVersion && !input.runId && !input.findingId)
    throw new Error('Choose an evidence target. Unmapped chapters can remain unmapped.');
  if (input.captureId && !input.runId) throw new Error('A capture requires its run.');
  const finding = input.findingId
    ? review.findings.find((item) => item.id === input.findingId)
    : undefined;
  if (input.findingId && !finding) throw new Error('Finding not found.');
  if (finding && input.runId && finding.runId !== input.runId)
    throw new Error('Finding belongs to a different run.');
  if (finding && input.captureId && finding.captureId !== input.captureId)
    throw new Error('Finding belongs to a different capture.');
  const link: ReviewEvidenceLink = {
    id: randomUUID(),
    source: structuredClone(input.source),
    visualisationVersion: visualisationSource(review, input.source),
    criterionId: input.criterionId,
    scenarioVersion: input.scenarioVersion,
    runId: input.runId ?? finding?.runId,
    captureId: input.captureId ?? finding?.captureId,
    findingId: input.findingId,
    criteriaVersion: review.criteria.at(-1)!.id,
    candidateTree: review.candidate.tree,
    createdAt: now(),
    provenance: 'human-linked',
    freshness: 'unknown',
  };
  updateLinkFreshness(getChangeReview(id), link);
  if (link.freshness !== 'current') throw new Error(link.freshnessDetail);
  review.evidenceLinks ??= [];
  review.evidenceLinks.push(link);
  return saveResponse(review);
}
export function unlinkReviewEvidence(id: string, linkId: string): ChangeReview {
  const review = editable(id);
  review.evidenceLinks = (review.evidenceLinks ?? []).filter((link) => link.id !== linkId);
  return saveResponse(review);
}
export function repairReviewFinding(
  id: string,
  findingId: string,
  input: Parameters<ChangeReviewApi['repairFinding']>[2],
): ChangeReview {
  const review = editable(id);
  const finding = review.findings.find((item) => item.id === findingId);
  if (!finding || (!input.threadId && !input.workItemRef))
    throw new Error('Choose a finding and repair thread or Work Item.');
  if (input.threadId) {
    const thread = getDb()
      .prepare('SELECT workspace_id FROM chat_threads WHERE id = ?')
      .get(input.threadId) as { workspace_id: string } | undefined;
    if (!thread || thread.workspace_id !== review.workspaceId)
      throw new Error('Repair thread must belong to this workspace.');
  }
  if (
    input.workItemRef &&
    (!input.workItemRef.id || !input.workItemRef.connectionId || !input.workItemRef.provider)
  )
    throw new Error('Repair Work Item needs its provider and connection.');
  finding.repair = { threadId: input.threadId, workItemRef: input.workItemRef, at: now() };
  return saveResponse(review);
}
export function recordNativeReviewEvidence(
  id: string,
  input: Parameters<ChangeReviewApi['recordNativeEvidence']>[1],
): ChangeReview {
  const review = editable(id);
  if (input.status === 'passed') {
    const current = captureReviewSnapshot(repoPath(review));
    if (
      current.head !== review.candidate.head ||
      current.tree !== review.candidate.tree ||
      reviewGit(repoPath(review), ['rev-parse', 'HEAD^{tree}']) !== review.candidate.tree
    )
      throw new Error(
        'Native build evidence requires the clean candidate commit. Commit changes and build this candidate first.',
      );
  }
  if (input.headSha !== review.candidate.head)
    throw new Error('Native build does not match this candidate head.');
  if (
    input.platform !== 'darwin' ||
    !['arm64', 'x64'].includes(input.arch) ||
    !['passed', 'failed', 'unsupported', 'unavailable'].includes(input.status) ||
    !['unsigned', 'signed', 'unavailable'].includes(input.signing)
  )
    throw new Error('Invalid native verification result.');
  if (
    !input.buildId?.trim() ||
    input.buildId.length > 300 ||
    !input.notes?.trim() ||
    input.notes.length > 8000
  )
    throw new Error('Record the build identity and manual verification notes.');
  review.nativeEvidence ??= [];
  review.nativeEvidence.push({
    candidateTree: review.candidate.tree,
    buildId: input.buildId,
    headSha: input.headSha,
    platform: input.platform,
    arch: input.arch,
    status: input.status,
    signing: input.signing,
    notes: input.notes,
    id: randomUUID(),
    recordedAt: now(),
    reviewer: userInfo().username,
    provenance: 'human-observed',
  });
  return saveResponse(review);
}

/** Resume repair sessions in their persisted candidate, never the regular checkout. */
export function resolveReviewRepairPaths(
  threadId: string | undefined,
  repoIds: string[],
  reviewId?: string,
): string[] | undefined {
  if (!threadId) {
    if (reviewId) throw new Error('A repair session requires a persisted thread.');
    return undefined;
  }
  const rows = getDb().prepare('SELECT record_json FROM change_reviews').all() as {
    record_json: string;
  }[];
  const review = reviewId
    ? read(reviewId)
    : rows
        .map((row) => JSON.parse(row.record_json) as ChangeReview)
        .find((item) => item.findings.some((finding) => finding.repair?.threadId === threadId));
  if (!review) return undefined;
  const thread = getDb()
    .prepare('SELECT workspace_id FROM chat_threads WHERE id = ?')
    .get(threadId) as { workspace_id: string } | undefined;
  if (
    !thread ||
    thread.workspace_id !== review.workspaceId ||
    repoIds.length !== 1 ||
    repoIds[0] !== review.repoId
  )
    throw new Error('Repair thread must target exactly the reviewed repository and workspace.');
  return [repoPath(review)];
}

/** A generic provider fork cannot persist the retained-candidate binding. */
export function assertReviewRepairForkAllowed(threadId: string): void {
  const rows = getDb().prepare('SELECT record_json FROM change_reviews').all() as {
    record_json: string;
  }[];
  if (
    rows.some((row) =>
      (JSON.parse(row.record_json) as ChangeReview).findings.some(
        (finding) => finding.repair?.threadId === threadId,
      ),
    )
  ) {
    throw new Error(
      'Repair threads cannot be forked. Request another fix from Change Review to preserve the candidate worktree.',
    );
  }
}
