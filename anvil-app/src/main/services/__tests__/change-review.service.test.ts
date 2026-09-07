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
