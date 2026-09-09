import { isFindingAccepted } from '../../../shared/change-review-types.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../change-review-runner.service.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
const mocks = vi.hoisted(() => ({
  tree: 'tree-a',
  text: '- Save valid settings\n- Preserve keyboard flow',
  fail: false,
  publish: vi.fn(),
}));
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  shell: {},
}));
vi.mock('../workspace.service.js', () => ({
  getWorkspace: () => ({ repos: [{ id: 'repo', path: '/repo' }] }),
}));
vi.mock('../review-snapshot.service.js', () => ({
  captureReviewSnapshot: () => ({ head: 'head', tree: mocks.tree, capturedAt: 'today' }),
  reviewGit: () => 'base-commit',
}));
vi.mock('../workitem-provider.js', () => ({
  getActiveProvider: () => ({
    getItem: async () => {
      if (mocks.fail) throw new Error('offline');
      return { id: 'WI-1', provider: 'linear', title: 'Settings', acceptanceCriteria: mocks.text };
    },
    publishReview: mocks.publish,
  }),
}));
import {
  createChangeReview,
  getChangeReview,
  configureChangeReview,
  refreshChangeReview,
  decideChangeReview,
  resolveReviewFinding,
  annotateChangeReview,
  validateScenario,
  publishChangeReview,
  linkReviewEvidence,
  recordNativeReviewEvidence,
} from '../change-review.service.js';
import type {
  ChangeReview,
  ReviewRun,
  ReviewScenario,
} from '../../../shared/change-review-types.js';
const scenario: ReviewScenario = {
  name: 'Settings',
  fixtureVersion: 'v1',
  resetCommand: 'reset',
  startCommand: 'start',
  readyPath: '/',
  steps: [{ action: 'goto', value: '/' }],
  viewports: [{ name: 'Mobile', width: 390, height: 844 }],
};
function persist(review: ChangeReview): void {
  db.prepare('UPDATE change_reviews SET record_json = ? WHERE id = ?').run(
    JSON.stringify(review),
    review.id,
  );
}
async function reviewWithRun(): Promise<ChangeReview> {
  let review = await createChangeReview({
    workspaceId: 'ws',
    repoId: 'repo',
    baseRef: 'main',
    workItemRef: { connectionId: 'connection', provider: 'linear', id: 'WI-1' },
  });
  review = configureChangeReview(review.id, scenario);
  review.runs.push({
    id: 'run',
    candidate: review.candidate,
    baseTree: 'base',
    criteriaVersion: review.criteria.at(-1)!.id,
    scenarioVersion: review.scenarioVersion!,
    startedAt: '2026-01-01',
    completedAt: '2026-01-02',
    provenance: 'runner-observed',
    outcome: 'passed',
    environment: 'test',
    base: [],
    candidateCaptures: [],
    log: '',
  });
  persist(review);
  return review;
}
beforeEach(() => {
  db.exec('DELETE FROM change_reviews; DELETE FROM workspaces; DELETE FROM repos;');
  db.prepare(
    "INSERT INTO workspaces (id,name,created_at,updated_at) VALUES (?,?,datetime('now'),datetime('now'))",
  ).run('ws', 'Test');
  db.prepare('INSERT INTO repos (id,name,path) VALUES (?,?,?)').run('repo', 'Repo', '/repo');
  mocks.tree = 'tree-a';
  mocks.text = '- Save valid settings\n- Preserve keyboard flow';
  mocks.fail = false;
  mocks.publish.mockReset();
});
describe('change acceptance', () => {
  it('preserves historical passing runs but refuses acceptance after source changes', async () => {
    const review = await reviewWithRun();
    mocks.tree = 'tree-b';
    expect(getChangeReview(review.id).freshness).toBe('stale');
    await expect(
      decideChangeReview(review.id, {
        runId: 'run',
        outcome: 'accepted',
        note: 'Reviewed',
        criterionDecisions: [],
      }),
    ).rejects.toThrow('stale');
    expect(getChangeReview(review.id).runs[0].outcome).toBe('passed');
  });
  it('versions provider criteria and invalidates previous evidence', async () => {
    const review = await reviewWithRun();
    mocks.text = '- A changed expectation';
    const refreshed = await refreshChangeReview(review.id);
    expect(refreshed.criteria).toHaveLength(2);
    await expect(
      decideChangeReview(review.id, {
        runId: 'run',
        outcome: 'accepted',
        note: 'Reviewed',
        criterionDecisions: [],
      }),
    ).rejects.toThrow('stale');
  });
  it('does not accept while the provider cannot be refreshed', async () => {
    const review = await reviewWithRun();
    mocks.fail = true;
    await expect(refreshChangeReview(review.id)).rejects.toThrow('offline');
    expect(getChangeReview(review.id).freshness).toBe('unknown');
  });
  it('records acceptance only for complete evidence and rejects tampered artifacts', async () => {
    const review = await reviewWithRun();
    const dir = join('/tmp', 'change-review', review.id, 'run');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'capture.png'), 'capture');
      writeFileSync(join(dir, 'trace.zip'), 'trace');
      review.runs[0].candidateCaptures = [
        {
          id: 'capture',
          viewport: 'Mobile',
          image: 'capture.png',
          trace: 'trace.zip',
          imageDigest: digest('capture'),
          traceDigest: digest('trace'),
          outcome: 'passed',
          steps: [],
        },
      ];
      persist(review);
      const decision = {
        runId: 'run',
        outcome: 'accepted' as const,
        note: 'Inspected visual result and keyboard flow',
        criterionDecisions: review.criteria[0].items.map((c) => ({
          criterionId: c.id,
          outcome: 'accepted' as const,
          note: 'Manual check',
        })),
      };
      const oldRun = {
        ...review.runs[0],
        id: 'old-replay',
        candidate: { ...review.candidate, tree: 'old-tree' },
      };
      review.runs.push(oldRun);
      review.findings.push({
        id: 'finding',
        runId: 'original',
        captureId: 'capture',
        note: 'Clipped control',
        history: [{ state: 'accepted', at: '2026-01-02', runId: oldRun.id }],
      });
      persist(review);
      await expect(decideChangeReview(review.id, decision)).rejects.toThrow(
        'Resolve open findings',
      );
      oldRun.candidate = review.candidate;
      oldRun.criteriaVersion = 'old-criteria';
      persist(review);
      await expect(decideChangeReview(review.id, decision)).rejects.toThrow(
        'Resolve open findings',
      );
      oldRun.criteriaVersion = review.criteria[0].id;
      oldRun.scenarioVersion = 'old-scenario';
      persist(review);
      await expect(decideChangeReview(review.id, decision)).rejects.toThrow(
        'Resolve open findings',
      );
      review.findings[0].history.push({ state: 'accepted', at: '2026-01-03', runId: 'run' });
      persist(review);
      expect((await decideChangeReview(review.id, decision)).decisions).toHaveLength(1);
      writeFileSync(join(dir, 'capture.png'), 'replaced');
      await expect(decideChangeReview(review.id, decision)).rejects.toThrow('Artifact changed');
    } finally {
      rmSync(join('/tmp', 'change-review', review.id), { recursive: true, force: true });
    }
  });
  it('does not treat absent captures or unchecked criteria as acceptance evidence', async () => {
    const review = await reviewWithRun();
    await expect(
      decideChangeReview(review.id, {
        runId: 'run',
        outcome: 'accepted',
        note: 'Reviewed',
        criterionDecisions: review.criteria[0].items.map((c) => ({
          criterionId: c.id,
          outcome: 'accepted',
          note: 'manual',
        })),
      }),
    ).rejects.toThrow('passing candidate run');
  });
  it('recovers interrupted runs as inconclusive', async () => {
    const review = await reviewWithRun();
    review.runs[0].outcome = 'running';
    persist(review);
    expect(getChangeReview(review.id).runs[0].outcome).toBe('inconclusive');
  });
  it('keeps a claimed fix open until a later passing replay exists', async () => {
    const review = await reviewWithRun();
    review.runs[0].candidateCaptures = [
      { id: 'capture' } as ReviewRun['candidateCaptures'][number],
    ];
    persist(review);
    const annotated = annotateChangeReview(review.id, {
      runId: 'run',
      captureId: 'capture',
      note: 'Button clipped',
    });
    const finding = annotated.findings[0];
    expect(
      resolveReviewFinding(
        review.id,
        finding.id,
        'ready_for_recheck',
        'run',
      ).findings[0].history.at(-1)?.state,
    ).toBe('ready_for_recheck');
    expect(() => resolveReviewFinding(review.id, finding.id, 'accepted', 'run')).toThrow(
      'subsequent passing replay',
    );
  });
  it('rejects external navigation and malformed scenario settings', () => {
    expect(() => validateScenario({ ...scenario, readyPath: '//production.example' })).toThrow(
      'local path',
    );
    expect(() =>
      validateScenario({
        ...scenario,
        steps: [{ action: 'goto', value: 'https://production.example' }],
      }),
    ).toThrow('local path');
    expect(() =>
      validateScenario({ ...scenario, viewports: [{ name: 'Mobile', width: NaN, height: 844 }] }),
    ).toThrow('dimensions');
  });
  it('never retries an uncertain provider publication or changes the saved decision', async () => {
    const review = await reviewWithRun();
    review.decisions.push({ id: 'decision' } as ChangeReview['decisions'][number]);
    persist(review);
    mocks.publish.mockRejectedValue(new Error('connection dropped'));
    await expect(publishChangeReview(review.id, 'decision', 'Redacted evidence')).rejects.toThrow(
      'not confirmed',
    );
    await expect(publishChangeReview(review.id, 'decision', 'Redacted evidence')).rejects.toThrow(
      'duplicate',
    );
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(getChangeReview(review.id).decisions).toHaveLength(1);
  });
});

describe('delivery evidence identity', () => {
  it('refuses missing retained candidates without falling back to the repository', async () => {
    await expect(
      createChangeReview({
        workspaceId: 'ws',
        repoId: 'repo',
        baseRef: 'main',
        origin: { workflowRunId: 'missing' },
      }),
    ).rejects.toThrow('Workflow candidate is unavailable');
    await expect(
      createChangeReview({
        workspaceId: 'ws',
        repoId: 'repo',
        baseRef: 'main',
        origin: { automationRunId: 'missing' },
      }),
    ).rejects.toThrow('Automation candidate is unavailable');
    await expect(
      createChangeReview({
        workspaceId: 'ws',
        repoId: 'repo',
        baseRef: 'main',
        origin: { executionPath: '/arbitrary' },
      }),
    ).rejects.toThrow('persisted workflow');
  });
  it('rejects a PR handoff pointing at another head', async () => {
    await expect(
      createChangeReview({
        workspaceId: 'ws',
        repoId: 'repo',
        baseRef: 'main',
        origin: { pullRequest: { id: '7', provider: 'github', headSha: 'other' } },
      }),
    ).rejects.toThrow('does not match');
  });
  it('requires explicit mappings and invalidates them when criteria change', async () => {
    const review = await reviewWithRun();
    db.prepare(
      'INSERT INTO pull_request_visualisations (id,repo_id,provider,pull_request_id,head_sha,status,pull_request_json,data_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      'vis',
      'repo',
      'github',
      '7',
      'head',
      'ready',
      '{}',
      JSON.stringify({ chapters: [{ id: 'chapter' }] }),
      'today',
    );
    const source = {
      visualisationId: 'vis',
      headSha: 'head',
      kind: 'chapter' as const,
      id: 'chapter',
    };
    expect(() => linkReviewEvidence(review.id, { source })).toThrow('Choose an evidence target');
    const linked = linkReviewEvidence(review.id, {
      source,
      criterionId: review.criteria[0].items[0].id,
    });
    expect(linked.evidenceLinks?.[0]).toMatchObject({
      provenance: 'human-linked',
      freshness: 'current',
    });
    expect(linked.decisions).toEqual([]);
    db.prepare(
      'INSERT INTO pull_request_visualisations (id,repo_id,provider,pull_request_id,head_sha,status,pull_request_json,data_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run('vis-new', 'repo', 'github', '7', 'new-head', 'ready', '{}', '{}', 'tomorrow');
    expect(getChangeReview(review.id).evidenceLinks?.[0].freshness).toBe('stale');
    db.prepare('DELETE FROM pull_request_visualisations WHERE id = ?').run('vis-new');
    db.prepare('UPDATE pull_request_visualisations SET data_json = ? WHERE id = ?').run(
      JSON.stringify({ chapters: [{ id: 'chapter', summary: 'regenerated' }] }),
      'vis',
    );
    expect(getChangeReview(review.id).evidenceLinks?.[0].freshness).toBe('stale');

    mocks.text = '- New intent';
    await refreshChangeReview(review.id);
    expect(getChangeReview(review.id).evidenceLinks?.[0].freshness).toBe('stale');
  });
  it('marks capture mappings stale when their artifacts disappear', async () => {
    const review = await reviewWithRun();
    const dir = join('/tmp', 'change-review', review.id, 'run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'image.png'), 'image');
    writeFileSync(join(dir, 'trace.zip'), 'trace');
    review.runs[0].candidateCaptures.push({
      id: 'capture',
      viewport: 'Mobile',
      image: 'image.png',
      trace: 'trace.zip',
      imageDigest: digest('image'),
      traceDigest: digest('trace'),
      outcome: 'passed',
      steps: [],
    });
    persist(review);
    db.prepare(
      'INSERT INTO pull_request_visualisations (id,repo_id,provider,pull_request_id,head_sha,status,pull_request_json,data_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      'vis2',
      'repo',
      'github',
      '8',
      'head',
      'ready',
      '{}',
      JSON.stringify({ risks: [{ id: 'risk' }] }),
      'today',
    );
    linkReviewEvidence(review.id, {
      source: { visualisationId: 'vis2', headSha: 'head', kind: 'risk', id: 'risk' },
      runId: 'run',
      captureId: 'capture',
    });
    const latest = getChangeReview(review.id);
    latest.findings.push({
      id: 'accepted-finding',
      runId: 'run',
      captureId: 'capture',
      note: 'Reviewed',
      history: [{ state: 'accepted', at: 'now', runId: 'run' }],
    });
    persist(latest);
    expect(getChangeReview(review.id).runs[0].evidenceAvailable).toBe(true);
    expect(isFindingAccepted(getChangeReview(review.id), latest.findings[0])).toBe(true);
    latest.origin = { pullRequest: { id: '8', number: 8, provider: 'github', headSha: 'head' } };
    persist(latest);
    db.prepare(
      "INSERT INTO automation_definitions(id,workspace_id,name,persona_id,prompt,schedule_cron,timezone,created_at,updated_at) VALUES ('watch','ws','Watch','coder','Review','* * * * *','UTC','now','now')",
    ).run();
    const watch = (
      id: string,
      observedAt: string,
      provider: string,
      pullRequestNumber: number,
      headSha: string,
      occurredAt: string,
      repoId = 'repo',
    ) => {
      db.prepare(
        "INSERT INTO watchtower_events(id,automation_id,event_type,source_id,payload_json,observed_at) VALUES (?,'watch','pull_request.head_changed',?,?,?)",
      ).run(
        id,
        id,
        JSON.stringify({
          workspaceId: 'ws',
          repoIds: [repoId],
          occurredAt,
          metadata: { repoId, provider, pullRequestNumber, headSha },
        }),
        observedAt,
      );
    };
    watch('other-provider', '2026-01-05', 'azure-devops', 8, 'unrelated', '2026-01-05');
    watch('other-pr', '2026-01-05', 'github', 9, 'unrelated', '2026-01-05');
    watch('other-repo', '2026-01-05', 'github', 8, 'unrelated', '2026-01-05', 'different-repo');
    expect(getChangeReview(review.id).freshness).toBe('current');
    // Later observation wins even though its remote occurredAt precedes the prior event.
    watch('older-head', '2026-01-01', 'github', 8, 'head', '2026-02-01');
    watch('new-head', '2026-01-02', 'github', 8, 'head-new', '2025-12-01');
    const changedHead = getChangeReview(review.id);
    expect(changedHead.freshness).toBe('stale');
    expect(changedHead.evidenceLinks?.[0].freshness).toBe('stale');
    expect(isFindingAccepted(changedHead, changedHead.findings[0])).toBe(false);
    await expect(refreshChangeReview(review.id)).rejects.toThrow('newer pull request head');
    db.prepare("DELETE FROM watchtower_events WHERE automation_id = 'watch'").run();
    db.prepare("DELETE FROM automation_definitions WHERE id = 'watch'").run();

    rmSync(dir, { recursive: true, force: true });
    const missing = getChangeReview(review.id);
    expect(missing.runs[0].evidenceAvailable).toBe(false);
    expect(missing.runs[0].evidenceDetail).toBeTruthy();
    expect(isFindingAccepted(missing, missing.findings[0])).toBe(false);
    expect(missing.evidenceLinks?.[0].freshness).toBe('stale');
  });
  it('keeps native observations separate from acceptance and enforces head identity', async () => {
    const review = await reviewWithRun();
    const input = {
      buildId: 'pr-7-head-darwin-arm64-1',
      headSha: 'head',
      platform: 'darwin' as const,
      arch: 'arm64' as const,
      status: 'unavailable' as const,
      signing: 'unavailable' as const,
      notes: 'No native build available',
    };
    expect(() => recordNativeReviewEvidence(review.id, { ...input, headSha: 'other' })).toThrow(
      'does not match',
    );
    const recorded = recordNativeReviewEvidence(review.id, input);
    expect(recorded.nativeEvidence?.[0].provenance).toBe('human-observed');
    expect(recorded.decisions).toEqual([]);
    expect(recorded.nativeEvidence?.[0].candidateTree).toBe(review.candidate.tree);
    expect(() => recordNativeReviewEvidence(review.id, { ...input, status: 'passed' })).toThrow(
      'clean candidate commit',
    );
  });
});
