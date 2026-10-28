import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUISurfaceIntent } from '../../../../shared/agent-ui-intents.js';
import type { ReviewSurfaceData } from '../../../../shared/surfaces/kinds/review/types.js';
import { buildReviewSurfaceData } from '../review/build.js';
import { REVIEW_FIXTURE_CONTEXT, fixtureFinding } from './review-fixture.js';

const state = vi.hoisted(() => ({
  intent: null as AgentUISurfaceIntent | null,
  delivered: [] as Array<{ surfaceId: string; message: string }>,
  deliver: true,
  repoPath: '/tmp/none',
}));

vi.mock('../../core.js', () => ({
  getSurface: vi.fn(() => state.intent),
  patchSurface: vi.fn(
    (surfaceId: string, _base: number | undefined, update: (data: unknown) => unknown) => {
      if (!state.intent || state.intent.id !== surfaceId) throw new Error('missing');
      state.intent = {
        ...state.intent,
        revision: state.intent.revision + 1,
        payload: { ...state.intent.payload, data: update(state.intent.payload.data) },
      };
      return state.intent;
    },
  ),
  deliverSurfaceFeedback: vi.fn(async (surfaceId: string, message: string) => {
    state.delivered.push({ surfaceId, message });
    return state.deliver;
  }),
  publishSurface: vi.fn(),
  requestUserApproval: vi.fn(),
}));

const postComment = vi.fn();
vi.mock('../../../services/code-review-pr.service.js', () => ({
  postCommentToPullRequest: (...args: unknown[]) => postComment(...args),
}));

const createItem = vi.fn();
const provider = { value: null as null | { createItem: typeof createItem } };
vi.mock('../../../services/workitem-provider.js', () => ({
  getActiveProvider: () => provider.value,
}));

vi.mock('../review/scope-diff.js', () => ({
  getReviewRepo: () => ({
    id: 'repo-1',
    name: 'app',
    path: state.repoPath,
    remoteUrl: 'https://github.com/acme/app.git',
  }),
}));

const { executeReviewAction, buildAskFixMessage } = await import('../review/actions.js');

function seed(data: ReviewSurfaceData): void {
  state.intent = {
    protocolVersion: 1,
    id: 'surface-1',
    kind: 'surface',
    revision: 1,
    scope: { threadId: 'thread-1' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: { surfaceKind: 'review', title: 'Review', streaming: false, digest: '', data },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function reviewData(overrides: Partial<ReviewSurfaceData> = {}): ReviewSurfaceData {
  return {
    ...buildReviewSurfaceData(
      {
        findings: [
          fixtureFinding(),
          fixtureFinding({
            id: 'f2',
            severity: 'medium',
            title: 'Audit before return',
            lineStart: 14,
            lineEnd: 14,
          }),
        ],
      },
      REVIEW_FIXTURE_CONTEXT,
    ),
    ...overrides,
  };
}

function data(): ReviewSurfaceData {
  return state.intent!.payload.data as ReviewSurfaceData;
}

function run(action: string, targetIds?: string[], note?: string) {
  return executeReviewAction(
    { intent: state.intent! },
    { surfaceId: 'surface-1', action, targetIds, note },
  );
}

beforeEach(() => {
  state.delivered = [];
  state.deliver = true;
  postComment.mockReset();
  createItem.mockReset();
  provider.value = null;
  seed(reviewData());
});

describe('review actions', () => {
  it('accepts findings and keeps the verdict in step', async () => {
    expect(await run('accept', ['f1', 'f2'])).toMatchObject({ ok: true });
    expect(data().findings.map((finding) => finding.status)).toEqual(['accepted', 'accepted']);
    expect(data().verdict.decision).toBe('ship-with-fixes');
  });

  it('requires a reason to dismiss and persists it', async () => {
    expect(await run('dismiss', ['f1'])).toMatchObject({ ok: false });
    expect(await run('dismiss', ['f1'], '  Covered by the mutex upstream. ')).toMatchObject({
      ok: true,
    });
    expect(data().findings[0]).toMatchObject({
      status: 'dismissed',
      dismissReason: 'Covered by the mutex upstream.',
    });
    expect(await run('reopen', ['f1'])).toMatchObject({ ok: true });
    expect(data().findings[0].dismissReason).toBeUndefined();
  });

  it('rejects unknown targets', async () => {
    expect(await run('accept', ['nope'])).toEqual({ ok: false, error: 'Unknown finding(s): nope' });
  });

  it('ask_fix marks findings fix-requested and sends a structured message', async () => {
    const result = await run('ask_fix', ['f1', 'f2'], 'do these');
    expect(result).toMatchObject({ ok: true });
    expect(data().findings.map((finding) => finding.status)).toEqual([
      'fix-requested',
      'fix-requested',
    ]);
    expect(state.delivered).toHaveLength(1);
    const { message } = state.delivered[0];
    expect(message).toContain(
      'f1 · High · src/auth/refresh.ts:13-14 — Cache write races the rotation',
    );
    expect(message).toContain('f2 · Medium · src/auth/refresh.ts:14');
    expect(message).toContain('User note: do these');
    expect(message).toContain("op: 'link_fix'");
  });

  it('ask_fix reverts statuses when no agent session is live', async () => {
    await run('accept', ['f2']);
    state.deliver = false;
    const result = await run('ask_fix', ['f1', 'f2']);
    expect(result.ok).toBe(false);
    expect(data().findings.map((finding) => finding.status)).toEqual(['open', 'accepted']);
  });

  it('post_to_pr refuses non-PR scopes and posts one summary comment for PRs', async () => {
    expect(await run('post_to_pr')).toMatchObject({ ok: false });
    seed(reviewData({ scope: { type: 'pull-request', repoId: 'repo-1', pullRequestId: '42' } }));
    postComment.mockResolvedValue({
      id: '9',
      url: 'https://github.com/acme/app/pull/42#c9',
      postedAt: 'now',
    });
    expect(await run('post_to_pr', ['f1'])).toMatchObject({ ok: true });
    const [remote, ref, body] = postComment.mock.calls[0];
    expect(remote).toBe('https://github.com/acme/app.git');
    expect(ref).toEqual({ id: '42' });
    expect(body).toContain('`src/auth/refresh.ts:13-14` — Cache write races the rotation');
    expect(body).not.toContain('Audit before return');
    expect(data().findings[0].prCommentUrl).toBe('https://github.com/acme/app/pull/42#c9');
    expect(data().prComments).toEqual([
      { url: 'https://github.com/acme/app/pull/42#c9', postedAt: 'now', findingIds: ['f1'] },
    ]);
  });

  it('create_work_items is honest without a provider and links created items', async () => {
    expect(await run('create_work_items', ['f1'])).toMatchObject({
      ok: false,
      error: expect.stringContaining('No work item provider'),
    });
    provider.value = { createItem };
    createItem.mockResolvedValueOnce({
      id: 'WI-1',
      title: 'High: Cache write',
      url: 'https://linear.app/wi-1',
    });
    createItem.mockRejectedValueOnce(new Error('rate limited'));
    const result = await run('create_work_items', ['f1', 'f2']);
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('1 failed') });
    expect(createItem.mock.calls[0][0].title).toBe('High: Cache write races the rotation');
    expect(data().findings[0].workItem).toEqual({
      id: 'WI-1',
      title: 'High: Cache write',
      url: 'https://linear.app/wi-1',
    });
    expect(data().findings[1].workItem).toBeUndefined();
  });

  it('buildAskFixMessage stays readable without a note', () => {
    expect(buildAskFixMessage('s', [data().findings[0]])).not.toContain('User note');
  });
});

describe('apply_patch', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'mezair-review-apply-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'src/auth'), { recursive: true });
    writeFileSync(join(repo, 'src/auth/refresh.ts'), 'one\ntwo\nthree\n');
    state.repoPath = repo;
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function seedPatch(patch: string): void {
    const review = reviewData();
    review.findings[0] = { ...review.findings[0], suggestedPatch: patch };
    seed(review);
  }

  it('checks then applies the suggested patch and marks the finding fixed', async () => {
    seedPatch('@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n');
    const result = await run('apply_patch', ['f1']);
    expect(result).toMatchObject({ ok: true });
    expect(readFileSync(join(repo, 'src/auth/refresh.ts'), 'utf-8')).toBe('one\nTWO\nthree\n');
    expect(data().findings[0]).toMatchObject({
      status: 'fixed',
      fixNote: expect.stringContaining('Applied'),
    });
  });

  it('reports a clean error when the patch no longer applies', async () => {
    seedPatch('@@ -1,3 +1,3 @@\n one\n-nope\n+TWO\n three\n');
    const result = await run('apply_patch', ['f1']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no longer applies cleanly');
    expect(readFileSync(join(repo, 'src/auth/refresh.ts'), 'utf-8')).toBe('one\ntwo\nthree\n');
    expect(data().findings[0].status).toBe('open');
  });

  it('refuses patches that touch other files or a missing patch', async () => {
    expect(await run('apply_patch', ['f2'])).toMatchObject({
      ok: false,
      error: 'This finding has no suggested patch.',
    });
    seedPatch('--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-a\n+b\n');
    expect(await run('apply_patch', ['f1'])).toMatchObject({ ok: false });
    expect(await run('apply_patch', ['f1', 'f2'])).toMatchObject({
      ok: false,
      error: 'Apply one suggested patch at a time.',
    });
  });
});
