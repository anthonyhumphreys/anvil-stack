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
} from '../../shared/change-review-types.js';
import { extractAcceptanceCriteria } from '../../shared/workitem-intent.js';
import { getDb } from '../db/database.js';
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
function repoPath(review: Pick<ChangeReview, 'workspaceId' | 'repoId'>): string {
  const repo = getWorkspace(review.workspaceId).repos.find((repo) => repo.id === review.repoId);
  if (!repo) throw new Error('The review repository is no longer linked to this workspace.');
  return repo.path;
}
function save(review: ChangeReview): ChangeReview {
  review.updatedAt = now();
  getDb()
    .prepare(
      'INSERT INTO change_reviews VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at',
    )
    .run(review.id, review.workspaceId, review.repoId, JSON.stringify(review), review.updatedAt);
  return review;
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
  if (!input.baseRef?.trim() || input.baseRef.startsWith('-'))
    throw new Error('Choose a base Git reference.');
  const baseCommit = reviewGit(path, ['rev-parse', '--verify', `${input.baseRef}^{commit}`]);
  const item = input.workItemRef
    ? await getActiveProvider(input.workItemRef.connectionId, true)?.getItem(input.workItemRef.id)
    : undefined;
  if (input.workItemRef && (!item || item.provider !== input.workItemRef.provider))
    throw new Error('Work Item provider does not match the linked connection.');
  return save({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    title: item?.title ?? 'Local change review',
    baseRef: input.baseRef,
    baseCommit,
    candidate: captureReviewSnapshot(path),
    workItemRef: input.workItemRef,
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
  ).map((row) => JSON.parse(row.record_json));
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
    review.freshness =
      captureReviewSnapshot(repoPath(review)).tree === review.candidate.tree
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
  review.candidate = snapshot;
  review.freshness = 'current';
  delete review.freshnessDetail;
  return save(review);
}
export function configureChangeReview(id: string, scenario: ReviewScenario): ChangeReview {
  const review = editable(id);
  review.scenario = validateScenario(scenario);
  review.scenarioVersion = digest(JSON.stringify(review.scenario));
  return save(review);
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
  return review;
}
export function cancelChangeReview(id: string): void {
  active.get(id)?.abort();
}
function currentRun(review: ChangeReview, runId: string): ReviewRun {
  const run = review.runs.find((run) => run.id === runId);
  if (
    !run ||
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
  return save(review);
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
  }
  finding.history.push({ state, at: now(), runId });
  return save(review);
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
    if (review.findings.some((f) => f.history.at(-1)?.state !== 'accepted'))
      throw new Error('Resolve open findings before acceptance.');
    for (const capture of [...run.base, ...run.candidateCaptures]) {
      verifiedArtifact(review, run, capture, 'image');
      verifiedArtifact(review, run, capture, 'trace');
    }
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
  return save(review);
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
    id: review.id,
    title: review.title,
    workItem: review.workItemRef,
    base: review.baseCommit,
    candidate: review.candidate,
    freshness: review.freshness,
    criteria: review.criteria,
    runs: review.runs.map(({ log: _log, ...run }) => ({
      ...run,
      base: run.base.map(({ image: _image, trace: _trace, ...c }) => c),
      candidateCaptures: run.candidateCaptures.map(({ image: _image, trace: _trace, ...c }) => c),
    })),
    findings: review.findings,
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
        ...review.findings.map((f) => `- ${f.history.at(-1)?.state}: ${f.note}`),
        '## Human decisions',
        ...review.decisions.map((d) => `- ${d.at}: ${d.outcome} for ${d.snapshot}. ${d.note}`),
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
    if (previous.status === 'published') return review;
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
    return save(latest);
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
