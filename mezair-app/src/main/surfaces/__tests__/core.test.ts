import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';
import type { AgentToolSessionContext } from '../../agent-tools/dispatch.js';
import type { MainSurfaceHandler } from '../types.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

const session = vi.hoisted(() => ({
  broadcastAgentUIIntent: vi.fn(),
  deliverStructuredAgentFeedback: vi.fn(async () => true),
  getCodexSession: vi.fn((id: string) => (id === 'session-1' ? { id } : null)),
  listActiveCodexSessions: vi.fn(() => [] as Array<{ id: string; appThreadId?: string }>),
}));
const handlers = vi.hoisted(() => new Map<string, MainSurfaceHandler>());

vi.mock('../../db/database.js', () => ({ getDb: () => inMemoryDb }));
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));
vi.mock('../../services/codex-session.service.js', () => session);
vi.mock('../index.js', () => ({ getMainSurfaceHandler: (kind: string) => handlers.get(kind) }));

import {
  getAgentUIIntent,
  listAgentUIIntents,
  validateAgentUIIntent,
} from '../../services/agent-ui-intent.service.js';
import { runSurfaceAction } from '../actions.js';
import { addSurfaceComment, listSurfaceComments, setSurfaceCommentStatus } from '../comments.js';
import {
  defineSurfaceTools,
  deliverSurfaceFeedback,
  getSurface,
  patchSurface,
  publishSurface,
  requestUserApproval,
  resolveMezairOwnedQuestion,
  surfaceToolProvider,
} from '../core.js';

const ctx: AgentToolSessionContext = {
  sessionId: 'session-1',
  appThreadId: 'thread-1',
  workspaceId: 'ws-1',
  repoIds: ['repo-1'],
  provider: 'codex',
  mode: 'workspace-auto',
  features: [],
};

beforeEach(() => {
  for (const table of [
    'surface_comments',
    'agent_ui_intent_events',
    'agent_ui_intent_responses',
    'agent_ui_intents',
    'chat_threads',
  ]) {
    inMemoryDb.exec(`DELETE FROM ${table}`);
  }
  inMemoryDb
    .prepare(
      'INSERT INTO chat_threads (id, persona_id, title, provider_thread_id) VALUES (?, ?, ?, ?)',
    )
    .run('thread-1', 'coder', 'Thread', 'provider-thread-1');
  inMemoryDb
    .prepare('INSERT INTO chat_threads (id, persona_id, title) VALUES (?, ?, ?)')
    .run('thread-2', 'coder', 'Other');
  handlers.clear();
  vi.clearAllMocks();
  session.deliverStructuredAgentFeedback.mockResolvedValue(true);
});

afterAll(() => inMemoryDb.close());

function publishSketch(key?: string) {
  return publishSurface(ctx, {
    surfaceKind: 'sketch',
    title: 'Latency',
    key,
    data: { sketchId: 'sketch-1', title: 'Latency' },
  });
}

describe('surface lifecycle', () => {
  it('publishes a validated, persisted and broadcast surface intent', () => {
    const intent = publishSketch();
    expect(intent).toMatchObject({
      kind: 'surface',
      revision: 1,
      lifecycle: 'presented',
      scope: { threadId: 'thread-1', workspaceId: 'ws-1', providerThreadId: 'provider-thread-1' },
      payload: {
        surfaceKind: 'sketch',
        title: 'Latency',
        streaming: false,
        digest: 'Sketch "Latency"',
      },
    });
    expect(intent.id).toMatch(/^surface:/);
    expect(getSurface(intent.id)).toEqual(intent);
    expect(listAgentUIIntents('thread-1').map((item) => item.id)).toContain(intent.id);
    expect(session.broadcastAgentUIIntent).toHaveBeenCalledWith(intent, 'session-1');
  });

  it('rejects invalid data, unknown kinds and missing threads', () => {
    expect(() =>
      publishSurface(ctx, { surfaceKind: 'sketch', title: 'x', data: { height: 'tall' } }),
    ).toThrow(expect.objectContaining({ code: 'invalid-params' }));
    expect(() => publishSurface(ctx, { surfaceKind: 'nope', title: 'x', data: {} })).toThrow(
      /Unknown surface kind/,
    );
    expect(() =>
      publishSurface(
        { ...ctx, appThreadId: undefined },
        { surfaceKind: 'sketch', title: 'x', data: { sketchId: 's' } },
      ),
    ).toThrow(expect.objectContaining({ code: 'unavailable' }));
  });

  it('validates surface intents at the service boundary but reads them structurally', () => {
    const intent = publishSketch();
    const invalid = { ...intent, payload: { ...intent.payload, data: { height: 'x' } } };
    expect(validateAgentUIIntent(invalid).ok).toBe(false);
    expect(validateAgentUIIntent(invalid, { structuralOnly: true }).ok).toBe(true);
    expect(
      validateAgentUIIntent({ ...intent, payload: { ...intent.payload, surfaceKind: 'nope' } })
        .errors,
    ).toContain('Unknown surface kind: nope.');
  });

  it('patches by revision, recomputes the digest and rejects stale revisions', () => {
    const intent = publishSketch();
    const patched = patchSurface<{ sketchId: string; height?: number }>(
      intent.id,
      1,
      (data) => ({ ...data, height: 320 }),
      { streaming: true },
    );
    expect(patched.revision).toBe(2);
    expect(patched.payload.digest).toContain('320px');
    expect(patched.payload.streaming).toBe(true);
    expect(() => patchSurface(intent.id, 1, (data) => data)).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    expect(() => patchSurface(intent.id, undefined, () => ({ height: 1 }))).toThrow(
      expect.objectContaining({ code: 'invalid-params' }),
    );
    expect(patchSurface(intent.id, undefined, (data) => data).revision).toBe(3);
  });

  it('supersedes earlier surfaces with the same key', () => {
    const first = publishSketch('sketch:latency');
    const second = publishSketch('sketch:latency');
    const other = publishSketch('sketch:other');
    const updatedFirst = getSurface(first.id);
    expect(updatedFirst?.payload.supersededBy).toBe(second.id);
    expect(updatedFirst?.revision).toBe(2);
    expect(getSurface(second.id)?.payload.supersededBy).toBeUndefined();
    expect(getSurface(other.id)?.payload.supersededBy).toBeUndefined();
  });

  it('delivers structured feedback to the owning session', async () => {
    const intent = publishSketch();
    await expect(deliverSurfaceFeedback(intent.id, 'hello')).resolves.toBe(true);
    const [sessionId, payload] = session.deliverStructuredAgentFeedback.mock
      .calls[0] as unknown as [string, string];
    expect(sessionId).toBe('session-1');
    expect(JSON.parse(payload)).toEqual({
      type: 'mezair.surface.feedback',
      surfaceId: intent.id,
      surfaceKind: 'sketch',
      title: 'Latency',
      message: 'hello',
    });
  });

  it('falls back to a live session on the same thread, else reports no delivery', async () => {
    const intent = publishSketch();
    session.getCodexSession.mockReturnValue(null);
    session.listActiveCodexSessions.mockReturnValueOnce([
      { id: 'session-2', appThreadId: 'thread-1' },
    ]);
    await expect(deliverSurfaceFeedback(intent.id, 'x')).resolves.toBe(true);
    expect(session.deliverStructuredAgentFeedback).toHaveBeenLastCalledWith(
      'session-2',
      expect.any(String),
    );
    await expect(deliverSurfaceFeedback(intent.id, 'x')).resolves.toBe(false);
    await expect(deliverSurfaceFeedback('surface:missing', 'x')).resolves.toBe(false);
    session.getCodexSession.mockImplementation((id: string) =>
      id === 'session-1' ? { id } : null,
    );
  });
});

describe('surface actions', () => {
  it('delivers agent-message actions with the filled template', async () => {
    const intent = publishSurface(ctx, {
      surfaceKind: 'artifact',
      title: 'Runbook',
      data: { artifactId: 'a1', version: 1, operation: 'created' },
    });
    // Artifact actions are commands; simulate an agent-message kind via a stub definition.
    const result = await runSurfaceAction({ surfaceId: intent.id, action: 'discard' });
    expect(result.ok).toBe(false);

    const sketch = publishSketch();
    handlers.set('sketch', {
      kind: 'sketch',
      executeAction: vi.fn(async () => ({ ok: true, message: 'kept' })),
    });
    await expect(runSurfaceAction({ surfaceId: sketch.id, action: 'keep' })).resolves.toEqual({
      ok: true,
      message: 'kept',
    });
    const events = inMemoryDb
      .prepare(
        "SELECT actor, payload_json FROM agent_ui_intent_events WHERE event_type = 'surface_action'",
      )
      .all() as Array<{ actor: string; payload_json: string }>;
    expect(events.at(-1)).toMatchObject({ actor: 'user' });
    expect(JSON.parse(events.at(-1)!.payload_json)).toMatchObject({ action: 'keep', ok: true });
  });

  it('validates action names and target counts', async () => {
    const sketch = publishSketch();
    await expect(
      runSurfaceAction({ surfaceId: sketch.id, action: 'explode' }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Unknown action: explode.',
    });
    await expect(
      runSurfaceAction({ surfaceId: sketch.id, action: 'keep', targetIds: ['x'] }),
    ).resolves.toMatchObject({ ok: false, error: 'Keep does not take a selection.' });
    await expect(
      runSurfaceAction({ surfaceId: 'surface:none', action: 'keep' }),
    ).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('default agent-message semantics', () => {
  it('fills {title}, {targets} and {note} and delivers feedback', async () => {
    const { getSurfaceKind } = await import('../../../shared/surfaces/registry.js');
    const definition = getSurfaceKind('sketch')!;
    definition.actions.ask_fix = {
      label: 'Ask fix',
      semantics: { type: 'agent-message', template: 'Fix {targets} in {title}. {note}' },
      targets: 'many',
    };
    try {
      const sketch = publishSketch();
      const result = await runSurfaceAction({
        surfaceId: sketch.id,
        action: 'ask_fix',
        targetIds: ['f1', 'f2'],
        note: 'quickly',
      });
      expect(result).toEqual({ ok: true, message: 'Sent to the agent.' });
      const payload = JSON.parse(
        (
          session.deliverStructuredAgentFeedback.mock.calls.at(-1) as unknown as [string, string]
        )[1],
      );
      expect(payload.message).toBe(
        'User action "Ask fix" (ask_fix): Fix f1, f2 in Latency. quickly',
      );
      await expect(
        runSurfaceAction({ surfaceId: sketch.id, action: 'ask_fix' }),
      ).resolves.toMatchObject({
        ok: false,
      });
    } finally {
      delete definition.actions.ask_fix;
    }
  });
});

describe('surface comments', () => {
  it('stores, lists, resolves and sends comments with anchor context', async () => {
    const sketch = publishSketch();
    const comment = await addSurfaceComment({
      surfaceId: sketch.id,
      anchor: {
        type: 'region',
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        label: 'Legend',
      },
      body: 'This is wrong',
      sendToAgent: true,
    });
    expect(comment).toMatchObject({ status: 'open', anchor: { type: 'region', label: 'Legend' } });
    expect(listSurfaceComments(sketch.id)).toHaveLength(1);
    const payload = JSON.parse(
      (session.deliverStructuredAgentFeedback.mock.calls.at(-1) as unknown as [string, string])[1],
    );
    expect(payload.message).toContain('This is wrong');
    expect(payload.message).toContain('Legend');
    expect(payload.message).toContain('x=0.100');
    expect(setSurfaceCommentStatus(comment.id, 'resolved').status).toBe('resolved');

    await expect(
      addSurfaceComment({ surfaceId: sketch.id, anchor: { type: 'diff-range' }, body: 'x' }),
    ).rejects.toThrow(/do not support diff-range/);
    await expect(
      addSurfaceComment({ surfaceId: sketch.id, anchor: { type: 'surface' }, body: '  ' }),
    ).rejects.toThrow(/required/);
  });

  it('exposes comments and reads through the generic tools, scoped to the thread', async () => {
    const sketch = publishSketch();
    await addSurfaceComment({
      surfaceId: sketch.id,
      anchor: { type: 'surface' },
      body: 'Open one',
    });
    const listed = await surfaceToolProvider.call(ctx, 'surface_comments', {
      surfaceId: sketch.id,
    });
    expect(listed?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Open one'),
    });

    const read = await surfaceToolProvider.call(ctx, 'surface_read', {
      surfaceId: sketch.id,
      select: 'title',
    });
    expect(read?.content[0]).toMatchObject({ text: expect.stringContaining('"Latency"') });

    await expect(
      surfaceToolProvider.call({ ...ctx, appThreadId: 'thread-2' }, 'surface_read', {
        surfaceId: sketch.id,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      surfaceToolProvider.call(ctx, 'surface_read', { surfaceId: sketch.id, extra: 1 }),
    ).rejects.toMatchObject({ code: 'invalid-params' });

    const completed = await surfaceToolProvider.call(ctx, 'surface_complete', {
      surfaceId: sketch.id,
    });
    expect(completed?.structuredContent).toMatchObject({ revision: 2 });
  });

  it('serves prompt bodies through mezair_skill_get', async () => {
    const tool = surfaceToolProvider
      .tools(ctx)
      .find((candidate) => candidate.name === 'mezair_skill_get');
    expect(tool?.description).toContain('code-review-senior');
    const result = await surfaceToolProvider.call(ctx, 'mezair_skill_get', {
      name: 'security-audit',
    });
    expect(result?.content[0]).toMatchObject({ type: 'text' });
    await expect(
      surfaceToolProvider.call(ctx, 'mezair_skill_get', { name: '../package' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('defineSurfaceTools', () => {
  it('derives publish and patch tools from the kind schema', async () => {
    const provider = defineSurfaceTools<{ sketchId: string; height?: number }>('sketch', {
      publishTool: { description: 'Publish', key: (data) => `sketch:${data.sketchId}` },
      patchTool: {
        description: 'Patch',
        operations: { type: 'object', properties: { height: { type: 'integer' } } },
        apply: (data, operations) => ({
          ...data,
          height: (operations[0] as { height: number }).height,
        }),
      },
    });
    expect(provider.tools(ctx).map((tool) => tool.name)).toEqual([
      'sketch_publish',
      'sketch_patch',
    ]);
    const published = await provider.call(ctx, 'sketch_publish', {
      title: 'Hello',
      data: { sketchId: 's1' },
    });
    const surfaceId = published?.structuredContent?.surfaceId as string;
    expect(getSurface(surfaceId)?.payload.key).toBe('sketch:s1');
    await expect(
      provider.call(ctx, 'sketch_publish', { title: 'Bad', data: { sketchId: 1 } }),
    ).rejects.toMatchObject({ code: 'invalid-params' });
    const patched = await provider.call(ctx, 'sketch_patch', {
      surfaceId,
      baseRevision: 1,
      operations: [{ height: 99 }],
    });
    expect(patched?.structuredContent).toMatchObject({ revision: 2 });
    expect(getSurface(surfaceId)?.payload.data).toMatchObject({ height: 99 });
    await expect(
      provider.call(ctx, 'sketch_patch', { surfaceId, baseRevision: 1, data: { sketchId: 's1' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('approvals', () => {
  it('publishes a Mezair-owned approval question and resolves on answer', async () => {
    const pending = requestUserApproval(ctx, {
      title: 'Create 3 work items?',
      detail: 'From critical findings',
      consequences: 'Creates tickets in Jira',
    });
    const [question] = session.broadcastAgentUIIntent.mock.calls.at(-1) as unknown as [
      {
        id: string;
        kind: string;
        payload: { questions: Array<{ kind: string; context: string }> };
      },
    ];
    expect(question.kind).toBe('question');
    expect(question.payload.questions[0]).toMatchObject({ kind: 'approval' });
    expect(question.payload.questions[0].context).toContain('Creates tickets in Jira');

    const resolved = resolveMezairOwnedQuestion(question.id, {
      intentId: question.id,
      action: 'submit',
      answers: { approve: true },
      answeredAt: new Date().toISOString(),
    });
    expect(resolved?.lifecycle).toBe('resolved');
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false on reject or cancel, and ignores provider-owned questions', async () => {
    const rejected = requestUserApproval(ctx, { title: 'Post to PR?', detail: '' });
    const id = (session.broadcastAgentUIIntent.mock.calls.at(-1) as unknown as [{ id: string }])[0]
      .id;
    resolveMezairOwnedQuestion(id, {
      intentId: id,
      action: 'cancel',
      answers: {},
      answeredAt: new Date().toISOString(),
    });
    await expect(rejected).resolves.toBe(false);
    expect(getAgentUIIntent(id)?.lifecycle).toBe('dismissed');

    const sketch = publishSketch();
    expect(
      resolveMezairOwnedQuestion(sketch.id, {
        intentId: sketch.id,
        action: 'submit',
        answers: {},
        answeredAt: new Date().toISOString(),
      }),
    ).toBeNull();
  });

  it('expires when the session stops', async () => {
    vi.useFakeTimers();
    try {
      const pending = requestUserApproval(ctx, { title: 'Commit?', detail: 'Write & commit' });
      const id = (
        session.broadcastAgentUIIntent.mock.calls.at(-1) as unknown as [{ id: string }]
      )[0].id;
      session.getCodexSession.mockReturnValue(null);
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(pending).resolves.toBe(false);
      expect(getAgentUIIntent(id)?.lifecycle).toBe('expired');
    } finally {
      vi.useRealTimers();
      session.getCodexSession.mockImplementation((id: string) =>
        id === 'session-1' ? { id } : null,
      );
    }
  });
});
