import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUISurfaceIntent } from '../../../../shared/agent-ui-intents.js';
import type { AgentToolSessionContext } from '../../../agent-tools/dispatch.js';
import type { ReviewSurfaceData } from '../../../../shared/surfaces/kinds/review/types.js';
import { REVIEW_FIXTURE_DIFF, REVIEW_FIXTURE_FILES, fixtureFinding } from './review-fixture.js';

const state = vi.hoisted(() => ({
  intent: null as AgentUISurfaceIntent | null,
  publishCalls: [] as unknown[],
  patchOptions: [] as unknown[],
  loadCalls: [] as unknown[],
}));

vi.mock('../../core.js', () => ({
  publishSurface: vi.fn(
    (
      _ctx: unknown,
      input: { surfaceKind: string; title: string; key: string; data: unknown; streaming: boolean },
    ) => {
      state.publishCalls.push(input);
      state.intent = {
        protocolVersion: 1,
        id: 'surface-9',
        kind: 'surface',
        revision: 1,
        scope: { threadId: 'thread-1' },
        lifecycle: 'presented',
        presentation: { collapsed: false, hidden: false },
        payload: {
          surfaceKind: input.surfaceKind,
          title: input.title,
          key: input.key,
          streaming: input.streaming,
          digest: '',
          data: input.data,
        },
        createdAt: 'now',
        updatedAt: 'now',
      };
      return state.intent;
    },
  ),
  patchSurface: vi.fn(
    (
      _id: string,
      base: number | undefined,
      update: (data: unknown) => unknown,
      options?: unknown,
    ) => {
      if (!state.intent) throw new Error('missing');
      if (base !== undefined && base !== state.intent.revision) throw new Error('conflict');
      state.patchOptions.push(options);
      state.intent = {
        ...state.intent,
        revision: state.intent.revision + 1,
        payload: { ...state.intent.payload, data: update(state.intent.payload.data) },
      };
      return state.intent;
    },
  ),
  getSurface: vi.fn(() => state.intent),
  deliverSurfaceFeedback: vi.fn(),
  requestUserApproval: vi.fn(),
}));

vi.mock('../review/scope-diff.js', () => ({
  getReviewRepo: () => ({ id: 'repo-1', name: 'app', path: '/Users/dev/code/app' }),
  scopeToRequest: (scope: { type: string; repoId: string }) => ({
    type: scope.type,
    repoId: scope.repoId,
  }),
  loadReviewDiff: vi.fn(async (_ctx: unknown, request: { type: string; repoId: string }) => {
    state.loadCalls.push(request);
    const parts = REVIEW_FIXTURE_DIFF.split(/^(?=diff --git )/m).filter(Boolean);
    return {
      scope: { type: request.type, repoId: request.repoId },
      key: `review:${request.repoId}:${request.type}`,
      repo: { id: 'repo-1', name: 'app', path: '/Users/dev/code/app' },
      files: REVIEW_FIXTURE_FILES,
      rawByPath: new Map(
        REVIEW_FIXTURE_FILES.map((file, index) => [
          file.path,
          // Inflate the added file so the 4 KB budget test omits it.
          file.status === 'added' ? `${parts[index]}${'+// padding\n'.repeat(400)}` : parts[index],
        ]),
      ),
      notes: [],
      loadedAt: Date.now(),
    };
  }),
}));

vi.mock('../../../utils/prompt-templates.js', () => ({
  loadPromptTemplate: () =>
    '# Review\n\n## Default Focus Areas (when no custom rubric provided)\n- **Bug Risk** — races\n\n## Instructions\nReturn JSON.',
}));
vi.mock('../../../services/code-review-pr.service.js', () => ({
  parseGitHubRemoteUrl: () => null,
  postCommentToPullRequest: vi.fn(),
}));
vi.mock('../../../services/pull-request-visualisation-persistence.service.js', () => ({
  getLatestPullRequestVisualisation: () => null,
}));
vi.mock('../../../services/workitem-provider.js', () => ({ getActiveProvider: () => null }));

const { reviewToolProvider, reviewSurfaceHandler } = await import('../review.js');

const ctx: AgentToolSessionContext = {
  sessionId: 'session-1',
  appThreadId: 'thread-1',
  repoIds: ['repo-1'],
  provider: 'codex',
  mode: 'workspace-auto',
  features: ['codereview'],
} as AgentToolSessionContext;

function call(name: string, args: Record<string, unknown>) {
  return reviewToolProvider.call(ctx, name, args);
}

beforeEach(() => {
  state.intent = null;
  state.publishCalls = [];
  state.patchOptions = [];
  state.loadCalls = [];
});

describe('review tool provider', () => {
  it('declares three codereview-gated tools on the review handler', () => {
    expect(reviewSurfaceHandler.kind).toBe('review');
    expect(reviewSurfaceHandler.toolProvider).toBe(reviewToolProvider);
    const tools = reviewToolProvider.tools(ctx);
    expect(tools.map((tool) => tool.name)).toEqual([
      'review_context',
      'review_publish',
      'review_patch',
    ]);
    expect(tools.every((tool) => tool.feature === 'codereview' && !tool.mutation)).toBe(true);
  });

  it('review_context rejects out-of-scope repos', async () => {
    await expect(
      call('review_context', { repoId: 'other', scope: 'working-tree' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('review_context returns scope, summary, rubric and a budgeted diff', async () => {
    const result = await call('review_context', {
      repoId: 'repo-1',
      scope: 'working-tree',
      maxBytes: 4000,
    });
    const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('{"type":"working-tree","repoId":"repo-1"}');
    expect(text).toContain('3 files · +66 −5');
    expect(text).toContain('- A src/gateway/new.ts (+62 −0)');
    expect(text).toContain('**Bug Risk** — races');
    expect(text).not.toContain('Return JSON');
    expect(text).toContain('@@ -10,6 +10,8 @@');
    expect(result?.structuredContent).toMatchObject({
      key: 'review:repo-1:working-tree',
      truncated: true,
    });
    expect(text).toContain('Omitted to stay within the 4 KB budget (1 file): src/gateway/new.ts');
    expect(result?.structuredContent).toMatchObject({
      includedFiles: ['src/auth/refresh.ts', 'src/old/legacy.ts'],
    });
  });

  it('review_publish validates, publishes under the scope key and returns the digest', async () => {
    const result = await call('review_publish', {
      scope: { type: 'working-tree', repoId: 'repo-1' },
      chapters: [{ title: 'Refresh', files: ['src/auth/refresh.ts'] }],
      findings: [fixtureFinding()],
      streaming: true,
    });
    expect(state.publishCalls[0]).toMatchObject({
      surfaceKind: 'review',
      key: 'review:repo-1:working-tree',
      title: 'Review · working tree',
      streaming: true,
    });
    expect(result?.structuredContent).toMatchObject({ surfaceId: 'surface-9', revision: 1 });
    expect(String(result?.structuredContent?.digest)).toMatch(/^Review: ship after 1 fix/);
  });

  it('review_publish surfaces anchoring failures as invalid-params', async () => {
    await expect(
      call('review_publish', {
        scope: { type: 'working-tree', repoId: 'repo-1' },
        chapters: [],
        findings: [fixtureFinding({ id: 'bad', lineStart: 400, lineEnd: 401 })],
      }),
    ).rejects.toMatchObject({
      code: 'invalid-params',
      message: expect.stringContaining('bad (src/auth/refresh.ts:400-401)'),
    });
    expect(state.publishCalls).toHaveLength(0);
  });

  it('review_patch applies ops by revision, loads the diff only when needed and completes streaming', async () => {
    await call('review_publish', {
      scope: { type: 'working-tree', repoId: 'repo-1' },
      chapters: [],
      findings: [fixtureFinding()],
      streaming: true,
    });
    state.loadCalls = [];
    await call('review_patch', {
      surfaceId: 'surface-9',
      baseRevision: 1,
      ops: [{ op: 'set_status', findingIds: ['f1'], status: 'accepted' }],
    });
    expect(state.loadCalls).toHaveLength(0);
    const result = await call('review_patch', {
      surfaceId: 'surface-9',
      baseRevision: 2,
      ops: [
        {
          op: 'add_finding',
          finding: fixtureFinding({
            id: 'f2',
            severity: 'low',
            filePath: 'src/gateway/new.ts',
            lineStart: 5,
            lineEnd: 5,
          }),
        },
      ],
      complete: true,
    });
    expect(state.loadCalls).toHaveLength(1);
    expect(state.patchOptions.at(-1)).toEqual({ streaming: false });
    expect(result?.structuredContent).toMatchObject({ revision: 3 });
    expect(
      (state.intent?.payload.data as ReviewSurfaceData).findings.map((finding) => finding.status),
    ).toEqual(['accepted', 'open']);
    await expect(
      call('review_patch', {
        surfaceId: 'surface-9',
        baseRevision: 1,
        ops: [{ op: 'set_status', findingIds: ['f1'], status: 'open' }],
      }),
    ).rejects.toThrow('conflict');
  });

  it('review_patch refuses surfaces from other threads', async () => {
    await call('review_publish', {
      scope: { type: 'working-tree', repoId: 'repo-1' },
      chapters: [],
      findings: [],
    });
    state.intent = { ...state.intent!, scope: { threadId: 'thread-2' } };
    await expect(
      call('review_patch', { surfaceId: 'surface-9', baseRevision: 1, ops: [], complete: true }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('ignores tools it does not own', async () => {
    expect(await call('sketch_show', {})).toBeUndefined();
  });
});
